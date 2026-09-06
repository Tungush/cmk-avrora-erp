// Package nkt (модуль HTTP) — рабочее место по Национальному каталогу
// товаров: реестр изделий с их положением в конвейере, паспорт для
// инженера, действия менеджера по доработке и дублям, журнал обмена.
//
// Все обращения к самому НКТ идут из фоновых заданий, а не отсюда
// (ТЗ §14): экран ставит задание в очередь и показывает состояние.
// Исключения — три действия человека, где ожидание оправдано и ответ
// нужен сразу: повторная отправка, решение по дублям и отзыв заявки.
package nkt

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/common"
	nktpkg "cmk-avrora-erp/backend-go/internal/nkt"
)

type Handler struct {
	pool *pgxpool.Pool
	svc  *nktpkg.Service
}

func New(pool *pgxpool.Pool) *Handler {
	return &Handler{pool: pool, svc: nktpkg.NewService(pool)}
}

// Service — фоновым заданиям в main.go нужен тот же экземпляр сервиса.
func (h *Handler) Service() *nktpkg.Service { return h.svc }

// respond — ошибки сервиса раскладываются в тот же конверт, что и везде.
func respond(c *gin.Context, err error) {
	var e400 *common.APIError400
	if errors.As(err, &e400) {
		common.Fail(c, http.StatusBadRequest, e400.Code, e400.Message)
		return
	}
	var e404 *common.APIError404
	if errors.As(err, &e404) {
		common.Fail(c, http.StatusNotFound, e404.Code, e404.Message)
		return
	}
	var he *nktpkg.HTTPError
	if errors.As(err, &he) {
		// Отказ НКТ — это не наша внутренняя ошибка: человеку нужно видеть,
		// что именно сказал каталог, иначе разбирать нечего
		common.Fail(c, http.StatusBadGateway, "NKT_UPSTREAM", he.Error())
		return
	}
	common.DebugLog(err)
	common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
}

// ---------------------------------------------------------------------------
// Реестр
// ---------------------------------------------------------------------------

// Cards — GET /nkt/cards?status=&codePrefix=&search=&page=&pageSize=
//
// Реестр строится по изделиям, а не по заведённым карточкам: пока ночное
// задание не прошло, у нового изделия строки в nkt_cards нет, но в реестре
// оно должно быть видно — со статусом NEW и пустым паспортом.
func (h *Handler) Cards(c *gin.Context) {
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(c.Query("pageSize"))
	if pageSize < 1 || pageSize > 500 {
		pageSize = 50
	}
	offset := (page - 1) * pageSize

	where := "WHERE a.is_active AND NOT a.is_material_resale"
	args := []interface{}{}

	if st := strings.TrimSpace(c.Query("status")); st != "" {
		args = append(args, st)
		where += " AND coalesce(c.status::text, 'NEW') = $" + strconv.Itoa(len(args))
	}
	if prefix := strings.TrimSpace(c.Query("codePrefix")); prefix != "" {
		args = append(args, prefix)
		where += " AND split_part(a.article_code,'-',1) = $" + strconv.Itoa(len(args))
	}
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		args = append(args, "%"+search+"%")
		n := strconv.Itoa(len(args))
		where += " AND (a.article_code ILIKE $" + n + " OR a.name ILIKE $" + n +
			" OR coalesce(c.ntin,'') ILIKE $" + n + ")"
	}

	// Категория подмешивается из справочника видов: пока карточки нет,
	// собственного ОКТРУ у изделия тоже нет, но умолчание уже известно —
	// показывать «не задан» там, где категория назначена, значит врать
	from := `FROM articles a
		LEFT JOIN nkt_cards c ON c.article_id = a.id
		LEFT JOIN nkt_queue q ON q.card_id = c.id
		LEFT JOIN nkt_category_map m
		       ON m.code_prefix = split_part(a.article_code,'-',1) AND m.is_active `

	ctx := c.Request.Context()
	var total int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) "+from+where, args...).Scan(&total); err != nil {
		respond(c, err)
		return
	}

	listArgs := append([]interface{}{}, args...)
	listArgs = append(listArgs, pageSize, offset)
	sql := `SELECT a.id, a.article_code, a.name, split_part(a.article_code,'-',1),
			coalesce(c.status::text,'NEW'), coalesce(nullif(c.oktru,''), m.oktru, ''), coalesce(c.gtin,''),
			coalesce(c.gtin_valid,false), coalesce(c.ntin,''), coalesce(c.product_url,''),
			coalesce(c.attempts,0), coalesce(c.last_error,''), coalesce(c.moderator_comment,''),
			c.updated_at, coalesce(q.operation::text,'')
		` + from + where + `
		ORDER BY a.article_code
		LIMIT $` + strconv.Itoa(len(listArgs)-1) + " OFFSET $" + strconv.Itoa(len(listArgs))

	rows, err := h.pool.Query(ctx, sql, listArgs...)
	if err != nil {
		respond(c, err)
		return
	}
	defer rows.Close()

	type row struct {
		ArticleID        string       `json:"articleId"`
		ArticleCode      string       `json:"articleCode"`
		ArticleName      string       `json:"articleName"`
		CodePrefix       string       `json:"codePrefix"`
		Status           string       `json:"status"`
		Oktru            string       `json:"oktru"`
		Gtin             string       `json:"gtin"`
		GtinValid        bool         `json:"gtinValid"`
		Ntin             string       `json:"ntin"`
		ProductURL       string       `json:"productUrl"`
		Attempts         int          `json:"attempts"`
		LastError        string       `json:"lastError"`
		ModeratorComment string       `json:"moderatorComment"`
		UpdatedAt        common.PDate `json:"updatedAt"`
		QueuedOp         string       `json:"queuedOp"`
	}
	data := []row{}
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.ArticleID, &r.ArticleCode, &r.ArticleName, &r.CodePrefix,
			&r.Status, &r.Oktru, &r.Gtin, &r.GtinValid, &r.Ntin, &r.ProductURL,
			&r.Attempts, &r.LastError, &r.ModeratorComment, &r.UpdatedAt, &r.QueuedOp); err != nil {
			respond(c, err)
			return
		}
		data = append(data, r)
	}
	c.JSON(http.StatusOK, gin.H{
		"data": data,
		"meta": gin.H{"page": page, "pageSize": pageSize, "total": total},
	})
}

// Summary — GET /nkt/summary: счётчики по статусам и доля цели.
//
// Критерий приёмки из ТЗ §1 — доля объектов в статусе «NTIN получен» от
// всех участвующих в обороте. Считается здесь, а не глазами по реестру.
func (h *Handler) Summary(c *gin.Context) {
	ctx := c.Request.Context()
	rows, err := h.pool.Query(ctx, `
		SELECT coalesce(c.status::text,'NEW') AS status, count(*)
		FROM articles a
		LEFT JOIN nkt_cards c ON c.article_id = a.id
		WHERE a.is_active AND NOT a.is_material_resale
		GROUP BY 1`)
	if err != nil {
		respond(c, err)
		return
	}
	defer rows.Close()

	byStatus := map[string]int{}
	total, done := 0, 0
	for rows.Next() {
		var st string
		var n int
		if err := rows.Scan(&st, &n); err != nil {
			respond(c, err)
			return
		}
		byStatus[st] = n
		total += n
		if st == nktpkg.StatusHasNtin {
			done = n
		}
	}

	// Проблемные заявки: три круга доработки и больше (ТЗ §10.7)
	var problem int
	_ = h.pool.QueryRow(ctx, "SELECT count(*) FROM nkt_cards WHERE attempts >= 3").Scan(&problem)

	share := 0.0
	if total > 0 {
		share = float64(done) / float64(total) * 100
	}
	c.JSON(http.StatusOK, gin.H{
		"byStatus":   byStatus,
		"total":      total,
		"withNtin":   done,
		"sharePct":   share,
		"problem":    problem,
		"configured": nktpkg.Configured(),
	})
}

// ---------------------------------------------------------------------------
// Карточка
// ---------------------------------------------------------------------------

// Card — GET /nkt/cards/:articleId: паспорт, состояние и схема для формы.
func (h *Handler) Card(c *gin.Context) {
	articleID := c.Param("articleId")
	card, err := h.svc.GetCard(c.Request.Context(), articleID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			common.NotFound(c, "Изделие не найдено")
			return
		}
		respond(c, err)
		return
	}
	schema, err := h.svc.LoadSchema(c.Request.Context(), card.Oktru)
	if err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"card": card, "schema": schema})
}

// SavePassport — PUT /nkt/cards/:articleId/passport
func (h *Handler) SavePassport(c *gin.Context) {
	var body nktpkg.Passport
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", "Не удалось разобрать паспорт")
		return
	}
	card, err := h.svc.SavePassport(c.Request.Context(), c.Param("articleId"), body)
	if err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusOK, card)
}

// Validate — POST /nkt/cards/:articleId/validate: проверка паспорта без
// отправки. Инженеру нужно видеть, чего не хватает, до подачи заявки, а не
// после того, как модератор вернул её через неделю.
func (h *Handler) Validate(c *gin.Context) {
	ctx := c.Request.Context()
	card, err := h.svc.GetCard(ctx, c.Param("articleId"))
	if err != nil {
		respond(c, err)
		return
	}
	issues, err := h.svc.ValidateCard(ctx, card)
	if err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": len(issues) == 0, "issues": issues})
}

// Submit — POST /nkt/cards/:articleId/submit: поставить в очередь на подачу.
func (h *Handler) Submit(c *gin.Context) {
	ctx := c.Request.Context()
	card, err := h.svc.GetCard(ctx, c.Param("articleId"))
	if err != nil {
		respond(c, err)
		return
	}
	if card.Status == nktpkg.StatusHasNtin {
		common.Conflict(c, "NKT_ALREADY_HAS_NTIN", "У изделия уже есть NTIN")
		return
	}
	if err := h.svc.Enqueue(ctx, card.ID, nktpkg.OpValidate); err != nil {
		respond(c, err)
		return
	}
	out, err := h.svc.GetCard(ctx, card.ArticleID)
	if err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}

// Resubmit — POST /nkt/cards/:articleId/resubmit: цикл доработки.
func (h *Handler) Resubmit(c *gin.Context) {
	card, err := h.svc.Resubmit(c.Request.Context(), c.Param("articleId"))
	if err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusOK, card)
}

// DuplicateDecision — POST /nkt/cards/:articleId/duplicate-decision
func (h *Handler) DuplicateDecision(c *gin.Context) {
	var body struct {
		Decision string `json:"decision"`
		Ntin     string `json:"ntin"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", "Не удалось разобрать решение")
		return
	}
	card, err := h.svc.DecideDuplicate(c.Request.Context(), c.Param("articleId"), body.Decision, body.Ntin)
	if err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusOK, card)
}

// Cancel — POST /nkt/cards/:articleId/cancel: отозвать заявку.
func (h *Handler) Cancel(c *gin.Context) {
	card, err := h.svc.CancelRequest(c.Request.Context(), c.Param("articleId"))
	if err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusOK, card)
}

// Log — GET /nkt/cards/:articleId/log: журнал обмена по изделию.
func (h *Handler) Log(c *gin.Context) {
	limit, _ := strconv.Atoi(c.Query("limit"))
	if limit < 1 || limit > 200 {
		limit = 50
	}
	rows, err := h.pool.Query(c.Request.Context(), `
		SELECT l.id, l.direction::text, l.method, l.url, coalesce(l.http_code,0),
		       coalesce(l.request_body,''), coalesce(l.response_body,''),
		       coalesce(l.duration_ms,0), l.created_at
		FROM nkt_log l
		JOIN nkt_cards c ON c.id = l.card_id
		WHERE c.article_id = $1
		ORDER BY l.created_at DESC
		LIMIT $2`, c.Param("articleId"), limit)
	if err != nil {
		respond(c, err)
		return
	}
	defer rows.Close()

	type entry struct {
		ID         int64        `json:"id"`
		Direction  string       `json:"direction"`
		Method     string       `json:"method"`
		URL        string       `json:"url"`
		HTTPCode   int          `json:"httpCode"`
		Request    string       `json:"requestBody"`
		Response   string       `json:"responseBody"`
		DurationMs int          `json:"durationMs"`
		CreatedAt  common.PDate `json:"createdAt"`
	}
	data := []entry{}
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.ID, &e.Direction, &e.Method, &e.URL, &e.HTTPCode,
			&e.Request, &e.Response, &e.DurationMs, &e.CreatedAt); err != nil {
			respond(c, err)
			return
		}
		data = append(data, e)
	}
	c.JSON(http.StatusOK, gin.H{"data": data})
}

// ---------------------------------------------------------------------------
// Справочники и обслуживание
// ---------------------------------------------------------------------------

// Categories — GET /nkt/categories: соответствие «вид изделия → ОКТРУ».
//
// Отдаются все виды, встречающиеся в артикулах, — включая те, которым
// категория ещё не назначена: аналитику нужно видеть незакрытые, а не
// только уже заполненные строки.
func (h *Handler) Categories(c *gin.Context) {
	rows, err := h.pool.Query(c.Request.Context(), `
		WITH prefixes AS (
		  SELECT split_part(article_code,'-',1) AS code_prefix, count(*) AS articles
		  FROM articles WHERE is_active AND NOT is_material_resale
		  GROUP BY 1
		)
		SELECT p.code_prefix, coalesce(m.oktru,''), coalesce(m.oktru_name,''),
		       coalesce(m.tnved_default,''), coalesce(m.is_active,false), p.articles
		FROM prefixes p
		LEFT JOIN nkt_category_map m ON m.code_prefix = p.code_prefix
		ORDER BY p.articles DESC, p.code_prefix`)
	if err != nil {
		respond(c, err)
		return
	}
	defer rows.Close()
	type row struct {
		CodePrefix   string `json:"codePrefix"`
		Oktru        string `json:"oktru"`
		OktruName    string `json:"oktruName"`
		TnvedDefault string `json:"tnvedDefault"`
		IsActive     bool   `json:"isActive"`
		Articles     int    `json:"articles"`
	}
	data := []row{}
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.CodePrefix, &r.Oktru, &r.OktruName, &r.TnvedDefault, &r.IsActive, &r.Articles); err != nil {
			respond(c, err)
			return
		}
		data = append(data, r)
	}
	c.JSON(http.StatusOK, gin.H{"data": data})
}

// SaveCategory — PUT /nkt/categories/:prefix
func (h *Handler) SaveCategory(c *gin.Context) {
	var body struct {
		Oktru        string `json:"oktru"`
		OktruName    string `json:"oktruName"`
		TnvedDefault string `json:"tnvedDefault"`
		IsActive     *bool  `json:"isActive"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", "Не удалось разобрать соответствие")
		return
	}
	if strings.TrimSpace(body.Oktru) == "" {
		common.BadRequest(c, "VALIDATION_ERROR", "Код ОКТРУ обязателен")
		return
	}
	active := true
	if body.IsActive != nil {
		active = *body.IsActive
	}
	if _, err := h.pool.Exec(c.Request.Context(), `
		INSERT INTO nkt_category_map (code_prefix, oktru, oktru_name, tnved_default, is_active, updated_at)
		VALUES ($1,$2,nullif($3,''),nullif($4,''),$5, now())
		ON CONFLICT (code_prefix) DO UPDATE SET oktru = EXCLUDED.oktru, oktru_name = EXCLUDED.oktru_name,
		   tnved_default = EXCLUDED.tnved_default, is_active = EXCLUDED.is_active, updated_at = now()`,
		c.Param("prefix"), strings.TrimSpace(body.Oktru), strings.TrimSpace(body.OktruName),
		strings.TrimSpace(body.TnvedDefault), active); err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Dictionary — GET /nkt/dictionaries/:code?search=: значения справочника НКТ
// для выпадающего списка в форме паспорта.
func (h *Handler) Dictionary(c *gin.Context) {
	args := []interface{}{c.Param("code")}
	where := "WHERE dictionary_code = $1"
	if s := strings.TrimSpace(c.Query("search")); s != "" {
		args = append(args, "%"+s+"%")
		where += " AND (name_ru ILIKE $2 OR value_id ILIKE $2)"
	}
	rows, err := h.pool.Query(c.Request.Context(),
		"SELECT value_id, name_ru FROM nkt_dictionary_values "+where+" ORDER BY name_ru LIMIT 200", args...)
	if err != nil {
		respond(c, err)
		return
	}
	defer rows.Close()
	type item struct {
		Value string `json:"value"`
		Label string `json:"label"`
	}
	data := []item{}
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.Value, &it.Label); err != nil {
			respond(c, err)
			return
		}
		data = append(data, it)
	}
	c.JSON(http.StatusOK, gin.H{"data": data})
}

// SyncSchema — POST /nkt/sync-schema: обновить схему атрибутов и справочники.
func (h *Handler) SyncSchema(c *gin.Context) {
	if !nktpkg.Configured() {
		common.Fail(c, http.StatusServiceUnavailable, "NKT_NOT_CONFIGURED",
			"Ключ НКТ не задан: заполните NKT_API_KEY в backend/.env")
		return
	}
	if err := h.svc.SyncSchema(c.Request.Context()); err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Backfill — POST /nkt/backfill?codePrefix=: завести карточки на изделия и
// поставить их в очередь (первичная загрузка, ТЗ §10.1).
func (h *Handler) Backfill(c *gin.Context) {
	ctx := c.Request.Context()
	created, err := h.svc.EnsureCards(ctx, strings.TrimSpace(c.Query("codePrefix")))
	if err != nil {
		respond(c, err)
		return
	}
	queued, err := h.svc.FillQueue(ctx)
	if err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"created": created, "queued": queued})
}

// Status — GET /nkt/status: настроен ли обмен и что в очереди.
func (h *Handler) Status(c *gin.Context) {
	ctx := c.Request.Context()
	var queued, attrs, dicts int
	var lastSync *string
	_ = h.pool.QueryRow(ctx, "SELECT count(*) FROM nkt_queue").Scan(&queued)
	_ = h.pool.QueryRow(ctx, "SELECT count(*) FROM nkt_attributes").Scan(&attrs)
	_ = h.pool.QueryRow(ctx, "SELECT count(*) FROM nkt_dictionary_values").Scan(&dicts)
	_ = h.pool.QueryRow(ctx, "SELECT to_char(max(synced_at),'YYYY-MM-DD HH24:MI') FROM nkt_attributes").Scan(&lastSync)

	c.JSON(http.StatusOK, gin.H{
		"configured":       nktpkg.Configured(),
		"baseUrl":          nktpkg.BaseURL(),
		"queued":           queued,
		"attributes":       attrs,
		"dictionaryValues": dicts,
		"schemaSyncedAt":   lastSync,
	})
}
