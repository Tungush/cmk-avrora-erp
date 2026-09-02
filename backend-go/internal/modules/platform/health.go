package platform

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
)

// HealthHandler — GET /api/v1/health для Docker HEALTHCHECK и мониторинга.
// В NestJS такой ручки не было: добавлена вместе с образом (02.09.2026).
// Публичная, без токена; проверяет живость базы коротким ping.
type HealthHandler struct{ pool *pgxpool.Pool }

func NewHealthHandler(pool *pgxpool.Pool) *HealthHandler { return &HealthHandler{pool: pool} }

func (h *HealthHandler) Health(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()
	if err := h.pool.Ping(ctx); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "degraded", "db": "unreachable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "db": "ok"})
}
