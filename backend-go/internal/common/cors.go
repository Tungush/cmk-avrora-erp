package common

import (
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

// CORS — эквивалент app.enableCors() в NestJS без опций (пакет `cors` с
// настройками по умолчанию): любой origin, стандартный набор методов,
// заголовки preflight отражаются из запроса, preflight отвечает 204.
//
// CORS_ORIGINS (через запятую) сужает список, когда фронт живёт на другом
// домене — например `https://cmk-avrora-erp.vercel.app`. Токен лежит в
// localStorage, а не в cookie, поэтому «*» дыры не создаёт, но список
// доменов оставляет меньше поверхности. Пусто — прежнее поведение «*».
// Разрешать credentials не нужно: авторизация идёт заголовком Bearer.
func CORS() gin.HandlerFunc {
	var allowed []string
	for _, o := range strings.Split(os.Getenv("CORS_ORIGINS"), ",") {
		if o = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(o), "/")); o != "" {
			allowed = append(allowed, o)
		}
	}

	return func(c *gin.Context) {
		origin := strings.TrimSuffix(c.GetHeader("Origin"), "/")
		switch {
		case len(allowed) == 0:
			c.Header("Access-Control-Allow-Origin", "*")
		case origin == "":
			// Запрос не из браузера (curl, 1С, мониторинг) — заголовок не нужен
		default:
			for _, a := range allowed {
				if a == origin {
					c.Header("Access-Control-Allow-Origin", origin)
					// Ответ зависит от Origin — иначе CDN/прокси отдаст его чужому домену
					c.Writer.Header().Add("Vary", "Origin")
					break
				}
			}
		}

		if c.Request.Method == http.MethodOptions {
			c.Header("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE")
			if h := c.GetHeader("Access-Control-Request-Headers"); h != "" {
				c.Header("Access-Control-Allow-Headers", h)
			}
			c.Writer.Header().Add("Vary", "Access-Control-Request-Headers")
			c.Header("Content-Length", "0")
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
