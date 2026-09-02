package misc

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	nom "cmk-avrora-erp/backend-go/internal/nomenclature"
)

// Перенос nomenclature.controller.ts + nomenclature.service.ts.
type NomenclatureHandler struct{ pool *pgxpool.Pool }

func NewNomenclatureHandler(pool *pgxpool.Pool) *NomenclatureHandler {
	return &NomenclatureHandler{pool: pool}
}

func (h *NomenclatureHandler) suggest(c *gin.Context, q string, limit int) ([]nom.MatchSuggestion, error) {
	if strings.TrimSpace(q) == "" {
		return []nom.MatchSuggestion{}, nil
	}
	ctx := c.Request.Context()
	rows, err := h.pool.Query(ctx, "SELECT id, name FROM materials")
	if err != nil {
		return nil, err
	}
	var items []nom.NamedItem
	idx := map[string]int{}
	for rows.Next() {
		var it nom.NamedItem
		if err := rows.Scan(&it.ID, &it.Name); err != nil {
			rows.Close()
			return nil, err
		}
		idx[it.ID] = len(items)
		items = append(items, it)
	}
	rows.Close()
	arows, err := h.pool.Query(ctx, "SELECT material_id, alias FROM material_aliases")
	if err != nil {
		return nil, err
	}
	for arows.Next() {
		var mid, alias string
		if err := arows.Scan(&mid, &alias); err != nil {
			arows.Close()
			return nil, err
		}
		if i, ok := idx[mid]; ok {
			items[i].Aliases = append(items[i].Aliases, alias)
		}
	}
	arows.Close()
	return nom.SuggestMatches(q, items, limit, nom.SuggestThreshold), nil
}

// Search — GET /nomenclature/search?q= (промахи логируются)
func (h *NomenclatureHandler) Search(c *gin.Context) {
	q := c.Query("q")
	s, err := h.suggest(c, q, 10)
	if err != nil {
		fail(c, err)
		return
	}
	if len(s) == 0 && strings.TrimSpace(q) != "" {
		user := authpkg.CurrentUser(c)
		h.pool.Exec(c.Request.Context(), "INSERT INTO search_misses (id, query, normalized, user_id) VALUES ($1,$2,$3,$4)", uuid.NewString(), strings.TrimSpace(q), nom.NormalizeName(q), dbUserID(user.UserID))
	}
	c.JSON(http.StatusOK, gin.H{"query": q, "suggestions": s, "total": len(s)})
}

// Suggest — GET /nomenclature/suggest?q=&limit=
func (h *NomenclatureHandler) Suggest(c *gin.Context) {
	limit, _ := strconv.Atoi(c.Query("limit"))
	if limit <= 0 {
		limit = 5
	}
	s, err := h.suggest(c, c.Query("q"), limit)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": s, "total": len(s)})
}

// Duplicates — GET /nomenclature/duplicates
func (h *NomenclatureHandler) Duplicates(c *gin.Context) {
	rows, err := h.pool.Query(c.Request.Context(), "SELECT id, name, material_code, unit, stock_qty FROM materials")
	if err != nil {
		fail(c, err)
		return
	}
	type mat struct {
		Code, Unit string
		Stock      float64
	}
	extra := map[string]mat{}
	var items []nom.NamedItem
	for rows.Next() {
		var it nom.NamedItem
		var m mat
		if err := rows.Scan(&it.ID, &it.Name, &m.Code, &m.Unit, &m.Stock); err != nil {
			rows.Close()
			fail(c, err)
			return
		}
		extra[it.ID] = m
		items = append(items, it)
	}
	rows.Close()
	groups := nom.FindDuplicateGroups(items)
	out := make([]gin.H, 0, len(groups))
	itemCount := 0
	for _, g := range groups {
		gi := make([]gin.H, 0, len(g.Items))
		for _, it := range g.Items {
			m := extra[it.ID]
			gi = append(gi, gin.H{"id": it.ID, "name": it.Name, "materialCode": m.Code, "unit": m.Unit, "stockQty": m.Stock})
		}
		itemCount += len(g.Items)
		out = append(out, gin.H{"key": g.Key, "items": gi})
	}
	c.JSON(http.StatusOK, gin.H{"groups": out, "groupCount": len(groups), "itemCount": itemCount})
}

// Stalled — GET /nomenclature/stalled-requests
func (h *NomenclatureHandler) Stalled(c *gin.Context) {
	rows, err := h.pool.Query(c.Request.Context(), "SELECT id, proposed_name, requested_by, created_at, sla_due_at FROM nomenclature_requests WHERE status IN ('APPROVED','WAITING_1C') ORDER BY created_at ASC")
	if err != nil {
		fail(c, err)
		return
	}
	defer rows.Close()
	now := time.Now()
	data := []gin.H{}
	for rows.Next() {
		var id, name string
		var by *string
		var created time.Time
		var sla *time.Time
		if err := rows.Scan(&id, &name, &by, &created, &sla); err != nil {
			fail(c, err)
			return
		}
		if sla != nil && sla.After(now) {
			continue
		}
		var slaOut interface{}
		if sla != nil {
			slaOut = common.NewPDate(*sla)
		}
		data = append(data, gin.H{"id": id, "proposedName": name, "requestedBy": by, "createdAt": common.NewPDate(created), "slaDueAt": slaOut,
			"waitingDays": int(math.Floor(float64(now.UnixMilli()-created.UnixMilli()) / 86400000))})
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "total": len(data)})
}

type aliasRaw struct {
	ID          string       `json:"id"`
	MaterialID  string       `json:"materialId"`
	Alias       string       `json:"alias"`
	Normalized  string       `json:"normalized"`
	Source      string       `json:"source"`
	ValidFrom   common.PDate `json:"validFrom"`
	ValidTo     common.PDate `json:"validTo"`
	CreatedByID *string      `json:"createdById"`
	CreatedAt   common.PDate `json:"createdAt"`
}

const aliasCols = "id, material_id, alias, normalized, source, valid_from, valid_to, created_by_id, created_at"

func scanAlias(row pgx.Row) (aliasRaw, error) {
	var a aliasRaw
	err := row.Scan(&a.ID, &a.MaterialID, &a.Alias, &a.Normalized, &a.Source, &a.ValidFrom, &a.ValidTo, &a.CreatedByID, &a.CreatedAt)
	return a, err
}

func (h *NomenclatureHandler) addAlias(c *gin.Context, materialID, alias, source, userID string) (aliasRaw, bool) {
	trimmed := strings.TrimSpace(alias)
	if trimmed == "" {
		common.BadRequest(c, "EMPTY_ALIAS", "Пустое имя добавить нельзя")
		return aliasRaw{}, false
	}
	ctx := c.Request.Context()
	normalized := nom.NormalizeName(trimmed)
	a, err := scanAlias(h.pool.QueryRow(ctx, "SELECT "+aliasCols+" FROM material_aliases WHERE material_id = $1 AND normalized = $2 LIMIT 1", materialID, normalized))
	if err == nil {
		return a, true
	}
	if err != pgx.ErrNoRows {
		fail(c, err)
		return aliasRaw{}, false
	}
	a, err = scanAlias(h.pool.QueryRow(ctx, "INSERT INTO material_aliases (id, material_id, alias, normalized, source, created_by_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING "+aliasCols,
		uuid.NewString(), materialID, trimmed, normalized, source, dbUserID(userID)))
	if err != nil {
		fail(c, err)
		return aliasRaw{}, false
	}
	return a, true
}

// Names — GET /nomenclature/materials/:materialId/names
func (h *NomenclatureHandler) Names(c *gin.Context) {
	mid := c.Param("materialId")
	ctx := c.Request.Context()
	var code, name string
	if err := h.pool.QueryRow(ctx, "SELECT material_code, name FROM materials WHERE id = $1", mid).Scan(&code, &name); err == pgx.ErrNoRows {
		common.NotFound(c, "Материал "+mid+" не найден")
		return
	} else if err != nil {
		fail(c, err)
		return
	}
	rows, err := h.pool.Query(ctx, "SELECT "+aliasCols+" FROM material_aliases WHERE material_id = $1 ORDER BY created_at ASC", mid)
	if err != nil {
		fail(c, err)
		return
	}
	defer rows.Close()
	aliases := []gin.H{}
	for rows.Next() {
		a, err := scanAlias(rows)
		if err != nil {
			fail(c, err)
			return
		}
		aliases = append(aliases, gin.H{"alias": a.Alias, "source": a.Source, "validFrom": a.ValidFrom, "validTo": a.ValidTo, "current": !a.ValidTo.Valid})
	}
	c.JSON(http.StatusOK, gin.H{"id": mid, "materialCode": code, "name": name, "aliases": aliases})
}

// AddAlias — POST /nomenclature/materials/:materialId/aliases
func (h *NomenclatureHandler) AddAlias(c *gin.Context) {
	var body struct {
		Alias  string  `json:"alias"`
		Source *string `json:"source"`
	}
	_ = c.ShouldBindJSON(&body)
	src := "MANUAL"
	if body.Source != nil && *body.Source != "" {
		src = *body.Source
	}
	if a, ok := h.addAlias(c, c.Param("materialId"), body.Alias, src, authpkg.CurrentUser(c).UserID); ok {
		c.JSON(http.StatusCreated, a)
	}
}

// ResolveMiss — POST /nomenclature/search-misses/:missId/resolve
func (h *NomenclatureHandler) ResolveMiss(c *gin.Context) {
	missID := c.Param("missId")
	var body struct {
		MaterialID string `json:"materialId"`
	}
	_ = c.ShouldBindJSON(&body)
	ctx := c.Request.Context()
	var query string
	if err := h.pool.QueryRow(ctx, "SELECT query FROM search_misses WHERE id = $1", missID).Scan(&query); err == pgx.ErrNoRows {
		common.NotFound(c, "Запрос "+missID+" не найден")
		return
	} else if err != nil {
		fail(c, err)
		return
	}
	if _, err := h.pool.Exec(ctx, "UPDATE search_misses SET resolved_material_id = $1, resolved_at = $2 WHERE id = $3", body.MaterialID, time.Now().UTC(), missID); err != nil {
		fail(c, err)
		return
	}
	if a, ok := h.addAlias(c, body.MaterialID, query, "SEARCH_MISS", authpkg.CurrentUser(c).UserID); ok {
		c.JSON(http.StatusCreated, a)
	}
}

const nreqCols = "id, proposed_name, series, description, reason, status, requested_by, created_at, decided_by, decided_at, decision_comment, article_id, onec_code, onec_name, onec_guid, onec_unit, linked_material_id, synced_at, sla_due_at, bitrix_task_id, bitrix_task_created_at"

// OnecResponse — POST /nomenclature/requests/:requestId/onec-response
func (h *NomenclatureHandler) OnecResponse(c *gin.Context) {
	rid := c.Param("requestId")
	var body struct {
		OnecCode         string  `json:"onecCode"`
		OnecName         string  `json:"onecName"`
		OnecGuid         *string `json:"onecGuid"`
		OnecUnit         *string `json:"onecUnit"`
		LinkedMaterialID *string `json:"linkedMaterialId"`
	}
	_ = c.ShouldBindJSON(&body)
	ctx := c.Request.Context()
	var proposed string
	if err := h.pool.QueryRow(ctx, "SELECT proposed_name FROM nomenclature_requests WHERE id = $1", rid).Scan(&proposed); err == pgx.ErrNoRows {
		common.NotFound(c, "Заявка "+rid+" не найдена")
		return
	} else if err != nil {
		fail(c, err)
		return
	}
	var linked *string
	if body.LinkedMaterialID != nil && *body.LinkedMaterialID != "" {
		linked = body.LinkedMaterialID
	}
	row := h.pool.QueryRow(ctx, "UPDATE nomenclature_requests SET onec_code = $1, onec_name = $2, onec_guid = $3, onec_unit = $4, linked_material_id = $5, synced_at = $6, status = 'SYNCED' WHERE id = $7 RETURNING "+nreqCols,
		body.OnecCode, body.OnecName, body.OnecGuid, body.OnecUnit, linked, time.Now().UTC(), rid)
	out := gin.H{}
	var id, pname, status string
	var series, desc, reason, reqBy, decBy, decComment, articleID, oCode, oName, oGuid, oUnit, linkedOut, btask *string
	var created common.PDate
	var decided, synced, sla, btaskAt common.PDate
	if err := row.Scan(&id, &pname, &series, &desc, &reason, &status, &reqBy, &created, &decBy, &decided, &decComment, &articleID, &oCode, &oName, &oGuid, &oUnit, &linkedOut, &synced, &sla, &btask, &btaskAt); err != nil {
		fail(c, err)
		return
	}
	out = gin.H{"id": id, "proposedName": pname, "series": series, "description": desc, "reason": reason, "status": status, "requestedBy": reqBy, "createdAt": created,
		"decidedBy": decBy, "decidedAt": decided, "decisionComment": decComment, "articleId": articleID, "onecCode": oCode, "onecName": oName, "onecGuid": oGuid,
		"onecUnit": oUnit, "linkedMaterialId": linkedOut, "syncedAt": synced, "slaDueAt": sla, "bitrixTaskId": btask, "bitrixTaskCreatedAt": btaskAt}
	if linked != nil {
		if _, ok := h.addAlias(c, *linked, proposed, "REQUEST", ""); !ok {
			return
		}
		if body.OnecName != "" {
			if _, ok := h.addAlias(c, *linked, body.OnecName, "ONEC", ""); !ok {
				return
			}
		}
	}
	c.JSON(http.StatusCreated, out)
}

// Rename — POST /nomenclature/materials/:materialId/onec-rename
func (h *NomenclatureHandler) Rename(c *gin.Context) {
	mid := c.Param("materialId")
	var body struct {
		NewName string `json:"newName"`
	}
	_ = c.ShouldBindJSON(&body)
	ctx := c.Request.Context()
	var name string
	if err := h.pool.QueryRow(ctx, "SELECT name FROM materials WHERE id = $1", mid).Scan(&name); err == pgx.ErrNoRows {
		common.NotFound(c, "Материал "+mid+" не найден")
		return
	} else if err != nil {
		fail(c, err)
		return
	}
	user := authpkg.CurrentUser(c)
	if nom.NormalizeName(name) != nom.NormalizeName(body.NewName) {
		tx, err := h.pool.Begin(ctx)
		if err != nil {
			fail(c, err)
			return
		}
		defer tx.Rollback(ctx)
		normalized := nom.NormalizeName(name)
		var existing string
		err = tx.QueryRow(ctx, "SELECT id FROM material_aliases WHERE material_id = $1 AND normalized = $2 LIMIT 1", mid, normalized).Scan(&existing)
		now := time.Now().UTC()
		if err == nil {
			_, err = tx.Exec(ctx, "UPDATE material_aliases SET valid_to = $1 WHERE id = $2", now, existing)
		} else if err == pgx.ErrNoRows {
			_, err = tx.Exec(ctx, "INSERT INTO material_aliases (id, material_id, alias, normalized, source, valid_to, created_by_id) VALUES ($1,$2,$3,$4,'ONEC',$5,$6)", uuid.NewString(), mid, name, normalized, now, dbUserID(user.UserID))
		}
		if err != nil {
			fail(c, err)
			return
		}
		if _, err := tx.Exec(ctx, "UPDATE materials SET name = $1 WHERE id = $2", body.NewName, mid); err != nil {
			fail(c, err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			fail(c, err)
			return
		}
	}
	m, err := loadMaterialRaw(c, h.pool, mid)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, m)
}
