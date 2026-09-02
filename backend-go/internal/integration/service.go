// Остаток integration.service.ts (всё, кроме Enqueue/FindExternalIds — они
// в outbox.go): маппинг внешних ID (ExternalRef), отправка накопленного
// outbox в 1С с ретраями, приём входящих (Inbox) с идемпотентностью по
// ключу документа внешней системы и HMAC-подпись вебхуков.
//
// Плановая отправка: в оригинале onModuleInit заводит setInterval на
// 5 минут ТОЛЬКО когда задан INTEGRATION_1C_URL (без адреса сообщения
// копятся в PENDING). В Go таймер здесь не живёт — горутина-тикер
// поднимается в cmd/server/main.go и зовёт FlushOutbox с тем же условием.
package integration

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/gin-gonic/gin"

	"cmk-avrora-erp/backend-go/internal/common"
)

// maxAttempts — после пятой неудачи сообщение становится DEAD (MAX_ATTEMPTS).
const maxAttempts = 5

// backoffMinutes — экспоненциальная задержка: 1, 2, 4, 8, 16 минут.
func backoffMinutes(attempt int) int {
	m := 1 << uint(attempt)
	if attempt >= 4 || m > 16 {
		return 16
	}
	return m
}

// Secret — INTEGRATION_SECRET оригинала: INTEGRATION_1C_SECRET || 'dev-1c-secret'.
func Secret() string {
	if v := os.Getenv("INTEGRATION_1C_SECRET"); v != "" {
		return v
	}
	return "dev-1c-secret"
}

// URL — INTEGRATION_1C_URL оригинала; "" = адрес не задан, отправка пропускается.
func URL() string { return os.Getenv("INTEGRATION_1C_URL") }

// ---------- Маппинг ID ----------

type LinkInput struct {
	EntityType   string
	LocalID      string
	ExternalID   string
	ExternalCode *string
	System       string // "" -> "1C"
}

// LinkExternal — перенос linkExternal: один документ 1С может оказаться
// привязан к другому нашему объекту (дубли Excel-миграции) — уникальность
// (system, entityType, externalId) тогда роняла бы upsert, поэтому старая
// привязка снимается: истина — за 1С. Затем upsert по (system, entityType,
// localId); synced_at — @updatedAt у Prisma, колонка без дефолта в БД,
// пишется явно и на create, и на update.
func LinkExternal(ctx context.Context, pool *pgxpool.Pool, in LinkInput) error {
	system := in.System
	if system == "" {
		system = "1C"
	}
	var conflictingID, conflictingLocalID string
	err := pool.QueryRow(ctx,
		`SELECT id, local_id FROM external_refs WHERE system = $1 AND entity_type = $2 AND external_id = $3`,
		system, in.EntityType, in.ExternalID).Scan(&conflictingID, &conflictingLocalID)
	if err != nil && err != pgx.ErrNoRows {
		return err
	}
	if err == nil && conflictingLocalID != in.LocalID {
		log.Printf("%s %s (%s) был привязан к %s, перепривязан к %s",
			in.EntityType, in.ExternalID, system, conflictingLocalID, in.LocalID)
		if _, err := pool.Exec(ctx, `DELETE FROM external_refs WHERE id = $1`, conflictingID); err != nil {
			return err
		}
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO external_refs (id, system, entity_type, local_id, external_id, external_code, synced_at)
		VALUES ($1, $2, $3, $4, $5, $6, now())
		ON CONFLICT (system, entity_type, local_id) DO UPDATE
		SET external_id = EXCLUDED.external_id, external_code = EXCLUDED.external_code, synced_at = now()`,
		uuid.NewString(), system, in.EntityType, in.LocalID, in.ExternalID, in.ExternalCode)
	return err
}

// FindLocalID — наш объект по идентификатору внешней системы (для входящих).
func FindLocalID(ctx context.Context, pool *pgxpool.Pool, entityType, externalID, system string) (*string, error) {
	if system == "" {
		system = "1C"
	}
	var localID string
	err := pool.QueryRow(ctx,
		`SELECT local_id FROM external_refs WHERE system = $1 AND entity_type = $2 AND external_id = $3`,
		system, entityType, externalID).Scan(&localID)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &localID, nil
}

// ---------- Модели очередей ----------

// OutboxMessage — строка outbox_messages как её отдаёт Prisma (все поля модели).
type OutboxMessage struct {
	ID          string
	System      string
	Type        string
	EntityType  string
	EntityID    string
	Payload     json.RawMessage
	Status      string
	Attempts    int
	LastError   *string
	NextRetryAt common.PDate
	CreatedAt   common.PDate
	SentAt      common.PDate
}

const OutboxCols = "id, system, type, entity_type, entity_id, payload, status, attempts, last_error, next_retry_at, created_at, sent_at"

func ScanOutbox(row pgx.Row) (OutboxMessage, error) {
	var m OutboxMessage
	var payload []byte
	err := row.Scan(&m.ID, &m.System, &m.Type, &m.EntityType, &m.EntityID, &payload, &m.Status, &m.Attempts,
		&m.LastError, &m.NextRetryAt, &m.CreatedAt, &m.SentAt)
	if err != nil {
		return m, err
	}
	m.Payload = rawJSON(payload)
	return m, nil
}

// OutboxJSON — ключи Prisma-модели OutboxMessage.
func OutboxJSON(m OutboxMessage) gin.H {
	return gin.H{
		"id":          m.ID,
		"system":      m.System,
		"type":        m.Type,
		"entityType":  m.EntityType,
		"entityId":    m.EntityID,
		"payload":     m.Payload,
		"status":      m.Status,
		"attempts":    m.Attempts,
		"lastError":   m.LastError,
		"nextRetryAt": m.NextRetryAt,
		"createdAt":   m.CreatedAt,
		"sentAt":      m.SentAt,
	}
}

// InboxMessage — строка inbox_messages как её отдаёт Prisma (все поля модели).
type InboxMessage struct {
	ID          string
	System      string
	Type        string
	ExternalKey string
	Payload     json.RawMessage
	Status      string
	Attempts    int
	Error       *string
	ReceivedAt  common.PDate
	ProcessedAt common.PDate
}

const InboxCols = "id, system, type, external_key, payload, status, attempts, error, received_at, processed_at"

func ScanInbox(row pgx.Row) (InboxMessage, error) {
	var m InboxMessage
	var payload []byte
	err := row.Scan(&m.ID, &m.System, &m.Type, &m.ExternalKey, &payload, &m.Status, &m.Attempts,
		&m.Error, &m.ReceivedAt, &m.ProcessedAt)
	if err != nil {
		return m, err
	}
	m.Payload = rawJSON(payload)
	return m, nil
}

// InboxJSON — ключи Prisma-модели InboxMessage.
func InboxJSON(m InboxMessage) gin.H {
	return gin.H{
		"id":          m.ID,
		"system":      m.System,
		"type":        m.Type,
		"externalKey": m.ExternalKey,
		"payload":     m.Payload,
		"status":      m.Status,
		"attempts":    m.Attempts,
		"error":       m.Error,
		"receivedAt":  m.ReceivedAt,
		"processedAt": m.ProcessedAt,
	}
}

// rawJSON — jsonb из pgx как есть; пустой буфер (NULL) — JSON null, а не
// «unexpected end of JSON input» при сериализации пустого RawMessage.
func rawJSON(b []byte) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage("null")
	}
	return json.RawMessage(b)
}

// ---------- Исходящие ----------

// FlushResult — сводка отправки; её же показывает журнал обмена. Порядок и
// состав ключей — как у двух литералов оригинала: при пропуске
// {skipped, reason, waiting, sent, failed}, иначе {skipped, sent, failed, processed}.
type FlushResult struct {
	Skipped   bool   `json:"skipped"`
	Reason    string `json:"reason,omitempty"`
	Waiting   *int   `json:"waiting,omitempty"`
	Sent      int    `json:"sent"`
	Failed    int    `json:"failed"`
	Processed *int   `json:"processed,omitempty"`
}

// FlushOutbox — перенос flushOutbox(limit = 50). Без настроенного адреса 1С
// ничего не отправляет: сообщения ждут в PENDING. limit <= 0 → 50 (дефолт
// параметра оригинала; контроллер зовёт flushOutbox() без аргументов).
func FlushOutbox(ctx context.Context, pool *pgxpool.Pool, limit int) (FlushResult, error) {
	if limit <= 0 {
		limit = 50
	}
	if URL() == "" {
		var waiting int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM outbox_messages WHERE status = 'PENDING'`).Scan(&waiting); err != nil {
			return FlushResult{}, err
		}
		return FlushResult{Skipped: true, Reason: "INTEGRATION_1C_URL не задан", Waiting: &waiting}, nil
	}

	now := time.Now().UTC()
	rows, err := pool.Query(ctx, `
		SELECT `+OutboxCols+` FROM outbox_messages
		WHERE status IN ('PENDING', 'FAILED') AND (next_retry_at IS NULL OR next_retry_at <= $1)
		ORDER BY created_at ASC
		LIMIT $2`, now, limit)
	if err != nil {
		return FlushResult{}, err
	}
	var messages []OutboxMessage
	for rows.Next() {
		m, err := ScanOutbox(rows)
		if err != nil {
			rows.Close()
			return FlushResult{}, err
		}
		messages = append(messages, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return FlushResult{}, err
	}

	sent, failed := 0, 0
	for _, m := range messages {
		// try { send; update(SENT) } catch { update(FAILED|DEAD) } — ошибка
		// самого update(SENT) тоже уходит в catch-ветку, как в оригинале.
		sendErr := send(ctx, m.ID, m.Type, m.Payload)
		if sendErr == nil {
			_, sendErr = pool.Exec(ctx, `
				UPDATE outbox_messages
				SET status = 'SENT', sent_at = $1, attempts = $2, last_error = NULL
				WHERE id = $3`, time.Now().UTC(), m.Attempts+1, m.ID)
		}
		if sendErr == nil {
			sent++
			continue
		}
		attempts := m.Attempts + 1
		dead := attempts >= maxAttempts
		var nextRetryAt *time.Time
		if !dead {
			t := time.Now().UTC().Add(time.Duration(backoffMinutes(attempts)) * time.Minute)
			nextRetryAt = &t
		}
		status := "FAILED"
		if dead {
			status = "DEAD"
		}
		if _, err := pool.Exec(ctx, `
			UPDATE outbox_messages
			SET status = $1::"IntegrationMessageStatus", attempts = $2, last_error = $3, next_retry_at = $4
			WHERE id = $5`, status, attempts, sendErr.Error(), nextRetryAt, m.ID); err != nil {
			return FlushResult{}, err
		}
		failed++
		if dead {
			// Мёртвое сообщение — повод для человека, а не молчаливая потеря
			log.Printf("Сообщение %s (%s) не доставлено после %d попыток", m.Type, m.ID, attempts)
		}
	}
	processed := len(messages)
	return FlushResult{Skipped: false, Sent: sent, Failed: failed, Processed: &processed}, nil
}

var httpClient = &http.Client{}

// send — транспорт до 1С. Подпись — HMAC над точными байтами тела, как для
// входящих. messageId в конверте — ключ идемпотентности: по
// production.completed 1С создаёт документ, и без ключа ретрай после
// таймаута (когда документ фактически проведён) создал бы второй документ.
//
// Тексты ошибок повторяют то, что оригинал кладёт в last_error: не-2xx →
// «1С ответила <status>: <первые 200 символов тела>»; таймаут AbortSignal —
// «The operation was aborted due to timeout»; любая сетевая ошибка
// undici — «fetch failed» (реальная причина — в DebugLog).
func send(ctx context.Context, messageID, typ string, payload json.RawMessage) error {
	body, err := envelope(messageID, typ, payload)
	if err != nil {
		return err
	}
	mac := hmac.New(sha256.New, []byte(Secret()))
	mac.Write(body)
	signature := hex.EncodeToString(mac.Sum(nil))

	reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, strings.TrimSuffix(URL(), "/")+"/"+typ, bytes.NewReader(body))
	if err != nil {
		common.DebugLog(err)
		return errors.New("fetch failed")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Signature", signature)
	res, err := httpClient.Do(req)
	if err != nil {
		return fetchError(err)
	}
	defer res.Body.Close()
	raw, readErr := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if readErr != nil {
			return fetchError(readErr)
		}
		return fmt.Errorf("1С ответила %d: %s", res.StatusCode, sliceUTF16(string(raw), 200))
	}
	// res.json().catch(() => ({})) — тело ответа никого не интересует
	if readErr != nil {
		return fetchError(readErr)
	}
	return nil
}

// envelope — JSON.stringify({ messageId, type, payload }): порядок ключей,
// без HTML-экранирования (<, >, & — как есть), payload — компактный.
func envelope(messageID, typ string, payload json.RawMessage) ([]byte, error) {
	if len(payload) == 0 {
		payload = json.RawMessage("null")
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	err := enc.Encode(struct {
		MessageID string          `json:"messageId"`
		Type      string          `json:"type"`
		Payload   json.RawMessage `json:"payload"`
	}{messageID, typ, payload})
	if err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// fetchError — сообщение так, как его видит e.message у Node fetch.
func fetchError(err error) error {
	common.DebugLog(err)
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return errors.New("The operation was aborted due to timeout")
	}
	return errors.New("fetch failed")
}

// ---------- Входящие ----------

// VerifySignature — проверка подписи: вебхуки подписываются HMAC, а не JWT.
// Пустая подпись — false; сравнение постоянного времени при равной длине.
func VerifySignature(raw []byte, signature string) bool {
	if signature == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(Secret()))
	mac.Write(raw)
	expected := []byte(hex.EncodeToString(mac.Sum(nil)))
	got := []byte(signature)
	return len(expected) == len(got) && hmac.Equal(expected, got)
}

// Receive — принять сообщение. Повторная доставка того же externalKey не
// создаёт второй записи — уникальный индекс (system, type, externalKey);
// тогда возвращается существующая строка и duplicate = true.
func Receive(ctx context.Context, pool *pgxpool.Pool, typ, externalKey string, payload json.RawMessage, system string) (InboxMessage, bool, error) {
	if system == "" {
		system = "1C"
	}
	existing, err := ScanInbox(pool.QueryRow(ctx,
		`SELECT `+InboxCols+` FROM inbox_messages WHERE system = $1 AND type = $2 AND external_key = $3`,
		system, typ, externalKey))
	if err == nil {
		return existing, true, nil
	}
	if err != pgx.ErrNoRows {
		return InboxMessage{}, false, err
	}
	if len(payload) == 0 {
		payload = json.RawMessage("null")
	}
	created, err := ScanInbox(pool.QueryRow(ctx, `
		INSERT INTO inbox_messages (id, system, type, external_key, payload)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING `+InboxCols,
		uuid.NewString(), system, typ, externalKey, []byte(payload)))
	if err != nil {
		return InboxMessage{}, false, err
	}
	return created, false, nil
}

// MarkProcessed — status PROCESSED, processed_at = now, error = NULL.
func MarkProcessed(ctx context.Context, pool *pgxpool.Pool, id string) error {
	tag, err := pool.Exec(ctx,
		`UPDATE inbox_messages SET status = 'PROCESSED', processed_at = $1, error = NULL WHERE id = $2`,
		time.Now().UTC(), id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("inbox_messages %s: запись не найдена", id)
	}
	return nil
}

// MarkFailed — DEAD при attempts >= 5, иначе FAILED; текст ошибки — первые
// 1000 символов (slice(0,1000) у JS — по UTF-16 code units, не по рунам).
func MarkFailed(ctx context.Context, pool *pgxpool.Pool, id, errText string, attempts int) error {
	status := "FAILED"
	if attempts >= maxAttempts {
		status = "DEAD"
	}
	tag, err := pool.Exec(ctx, `
		UPDATE inbox_messages
		SET status = $1::"IntegrationMessageStatus", attempts = $2, error = $3
		WHERE id = $4`, status, attempts, sliceUTF16(errText, 1000), id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("inbox_messages %s: запись не найдена", id)
	}
	return nil
}

// sliceUTF16 — JS String.prototype.slice(0, n): считает UTF-16 code units,
// разрезанная суррогатная пара становится U+FFFD (как при записи в БД).
func sliceUTF16(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= n {
		return s
	}
	return string(utf16.Decode(units[:n]))
}
