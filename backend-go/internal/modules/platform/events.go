// Перенос events.controller.ts — SSE-поток доменных событий
// (article:cost_updated, batch:override_requested, batch:reservation_expiring).
// EventSource не умеет ставить Authorization, поэтому токен приходит
// query-параметром и проверяется вручную тем же секретом, что JwtAuthGuard.
package platform

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/events"
)

type EventsHandler struct{}

func NewEventsHandler() *EventsHandler { return &EventsHandler{} }

// Stream — GET /events/stream?token= (публичный роут, @Sse('stream')).
// jwt.verify(token ?? "", JWT_SECRET) → иначе 401 INVALID_TOKEN.
func (h *EventsHandler) Stream(c *gin.Context) {
	token, err := jwt.Parse(c.Query("token"), func(t *jwt.Token) (interface{}, error) {
		return []byte(auth.Secret()), nil
	})
	if err != nil || !token.Valid {
		common.Fail(c, http.StatusUnauthorized, "INVALID_TOKEN", "Нужен действующий токен")
		return
	}

	ch, cancel := events.Subscribe()
	defer cancel()

	w := c.Writer
	// Тот же набор заголовков, что у SseStream Nest (сверено curl -D по живому :3000)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0, no-transform")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expire", "0")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	w.Flush()

	ctx := c.Request.Context()
	for {
		select {
		case <-ctx.Done():
			// клиент отключился (EventSource переживает обрывы сам и переподключится)
			return
		case ev := <-ch:
			// map((e) => ({ data: { type: e.type, ...e.data } })) → "data: <json>\n\n"
			payload := make(map[string]interface{}, len(ev.Data)+1)
			payload["type"] = ev.Type
			for k, v := range ev.Data {
				payload[k] = v
			}
			body, err := json.Marshal(payload)
			if err != nil {
				continue
			}
			if _, err := w.Write([]byte("data: " + string(body) + "\n\n")); err != nil {
				return
			}
			w.Flush()
		}
	}
}
