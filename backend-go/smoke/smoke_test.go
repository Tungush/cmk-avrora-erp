// Дымовой прогон живого сервера (`npm run smoke [адрес]`, см. scripts/smoke.mjs).
//
// Что проверяет: здоровье, вход без токена и с чужим токеном, JSON-конверт
// ошибок, раздачу фронтенда, и что ~60 основных GET-ручек всех разделов
// отвечают 200 валидным JSON быстрее 5 с. В базу ничего не пишет — можно
// гонять на боевом сервере после каждого обновления.
//
// Пропускается без SMOKE_BASE_URL (обычный `go test ./...` его не трогает).
// SMOKE_SPA=0 — не требовать раздачи фронтенда (локальный dev на :3100).
package smoke

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"cmk-avrora-erp/backend-go/internal/auth"
)

var base = strings.TrimRight(os.Getenv("SMOKE_BASE_URL"), "/")

func TestMain(m *testing.M) {
	if base == "" {
		fmt.Println("SMOKE_BASE_URL не задан — дымовой прогон пропущен")
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func mint(t *testing.T, userID, email string, roles []string) string {
	t.Helper()
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"userId": userID, "email": email, "roles": roles,
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	s, err := tok.SignedString([]byte(auth.Secret()))
	if err != nil {
		t.Fatalf("не удалось подписать токен: %v", err)
	}
	return s
}

func adminToken(t *testing.T) string {
	return mint(t, "usr-smoke-admin", "smoke-admin@local", []string{"admin"})
}

type resp struct {
	status int
	body   []byte
	ctype  string
	dur    time.Duration
}

var client = &http.Client{Timeout: 20 * time.Second}

func call(t *testing.T, method, path, token string) resp {
	t.Helper()
	req, err := http.NewRequest(method, base+path, nil)
	if err != nil {
		t.Fatalf("запрос %s: %v", path, err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	start := time.Now()
	r, err := client.Do(req)
	if err != nil {
		t.Fatalf("сервер %s недоступен (%s): %v", base, path, err)
	}
	defer r.Body.Close()
	body, _ := io.ReadAll(r.Body)
	return resp{status: r.StatusCode, body: body, ctype: r.Header.Get("Content-Type"), dur: time.Since(start)}
}

func get(t *testing.T, path, token string) resp { return call(t, http.MethodGet, path, token) }

// errorCode достаёт error.code из JSON-конверта {"error":{"code","message"}}
func errorCode(body []byte) string {
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &env)
	return env.Error.Code
}

func TestHealth(t *testing.T) {
	r := get(t, "/api/v1/health", "")
	if r.status != 200 {
		t.Fatalf("health: %d %s", r.status, r.body)
	}
	var h map[string]string
	if err := json.Unmarshal(r.body, &h); err != nil || h["status"] != "ok" || h["db"] != "ok" {
		t.Fatalf("health: ожидали {status:ok, db:ok}, получили %s", r.body)
	}
	if hr := call(t, http.MethodHead, "/api/v1/health", ""); hr.status != 200 {
		t.Errorf("HEAD /health: %d", hr.status)
	}
}

func TestAuthRequired(t *testing.T) {
	if r := get(t, "/api/v1/orders", ""); r.status != 401 || errorCode(r.body) != "UNAUTHORIZED" {
		t.Errorf("без токена ожидали 401 UNAUTHORIZED, получили %d %s", r.status, r.body)
	}
	if r := get(t, "/api/v1/orders", "abc.def.ghi"); r.status != 401 || errorCode(r.body) != "INVALID_TOKEN" {
		t.Errorf("с мусорным токеном ожидали 401 INVALID_TOKEN, получили %d %s", r.status, r.body)
	}
	// Токен, подписанный другим секретом, не должен проходить
	other := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"userId": "x", "roles": []string{"admin"}, "exp": time.Now().Add(time.Hour).Unix()})
	s, _ := other.SignedString([]byte("not-the-server-secret"))
	if r := get(t, "/api/v1/orders", s); r.status != 401 {
		t.Errorf("чужая подпись: ожидали 401, получили %d", r.status)
	}
}

func TestUnknownRoute(t *testing.T) {
	r := get(t, "/api/v1/nope", adminToken(t))
	if r.status != 404 || errorCode(r.body) != "Not Found" {
		t.Errorf("неизвестный маршрут: ожидали 404 JSON {error.code:'Not Found'}, получили %d %s", r.status, r.body)
	}
}

func TestSPA(t *testing.T) {
	if os.Getenv("SMOKE_SPA") == "0" {
		t.Skip("SMOKE_SPA=0")
	}
	for _, p := range []string{"/", "/orders", "/production/kanban"} {
		r := get(t, p, "")
		if r.status != 200 || !strings.Contains(r.ctype, "text/html") || !strings.Contains(strings.ToLower(string(r.body)), "<!doctype html") {
			t.Errorf("%s: фронтенд не раздаётся (%d %s) — STATIC_DIR не задан?", p, r.status, r.ctype)
		}
	}
}

func TestRoleGuards(t *testing.T) {
	shift := mint(t, "usr-smoke-shift", "smoke-shift@local", []string{"shop_foreman", "warehouse_material", "engineer"})
	if r := get(t, "/api/v1/auth/me", shift); r.status != 200 && r.status != 201 {
		t.Errorf("/auth/me сменной ролью: %d %s", r.status, r.body)
	}
	if r := get(t, "/api/v1/users", shift); r.status != 403 {
		t.Errorf("/users не-админом: ожидали 403, получили %d", r.status)
	}
	if r := get(t, "/api/v1/orders?page=1&pageSize=1", shift); r.status != 200 {
		t.Errorf("/orders сменной ролью: %d %s", r.status, r.body)
	}
}

// Основные списки и сводки каждого раздела — 200, валидный JSON, быстрее 5 с
var adminReads = []string{
	"/auth/me",
	"/orders?page=1&pageSize=5", "/orders/inbox", "/orders/sites", "/orders-dashboard",
	"/articles?page=1&pageSize=5", "/articles/gaps", "/articles/price-digest",
	"/materials?page=1&pageSize=5", "/customers?page=1&pageSize=5",
	"/dashboards/director", "/dashboards/role-widgets", "/dashboards/monthly-series",
	"/dashboards/production-summary", "/dashboards/finished-goods-summary",
	"/dashboards/cash-forecast", "/dashboards/workload-forecast",
	"/payment-documents?page=1&pageSize=5", "/payment-documents/customer-debts",
	"/payment-documents/receivables", "/payment-documents/reconciliation", "/credit-lines",
	"/purchases/dashboard", "/purchases/documents", "/purchase-requests",
	"/contractor-requests", "/contractor-work", "/contractors",
	"/production-plan", "/production-plan/matrix", "/production-plan/shop-floor", "/production-plan/weekly",
	"/warehouse/materials/balance", "/warehouse/finished-goods", "/warehouse/finished-goods/balance",
	"/warehouse/offcuts", "/warehouse/receipts", "/warehouse/warehouses", "/min-stock-levels",
	"/material-batches/anomalies", "/batch-reservations/expiring", "/batch-reservations/overrides",
	"/price-reviews", "/work-centers", "/costing-config",
	"/users", "/users/roles", "/saved-views", "/audit-log",
	"/search?q=труба", "/integrations/status", "/integrations/messages",
	"/nkt/status", "/nkt/summary", "/nkt/cards", "/nkt/categories",
	"/deals", "/nomenclature-requests", "/nomenclature/duplicates", "/nomenclature/stalled-requests",
	"/acceptance-acts",
}

func checkJSON200(t *testing.T, path string, r resp) {
	t.Helper()
	if r.status != 200 {
		t.Errorf("%s: %d %s", path, r.status, truncate(r.body))
		return
	}
	if !json.Valid(r.body) {
		t.Errorf("%s: тело не JSON: %s", path, truncate(r.body))
		return
	}
	if s := string(r.body); strings.Contains(s, "undefined") || strings.Contains(s, "NaN") {
		t.Errorf("%s: в ответе «undefined»/«NaN»", path)
	}
	if r.dur > 5*time.Second {
		t.Errorf("%s: %s — медленнее 5 с", path, r.dur.Round(time.Millisecond))
	} else if r.dur > 2*time.Second {
		t.Logf("%s: %s — медленнее 2 с, стоит посмотреть", path, r.dur.Round(time.Millisecond))
	}
}

func truncate(b []byte) string {
	s := string(b)
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}

func TestAdminReads(t *testing.T) {
	tok := adminToken(t)
	for _, p := range adminReads {
		p := p
		t.Run(p, func(t *testing.T) { checkJSON200(t, p, get(t, "/api/v1"+p, tok)) })
	}
}

// firstID берёт id первой записи из списка ({"data":[…]} или […])
func firstID(t *testing.T, path, tok string) string {
	t.Helper()
	r := get(t, "/api/v1"+path, tok)
	if r.status != 200 {
		t.Fatalf("%s: %d %s", path, r.status, truncate(r.body))
	}
	var env struct {
		Data []map[string]any `json:"data"`
	}
	var arr []map[string]any
	if err := json.Unmarshal(r.body, &env); err == nil && len(env.Data) > 0 {
		id, _ := env.Data[0]["id"].(string)
		return id
	}
	if err := json.Unmarshal(r.body, &arr); err == nil && len(arr) > 0 {
		id, _ := arr[0]["id"].(string)
		return id
	}
	return ""
}

func TestByIdReads(t *testing.T) {
	tok := adminToken(t)
	order := firstID(t, "/orders?page=1&pageSize=1", tok)
	article := firstID(t, "/articles?page=1&pageSize=1", tok)
	material := firstID(t, "/materials?page=1&pageSize=1", tok)
	customer := firstID(t, "/customers?page=1&pageSize=1", tok)
	doc := firstID(t, "/payment-documents?page=1&pageSize=1", tok)
	if order == "" || article == "" || material == "" {
		t.Fatalf("пустые справочники: заказ=%q изделие=%q материал=%q — база не заполнена?", order, article, material)
	}
	paths := []string{
		"/orders/" + order, "/orders/" + order + "/customer-payments", "/orders/" + order + "/material-availability",
		"/orders/" + order + "/contractor-work", "/warehouse/offcuts/for-order/" + order,
		"/articles/" + article, "/articles/" + article + "/bom", "/articles/" + article + "/routing",
		"/articles/" + article + "/routing/costing", "/articles/" + article + "/routing/usage",
		"/articles/" + article + "/routing/history", "/articles/" + article + "/routing/costing/history",
		"/nkt/cards/" + article,
		"/materials/" + material, "/warehouse/materials/" + material + "/movements",
		"/material-batches/" + material, "/batch-reservations/availability/" + material,
	}
	if customer != "" {
		paths = append(paths, "/customers/"+customer)
	}
	if doc != "" {
		paths = append(paths, "/payment-documents/"+doc)
	}
	for _, p := range paths {
		p := p
		t.Run(p, func(t *testing.T) { checkJSON200(t, p, get(t, "/api/v1"+p, tok)) })
	}
	// Позиции заказа → калькуляции позиции
	r := get(t, "/api/v1/orders/"+order, tok)
	var o struct {
		OrderLines []struct {
			ID string `json:"id"`
		} `json:"orderLines"`
	}
	if json.Unmarshal(r.body, &o) == nil && len(o.OrderLines) > 0 {
		p := "/order-lines/" + o.OrderLines[0].ID + "/costings"
		t.Run(p, func(t *testing.T) { checkJSON200(t, p, get(t, "/api/v1"+p, tok)) })
	}
}
