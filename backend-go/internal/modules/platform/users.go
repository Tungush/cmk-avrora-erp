package platform

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
)

// Перенос users.controller.ts — управление пользователями (admin/director).
type UsersHandler struct{ pool *pgxpool.Pool }

func NewUsersHandler(pool *pgxpool.Pool) *UsersHandler { return &UsersHandler{pool: pool} }

func usersRespondErr(c *gin.Context, err error) {
	common.DebugLog(err)
	common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
}

// shape — {id,email,isActive,createdAt,roles:[{code,name}],employee:{id,name}|null}
func (h *UsersHandler) shape(c *gin.Context, ids []string) ([]gin.H, error) {
	ctx := c.Request.Context()
	if len(ids) == 0 {
		return []gin.H{}, nil
	}
	rows, err := h.pool.Query(ctx, `SELECT u.id, u.email, u.is_active, u.created_at, e.id, e.name FROM users u
		LEFT JOIN employees e ON e.id = u.employee_id WHERE u.id = ANY($1) ORDER BY u.email ASC`, ids)
	if err != nil {
		return nil, err
	}
	type u struct {
		ID, Email      string
		IsActive       bool
		CreatedAt      common.PDate
		EmpID, EmpName *string
	}
	var users []u
	for rows.Next() {
		var x u
		if err := rows.Scan(&x.ID, &x.Email, &x.IsActive, &x.CreatedAt, &x.EmpID, &x.EmpName); err != nil {
			rows.Close()
			return nil, err
		}
		users = append(users, x)
	}
	rows.Close()
	rrows, err := h.pool.Query(ctx, "SELECT ur.user_id, r.code, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ANY($1)", ids)
	if err != nil {
		return nil, err
	}
	roles := map[string][]gin.H{}
	for rrows.Next() {
		var uid, code, name string
		if err := rrows.Scan(&uid, &code, &name); err != nil {
			rrows.Close()
			return nil, err
		}
		roles[uid] = append(roles[uid], gin.H{"code": code, "name": name})
	}
	rrows.Close()
	out := make([]gin.H, 0, len(users))
	for _, x := range users {
		var emp interface{}
		if x.EmpID != nil {
			emp = gin.H{"id": *x.EmpID, "name": *x.EmpName}
		}
		rs := roles[x.ID]
		if rs == nil {
			rs = []gin.H{}
		}
		out = append(out, gin.H{"id": x.ID, "email": x.Email, "isActive": x.IsActive, "createdAt": x.CreatedAt, "roles": rs, "employee": emp})
	}
	return out, nil
}

// FindAll — GET /users.
func (h *UsersHandler) FindAll(c *gin.Context) {
	rows, err := h.pool.Query(c.Request.Context(), "SELECT id FROM users ORDER BY email ASC")
	if err != nil {
		usersRespondErr(c, err)
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			usersRespondErr(c, err)
			return
		}
		ids = append(ids, id)
	}
	rows.Close()
	out, err := h.shape(c, ids)
	if err != nil {
		usersRespondErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}

// Roles — GET /users/roles — справочник ролей.
func (h *UsersHandler) Roles(c *gin.Context) {
	rows, err := h.pool.Query(c.Request.Context(), "SELECT code, name, description, family, is_system FROM roles ORDER BY family ASC, code ASC")
	if err != nil {
		usersRespondErr(c, err)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var code, name string
		var desc, family *string
		var isSystem bool
		if err := rows.Scan(&code, &name, &desc, &family, &isSystem); err != nil {
			usersRespondErr(c, err)
			return
		}
		out = append(out, gin.H{"code": code, "name": name, "description": desc, "family": family, "isSystem": isSystem})
	}
	c.JSON(http.StatusOK, out)
}

type createUserBody struct {
	Email      string   `json:"email"`
	Password   string   `json:"password"`
	Roles      []string `json:"roles"`
	EmployeeID *string  `json:"employeeId"`
}

func (h *UsersHandler) roleIDs(c *gin.Context, codes []string) ([]string, []string, error) {
	rows, err := h.pool.Query(c.Request.Context(), "SELECT id, code FROM roles WHERE code = ANY($1)", codes)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	known := map[string]string{}
	var ids []string
	for rows.Next() {
		var id, code string
		if err := rows.Scan(&id, &code); err != nil {
			return nil, nil, err
		}
		known[code] = id
		ids = append(ids, id)
	}
	var bad []string
	for _, cd := range codes {
		if _, ok := known[cd]; !ok {
			bad = append(bad, cd)
		}
	}
	return ids, bad, nil
}

// Create — POST /users.
func (h *UsersHandler) Create(c *gin.Context) {
	var body createUserBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if email == "" || !strings.Contains(email, "@") {
		common.BadRequest(c, "INVALID_EMAIL", "Укажите email")
		return
	}
	if len(body.Password) < 8 {
		common.BadRequest(c, "WEAK_PASSWORD", "Пароль — минимум 8 символов")
		return
	}
	if len(body.Roles) == 0 {
		common.BadRequest(c, "ROLES_REQUIRED", "Выберите хотя бы одну роль")
		return
	}
	ctx := c.Request.Context()
	var dup string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM users WHERE email = $1", email).Scan(&dup); err == nil {
		common.Conflict(c, "EMAIL_TAKEN", "Пользователь "+email+" уже есть")
		return
	} else if err != pgx.ErrNoRows {
		usersRespondErr(c, err)
		return
	}
	ids, bad, err := h.roleIDs(c, body.Roles)
	if err != nil {
		usersRespondErr(c, err)
		return
	}
	if len(ids) != len(body.Roles) {
		common.BadRequest(c, "UNKNOWN_ROLE", "Неизвестные роли: "+strings.Join(bad, ", "))
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), 10)
	if err != nil {
		usersRespondErr(c, err)
		return
	}
	var empID *string
	if body.EmployeeID != nil && *body.EmployeeID != "" {
		empID = body.EmployeeID
	}
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		usersRespondErr(c, err)
		return
	}
	defer tx.Rollback(ctx)
	uid := uuid.NewString()
	if _, err := tx.Exec(ctx, "INSERT INTO users (id, email, password_hash, employee_id, updated_at) VALUES ($1,$2,$3,$4,now())", uid, email, string(hash), empID); err != nil {
		usersRespondErr(c, err)
		return
	}
	for _, rid := range ids {
		if _, err := tx.Exec(ctx, "INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)", uid, rid); err != nil {
			usersRespondErr(c, err)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		usersRespondErr(c, err)
		return
	}
	out, err := h.shape(c, []string{uid})
	if err != nil {
		usersRespondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, out[0])
}

type updateUserBody struct {
	Roles       *[]string `json:"roles"`
	IsActive    *bool     `json:"isActive"`
	EmployeeID  *string   `json:"employeeId"`
	hasEmployee bool
}

// Update — PATCH /users/:id — роли, активность, привязка к сотруднику.
func (h *UsersHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var raw map[string]interface{}
	if err := c.ShouldBindJSON(&raw); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	var x string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM users WHERE id = $1", id).Scan(&x); err == pgx.ErrNoRows {
		common.NotFound(c, "Пользователь "+id+" не найден")
		return
	} else if err != nil {
		usersRespondErr(c, err)
		return
	}
	me := authpkg.CurrentUser(c)
	isSelf := me.UserID == id
	isActive, hasActive := raw["isActive"].(bool)
	if isSelf && hasActive && !isActive {
		common.Conflict(c, "SELF_LOCKOUT", "Нельзя отключить собственную учётку")
		return
	}
	var roles []string
	hasRoles := false
	if rr, ok := raw["roles"].([]interface{}); ok {
		hasRoles = true
		for _, r := range rr {
			if s, ok := r.(string); ok {
				roles = append(roles, s)
			}
		}
	}
	if isSelf && hasRoles {
		hasAdmin := false
		for _, r := range roles {
			if r == "admin" {
				hasAdmin = true
			}
		}
		if !hasAdmin {
			var cnt int
			_ = h.pool.QueryRow(ctx, "SELECT count(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.code = 'admin'", id).Scan(&cnt)
			if cnt > 0 {
				common.Conflict(c, "SELF_LOCKOUT", "Нельзя снять admin с собственной учётки")
				return
			}
		}
	}
	if hasRoles {
		if len(roles) == 0 {
			common.BadRequest(c, "ROLES_REQUIRED", "Хотя бы одна роль обязательна")
			return
		}
		ids, _, err := h.roleIDs(c, roles)
		if err != nil {
			usersRespondErr(c, err)
			return
		}
		if len(ids) != len(roles) {
			common.BadRequest(c, "UNKNOWN_ROLE", "Среди ролей есть неизвестные")
			return
		}
		tx, err := h.pool.Begin(ctx)
		if err != nil {
			usersRespondErr(c, err)
			return
		}
		if _, err := tx.Exec(ctx, "DELETE FROM user_roles WHERE user_id = $1", id); err != nil {
			tx.Rollback(ctx)
			usersRespondErr(c, err)
			return
		}
		for _, rid := range ids {
			if _, err := tx.Exec(ctx, "INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)", id, rid); err != nil {
				tx.Rollback(ctx)
				usersRespondErr(c, err)
				return
			}
		}
		if err := tx.Commit(ctx); err != nil {
			usersRespondErr(c, err)
			return
		}
	}
	sets, args := []string{"updated_at = now()"}, []interface{}{}
	if hasActive {
		args = append(args, isActive)
		sets = append(sets, "is_active = $"+itoa(len(args)))
	}
	if v, ok := raw["employeeId"]; ok {
		var emp *string
		if s, ok := v.(string); ok && s != "" {
			emp = &s
		}
		args = append(args, emp)
		sets = append(sets, "employee_id = $"+itoa(len(args)))
	}
	args = append(args, id)
	if _, err := h.pool.Exec(ctx, "UPDATE users SET "+strings.Join(sets, ", ")+" WHERE id = $"+itoa(len(args)), args...); err != nil {
		usersRespondErr(c, err)
		return
	}
	out, err := h.shape(c, []string{id})
	if err != nil {
		usersRespondErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out[0])
}

func itoa(n int) string { return strings.TrimSpace(strings.Repeat(" ", 0) + fmtInt(n)) }
func fmtInt(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

// ResetPassword — POST /users/:id/reset-password.
func (h *UsersHandler) ResetPassword(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	var x string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM users WHERE id = $1", id).Scan(&x); err == pgx.ErrNoRows {
		common.NotFound(c, "Пользователь "+id+" не найден")
		return
	} else if err != nil {
		usersRespondErr(c, err)
		return
	}
	if len(body.Password) < 8 {
		common.BadRequest(c, "WEAK_PASSWORD", "Пароль — минимум 8 символов")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), 10)
	if err != nil {
		usersRespondErr(c, err)
		return
	}
	if _, err := h.pool.Exec(ctx, "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2", string(hash), id); err != nil {
		usersRespondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"ok": true})
}
