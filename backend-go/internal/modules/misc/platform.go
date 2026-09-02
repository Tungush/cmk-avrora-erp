package misc

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/nomenclature"
)

type PlatformHandler struct{ pool *pgxpool.Pool }

func NewPlatformHandler(pool *pgxpool.Pool) *PlatformHandler { return &PlatformHandler{pool: pool} }

const searchLimit = 8

// Search — GET /search?q= — общий поиск: заказы, изделия, материалы (по правам).
func (h *PlatformHandler) Search(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if len([]rune(q)) < 2 {
		c.JSON(http.StatusOK, gin.H{"query": q, "orders": []interface{}{}, "articles": []interface{}{}, "materials": []interface{}{}})
		return
	}
	user := authpkg.CurrentUser(c)
	perms := authpkg.PermissionsForRoles(user.Roles)
	has := func(p string) bool { return authpkg.HasPermission(perms, p) }
	like := "%" + q + "%"
	ctx := c.Request.Context()

	orders := []gin.H{}
	if has("order.core:read") {
		rows, err := h.pool.Query(ctx, `SELECT o.id, o.order_number, o.status, o.is_archived, o.onec_num, cu.name FROM orders o
			LEFT JOIN customers cu ON cu.id = o.customer_id
			WHERE o.order_number ILIKE $1 OR o.onec_num ILIKE $1 OR cu.name ILIKE $1 OR o.final_customer ILIKE $1 OR o.project_site ILIKE $1 OR o.customer_order_num ILIKE $1
			ORDER BY o.is_archived ASC, o.created_at DESC LIMIT $2`, like, searchLimit)
		if err != nil {
			fail(c, err)
			return
		}
		for rows.Next() {
			var id, num, status string
			var archived bool
			var onec, cname *string
			if err := rows.Scan(&id, &num, &status, &archived, &onec, &cname); err != nil {
				rows.Close()
				fail(c, err)
				return
			}
			var parts []string
			if cname != nil && *cname != "" {
				parts = append(parts, *cname)
			}
			if onec != nil && *onec != "" {
				parts = append(parts, "1С: "+*onec)
			}
			orders = append(orders, gin.H{"id": id, "orderNumber": num, "subtitle": strings.Join(parts, " · "), "status": status, "isArchived": archived})
		}
		rows.Close()
	}
	articles := []gin.H{}
	if has("article.core:read") {
		rows, err := h.pool.Query(ctx, "SELECT id, article_code, name, is_active FROM articles WHERE article_code ILIKE $1 OR name ILIKE $1 ORDER BY article_code ASC LIMIT $2", like, searchLimit)
		if err != nil {
			fail(c, err)
			return
		}
		for rows.Next() {
			var id, code, name string
			var active bool
			if err := rows.Scan(&id, &code, &name, &active); err != nil {
				rows.Close()
				fail(c, err)
				return
			}
			articles = append(articles, gin.H{"id": id, "articleCode": code, "name": name, "isActive": active})
		}
		rows.Close()
	}
	materials := []gin.H{}
	if has("material.core:read") {
		rows, err := h.pool.Query(ctx, "SELECT id, material_code, name, unit FROM materials WHERE material_code ILIKE $1 OR name ILIKE $1 ORDER BY name ASC LIMIT $2", like, searchLimit)
		if err != nil {
			fail(c, err)
			return
		}
		var directIDs []string
		for rows.Next() {
			var id, code, name, unit string
			if err := rows.Scan(&id, &code, &name, &unit); err != nil {
				rows.Close()
				fail(c, err)
				return
			}
			materials = append(materials, gin.H{"id": id, "materialCode": code, "name": name, "unit": unit, "viaAlias": nil})
			directIDs = append(directIDs, id)
		}
		rows.Close()
		if len(materials) < searchLimit {
			if directIDs == nil {
				directIDs = []string{}
			}
			// take без orderBy → неявный ORDER BY id (Prisma)
			arows, err := h.pool.Query(ctx, `SELECT a.alias, m.id, m.material_code, m.name, m.unit FROM material_aliases a JOIN materials m ON m.id = a.material_id
				WHERE (a.alias ILIKE $1 OR a.normalized LIKE $2) AND NOT (a.material_id = ANY($3)) ORDER BY a.id LIMIT $4`,
				like, "%"+nomenclature.NormalizeName(q)+"%", directIDs, searchLimit-len(materials))
			if err != nil {
				fail(c, err)
				return
			}
			for arows.Next() {
				var alias, id, code, name, unit string
				if err := arows.Scan(&alias, &id, &code, &name, &unit); err != nil {
					arows.Close()
					fail(c, err)
					return
				}
				materials = append(materials, gin.H{"id": id, "materialCode": code, "name": name, "unit": unit, "viaAlias": alias})
			}
			arows.Close()
		}
	}
	c.JSON(http.StatusOK, gin.H{"query": q, "orders": orders, "articles": articles, "materials": materials})
}

type savedView struct {
	ID         string          `json:"id"`
	Module     string          `json:"module"`
	Name       string          `json:"name"`
	OwnerEmail string          `json:"ownerEmail"`
	Config     json.RawMessage `json:"config"`
	CreatedAt  common.PDate    `json:"createdAt"`
}

// SavedViewsList — GET /saved-views?module=
func (h *PlatformHandler) SavedViewsList(c *gin.Context) {
	module := c.Query("module")
	if module == "" {
		module = "orders"
	}
	user := authpkg.CurrentUser(c)
	rows, err := h.pool.Query(c.Request.Context(), "SELECT id, module, name, owner_email, config, created_at FROM saved_views WHERE module = $1 AND owner_email = $2 ORDER BY created_at ASC", module, user.Email)
	if err != nil {
		fail(c, err)
		return
	}
	defer rows.Close()
	out := []savedView{}
	for rows.Next() {
		var v savedView
		if err := rows.Scan(&v.ID, &v.Module, &v.Name, &v.OwnerEmail, &v.Config, &v.CreatedAt); err != nil {
			fail(c, err)
			return
		}
		out = append(out, v)
	}
	c.JSON(http.StatusOK, out)
}

// SavedViewsCreate — POST /saved-views
func (h *PlatformHandler) SavedViewsCreate(c *gin.Context) {
	var body struct {
		Module string          `json:"module"`
		Name   string          `json:"name"`
		Config json.RawMessage `json:"config"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		common.BadRequest(c, "INVALID_NAME", "Имя представления обязательно")
		return
	}
	if r := []rune(name); len(r) > 100 {
		name = string(r[:100])
	}
	module := body.Module
	if module == "" {
		module = "orders"
	}
	cfg := body.Config
	if len(cfg) == 0 || string(cfg) == "null" {
		cfg = json.RawMessage("{}")
	}
	user := authpkg.CurrentUser(c)
	var v savedView
	if err := h.pool.QueryRow(c.Request.Context(), "INSERT INTO saved_views (id, module, name, owner_email, config) VALUES ($1,$2,$3,$4,$5) RETURNING id, module, name, owner_email, config, created_at",
		uuid.NewString(), module, name, user.Email, cfg).Scan(&v.ID, &v.Module, &v.Name, &v.OwnerEmail, &v.Config, &v.CreatedAt); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, v)
}

// SavedViewsDelete — DELETE /saved-views/:id
func (h *PlatformHandler) SavedViewsDelete(c *gin.Context) {
	id := c.Param("id")
	ctx := c.Request.Context()
	var owner string
	err := h.pool.QueryRow(ctx, "SELECT owner_email FROM saved_views WHERE id = $1", id).Scan(&owner)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Представление не найдено")
		return
	} else if err != nil {
		fail(c, err)
		return
	}
	if owner != authpkg.CurrentUser(c).Email {
		common.Fail(c, http.StatusForbidden, "NOT_OWNER", "Чужое представление удалить нельзя")
		return
	}
	if _, err := h.pool.Exec(ctx, "DELETE FROM saved_views WHERE id = $1", id); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}

// AuditLog — GET /audit-log?userId=&entity=&page=&pageSize=
func (h *PlatformHandler) AuditLog(c *gin.Context) {
	page, size := pageParams(c, 50)
	where, args := "WHERE 1=1", []interface{}{}
	if v := c.Query("userId"); v != "" {
		args = append(args, v)
		where += " AND user_id = $" + itoa(len(args))
	}
	if v := c.Query("entity"); v != "" {
		args = append(args, v)
		where += " AND entity_type = $" + itoa(len(args))
	}
	ctx := c.Request.Context()
	var total int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM audit_log "+where, args...).Scan(&total); err != nil {
		fail(c, err)
		return
	}
	largs := append(append([]interface{}{}, args...), size, (page-1)*size)
	rows, err := h.pool.Query(ctx, "SELECT id, entity_type, entity_id, action, before, after, user_id, user_role, timestamp, comment FROM audit_log "+where+" ORDER BY timestamp DESC LIMIT $"+itoa(len(largs)-1)+" OFFSET $"+itoa(len(largs)), largs...)
	if err != nil {
		fail(c, err)
		return
	}
	defer rows.Close()
	type entry struct {
		ID         string          `json:"id"`
		EntityType string          `json:"entityType"`
		EntityID   string          `json:"entityId"`
		Action     string          `json:"action"`
		Before     json.RawMessage `json:"before"`
		After      json.RawMessage `json:"after"`
		UserID     *string         `json:"userId"`
		UserRole   *string         `json:"userRole"`
		Timestamp  common.PDate    `json:"timestamp"`
		Comment    *string         `json:"comment"`
	}
	data := []entry{}
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.ID, &e.EntityType, &e.EntityID, &e.Action, &e.Before, &e.After, &e.UserID, &e.UserRole, &e.Timestamp, &e.Comment); err != nil {
			fail(c, err)
			return
		}
		data = append(data, e)
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "meta": gin.H{"page": page, "pageSize": size, "total": total}})
}
