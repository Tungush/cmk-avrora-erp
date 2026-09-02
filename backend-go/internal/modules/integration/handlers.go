// Перенос integration.controller.ts — HTTP-поверхность обмена с 1С: вебхук
// (HMAC-подпись вместо JWT — у внешней системы нет пользователя,
// 04_ROLES_PERMISSIONS.md §вебхуки), журнал обмена, приём заказов/закупа
// GET-запросами к HTTP-сервисам 1С (ТЗ v10), outbox/inbox вручную.
// Имя пакета integrationapi: «integration» занято internal/integration.
package integrationapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/integration"
	"cmk-avrora-erp/backend-go/internal/onec"
)

// knownInboxTypes — типы, которые принимаем от 1С (08_INTEGRATION_1C.md §4)
var knownInboxTypes = []string{
	"nomenclature.created",
	"receipt.posted",
	"stock.snapshot",
	"payment.posted",
	"order.status_changed",
	"purchase_order.posted",
}

type Handler struct {
	pool   *pgxpool.Pool
	client *onec.Client
}

func New(pool *pgxpool.Pool) *Handler {
	return &Handler{pool: pool, client: onec.NewClient()}
}

// dbErr — ошибка чтения/записи БД: как в остальных модулях (код и статус те
// же, что у Nest; текст заглушки — принятое расхождение).
func dbErr(c *gin.Context, err error) {
	common.DebugLog(err)
	common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
}

// onecErr — ошибки обмена с 1С: типизированные → свой статус; «адрес 1С не
// задан» → 503 ONEC_NOT_CONFIGURED (ServiceUnavailableException оригинала);
// остальное (1С недоступна, ответила 502, …) у Nest — необработанный Error →
// 500 с ТЕКСТОМ ошибки, а не с заглушкой: этот текст админ читает на экране
// обмена, чтобы понять, что именно сломалось.
func onecErr(c *gin.Context, err error) {
	switch e := err.(type) {
	case *common.APIError404:
		common.Fail(c, http.StatusNotFound, e.Code, e.Message)
		return
	case *common.APIError400:
		common.Fail(c, http.StatusBadRequest, e.Code, e.Message)
		return
	case *common.APIError409:
		common.Fail(c, http.StatusConflict, e.Code, e.Message)
		return
	case *common.APIError403:
		common.Fail(c, http.StatusForbidden, e.Code, e.Message)
		return
	case *common.APIError503:
		common.Fail(c, http.StatusServiceUnavailable, e.Code, e.Message)
		return
	}
	if errors.Is(err, onec.NotConfiguredError{}) {
		common.Fail(c, http.StatusServiceUnavailable, onec.NotConfiguredCode, onec.NotConfiguredMessage)
		return
	}
	common.DebugLog(err)
	common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error())
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// ---------- Вебхук 1С ----------

type receiveOut struct {
	Accepted  bool           `json:"accepted"`
	Duplicate bool           `json:"duplicate"`
	MessageID string         `json:"messageId"`
	Status    string         `json:"status,omitempty"`
	Result    *ProcessResult `json:"result,omitempty"`
}

// Receive — POST /integrations/1c/webhook/:type (@Public: HMAC, идемпотентно).
func (h *Handler) Receive(c *gin.Context) {
	ctx := c.Request.Context()
	typ := c.Param("type")

	// body-parser у Nest (main.ts: rawBody: true; Express 5 / body-parser 2),
	// сверено с живым Nest: разбираются только application/json и
	// application/x-www-form-urlencoded — тогда req.rawBody это байты как
	// пришли (verify зовётся и на пустом теле: rawBody = "", body = {}), а
	// body — разобранный объект. Другой Content-Type никто не разбирает →
	// req.body = undefined: JSON.stringify(undefined) роняет
	// createHmac().update() с ERR_INVALID_ARG_TYPE — «ошибка с кодом» для
	// фильтра → 500 с общим текстом (пустая подпись отсекается раньше → 401).
	// Невалидный JSON падает ещё в middleware, ДО проверки типа: SyntaxError
	// body-parser → 400 с code "Bad Request".
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error())
		return
	}
	var body interface{}
	bodyUndefined := false
	mediaType, _, _ := mime.ParseMediaType(c.GetHeader("Content-Type"))
	switch {
	case mediaType == "application/json" && len(raw) > 0:
		if err := json.Unmarshal(raw, &body); err != nil {
			common.Fail(c, http.StatusBadRequest, "Bad Request", err.Error())
			return
		}
		switch body.(type) {
		case map[string]interface{}, []interface{}:
		default:
			// strict-режим body-parser: на верхнем уровне только объект или массив
			// текст V8: первый непробельный символ, тело — как пришло (с пробелами)
			first := string(bytes.TrimSpace(raw)[:1])
			common.Fail(c, http.StatusBadRequest, "Bad Request",
				"Unexpected token '"+first+"', \""+string(raw)+"\" is not valid JSON")
			return
		}
	case mediaType == "application/json":
		body = map[string]interface{}{}
	case mediaType == "application/x-www-form-urlencoded":
		body = parseForm(raw)
	default:
		bodyUndefined = true
	}

	if !containsString(knownInboxTypes, typ) {
		common.Fail(c, http.StatusBadRequest, "UNKNOWN_TYPE",
			"Неизвестный тип: "+typ+". Допустимо: "+strings.Join(knownInboxTypes, ", "))
		return
	}

	signature := c.GetHeader("X-Signature")
	if signature == "" {
		common.Fail(c, http.StatusUnauthorized, "INVALID_SIGNATURE", "Подпись не совпала")
		return
	}
	if bodyUndefined {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "An unexpected internal error occurred")
		return
	}
	if !integration.VerifySignature(raw, signature) {
		common.Fail(c, http.StatusUnauthorized, "INVALID_SIGNATURE", "Подпись не совпала")
		return
	}

	// Ключ идемпотентности — GUID документа 1С: повторная доставка не применится дважды.
	// String(body.externalKey ?? body.guid ?? body.documentNumber ?? '')
	externalKey := ""
	if obj, ok := body.(map[string]interface{}); ok {
		if v, found := coalesce(obj, "externalKey", "guid", "documentNumber"); found {
			externalKey = jsString(v)
		}
	}
	if externalKey == "" {
		common.Fail(c, http.StatusBadRequest, "MISSING_KEY", "Нужен externalKey (GUID документа 1С) для идемпотентности")
		return
	}

	// Prisma пишет в payload разобранный body (объект), не сырые байты
	payload, err := json.Marshal(body)
	if err != nil {
		dbErr(c, err)
		return
	}
	msg, duplicate, err := integration.Receive(ctx, h.pool, typ, externalKey, payload, "1C")
	if err != nil {
		dbErr(c, err)
		return
	}
	if duplicate {
		c.JSON(http.StatusCreated, receiveOut{Accepted: true, Duplicate: true, MessageID: msg.ID, Status: msg.Status})
		return
	}

	// Обрабатываем сразу; при ошибке сообщение останется в очереди на ретрай
	result, err := ProcessPending(ctx, h.pool, 5)
	if err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, receiveOut{Accepted: true, Duplicate: false, MessageID: msg.ID, Result: &result})
}

// parseForm — bodyParser.urlencoded({ extended: true }) в первом приближении:
// ключ → строка, повторный ключ → массив строк (как qs); вложенные скобки
// не разбираются. 1С шлёт JSON — ветка нужна только для тождества с Nest.
func parseForm(raw []byte) map[string]interface{} {
	out := map[string]interface{}{}
	values, _ := url.ParseQuery(string(raw))
	for k, vs := range values {
		if len(vs) == 1 {
			out[k] = vs[0]
			continue
		}
		arr := make([]interface{}, len(vs))
		for i, v := range vs {
			arr[i] = v
		}
		out[k] = arr
	}
	return out
}

// coalesce — цепочка `a ?? b ?? c`: пропускает только null/undefined
// (отсутствующий ключ или JSON null), НЕ пустую строку, 0 или false.
func coalesce(obj map[string]interface{}, keys ...string) (interface{}, bool) {
	for _, k := range keys {
		if v, ok := obj[k]; ok && v != nil {
			return v, true
		}
	}
	return nil, false
}

// ---------- Журнал обмена ----------

type statusPull struct {
	Configured   bool    `json:"configured"`
	BaseURL      *string `json:"baseUrl"`
	SyncedOrders int     `json:"syncedOrders"`
	TotalOrders  int     `json:"totalOrders"`
}

type statusOut struct {
	Configured bool           `json:"configured"`
	Endpoint   *string        `json:"endpoint"`
	Pull       statusPull     `json:"pull"`
	Outbox     map[string]int `json:"outbox"`
	Inbox      map[string]int `json:"inbox"`
}

// countByStatus — groupBy({ by: ['status'], _count }) → { STATUS: n } ({} когда пусто).
func (h *Handler) countByStatus(ctx context.Context, table string) (map[string]int, error) {
	rows, err := h.pool.Query(ctx, "SELECT status::text, count(*) FROM "+table+" GROUP BY status")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			return nil, err
		}
		out[status] = n
	}
	return out, rows.Err()
}

// Status — GET /integrations/status (admin, director).
func (h *Handler) Status(c *gin.Context) {
	ctx := c.Request.Context()
	outbox, err := h.countByStatus(ctx, "outbox_messages")
	if err != nil {
		dbErr(c, err)
		return
	}
	inbox, err := h.countByStatus(ctx, "inbox_messages")
	if err != nil {
		dbErr(c, err)
		return
	}
	var syncedOrders, totalOrders int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM orders WHERE onec_synced_at IS NOT NULL").Scan(&syncedOrders); err != nil {
		dbErr(c, err)
		return
	}
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM orders").Scan(&totalOrders); err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusOK, statusOut{
		Configured: integration.URL() != "",
		Endpoint:   nullable(integration.URL()),
		// Приём данных: GET-запросы к HTTP-сервисам 1С
		Pull: statusPull{
			Configured:   onec.Configured(),
			BaseURL:      nullable(onec.BaseURL()),
			SyncedOrders: syncedOrders,
			TotalOrders:  totalOrders,
		},
		Outbox: outbox,
		Inbox:  inbox,
	})
}

// jsTake — Number(query.limit) || 50: пусто / не число / 0 → 50.
func jsTake(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 50
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || f == 0 {
		return 50
	}
	return int(f)
}

// Messages — GET /integrations/messages?direction=&status=&limit= (admin, director).
func (h *Handler) Messages(c *gin.Context) {
	ctx := c.Request.Context()
	take := jsTake(c.Query("limit"))
	status := c.Query("status")
	direction := c.Query("direction")

	outbox := []gin.H{}
	if direction != "in" {
		sql := "SELECT " + integration.OutboxCols + " FROM outbox_messages"
		args := []interface{}{}
		if status != "" {
			sql += " WHERE status = $1"
			args = append(args, status)
		}
		sql += " ORDER BY created_at DESC LIMIT $" + strconv.Itoa(len(args)+1)
		args = append(args, take)
		rows, err := h.pool.Query(ctx, sql, args...)
		if err != nil {
			dbErr(c, err)
			return
		}
		for rows.Next() {
			m, err := integration.ScanOutbox(rows)
			if err != nil {
				rows.Close()
				dbErr(c, err)
				return
			}
			outbox = append(outbox, integration.OutboxJSON(m))
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			dbErr(c, err)
			return
		}
	}

	inbox := []gin.H{}
	if direction != "out" {
		sql := "SELECT " + integration.InboxCols + " FROM inbox_messages"
		args := []interface{}{}
		if status != "" {
			sql += " WHERE status = $1"
			args = append(args, status)
		}
		sql += " ORDER BY received_at DESC LIMIT $" + strconv.Itoa(len(args)+1)
		args = append(args, take)
		rows, err := h.pool.Query(ctx, sql, args...)
		if err != nil {
			dbErr(c, err)
			return
		}
		for rows.Next() {
			m, err := integration.ScanInbox(rows)
			if err != nil {
				rows.Close()
				dbErr(c, err)
				return
			}
			inbox = append(inbox, integration.InboxJSON(m))
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			dbErr(c, err)
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"outbox": outbox, "inbox": inbox})
}

// ---------- Приём из 1С (GET-запросы, ТЗ v10) ----------

// readJSONBody — @Body() у Nest: application/json с непустым телом
// разбирается, иначе body = {} (все поля по умолчанию); невалидный JSON —
// ошибка body-parser → 500.
func readJSONBody(c *gin.Context, dst interface{}) bool {
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error())
		return false
	}
	mediaType, _, _ := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if mediaType != "application/json" || len(raw) == 0 {
		return true
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", err.Error())
		return false
	}
	return true
}

// decodeParam — decodeURIComponent(param) поверх уже раскодированного
// роутером значения (Express тоже декодирует params сам — у оригинала
// декодирование двойное); URIError у Nest → 500.
func decodeParam(c *gin.Context, raw string) (string, bool) {
	s, err := url.PathUnescape(raw)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "URI malformed")
		return "", false
	}
	return s, true
}

// SyncOrders — POST /integrations/1c/sync/orders (admin, sales_manager, director).
func (h *Handler) SyncOrders(c *gin.Context) {
	var body struct {
		Limit      *float64 `json:"limit"`
		OnlyActive *bool    `json:"onlyActive"`
	}
	if !readJSONBody(c, &body) {
		return
	}
	limit := 50 // body?.limit ?? 50
	if body.Limit != nil {
		limit = int(*body.Limit)
	}
	report, err := onec.SyncOrders(c.Request.Context(), h.pool, h.client, limit, body.OnlyActive)
	if err != nil {
		onecErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, report)
}

// SyncOrder — POST /integrations/1c/sync/order/:orderNumber (admin, sales_manager, director).
func (h *Handler) SyncOrder(c *gin.Context) {
	orderNumber, ok := decodeParam(c, c.Param("orderNumber"))
	if !ok {
		return
	}
	report := onec.EmptyReport()
	report.Requested = 1
	if _, err := onec.SyncClientOrder(c.Request.Context(), h.pool, h.client, orderNumber, report); err != nil {
		onecErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, report)
}

// SyncProcurement — POST /integrations/1c/sync/procurement/:orderNumber (admin, procurement, director).
func (h *Handler) SyncProcurement(c *gin.Context) {
	orderNumber, ok := decodeParam(c, c.Param("orderNumber"))
	if !ok {
		return
	}
	result, err := onec.SyncProcurementForOrder(c.Request.Context(), h.pool, h.client, orderNumber)
	if err != nil {
		onecErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, result)
}

type pingNoOrderOut struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

type pingOut struct {
	OK          bool   `json:"ok"`
	Message     string `json:"message"`
	OrderNumber string `json:"orderNumber"`
}

// Ping — GET /integrations/1c/ping?orderNumber= (admin, director).
func (h *Handler) Ping(c *gin.Context) {
	ctx := c.Request.Context()
	orderNumber := c.Query("orderNumber")
	if orderNumber == "" {
		// findFirst без orderBy — без ORDER BY, LIMIT 1: сверено с живым Nest
		// (он отдаёт Т7АА-000247 — физический порядок; ORDER BY id дал бы другой заказ)
		err := h.pool.QueryRow(ctx, "SELECT order_number FROM orders WHERE NOT (order_number LIKE '%ROW%') LIMIT 1").Scan(&orderNumber)
		if err != nil && err != pgx.ErrNoRows {
			dbErr(c, err)
			return
		}
	}
	if orderNumber == "" {
		c.JSON(http.StatusOK, pingNoOrderOut{OK: false, Message: "Нет заказа для проверки"})
		return
	}
	ok, message := h.client.Ping(ctx, orderNumber)
	c.JSON(http.StatusOK, pingOut{OK: ok, Message: message, OrderNumber: orderNumber})
}

// ---------- Outbox / inbox вручную ----------

// Flush — POST /integrations/outbox/flush (admin).
func (h *Handler) Flush(c *gin.Context) {
	result, err := integration.FlushOutbox(c.Request.Context(), h.pool, 50)
	if err != nil {
		onecErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, result)
}

// Process — POST /integrations/inbox/process (admin).
func (h *Handler) Process(c *gin.Context) {
	result, err := ProcessPending(c.Request.Context(), h.pool, 50)
	if err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, result)
}

type retryOut struct {
	Direction string `json:"direction"`
	Requeued  bool   `json:"requeued"`
}

// Retry — POST /integrations/messages/:id/retry (admin): сброс счётчика попыток.
func (h *Handler) Retry(c *gin.Context) {
	ctx := c.Request.Context()
	id := c.Param("id")

	tag, err := h.pool.Exec(ctx, `UPDATE outbox_messages
		SET status = 'PENDING', attempts = 0, next_retry_at = NULL, last_error = NULL WHERE id = $1`, id)
	if err != nil {
		dbErr(c, err)
		return
	}
	if tag.RowsAffected() > 0 {
		c.JSON(http.StatusCreated, retryOut{Direction: "out", Requeued: true})
		return
	}

	tag, err = h.pool.Exec(ctx, `UPDATE inbox_messages
		SET status = 'PENDING', attempts = 0, error = NULL WHERE id = $1`, id)
	if err != nil {
		dbErr(c, err)
		return
	}
	if tag.RowsAffected() > 0 {
		c.JSON(http.StatusCreated, retryOut{Direction: "in", Requeued: true})
		return
	}
	common.Fail(c, http.StatusNotFound, "NOT_FOUND", "Сообщение не найдено")
}
