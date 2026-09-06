package common

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// IsUUID — строка похожа на UUID (все id в схеме — uuid).
func IsUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil
}

// RequireUUIDParams — параметры маршрута вида :id / :orderId / :articleId
// обязаны быть UUID. Иначе значение уходило в SQL как есть, Postgres
// отвечал «invalid input syntax for type uuid», и клиент получал 500
// «Ошибка базы данных» вместо 404 (пустой id в «/orders//status»,
// «/orders/not-a-uuid» — проверка перед пилотом, 06.09.2026).
func RequireUUIDParams() gin.HandlerFunc {
	return func(c *gin.Context) {
		for _, p := range c.Params {
			if p.Key != "id" && !strings.HasSuffix(p.Key, "Id") {
				continue
			}
			if !IsUUID(p.Value) {
				Fail(c, http.StatusNotFound, "NOT_FOUND", "Запись "+p.Key+"="+p.Value+" не найдена")
				return
			}
		}
		c.Next()
	}
}
