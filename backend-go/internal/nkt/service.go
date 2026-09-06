package nkt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/integration"
)

// ---------------------------------------------------------------------------
// Статусы
// ---------------------------------------------------------------------------

// Значения перечисления NktStatus. Статусов READY_TO_SEARCH и MATCHED из ТЗ
// здесь нет: периметр — собственное производство, для него шаг поиска в НКТ
// пропускается, карточки там заведомо нет (ТЗ §10.3).
const (
	StatusNew              = "NEW"
	StatusDataIncomplete   = "DATA_INCOMPLETE"
	StatusNeedRegistration = "NEED_REGISTRATION"
	StatusRequestCreated   = "REQUEST_CREATED"
	StatusModeration       = "MODERATION"
	StatusMatchReview      = "MATCH_REVIEW"
	StatusRework           = "REWORK"
	StatusRejected         = "REJECTED"
	StatusReadyToPublish   = "READY_TO_PUBLISH"
	StatusHasNtin          = "HAS_NTIN"
	StatusError            = "ERROR"
)

// Операции очереди (NktQueueOp).
const (
	OpValidate = "VALIDATE"
	OpSubmit   = "SUBMIT"
	OpPoll     = "POLL"
	OpPublish  = "PUBLISH"
)

// Задержки ретраев из ТЗ §13: 1 мин → 5 мин → 30 мин → 2 ч → 6 ч.
// После пятой неудачи объект уходит в ERROR и ждёт администратора.
var retryDelays = []time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute, 2 * time.Hour, 6 * time.Hour}

var maxAttempts = len(retryDelays)

// Первый опрос статуса — через полчаса: модерация быстрее не отвечает, но и
// ждать полные четыре часа на пилоте бессмысленно. Дальше — раз в 4 часа.
const (
	firstPollDelay = 30 * time.Minute
	pollDelay      = 4 * time.Hour
	// Задание, взятое умершим воркером, освобождается через это время —
	// иначе изделие заперто навсегда
	lockTimeout = 15 * time.Minute
)

// ---------------------------------------------------------------------------
// Сервис
// ---------------------------------------------------------------------------

type Service struct {
	pool   *pgxpool.Pool
	client *Client
}

type ctxKey string

const ctxCardID ctxKey = "nktCardID"

// withCard — привязывает вызовы НКТ к изделию, чтобы журнал обмена можно
// было читать с карточки, а не сплошной лентой.
func withCard(ctx context.Context, cardID string) context.Context {
	return context.WithValue(ctx, ctxCardID, cardID)
}

func NewService(pool *pgxpool.Pool) *Service {
	s := &Service{pool: pool}
	s.client = NewClient(s.record)
	return s
}

func (s *Service) Client() *Client { return s.client }

// record — строка журнала обмена. Пишется вне транзакции шага: журнал не
// должен исчезнуть вместе с откатом неудачного шага — именно по нему потом
// и разбираются, почему шаг не удался.
func (s *Service) record(ctx context.Context, rec Record) {
	var cardID interface{}
	if v, ok := ctx.Value(ctxCardID).(string); ok && v != "" {
		cardID = v
	}
	dir := "OUT"
	// Контекст запроса мог быть уже отменён — журнал пишем всё равно
	logCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, err := s.pool.Exec(logCtx, `
		INSERT INTO nkt_log (card_id, direction, method, url, http_code, request_body, response_body, duration_ms)
		VALUES ($1,$2::"NktLogDirection",$3,$4,$5,$6,$7,$8)`,
		cardID, dir, rec.Method, rec.URL, nullInt(rec.HTTPCode), truncate(rec.Request), truncate(rec.Response), rec.DurationMs)
	if err != nil {
		log.Printf("НКТ: журнал обмена не записан: %v", err)
	}
}

func nullInt(v int) interface{} {
	if v == 0 {
		return nil
	}
	return v
}

// truncate — тела ответов НКТ на схему категории доходят до сотен килобайт;
// в журнале от них нужен диагностический хвост, а не полный дубль справочника.
func truncate(s string) string {
	const limit = 20000
	if len(s) <= limit {
		return s
	}
	return s[:limit] + fmt.Sprintf("… (обрезано, всего %d байт)", len(s))
}

// ---------------------------------------------------------------------------
// Карточки
// ---------------------------------------------------------------------------

type Card struct {
	ID          string `json:"id"`
	ArticleID   string `json:"articleId"`
	ArticleCode string `json:"articleCode"`
	ArticleName string `json:"articleName"`
	// Вид изделия — префикс артикула до дефиса. По нему берётся умолчание
	// категории: колонка articles.series пуста у всех изделий
	CodePrefix string `json:"codePrefix"`

	Oktru      string            `json:"oktru"`
	Tnved      string            `json:"tnved"`
	Gtin       string            `json:"gtin"`
	GtinValid  bool              `json:"gtinValid"`
	NameRu     string            `json:"nameRu"`
	NameKk     string            `json:"nameKk"`
	Brand      string            `json:"brand"`
	Attributes map[string]string `json:"attributes"`
	Images     []ImageRef        `json:"images"`

	Status           string           `json:"status"`
	RequestID        string           `json:"requestId"`
	RequestStatusRaw string           `json:"requestStatusRaw"`
	ModeratorComment string           `json:"moderatorComment"`
	RevisionDetails  []RevisionDetail `json:"revisionDetails"`
	Duplicates       []Duplicate      `json:"duplicates"`
	Ntin             string           `json:"ntin"`
	NtinSource       string           `json:"ntinSource"`
	ProductURL       string           `json:"productUrl"`
	Attempts         int              `json:"attempts"`
	LastError        string           `json:"lastError"`
	AutoPublication  bool             `json:"autoPublication"`
	LastSyncAt       common.PDate     `json:"lastSyncAt"`
	NextRetryAt      common.PDate     `json:"nextRetryAt"`
	PublishedAt      common.PDate     `json:"publishedAt"`
	UpdatedAt        common.PDate     `json:"updatedAt"`
	// Заполняется на чтении: стоит ли изделие в очереди и на какой шаг
	QueuedOp string `json:"queuedOp"`
}

const cardCols = `c.id, c.article_id, a.article_code, a.name, split_part(a.article_code,'-',1),
	coalesce(c.oktru,''), coalesce(c.tnved,''), coalesce(c.gtin,''), c.gtin_valid,
	coalesce(c.name_ru,''), coalesce(c.name_kk,''), coalesce(c.brand,''), c.attributes, c.images,
	c.status::text, coalesce(c.request_id,''), coalesce(c.request_status_raw,''),
	coalesce(c.moderator_comment,''), c.revision_details, c.duplicates,
	coalesce(c.ntin,''), coalesce(c.ntin_source::text,''), coalesce(c.product_url,''),
	c.attempts, coalesce(c.last_error,''), c.auto_publication,
	c.last_sync_at, c.next_retry_at, c.published_at, c.updated_at,
	coalesce(q.operation::text,'')`

const cardFrom = `FROM nkt_cards c
	JOIN articles a ON a.id = c.article_id
	LEFT JOIN nkt_queue q ON q.card_id = c.id`

func scanCard(row pgx.Row) (Card, error) {
	var c Card
	var attrs, images, revision, dups []byte
	err := row.Scan(&c.ID, &c.ArticleID, &c.ArticleCode, &c.ArticleName, &c.CodePrefix,
		&c.Oktru, &c.Tnved, &c.Gtin, &c.GtinValid,
		&c.NameRu, &c.NameKk, &c.Brand, &attrs, &images,
		&c.Status, &c.RequestID, &c.RequestStatusRaw,
		&c.ModeratorComment, &revision, &dups,
		&c.Ntin, &c.NtinSource, &c.ProductURL,
		&c.Attempts, &c.LastError, &c.AutoPublication,
		&c.LastSyncAt, &c.NextRetryAt, &c.PublishedAt, &c.UpdatedAt,
		&c.QueuedOp)
	if err != nil {
		return c, err
	}
	c.Attributes = map[string]string{}
	_ = json.Unmarshal(attrs, &c.Attributes)
	c.Images = []ImageRef{}
	_ = json.Unmarshal(images, &c.Images)
	if len(revision) > 0 {
		_ = json.Unmarshal(revision, &c.RevisionDetails)
	}
	if len(dups) > 0 {
		_ = json.Unmarshal(dups, &c.Duplicates)
	}
	return c, nil
}

// Passport — паспортная часть карточки, в том виде, в каком её ждёт сборка тела.
func (c Card) Passport() Passport {
	return Passport{
		Oktru: c.Oktru, Tnved: c.Tnved, Gtin: c.Gtin,
		NameRu: c.NameRu, NameKk: c.NameKk, Brand: c.Brand,
		Attributes: c.Attributes, Images: c.Images,
	}
}

// GetCard — карточка по изделию. Создаётся при первом обращении, чтобы
// инженер мог открыть паспорт, не дожидаясь ночного задания.
func (s *Service) GetCard(ctx context.Context, articleID string) (Card, error) {
	if err := s.ensureCard(ctx, articleID); err != nil {
		return Card{}, err
	}
	row := s.pool.QueryRow(ctx, "SELECT "+cardCols+" "+cardFrom+" WHERE c.article_id = $1", articleID)
	return scanCard(row)
}

// ensureCard — карточка на изделие с умолчаниями категории по виду.
func (s *Service) ensureCard(ctx context.Context, articleID string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO nkt_cards (article_id, oktru, tnved)
		SELECT a.id, m.oktru, m.tnved_default
		FROM articles a
		LEFT JOIN nkt_category_map m
		       ON m.code_prefix = split_part(a.article_code,'-',1) AND m.is_active
		WHERE a.id = $1
		ON CONFLICT (article_id) DO NOTHING`, articleID)
	return err
}

// EnsureCards — первичная загрузка и ежесуточное пополнение (ТЗ §10.1).
//
// Периметр — изделия ЦМК: перепродажа сырья исключена (is_material_resale),
// ей NTIN присваивается по чужому GTIN, а штрихкодов у нас нет.
// Фильтр — по виду изделия (префикс артикула). Возвращает число заведённых.
func (s *Service) EnsureCards(ctx context.Context, codePrefix string) (int64, error) {
	args := []interface{}{}
	filter := ""
	if codePrefix != "" {
		args = append(args, codePrefix)
		filter = " AND split_part(a.article_code,'-',1) = $1"
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO nkt_cards (article_id, oktru, tnved)
		SELECT a.id, m.oktru, m.tnved_default
		FROM articles a
		LEFT JOIN nkt_category_map m
		       ON m.code_prefix = split_part(a.article_code,'-',1) AND m.is_active
		WHERE a.is_active AND NOT a.is_material_resale`+filter+`
		ON CONFLICT (article_id) DO NOTHING`, args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// FillQueue — ставит в очередь всё, что ждёт хода автомата (ТЗ §7.5).
//
// DATA_INCOMPLETE не берётся: там ход за инженером, и гонять валидацию по
// кругу каждую ночь значит только раздувать журнал. Такая карточка вернётся
// в очередь сохранением паспорта.
func (s *Service) FillQueue(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO nkt_queue (card_id, operation, priority)
		SELECT c.id,
		       CASE c.status
		         WHEN 'REQUEST_CREATED'  THEN 'SUBMIT'::"NktQueueOp"
		         WHEN 'MODERATION'       THEN 'POLL'::"NktQueueOp"
		         WHEN 'READY_TO_PUBLISH' THEN 'PUBLISH'::"NktQueueOp"
		         ELSE 'VALIDATE'::"NktQueueOp"
		       END,
		       100
		FROM nkt_cards c
		WHERE c.status IN ('NEW','NEED_REGISTRATION','REQUEST_CREATED','MODERATION','READY_TO_PUBLISH','ERROR')
		ON CONFLICT (card_id) DO NOTHING`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// Enqueue — ручная постановка. Приоритет 0: то, что попросил человек,
// проходит раньше ночного пополнения.
func (s *Service) Enqueue(ctx context.Context, cardID, op string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO nkt_queue (card_id, operation, priority, not_before)
		VALUES ($1, $2::"NktQueueOp", 0, now())
		ON CONFLICT (card_id) DO UPDATE
		  SET operation = EXCLUDED.operation, priority = 0, not_before = now(), locked_at = NULL`,
		cardID, op)
	return err
}

// ---------------------------------------------------------------------------
// Очередь
// ---------------------------------------------------------------------------

type queueItem struct {
	ID        string
	CardID    string
	Operation string
}

// claim — забрать пачку заданий. SKIP LOCKED и отметка locked_at — то самое
// исключение параллельной обработки одного объекта из ТЗ §7.5.
func (s *Service) claim(ctx context.Context, limit int) ([]queueItem, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE nkt_queue q SET locked_at = now()
		FROM (
		  SELECT id FROM nkt_queue
		  WHERE not_before <= now()
		    AND (locked_at IS NULL OR locked_at < now() - $2::interval)
		  ORDER BY priority, enqueued_at
		  LIMIT $1
		  FOR UPDATE SKIP LOCKED
		) s
		WHERE q.id = s.id
		RETURNING q.id, q.card_id, q.operation::text`, limit, lockTimeout.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []queueItem
	for rows.Next() {
		var it queueItem
		if err := rows.Scan(&it.ID, &it.CardID, &it.Operation); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// ProcessQueue — один проход фонового задания. Возвращает число обработанных.
func (s *Service) ProcessQueue(ctx context.Context, limit int) (int, error) {
	if !Configured() {
		return 0, nil
	}
	items, err := s.claim(ctx, limit)
	if err != nil {
		return 0, err
	}
	for _, it := range items {
		if err := s.step(ctx, it); err != nil {
			log.Printf("НКТ: шаг %s по карточке %s не удался: %v", it.Operation, it.CardID, err)
		}
	}
	return len(items), nil
}

// step — один шаг конвейера. Что именно делать, решает статус карточки, а не
// операция в очереди: операция — это заявка на действие, а истина о том, где
// объект находится, всегда в его статусе.
func (s *Service) step(ctx context.Context, it queueItem) error {
	row := s.pool.QueryRow(ctx, "SELECT "+cardCols+" "+cardFrom+" WHERE c.id = $1", it.CardID)
	card, err := scanCard(row)
	if err != nil {
		return err
	}
	ctx = withCard(ctx, card.ID)

	switch card.Status {
	case StatusNew, StatusNeedRegistration, StatusError:
		return s.stepValidateAndSubmit(ctx, card)
	case StatusRequestCreated:
		return s.stepModerate(ctx, card)
	case StatusModeration:
		return s.stepPoll(ctx, card)
	case StatusReadyToPublish:
		return s.stepPublish(ctx, card)
	default:
		// DATA_INCOMPLETE, MATCH_REVIEW, REWORK, REJECTED — ход за человеком;
		// HAS_NTIN — конец. Задание снимается, чтобы не крутилось вхолостую
		return s.dequeue(ctx, card.ID)
	}
}

func (s *Service) dequeue(ctx context.Context, cardID string) error {
	_, err := s.pool.Exec(ctx, "DELETE FROM nkt_queue WHERE card_id = $1", cardID)
	return err
}

func (s *Service) reschedule(ctx context.Context, cardID, op string, in time.Duration) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE nkt_queue SET operation = $2::"NktQueueOp", not_before = now() + $3::interval, locked_at = NULL
		WHERE card_id = $1`, cardID, op, in.String())
	return err
}

// fail — обработка отказа НКТ по таблице ТЗ §13.
func (s *Service) fail(ctx context.Context, card Card, op string, err error) error {
	var he *HTTPError
	errors.As(err, &he)

	// 401 — ключ протух или отозван. Ретраить бессмысленно и вредно:
	// каждая попытка уходит в их счётчик. Объект возвращается в очередь
	// с большой задержкой, администратору видно по журналу
	if he != nil && he.Code == 401 {
		if uerr := s.setError(ctx, card.ID, "НКТ отклонил ключ API (401). Проверьте NKT_API_KEY."); uerr != nil {
			return uerr
		}
		return s.dequeue(ctx, card.ID)
	}

	// 409 — дубль на их стороне. Повторно создавать нельзя, нужен разбор
	if he != nil && he.Code == 409 {
		if uerr := s.setError(ctx, card.ID, "НКТ считает заявку дублем (409): "+he.Body); uerr != nil {
			return uerr
		}
		return s.dequeue(ctx, card.ID)
	}

	// 404 по заявке — заявки на их стороне больше нет. Сбрасываем
	// идентификатор и начинаем заново (ТЗ §13)
	if he != nil && he.Code == 404 && card.RequestID != "" {
		if _, uerr := s.pool.Exec(ctx, `
			UPDATE nkt_cards SET request_id = NULL, request_status_raw = NULL,
			   status = 'NEED_REGISTRATION', last_error = $2, updated_at = now()
			WHERE id = $1`, card.ID, "заявки нет в НКТ (404), подаём заново"); uerr != nil {
			return uerr
		}
		return s.reschedule(ctx, card.ID, OpValidate, time.Minute)
	}

	retryable := he == nil || he.Retryable()
	if !retryable {
		if uerr := s.setError(ctx, card.ID, err.Error()); uerr != nil {
			return uerr
		}
		return s.dequeue(ctx, card.ID)
	}

	attempt := card.Attempts
	if attempt >= maxAttempts {
		if uerr := s.setError(ctx, card.ID, "исчерпаны попытки обмена: "+err.Error()); uerr != nil {
			return uerr
		}
		return s.dequeue(ctx, card.ID)
	}
	delay := retryDelays[attempt]
	// 429 — ждём столько, сколько попросили
	if he != nil && he.Code == 429 && he.RetryAfter > 0 {
		delay = he.RetryAfter
	}
	if _, uerr := s.pool.Exec(ctx, `
		UPDATE nkt_cards SET attempts = attempts + 1, last_error = $2,
		   next_retry_at = now() + $3::interval, updated_at = now()
		WHERE id = $1`, card.ID, err.Error(), delay.String()); uerr != nil {
		return uerr
	}
	return s.reschedule(ctx, card.ID, op, delay)
}

func (s *Service) setError(ctx context.Context, cardID, msg string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE nkt_cards SET status = 'ERROR', last_error = $2, next_retry_at = NULL, updated_at = now()
		WHERE id = $1`, cardID, msg)
	return err
}

// ---------------------------------------------------------------------------
// Шаги конвейера
// ---------------------------------------------------------------------------

// stepValidateAndSubmit — проверка паспорта и подача заявки.
//
// Поиска в НКТ перед подачей нет намеренно: периметр — собственное
// производство, карточки там заведомо нет (ТЗ §10.3). Похожие карточки
// ищет сам НКТ при создании заявки, и это лучше нашего поиска: они видят
// весь каталог, а мы — только то, что отдаёт запрос.
func (s *Service) stepValidateAndSubmit(ctx context.Context, card Card) error {
	// Заполненный идентификатор заявки при любых обстоятельствах запрещает
	// создание второй заявки по объекту (ТЗ §13)
	if card.RequestID != "" {
		return s.stepModerate(ctx, card)
	}

	schema, err := s.LoadSchema(ctx, card.Oktru)
	if err != nil {
		return err
	}
	issues := Validate(card.Passport(), schema, s.dictLookup(ctx))
	if len(issues) > 0 {
		if err := s.setIncomplete(ctx, card.ID, issues); err != nil {
			return err
		}
		return s.dequeue(ctx, card.ID)
	}

	body := BuildRequest(card.Passport(), schema, card.AutoPublication)
	hash := PayloadHash(body)

	requestID, err := s.client.CreateRequest(ctx, body)
	if err != nil {
		return s.fail(ctx, card, OpSubmit, err)
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE nkt_cards SET status = 'REQUEST_CREATED', request_id = $2, payload_hash = $3,
		   attempts = 0, last_error = NULL, next_retry_at = NULL,
		   last_sync_at = now(), updated_at = now()
		WHERE id = $1`, card.ID, requestID, hash); err != nil {
		return err
	}
	card.RequestID = requestID
	card.Status = StatusRequestCreated
	return s.stepModerate(ctx, card)
}

func (s *Service) setIncomplete(ctx context.Context, cardID string, issues []ValidationIssue) error {
	parts := make([]string, 0, len(issues))
	for _, i := range issues {
		name := i.Name
		if name == "" {
			name = i.Code
		}
		parts = append(parts, name+" — "+i.Message)
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE nkt_cards SET status = 'DATA_INCOMPLETE', last_error = $2, next_retry_at = NULL, updated_at = now()
		WHERE id = $1`, cardID, strings.Join(parts, "; "))
	return err
}

// stepModerate — отправка созданной заявки на модерацию.
func (s *Service) stepModerate(ctx context.Context, card Card) error {
	if card.RequestID == "" {
		return s.reschedule(ctx, card.ID, OpValidate, time.Minute)
	}
	if err := s.client.SendToModeration(ctx, card.RequestID); err != nil {
		return s.fail(ctx, card, OpSubmit, err)
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE nkt_cards SET status = 'MODERATION', attempts = 0, last_error = NULL,
		   next_retry_at = NULL, last_sync_at = now(), updated_at = now()
		WHERE id = $1`, card.ID); err != nil {
		return err
	}
	return s.reschedule(ctx, card.ID, OpPoll, firstPollDelay)
}

// stepPoll — опрос статуса заявки и раскладка ответа по нашим статусам.
func (s *Service) stepPoll(ctx context.Context, card Card) error {
	if card.RequestID == "" {
		return s.reschedule(ctx, card.ID, OpValidate, time.Minute)
	}
	st, err := s.client.Status(ctx, card.RequestID)
	if err != nil {
		return s.fail(ctx, card, OpPoll, err)
	}
	return s.applyStatus(ctx, card, st)
}

func (s *Service) applyStatus(ctx context.Context, card Card, st *RequestStatus) error {
	comment := strings.TrimSpace(st.Comment)
	if st.Reason != "" {
		if comment != "" {
			comment += "\n"
		}
		comment += st.Reason
	}
	if st.NextAction != nil && st.NextAction.Description != "" {
		comment += "\nДальше: " + st.NextAction.Description
	}
	if st.PhotoModeration != nil && st.PhotoModeration.Comment != "" {
		comment += "\nПо изображениям: " + st.PhotoModeration.Comment
	}
	revision, _ := json.Marshal(st.RevisionDetails)

	switch st.Code {
	case "new", "onModeration", "accepted":
		if _, err := s.pool.Exec(ctx, `
			UPDATE nkt_cards SET status = 'MODERATION', request_status_raw = $2,
			   attempts = 0, last_sync_at = now(), updated_at = now()
			WHERE id = $1`, card.ID, st.Code); err != nil {
			return err
		}
		return s.reschedule(ctx, card.ID, OpPoll, pollDelay)

	case "underRevision":
		// Два разных исхода под одним статусом: либо нашли похожие карточки
		// и решение за менеджером, либо модератор написал замечания.
		// Различает наличие списка дублей
		dups, derr := s.client.Duplicates(ctx, card.RequestID)
		if derr == nil && len(dups) > 0 {
			payload, _ := json.Marshal(dups)
			if _, err := s.pool.Exec(ctx, `
				UPDATE nkt_cards SET status = 'MATCH_REVIEW', request_status_raw = $2,
				   moderator_comment = $3, revision_details = $4, duplicates = $5,
				   attempts = 0, last_sync_at = now(), updated_at = now()
				WHERE id = $1`, card.ID, st.Code, comment, revision, payload); err != nil {
				return err
			}
			return s.dequeue(ctx, card.ID)
		}
		if _, err := s.pool.Exec(ctx, `
			UPDATE nkt_cards SET status = 'REWORK', request_status_raw = $2,
			   moderator_comment = $3, revision_details = $4, duplicates = NULL,
			   attempts = 0, last_sync_at = now(), updated_at = now()
			WHERE id = $1`, card.ID, st.Code, comment, revision); err != nil {
			return err
		}
		return s.dequeue(ctx, card.ID)

	case "rejected", "cancelled":
		if _, err := s.pool.Exec(ctx, `
			UPDATE nkt_cards SET status = 'REJECTED', request_status_raw = $2,
			   moderator_comment = $3, revision_details = $4,
			   last_sync_at = now(), updated_at = now()
			WHERE id = $1`, card.ID, st.Code, comment, revision); err != nil {
			return err
		}
		return s.dequeue(ctx, card.ID)

	case "readyToPublish":
		if _, err := s.pool.Exec(ctx, `
			UPDATE nkt_cards SET status = 'READY_TO_PUBLISH', request_status_raw = $2,
			   moderator_comment = $3, attempts = 0, last_sync_at = now(), updated_at = now()
			WHERE id = $1`, card.ID, st.Code, comment); err != nil {
			return err
		}
		return s.reschedule(ctx, card.ID, OpPublish, 0)

	case "completed", "existingProductSelected":
		source := "REQUEST"
		if st.Code == "existingProductSelected" {
			// Карточку не создавали — взяли существующую при разборе дублей
			source = "MANUAL"
		}
		return s.assignNtin(ctx, card, st.NtinCode, st.ProductURL, source, st.Code)

	default:
		// Незнакомый код статуса — не повод считать, что всё хорошо:
		// сырой код сохраняется, опрос продолжается
		if _, err := s.pool.Exec(ctx, `
			UPDATE nkt_cards SET request_status_raw = $2, moderator_comment = $3,
			   last_sync_at = now(), updated_at = now()
			WHERE id = $1`, card.ID, st.Code, comment); err != nil {
			return err
		}
		return s.reschedule(ctx, card.ID, OpPoll, pollDelay)
	}
}

// assignNtin — целевое состояние. NTIN уходит дальше по штатному обмену:
// в 1С, а оттуда на витрину Битрикса (ТЗ §10.8). Обратный обмен по NTIN не
// предусмотрен — источником значения всегда остаёмся мы.
func (s *Service) assignNtin(ctx context.Context, card Card, ntin, productURL, source, raw string) error {
	if ntin == "" {
		// Статус говорит «выполнено», а кода нет — это их сбой, не наш успех
		return s.fail(ctx, card, OpPoll, fmt.Errorf("НКТ вернул статус %s без NTIN", raw))
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		UPDATE nkt_cards SET status = 'HAS_NTIN', ntin = $2, product_url = $3,
		   ntin_source = $4::"NktNtinSource", request_status_raw = $5,
		   published_at = coalesce(published_at, now()), attempts = 0, last_error = NULL,
		   next_retry_at = NULL, last_sync_at = now(), updated_at = now()
		WHERE id = $1`, card.ID, ntin, productURL, source, raw); err != nil {
		return err
	}
	if err := integration.Enqueue(ctx, tx, integration.Message{
		Type:       "nkt.ntin.assigned",
		EntityType: "article",
		EntityID:   card.ArticleID,
		Payload: map[string]interface{}{
			"articleCode": card.ArticleCode,
			"ntin":        ntin,
			"gtin":        card.Gtin,
			"source":      source,
			"productUrl":  productURL,
		},
	}); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM nkt_queue WHERE card_id = $1", card.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) stepPublish(ctx context.Context, card Card) error {
	if card.RequestID == "" {
		return s.reschedule(ctx, card.ID, OpValidate, time.Minute)
	}
	if err := s.client.Publish(ctx, card.RequestID); err != nil {
		return s.fail(ctx, card, OpPublish, err)
	}
	// Публикация не отдаёт NTIN — его приносит следующий опрос статуса
	return s.reschedule(ctx, card.ID, OpPoll, time.Minute)
}

// ---------------------------------------------------------------------------
// Действия менеджера
// ---------------------------------------------------------------------------

// SavePassport — сохранение паспорта инженером. Штрихкод нормализуется по
// GS1: невалидный считается отсутствующим (ТЗ §10.2).
func (s *Service) SavePassport(ctx context.Context, articleID string, p Passport) (Card, error) {
	if err := s.ensureCard(ctx, articleID); err != nil {
		return Card{}, err
	}
	gtin, valid := "", false
	if strings.TrimSpace(p.Gtin) != "" {
		gtin, valid = NormalizeGTIN(p.Gtin)
	}
	attrs, err := json.Marshal(nonEmpty(p.Attributes))
	if err != nil {
		return Card{}, err
	}
	images, err := json.Marshal(p.Images)
	if err != nil {
		return Card{}, err
	}

	// Паспорт правится и на доработке, и после отказа — статус тогда
	// возвращается в начало конвейера, чтобы правка ушла в НКТ. Карточку с
	// уже присвоенным NTIN правка паспорта с места не сдвигает: там
	// изменение — это отдельная заявка на редактирование
	if _, err := s.pool.Exec(ctx, `
		UPDATE nkt_cards SET oktru = nullif($2,''), tnved = nullif($3,''),
		   gtin = nullif($4,''), gtin_valid = $5,
		   name_ru = nullif($6,''), name_kk = nullif($7,''), brand = nullif($8,''),
		   attributes = $9, images = $10,
		   status = CASE WHEN status IN ('DATA_INCOMPLETE','ERROR','NEW') THEN 'NEW'::"NktStatus" ELSE status END,
		   updated_at = now()
		WHERE article_id = $1`,
		articleID, strings.TrimSpace(p.Oktru), strings.TrimSpace(p.Tnved),
		gtin, valid, strings.TrimSpace(p.NameRu), strings.TrimSpace(p.NameKk),
		strings.TrimSpace(p.Brand), attrs, images); err != nil {
		return Card{}, err
	}
	return s.GetCard(ctx, articleID)
}

func nonEmpty(m map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		if strings.TrimSpace(v) != "" {
			out[k] = strings.TrimSpace(v)
		}
	}
	return out
}

// Resubmit — цикл доработки (ТЗ §10.7): тело пересобирается, уходит в
// обновление заявки и снова на модерацию.
//
// Если тело не изменилось, отправка не выполняется: модератор увидит ровно
// то же самое и вернёт с тем же замечанием, а счётчик попыток вырастет.
func (s *Service) Resubmit(ctx context.Context, articleID string) (Card, error) {
	card, err := s.GetCard(ctx, articleID)
	if err != nil {
		return Card{}, err
	}
	if card.RequestID == "" {
		// Заявки ещё нет — обычная подача
		if err := s.Enqueue(ctx, card.ID, OpValidate); err != nil {
			return Card{}, err
		}
		return s.GetCard(ctx, articleID)
	}
	ctx = withCard(ctx, card.ID)

	schema, err := s.LoadSchema(ctx, card.Oktru)
	if err != nil {
		return Card{}, err
	}
	if issues := Validate(card.Passport(), schema, s.dictLookup(ctx)); len(issues) > 0 {
		if err := s.setIncomplete(ctx, card.ID, issues); err != nil {
			return Card{}, err
		}
		return s.GetCard(ctx, articleID)
	}

	body := BuildRequest(card.Passport(), schema, card.AutoPublication)
	hash := PayloadHash(body)
	var stored *string
	if err := s.pool.QueryRow(ctx, "SELECT payload_hash FROM nkt_cards WHERE id = $1", card.ID).Scan(&stored); err != nil {
		return Card{}, err
	}
	if stored != nil && *stored == hash {
		return Card{}, &common.APIError400{
			Code:    "NKT_PAYLOAD_UNCHANGED",
			Message: "Заявка не изменилась с прошлой отправки — модератор вернёт её с тем же замечанием. Поправьте паспорт.",
		}
	}

	if err := s.client.UpdateRequest(ctx, card.RequestID, body); err != nil {
		return Card{}, err
	}
	if err := s.client.SendToModeration(ctx, card.RequestID); err != nil {
		return Card{}, err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE nkt_cards SET status = 'MODERATION', payload_hash = $2, attempts = attempts + 1,
		   moderator_comment = NULL, revision_details = NULL, last_error = NULL,
		   last_sync_at = now(), updated_at = now()
		WHERE id = $1`, card.ID, hash); err != nil {
		return Card{}, err
	}
	if err := s.reschedule(ctx, card.ID, OpPoll, firstPollDelay); err != nil {
		// Карточки могло не быть в очереди — ставим заново
		if err := s.Enqueue(ctx, card.ID, OpPoll); err != nil {
			return Card{}, err
		}
	}
	return s.GetCard(ctx, articleID)
}

// DecideDuplicate — решение менеджера по найденным НКТ дублям.
//
// decision = USE_EXISTING означает «это тот же товар»: НКТ закрывает заявку
// и отдаёт NTIN выбранной карточки. Автоматически такое решение не
// принимается ни при какой схожести (ТЗ §10.4) — одинаково названные товары
// разных производителей это разные карточки, а чужой NTIN даёт ошибку при
// пробитии чека и маркировке.
func (s *Service) DecideDuplicate(ctx context.Context, articleID, decision, ntin string) (Card, error) {
	card, err := s.GetCard(ctx, articleID)
	if err != nil {
		return Card{}, err
	}
	if card.RequestID == "" {
		return Card{}, &common.APIError400{Code: "NKT_NO_REQUEST", Message: "По изделию нет заявки в НКТ"}
	}
	if decision != "CONTINUE" && decision != "USE_EXISTING" {
		return Card{}, &common.APIError400{Code: "NKT_BAD_DECISION", Message: "Решение может быть CONTINUE или USE_EXISTING"}
	}
	if decision == "USE_EXISTING" && ntin == "" {
		return Card{}, &common.APIError400{Code: "NKT_NTIN_REQUIRED", Message: "Для выбора существующей карточки нужен её NTIN"}
	}
	ctx = withCard(ctx, card.ID)

	if err := s.client.DuplicateDecision(ctx, card.RequestID, decision, ntin); err != nil {
		return Card{}, err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE nkt_cards SET status = 'MODERATION', duplicates = NULL,
		   moderator_comment = NULL, last_sync_at = now(), updated_at = now()
		WHERE id = $1`, card.ID); err != nil {
		return Card{}, err
	}
	// Решение отражается в статусе заявки не мгновенно — забираем его опросом
	if err := s.Enqueue(ctx, card.ID, OpPoll); err != nil {
		return Card{}, err
	}
	if err := s.reschedule(ctx, card.ID, OpPoll, time.Minute); err != nil {
		return Card{}, err
	}
	return s.GetCard(ctx, articleID)
}

// CancelRequest — отзыв заявки.
func (s *Service) CancelRequest(ctx context.Context, articleID string) (Card, error) {
	card, err := s.GetCard(ctx, articleID)
	if err != nil {
		return Card{}, err
	}
	if card.RequestID == "" {
		return Card{}, &common.APIError400{Code: "NKT_NO_REQUEST", Message: "По изделию нет заявки в НКТ"}
	}
	ctx = withCard(ctx, card.ID)
	if err := s.client.Cancel(ctx, card.RequestID); err != nil {
		return Card{}, err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE nkt_cards SET status = 'REJECTED', request_status_raw = 'cancelled',
		   last_sync_at = now(), updated_at = now()
		WHERE id = $1`, card.ID); err != nil {
		return Card{}, err
	}
	if err := s.dequeue(ctx, card.ID); err != nil {
		return Card{}, err
	}
	return s.GetCard(ctx, articleID)
}

// ---------------------------------------------------------------------------
// Схема и справочники
// ---------------------------------------------------------------------------

// LoadSchema — атрибуты категории: базовые (общие для всех, oktru = ”)
// плюс расширенные этой ОКТРУ.
func (s *Service) LoadSchema(ctx context.Context, oktru string) ([]SchemaAttr, error) {
	if strings.TrimSpace(oktru) == "" {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT code, attr_group::text, name_ru, coalesce(name_kk,''), coalesce(description_ru,''),
		       data_type, is_required, coalesce(dictionary_code,''), coalesce(pattern,''),
		       coalesce(max_length,0), coalesce(min_value,''), coalesce(max_value,''), attribute_order
		FROM nkt_attributes
		WHERE oktru IN ('', $1)
		ORDER BY attr_group, attribute_order, code`, oktru)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SchemaAttr
	for rows.Next() {
		var a SchemaAttr
		if err := rows.Scan(&a.Code, &a.Group, &a.NameRu, &a.NameKk, &a.DescriptionRu,
			&a.DataType, &a.IsRequired, &a.DictionaryCode, &a.Pattern,
			&a.MaxLength, &a.MinValue, &a.MaxValue, &a.Order); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ValidateCard — проверка паспорта без отправки. Инженеру нужно видеть,
// чего не хватает, до подачи заявки, а не через неделю от модератора.
func (s *Service) ValidateCard(ctx context.Context, card Card) ([]ValidationIssue, error) {
	schema, err := s.LoadSchema(ctx, card.Oktru)
	if err != nil {
		return nil, err
	}
	issues := Validate(card.Passport(), schema, s.dictLookup(ctx))
	if issues == nil {
		issues = []ValidationIssue{}
	}
	return issues, nil
}

// dictLookup — проверка значения по кэшу справочника. Кэш пуст (справочники
// ещё не синхронизированы) — проверка не выполняется: мы не вправе объявить
// значение неверным, не имея с чем сравнивать.
func (s *Service) dictLookup(ctx context.Context) DictLookup {
	return func(dictionaryCode, value string) bool {
		var total, hit int
		err := s.pool.QueryRow(ctx, `
			SELECT count(*), count(*) FILTER (WHERE value_id = $2)
			FROM nkt_dictionary_values WHERE dictionary_code = $1`, dictionaryCode, value).Scan(&total, &hit)
		if err != nil || total == 0 {
			return true
		}
		return hit > 0
	}
}

// SyncSchema — ежесуточное обновление схемы и справочников (ТЗ §12.3).
//
// В коде не должно быть литеральных списков единиц измерения, стран, типов
// упаковки и прочих справочных значений — только чтение из этих таблиц.
func (s *Service) SyncSchema(ctx context.Context) error {
	if !Configured() {
		return nil
	}
	base, err := s.client.BaseAttributes(ctx)
	if err != nil {
		return fmt.Errorf("базовые атрибуты: %w", err)
	}
	if err := s.saveAttributes(ctx, "", GroupBase, base); err != nil {
		return err
	}

	codes, err := s.activeOktru(ctx)
	if err != nil {
		return err
	}
	for _, oktru := range codes {
		main, additional, err := s.client.GovAttributes(ctx, oktru)
		if err != nil {
			log.Printf("НКТ: схема категории %s не обновлена: %v", oktru, err)
			continue
		}
		if err := s.saveAttributes(ctx, oktru, GroupMainExt, main); err != nil {
			return err
		}
		if err := s.saveAttributes(ctx, oktru, GroupAdditionalExt, additional); err != nil {
			return err
		}
	}
	return s.syncDictionaries(ctx)
}

// activeOktru — категории, которые нас касаются: из справочника серий и из
// карточек, где инженер уточнил категорию вручную.
func (s *Service) activeOktru(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT oktru FROM (
		  SELECT oktru FROM nkt_category_map WHERE is_active
		  UNION
		  SELECT oktru FROM nkt_cards WHERE oktru IS NOT NULL
		) t WHERE oktru <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Service) saveAttributes(ctx context.Context, oktru, group string, attrs []Attribute) error {
	for _, a := range attrs {
		if a.Code == "" {
			continue
		}
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO nkt_attributes (oktru, code, attr_group, name_ru, name_kk, description_ru,
			   data_type, is_required, dictionary_code, pattern, max_length, min_value, max_value,
			   attribute_order, synced_at)
			VALUES ($1,$2,$3::"NktAttrGroup",$4,nullif($5,''),nullif($6,''),$7,$8,nullif($9,''),nullif($10,''),
			   nullif($11,0),nullif($12,''),nullif($13,''),$14, now())
			ON CONFLICT (oktru, code) DO UPDATE SET
			   attr_group = EXCLUDED.attr_group, name_ru = EXCLUDED.name_ru, name_kk = EXCLUDED.name_kk,
			   description_ru = EXCLUDED.description_ru, data_type = EXCLUDED.data_type,
			   is_required = EXCLUDED.is_required, dictionary_code = EXCLUDED.dictionary_code,
			   pattern = EXCLUDED.pattern, max_length = EXCLUDED.max_length,
			   min_value = EXCLUDED.min_value, max_value = EXCLUDED.max_value,
			   attribute_order = EXCLUDED.attribute_order, synced_at = now()`,
			oktru, a.Code, group, a.NameRu, a.NameKk, a.DescriptionRu,
			a.DataType, a.IsRequired, a.DictionaryCode, a.Pattern, a.MaxLength,
			a.MinValue, a.MaxValue, a.AttributeOrder); err != nil {
			return err
		}
	}
	return nil
}

// syncDictionaries — значения справочников, на которые ссылается схема.
func (s *Service) syncDictionaries(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT dictionary_code FROM nkt_attributes
		WHERE dictionary_code IS NOT NULL AND dictionary_code <> ''`)
	if err != nil {
		return err
	}
	var codes []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			rows.Close()
			return err
		}
		codes = append(codes, c)
	}
	rows.Close()

	for _, code := range codes {
		// Справочник ТН ВЭД и классификатор ОКТРУ — десятки тысяч строк.
		// Тянем страницами и с потолком: полный классификатор нам не нужен,
		// проверяются только те значения, которые кто-то ввёл
		const pageSize = 500
		const maxPages = 40
		for page := 0; page < maxPages; page++ {
			items, totalPages, err := s.client.DictionaryItems(ctx, code, page, pageSize)
			if err != nil {
				log.Printf("НКТ: справочник %s не обновлён: %v", code, err)
				break
			}
			for _, it := range items {
				if it.Code == "" {
					continue
				}
				if _, err := s.pool.Exec(ctx, `
					INSERT INTO nkt_dictionary_values (dictionary_code, value_id, name_ru, name_kk, synced_at)
					VALUES ($1,$2,$3,nullif($4,''), now())
					ON CONFLICT (dictionary_code, value_id) DO UPDATE SET
					   name_ru = EXCLUDED.name_ru, name_kk = EXCLUDED.name_kk, synced_at = now()`,
					code, it.Code, it.NameRu, it.NameKk); err != nil {
					return err
				}
			}
			if page+1 >= totalPages || len(items) == 0 {
				break
			}
		}
	}
	return nil
}

// CleanupLog — журнал хранится 6 месяцев (ТЗ §14).
func (s *Service) CleanupLog(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, "DELETE FROM nkt_log WHERE created_at < now() - interval '6 months'")
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
