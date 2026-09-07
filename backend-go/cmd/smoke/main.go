// Дымовой прогон работающего сервиса.
//
//	npm run smoke                          # http://localhost:3000
//	npm run smoke -- http://localhost:3100 # локальная разработка
//	docker exec erp_api_pilot /app/smoke   # на сервере, где нет тулчейна
//
// Проверяет: здоровье и базу, отказ без токена и с чужой подписью, JSON-конверт
// ошибок, раздачу интерфейса, около шестидесяти ручек всех разделов, чтение по
// идентификаторам и разделение прав между админом и сменным аккаунтом.
// В базу ничего не пишет — можно гонять на боевом сервере после обновления.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
)

var (
	base    string
	client  = &http.Client{Timeout: 20 * time.Second}
	passed  int
	failed  int
	verbose bool
)

func mint(userID, email string, roles []string) string {
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"userId": userID, "email": email, "roles": roles,
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	s, err := tok.SignedString([]byte(auth.Secret()))
	if err != nil {
		fmt.Println("не удалось подписать токен:", err)
		os.Exit(2)
	}
	return s
}

type resp struct {
	status int
	body   string
	ctype  string
	took   time.Duration
	err    error
}

func call(method, path, token string) resp {
	req, err := http.NewRequest(method, base+path, nil)
	if err != nil {
		return resp{err: err}
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	start := time.Now()
	r, err := client.Do(req)
	if err != nil {
		return resp{err: err, took: time.Since(start)}
	}
	defer r.Body.Close()
	body, _ := io.ReadAll(r.Body)
	return resp{status: r.StatusCode, body: string(body), ctype: r.Header.Get("Content-Type"), took: time.Since(start)}
}

func get(path, token string) resp { return call(http.MethodGet, path, token) }

func ok(what string, extra string) {
	passed++
	if verbose {
		fmt.Printf("  ok      %s%s\n", what, extra)
	}
}

func fail(what, why string) {
	failed++
	fmt.Printf("  ПРОВАЛ  %s\n          %s\n", what, why)
}

func short(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 160 {
		return s[:160] + "…"
	}
	return s
}

// errorCode достаёт error.code из конверта {"error":{"code","message"}}
func errorCode(body string) string {
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal([]byte(body), &env)
	return env.Error.Code
}

func expectJSON200(path, token string) {
	r := get(path, token)
	switch {
	case r.err != nil:
		fail(path, "сервер не ответил: "+r.err.Error())
	case r.status != 200:
		fail(path, fmt.Sprintf("код %d: %s", r.status, short(r.body)))
	case !json.Valid([]byte(r.body)):
		fail(path, "тело не JSON: "+short(r.body))
	case strings.Contains(r.body, "undefined") || strings.Contains(r.body, "NaN"):
		fail(path, "в ответе «undefined» или «NaN»")
	case r.took > 5*time.Second:
		fail(path, fmt.Sprintf("%s — медленнее пяти секунд", r.took.Round(time.Millisecond)))
	default:
		if r.took > 2*time.Second {
			fmt.Printf("  медленно %s — %s\n", path, r.took.Round(time.Millisecond))
		}
		ok(path, fmt.Sprintf(" (%s)", r.took.Round(time.Millisecond)))
	}
}

var reads = []string{
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

// firstID — идентификатор первой записи списка ({"data":[…]} или […])
func firstID(path, token string) string {
	r := get(path, token)
	if r.err != nil || r.status != 200 {
		return ""
	}
	var env struct {
		Data []map[string]any `json:"data"`
	}
	if json.Unmarshal([]byte(r.body), &env) == nil && len(env.Data) > 0 {
		if id, _ := env.Data[0]["id"].(string); id != "" {
			return id
		}
	}
	var arr []map[string]any
	if json.Unmarshal([]byte(r.body), &arr) == nil && len(arr) > 0 {
		if id, _ := arr[0]["id"].(string); id != "" {
			return id
		}
	}
	return ""
}

func main() {
	flag.BoolVar(&verbose, "v", false, "печатать каждую успешную проверку")
	flag.Parse()

	// В контейнере переменные приходят из compose, на машине разработки — из backend/.env
	common.LoadDotEnv("../backend/.env")
	common.LoadDotEnv("backend/.env")

	base = strings.TrimRight(flag.Arg(0), "/")
	if base == "" {
		base = strings.TrimRight(os.Getenv("SMOKE_BASE_URL"), "/")
	}
	if base == "" {
		base = "http://localhost:3000"
	}
	fmt.Printf("Дымовой прогон: %s\n\n", base)

	admin := mint("usr-smoke-admin", "smoke-admin@local", []string{"admin"})
	shift := mint("usr-smoke-shift", "smoke-shift@local", []string{"shop_foreman", "warehouse_material", "engineer"})

	fmt.Println("Здоровье и доступ")
	health := get("/api/v1/health", "")
	if health.err != nil {
		fmt.Printf("  ПРОВАЛ  /api/v1/health\n          сервер %s не отвечает: %v\n", base, health.err)
		fmt.Println("\nПоднят ли сервис? npm run pilot, затем npm run pilot:logs")
		os.Exit(1)
	}
	var h map[string]string
	if health.status != 200 || json.Unmarshal([]byte(health.body), &h) != nil || h["status"] != "ok" || h["db"] != "ok" {
		fail("/api/v1/health", fmt.Sprintf("код %d: %s", health.status, short(health.body)))
	} else {
		ok("/api/v1/health", "")
	}

	if r := call(http.MethodHead, "/api/v1/health", ""); r.status == 200 {
		ok("HEAD /api/v1/health", "")
	} else {
		fail("HEAD /api/v1/health", fmt.Sprintf("код %d", r.status))
	}

	if r := get("/api/v1/orders", ""); r.status == 401 && errorCode(r.body) == "UNAUTHORIZED" {
		ok("без токена — 401", "")
	} else {
		fail("без токена", fmt.Sprintf("ожидали 401 UNAUTHORIZED, получили %d: %s", r.status, short(r.body)))
	}

	alien := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"userId": "x", "roles": []string{"admin"}, "exp": time.Now().Add(time.Hour).Unix(),
	})
	alienStr, _ := alien.SignedString([]byte("чужой-секрет"))
	if r := get("/api/v1/orders", alienStr); r.status == 401 {
		ok("чужая подпись — 401", "")
	} else {
		fail("чужая подпись", fmt.Sprintf("ожидали 401, получили %d", r.status))
	}

	if r := get("/api/v1/nope", admin); r.status == 404 && errorCode(r.body) != "" {
		ok("неизвестный маршрут — 404 JSON", "")
	} else {
		fail("/api/v1/nope", fmt.Sprintf("ожидали 404 с JSON-конвертом, получили %d: %s", r.status, short(r.body)))
	}

	if r := get("/api/v1/orders/не-uuid", admin); r.status == 404 {
		ok("кривой идентификатор — 404", "")
	} else {
		fail("/orders/не-uuid", fmt.Sprintf("ожидали 404, получили %d", r.status))
	}

	// Интерфейс раздаётся только там, где задан STATIC_DIR (образ), не на dev-сервере :3100
	if os.Getenv("SMOKE_SPA") != "0" && !strings.Contains(base, ":3100") {
		for _, p := range []string{"/", "/orders"} {
			r := get(p, "")
			if r.status == 200 && strings.Contains(r.ctype, "text/html") && strings.Contains(strings.ToLower(r.body), "<!doctype html") {
				ok("интерфейс "+p, "")
			} else {
				fail("интерфейс "+p, fmt.Sprintf("код %d, тип %s — задан ли STATIC_DIR?", r.status, r.ctype))
			}
		}
	}

	fmt.Println("\nПрава ролей")
	if r := get("/api/v1/auth/me", shift); r.status == 200 {
		ok("сменный аккаунт входит", "")
	} else {
		fail("/auth/me сменным", fmt.Sprintf("код %d", r.status))
	}
	if r := get("/api/v1/users", shift); r.status == 403 {
		ok("пользователи закрыты от смены", "")
	} else {
		fail("/users сменным", fmt.Sprintf("ожидали 403, получили %d", r.status))
	}
	if r := get("/api/v1/dashboards/cash-forecast", shift); r.status == 403 {
		ok("деньги закрыты от смены", "")
	} else {
		fail("/dashboards/cash-forecast сменным", fmt.Sprintf("ожидали 403, получили %d", r.status))
	}
	if r := get("/api/v1/orders?page=1&pageSize=1", shift); r.status == 200 {
		ok("заказы открыты смене", "")
	} else {
		fail("/orders сменным", fmt.Sprintf("код %d", r.status))
	}

	fmt.Println("\nЧтение по разделам")
	for _, p := range reads {
		expectJSON200("/api/v1"+p, admin)
	}

	fmt.Println("\nЧтение по идентификаторам")
	order := firstID("/api/v1/orders?page=1&pageSize=1", admin)
	article := firstID("/api/v1/articles?page=1&pageSize=1", admin)
	material := firstID("/api/v1/materials?page=1&pageSize=1", admin)
	if order == "" || article == "" || material == "" {
		fail("справочники", fmt.Sprintf("база пуста: заказ %q, изделие %q, материал %q", order, article, material))
	} else {
		for _, p := range []string{
			"/orders/" + order, "/orders/" + order + "/customer-payments", "/orders/" + order + "/material-availability",
			"/orders/" + order + "/contractor-work", "/warehouse/offcuts/for-order/" + order,
			"/articles/" + article, "/articles/" + article + "/bom", "/articles/" + article + "/routing",
			"/articles/" + article + "/routing/costing", "/articles/" + article + "/routing/usage",
			"/articles/" + article + "/routing/history", "/nkt/cards/" + article,
			"/materials/" + material, "/warehouse/materials/" + material + "/movements",
			"/material-batches/" + material, "/batch-reservations/availability/" + material,
		} {
			expectJSON200("/api/v1"+p, admin)
		}
	}

	fmt.Printf("\nПроверок пройдено: %d, провалов: %d\n", passed, failed)
	if failed == 0 {
		fmt.Println("Сервис отвечает корректно.")
		return
	}
	os.Exit(1)
}
