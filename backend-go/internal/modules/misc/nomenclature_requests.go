package misc

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/bitrix"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/integration"
	"cmk-avrora-erp/backend-go/internal/models"
	"cmk-avrora-erp/backend-go/internal/modules/catalog"
)

// Перенос nomenclature-requests.controller.ts — заявки на номенклатуру.
type NomenclatureRequestsHandler struct{ pool *pgxpool.Pool }

func NewNomenclatureRequestsHandler(pool *pgxpool.Pool) *NomenclatureRequestsHandler {
	return &NomenclatureRequestsHandler{pool: pool}
}

var knownSeries = map[string]bool{"k": true, "n": true, "d": true, "t": true, "z": true, "a": true, "b": true}

const nreqCols2 = "r.id, r.proposed_name, r.series, r.description, r.reason, r.status, r.requested_by, r.created_at, r.decided_by, r.decided_at, r.decision_comment, r.article_id, r.onec_code, r.onec_name, r.onec_guid, r.onec_unit, r.linked_material_id, r.synced_at, r.sla_due_at, r.bitrix_task_id, r.bitrix_task_created_at"

type nreqRaw struct {
	ID              string       `json:"id"`
	ProposedName    string       `json:"proposedName"`
	Series          *string      `json:"series"`
	Description     *string      `json:"description"`
	Reason          *string      `json:"reason"`
	Status          string       `json:"status"`
	RequestedBy     *string      `json:"requestedBy"`
	CreatedAt       common.PDate `json:"createdAt"`
	DecidedBy       *string      `json:"decidedBy"`
	DecidedAt       common.PDate `json:"decidedAt"`
	DecisionComment *string      `json:"decisionComment"`
	ArticleID       *string      `json:"articleId"`
	OnecCode        *string      `json:"onecCode"`
	OnecName        *string      `json:"onecName"`
	OnecGuid        *string      `json:"onecGuid"`
	OnecUnit        *string      `json:"onecUnit"`
	LinkedMaterial  *string      `json:"linkedMaterialId"`
	SyncedAt        common.PDate `json:"syncedAt"`
	SlaDueAt        common.PDate `json:"slaDueAt"`
	BitrixTaskID    *string      `json:"bitrixTaskId"`
	BitrixTaskAt    common.PDate `json:"bitrixTaskCreatedAt"`
}

func scanNreq(row pgx.Row) (nreqRaw, error) {
	var r nreqRaw
	err := row.Scan(&r.ID, &r.ProposedName, &r.Series, &r.Description, &r.Reason, &r.Status, &r.RequestedBy, &r.CreatedAt, &r.DecidedBy, &r.DecidedAt,
		&r.DecisionComment, &r.ArticleID, &r.OnecCode, &r.OnecName, &r.OnecGuid, &r.OnecUnit, &r.LinkedMaterial, &r.SyncedAt, &r.SlaDueAt, &r.BitrixTaskID, &r.BitrixTaskAt)
	return r, err
}

func (h *NomenclatureRequestsHandler) nextArticleCode(c *gin.Context, series string) (string, error) {
	prefix := series + "-"
	rows, err := h.pool.Query(c.Request.Context(), "SELECT article_code FROM articles WHERE article_code LIKE $1 || '%'", prefix)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	max := 0
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return "", err
		}
		if n, err := strconv.Atoi(strings.TrimPrefix(code, prefix)); err == nil && n > max {
			max = n
		}
	}
	return fmt.Sprintf("%s%03d", prefix, max+1), nil
}

// Create — POST /nomenclature-requests (engineer/sales_manager/planner/admin)
func (h *NomenclatureRequestsHandler) Create(c *gin.Context) {
	var body struct {
		ProposedName string  `json:"proposedName"`
		Series       *string `json:"series"`
		Description  *string `json:"description"`
		Reason       *string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&body)
	name := strings.TrimSpace(body.ProposedName)
	if name == "" {
		common.BadRequest(c, "INVALID_NAME", "Укажите наименование изделия")
		return
	}
	ctx := c.Request.Context()
	var exCode, exName string
	if err := h.pool.QueryRow(ctx, "SELECT article_code, name FROM articles WHERE lower(name) = lower($1) LIMIT 1", name).Scan(&exCode, &exName); err == nil {
		common.Conflict(c, "ARTICLE_EXISTS", "Такое изделие уже есть: "+exCode+" — "+exName)
		return
	} else if err != pgx.ErrNoRows {
		fail(c, err)
		return
	}
	var pending string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM nomenclature_requests WHERE lower(proposed_name) = lower($1) AND status = 'PENDING' LIMIT 1", name).Scan(&pending); err == nil {
		common.Conflict(c, "REQUEST_ALREADY_PENDING", "Заявка на эту номенклатуру уже на рассмотрении")
		return
	} else if err != pgx.ErrNoRows {
		fail(c, err)
		return
	}
	var series *string
	if body.Series != nil && knownSeries[*body.Series] {
		series = body.Series
	}
	trim := func(p *string) *string {
		if p == nil {
			return nil
		}
		t := strings.TrimSpace(*p)
		if t == "" {
			return nil
		}
		return &t
	}
	user := authpkg.CurrentUser(c)
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	defer tx.Rollback(ctx)
	r, err := scanNreq(tx.QueryRow(ctx, "INSERT INTO nomenclature_requests AS r (id, proposed_name, series, description, reason, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING "+nreqCols2,
		uuid.NewString(), name, series, trim(body.Description), trim(body.Reason), user.Email))
	if err != nil {
		fail(c, err)
		return
	}
	if err := integration.Enqueue(ctx, tx, integration.Message{Type: "nomenclature.requested", EntityType: "NomenclatureRequest", EntityID: r.ID,
		Payload: map[string]interface{}{"requestId": r.ID, "name": r.ProposedName, "series": r.Series, "description": r.Description, "reason": r.Reason, "requestedBy": r.RequestedBy}}); err != nil {
		fail(c, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		fail(c, err)
		return
	}
	if taskID := bitrix.CreateNomenclatureTask(ctx, bitrix.NomenclatureRequest{ID: r.ID, ProposedName: r.ProposedName, Description: r.Description, Reason: r.Reason, RequestedBy: r.RequestedBy}); taskID != nil {
		r, err = scanNreq(h.pool.QueryRow(ctx, "UPDATE nomenclature_requests AS r SET bitrix_task_id = $1, bitrix_task_created_at = $2 WHERE id = $3 RETURNING "+nreqCols2, *taskID, time.Now().UTC(), r.ID))
		if err != nil {
			fail(c, err)
			return
		}
	}
	c.JSON(http.StatusCreated, r)
}

// List — GET /nomenclature-requests?status=
func (h *NomenclatureRequestsHandler) List(c *gin.Context) {
	where, args := "", []interface{}{}
	if v := c.Query("status"); v != "" {
		args = append(args, v)
		where = " WHERE r.status = $1"
	}
	rows, err := h.pool.Query(c.Request.Context(), "SELECT "+nreqCols2+", a.article_code, a.name FROM nomenclature_requests r LEFT JOIN articles a ON a.id = r.article_id"+where+" ORDER BY r.created_at DESC LIMIT 100", args...)
	if err != nil {
		fail(c, err)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var r nreqRaw
		var code, name *string
		if err := rows.Scan(&r.ID, &r.ProposedName, &r.Series, &r.Description, &r.Reason, &r.Status, &r.RequestedBy, &r.CreatedAt, &r.DecidedBy, &r.DecidedAt,
			&r.DecisionComment, &r.ArticleID, &r.OnecCode, &r.OnecName, &r.OnecGuid, &r.OnecUnit, &r.LinkedMaterial, &r.SyncedAt, &r.SlaDueAt, &r.BitrixTaskID, &r.BitrixTaskAt, &code, &name); err != nil {
			fail(c, err)
			return
		}
		m := nreqJSON(r)
		if code != nil {
			m["article"] = gin.H{"articleCode": *code, "name": *name}
		} else {
			m["article"] = nil
		}
		out = append(out, m)
	}
	c.JSON(http.StatusOK, out)
}

func nreqJSON(r nreqRaw) gin.H {
	return gin.H{"id": r.ID, "proposedName": r.ProposedName, "series": r.Series, "description": r.Description, "reason": r.Reason, "status": r.Status,
		"requestedBy": r.RequestedBy, "createdAt": r.CreatedAt, "decidedBy": r.DecidedBy, "decidedAt": r.DecidedAt, "decisionComment": r.DecisionComment,
		"articleId": r.ArticleID, "onecCode": r.OnecCode, "onecName": r.OnecName, "onecGuid": r.OnecGuid, "onecUnit": r.OnecUnit, "linkedMaterialId": r.LinkedMaterial,
		"syncedAt": r.SyncedAt, "slaDueAt": r.SlaDueAt, "bitrixTaskId": r.BitrixTaskID, "bitrixTaskCreatedAt": r.BitrixTaskAt}
}

func (h *NomenclatureRequestsHandler) pending(c *gin.Context, id string) (nreqRaw, bool) {
	r, err := scanNreq(h.pool.QueryRow(c.Request.Context(), "SELECT "+nreqCols2+" FROM nomenclature_requests r WHERE r.id = $1", id))
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Заявка не найдена")
		return r, false
	} else if err != nil {
		fail(c, err)
		return r, false
	}
	if r.Status != "PENDING" {
		common.Conflict(c, "ALREADY_DECIDED", "Заявка уже рассмотрена")
		return r, false
	}
	return r, true
}

// Approve — POST /nomenclature-requests/:id/approve (engineer/admin)
func (h *NomenclatureRequestsHandler) Approve(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		ArticleCode *string `json:"articleCode"`
		Series      *string `json:"series"`
		Comment     *string `json:"comment"`
	}
	_ = c.ShouldBindJSON(&body)
	r, ok := h.pending(c, id)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	code := ""
	if body.ArticleCode != nil {
		code = strings.TrimSpace(*body.ArticleCode)
	}
	if code != "" {
		var dup string
		if err := h.pool.QueryRow(ctx, "SELECT id FROM articles WHERE article_code = $1", code).Scan(&dup); err == nil {
			common.Conflict(c, "DUPLICATE_CODE", "Артикул "+code+" уже занят")
			return
		} else if err != pgx.ErrNoRows {
			fail(c, err)
			return
		}
	} else {
		series := "n"
		if body.Series != nil {
			series = *body.Series
		} else if r.Series != nil {
			series = *r.Series
		}
		var err error
		if code, err = h.nextArticleCode(c, series); err != nil {
			fail(c, err)
			return
		}
	}
	user := authpkg.CurrentUser(c)
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	defer tx.Rollback(ctx)
	art, err := catalog.ScanArticle(tx.QueryRow(ctx, "INSERT INTO articles (id, article_code, name, series, description, is_active, updated_at) VALUES ($1,$2,$3,$4,$5,true,now()) RETURNING "+catalog.ArticleCols,
		uuid.NewString(), code, r.ProposedName, r.Series, r.Description))
	if err != nil {
		fail(c, err)
		return
	}
	upd, err := scanNreq(tx.QueryRow(ctx, "UPDATE nomenclature_requests AS r SET status = 'APPROVED', article_id = $1, decided_by = $2, decided_at = $3, decision_comment = $4 WHERE id = $5 RETURNING "+nreqCols2,
		art.ID, user.Email, time.Now().UTC(), body.Comment, id))
	if err != nil {
		fail(c, err)
		return
	}
	role := ""
	if len(user.Roles) > 0 {
		role = user.Roles[0]
	}
	reqBy := "—"
	if r.RequestedBy != nil {
		reqBy = *r.RequestedBy
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log (id, entity_type, entity_id, action, after, user_id, user_role, comment) VALUES ($1,'Article',$2,'nomenclature_created',$3,$4,$5,$6)`,
		uuid.NewString(), art.ID, mustJSON(gin.H{"articleCode": art.ArticleCode, "name": art.Name}), dbUserID(user.UserID), role, "Заявка на номенклатуру от "+reqBy); err != nil {
		fail(c, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		fail(c, err)
		return
	}
	m := nreqJSON(upd)
	m["article"] = gin.H{"articleCode": art.ArticleCode, "name": art.Name}
	c.JSON(http.StatusCreated, gin.H{"request": m, "article": art})
}

// Reject — POST /nomenclature-requests/:id/reject (engineer/admin)
func (h *NomenclatureRequestsHandler) Reject(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Comment *string `json:"comment"`
	}
	_ = c.ShouldBindJSON(&body)
	if _, ok := h.pending(c, id); !ok {
		return
	}
	user := authpkg.CurrentUser(c)
	r, err := scanNreq(h.pool.QueryRow(c.Request.Context(), "UPDATE nomenclature_requests AS r SET status = 'REJECTED', decided_by = $1, decided_at = $2, decision_comment = $3 WHERE id = $4 RETURNING "+nreqCols2,
		user.Email, time.Now().UTC(), body.Comment, id))
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, r)
}

var _ = models.Article{}
