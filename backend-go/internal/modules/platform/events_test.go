package platform

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/events"
)

func TestStream(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/events/stream", NewEventsHandler().Stream)
	srv := httptest.NewServer(r)
	defer srv.Close()

	// без токена / с мусором → 401 INVALID_TOKEN
	for _, q := range []string{"", "?token=abc"} {
		resp, err := http.Get(srv.URL + "/events/stream" + q)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(string(body), `"INVALID_TOKEN"`) {
			t.Fatalf("%q: ждали 401 INVALID_TOKEN, получили %d %s", q, resp.StatusCode, body)
		}
	}

	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"userId": "usr-test", "email": "t@example.local", "roles": []string{"admin"},
		"exp": time.Now().Add(time.Minute).Unix(),
	}).SignedString([]byte(auth.Secret()))
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/events/stream?token="+token, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("ждали 200 text/event-stream, получили %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}

	// Подписка оформляется ДО отправки заголовков — раз заголовки пришли, Emit уже дойдёт
	events.Emit("article:cost_updated", map[string]interface{}{"articleId": "a1", "trigger": "test"})

	reader := bufio.NewReader(resp.Body)
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	want := `data: {"articleId":"a1","trigger":"test","type":"article:cost_updated"}` + "\n"
	if line != want {
		t.Fatalf("кадр SSE:\n got %q\nwant %q", line, want)
	}
	if blank, _ := reader.ReadString('\n'); blank != "\n" {
		t.Fatalf("после data ждали пустую строку, получили %q", blank)
	}
	cancel() // отключение клиента завершает цикл хендлера
}
