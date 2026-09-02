// Package auth — точный перенос jwt-auth.guard.ts + rbac.guard.ts.
// Секрет и форма payload совпадают с NestJS, поэтому токен, выданный
// старым бэкендом, действует и здесь, и наоборот — важно на время,
// пока оба сервиса живут параллельно (strangler-миграция).
package auth

import (
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"cmk-avrora-erp/backend-go/internal/common"
)

func Secret() string {
	if s := os.Getenv("JWT_SECRET"); s != "" {
		return s
	}
	return "erp_super_secret_jwt_key"
}

// UserPayload — то же самое, что request.user в Nest: userId/email/roles.
type UserPayload struct {
	UserID string   `json:"userId"`
	Email  string   `json:"email"`
	Roles  []string `json:"roles"`
}

const contextKey = "user"

type claims struct {
	UserID string   `json:"userId"`
	Email  string   `json:"email"`
	Roles  []string `json:"roles"`
	jwt.RegisteredClaims
}

// Middleware — эквивалент JwtAuthGuard. Публичные роуты (сейчас только
// /auth/login) регистрируются отдельно, до подключения этой цепочки.
func Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if header == "" || !strings.HasPrefix(header, "Bearer ") {
			common.Unauthorized(c, "UNAUTHORIZED", "Missing or malformed Authorization header Bearer token")
			return
		}
		tokenStr := strings.TrimPrefix(header, "Bearer ")

		token, err := jwt.ParseWithClaims(tokenStr, &claims{}, func(t *jwt.Token) (interface{}, error) {
			return []byte(Secret()), nil
		})
		if err != nil || !token.Valid {
			common.Unauthorized(c, "INVALID_TOKEN", "Invalid or expired JWT access token")
			return
		}
		cl := token.Claims.(*claims)
		c.Set(contextKey, UserPayload{UserID: cl.UserID, Email: cl.Email, Roles: cl.Roles})
		c.Next()
	}
}

func CurrentUser(c *gin.Context) UserPayload {
	v, _ := c.Get(contextKey)
	u, _ := v.(UserPayload)
	return u
}

// RequireRoles — эквивалент RbacGuard: admin проходит всегда (§ rbac.guard.ts:36),
// иначе нужно совпадение хотя бы одной роли. Порядок регистрации в Nest был
// «в декораторе метода» — здесь это явный middleware на конкретном роуте,
// тот же эффект, тот же текст ошибки для отладки на фронте.
func RequireRoles(roles ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if len(roles) == 0 {
			c.Next()
			return
		}
		user := CurrentUser(c)
		if len(user.Roles) == 0 {
			common.Fail(c, http.StatusForbidden, "FORBIDDEN", "Access denied: user has no roles assigned")
			return
		}
		for _, r := range user.Roles {
			if r == "admin" {
				c.Next()
				return
			}
		}
		for _, need := range roles {
			for _, have := range user.Roles {
				if need == have {
					c.Next()
					return
				}
			}
		}
		common.Fail(c, http.StatusForbidden, "FORBIDDEN",
			"Access denied: required role(s): ["+strings.Join(roles, ", ")+"], user has: ["+strings.Join(user.Roles, ", ")+"]")
	}
}
