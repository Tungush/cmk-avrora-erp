// Точный перенос auth.controller.ts. Строка за строкой: тот же порядок
// проверок (email обязателен → известный email проверяет пароль ВСЕГДА,
// демо-режим касается только неизвестного email), те же коды ошибок,
// тот же payload токена — старый и новый бэкенд выдают взаимозаменяемые
// токены, это важно, пока оба сервиса живут параллельно.
package platform

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
)

type AuthHandler struct {
	pool *pgxpool.Pool
}

func NewAuthHandler(pool *pgxpool.Pool) *AuthHandler {
	return &AuthHandler{pool: pool}
}

type loginBody struct {
	Email    string   `json:"email"`
	Password string   `json:"password"`
	Roles    []string `json:"roles"`
}

type userOut struct {
	UserID string   `json:"userId"`
	Email  string   `json:"email"`
	Roles  []string `json:"roles"`
}

func isDemoMode() bool {
	return os.Getenv("AUTH_DEMO_MODE") != "false"
}

func (h *AuthHandler) Login(c *gin.Context) {
	var body loginBody
	if err := c.ShouldBindJSON(&body); err != nil || body.Email == "" {
		common.Unauthorized(c, "INVALID_CREDENTIALS", "Email is required")
		return
	}

	ctx := c.Request.Context()
	var (
		userID       string
		passwordHash string
	)
	err := h.pool.QueryRow(ctx,
		`SELECT id, password_hash FROM users WHERE email = $1`, body.Email,
	).Scan(&userID, &passwordHash)

	var (
		outUserID string
		outEmail  string
		outRoles  []string
	)

	if err == nil {
		// Известный email — пароль проверяется ВСЕГДА, демо-режим тут ни при
		// чём (auth.controller.ts:50-56). До этой правки в оригинале любой
		// известный адрес пускал внутрь без пароля — не повторять тот баг.
		if bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(body.Password)) != nil {
			common.Unauthorized(c, "INVALID_CREDENTIALS", "Неверный email или пароль")
			return
		}
		roles, rerr := rolesForUser(ctx, h.pool, userID)
		if rerr != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Не удалось прочитать роли")
			return
		}
		outUserID, outEmail, outRoles = userID, body.Email, roles
	} else if err == pgx.ErrNoRows {
		if !isDemoMode() {
			common.Unauthorized(c, "UNKNOWN_USER", "Пользователь не найден. Демо-вход отключён (AUTH_DEMO_MODE=false)")
			return
		}
		selected := body.Roles
		if len(selected) == 0 {
			selected = []string{"sales_manager"}
		}
		outUserID = "usr-" + strconv.FormatInt(time.Now().UnixMilli(), 10)
		outEmail = body.Email
		outRoles = selected
	} else {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	token, terr := issueToken(outUserID, outEmail, outRoles)
	if terr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Не удалось выпустить токен")
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"accessToken": token,
		"user":        userOut{UserID: outUserID, Email: outEmail, Roles: outRoles},
		"permissions": authpkgPermissions(outRoles),
		"family":      auth.FamilyForRoles(outRoles),
	})
}

func (h *AuthHandler) Me(c *gin.Context) {
	u := auth.CurrentUser(c)
	c.JSON(http.StatusOK, gin.H{
		"user":        userOut{UserID: u.UserID, Email: u.Email, Roles: u.Roles},
		"family":      auth.FamilyForRoles(u.Roles),
		"permissions": authpkgPermissions(u.Roles),
		"fieldGroups": auth.FieldGroupsForUI(),
	})
}

func authpkgPermissions(roles []string) []string {
	return auth.PermissionsForRoles(roles)
}

func rolesForUser(ctx context.Context, pool *pgxpool.Pool, userID string) ([]string, error) {
	rows, err := pool.Query(ctx,
		`SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []string
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		roles = append(roles, code)
	}
	return roles, rows.Err()
}

// issueToken — payload и TTL идентичны jwt.sign(payload, JWT_SECRET, {expiresIn: '8h'})
// в оригинале: {userId, email, roles}, 8 часов.
func issueToken(userID, email string, roles []string) (string, error) {
	claims := jwt.MapClaims{
		"userId": userID,
		"email":  email,
		"roles":  roles,
		"exp":    time.Now().Add(8 * time.Hour).Unix(),
		"iat":    time.Now().Unix(),
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString([]byte(auth.Secret()))
}
