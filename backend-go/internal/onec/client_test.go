package onec

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"cmk-avrora-erp/backend-go/internal/common"
)

func attemptsString(as []LookupAttempt) string {
	parts := make([]string, len(as))
	for i, a := range as {
		y := "-"
		if a.Year != nil {
			y = *a.Year
		}
		parts[i] = a.Kind + ":" + a.Num + ":" + y
	}
	return strings.Join(parts, " | ")
}

// Четыре формата из комментария оригинала + обрезка + пустой номер.
func TestLookupAttempts(t *testing.T) {
	cases := map[string]string{
		"Т7АА-002345-2026": "onec:Т7АА-002345:2026 | adem:Т7АА-002345-2026:-",
		"П-100014-22":      "adem:П-100014-22:-",
		"LVАА-000135":      "onec:LVАА-000135:- | adem:LVАА-000135:-",
		"1151185":          "adem:1151185:-",
		"  1151185 ":       "adem:1151185:-",
		"A-2020-2021":      "onec:A-2020:2021 | adem:A-2020-2021:-",
		"2026":             "adem:2026:-",
		"X-12":             "adem:X-12:-",
		"":                 "",
		"   ":              "",
	}
	for in, want := range cases {
		if got := attemptsString(LookupAttempts(in)); got != want {
			t.Errorf("LookupAttempts(%q) = %q, want %q", in, got, want)
		}
	}
	if got := LookupAttempts(""); got == nil || len(got) != 0 {
		t.Errorf("empty number must yield an empty (non-nil) slice, got %#v", got)
	}
}

func TestParseOrderNumber(t *testing.T) {
	if a := ParseOrderNumber("Т7АА-002345-2026"); a.Kind != "onec" || a.Num != "Т7АА-002345" || a.Year == nil || *a.Year != "2026" {
		t.Errorf("unexpected %+v", a)
	}
	// Фолбэк берёт сырой, не обрезанный номер
	if a := ParseOrderNumber("  "); a.Kind != "adem" || a.Num != "  " || a.Year != nil {
		t.Errorf("unexpected fallback %+v", a)
	}
}

func TestJsNumber(t *testing.T) {
	cases := map[float64]string{
		0: "0", 1151185: "1151185", 0.5: "0.5", 123.45: "123.45", -2: "-2",
		1e21: "1e+21", 1e20: "100000000000000000000", 1e-7: "1e-7", 0.000001: "0.000001",
		1.5e-7: "1.5e-7", 12345678901234567890: "12345678901234567000",
	}
	for in, want := range cases {
		if got := jsNumber(in); got != want {
			t.Errorf("jsNumber(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestFormEncodeAndQuery(t *testing.T) {
	if got := formEncode("П-100014-22 a*b~c"); got != "%D0%9F-100014-22+a*b%7Ec" {
		t.Errorf("formEncode = %q", got)
	}
	q := encodeQuery(map[string]string{"clientorder_year": "2026", "clientorder_num": "Т7", "empty": ""})
	if q != "clientorder_num=%D0%A27&clientorder_year=2026" {
		t.Errorf("encodeQuery = %q", q)
	}
}

func TestParseJSONKeepsKeyOrder(t *testing.T) {
	v, err := parseJSON(`{"z":1,"a":[{"y":null,"b":"x"}],"z":2}`)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(v)
	if string(b) != `{"z":2,"a":[{"y":null,"b":"x"}]}` {
		t.Errorf("marshal = %s", b)
	}
	if _, err := parseJSON(`{"a":1} x`); err == nil {
		t.Error("trailing garbage must not parse")
	}
	if jsSlice("aé😀b", 3) != "aé" || jsSlice("abc", 10) != "abc" {
		t.Error("jsSlice must count UTF-16 units")
	}
}

func TestNotConfigured(t *testing.T) {
	t.Setenv("ONEC_BASE_URL", "")
	c := NewClient()
	ok, msg := c.Ping(context.Background(), "П-100014-22")
	if ok || msg != NotConfiguredMessage {
		t.Errorf("ping = %v %q", ok, msg)
	}
	_, err := c.GetTurnover(context.Background(), "1151185")
	if !errors.Is(err, NotConfiguredError{}) || !errors.Is(err, &NotConfiguredError{}) {
		t.Errorf("expected NotConfiguredError, got %v", err)
	}
	var nc NotConfiguredError
	if !errors.As(err, &nc) {
		t.Error("errors.As must match the value form")
	}
	if api := nc.APIError(); api.Code != "ONEC_NOT_CONFIGURED" || api.Error() != NotConfiguredMessage {
		t.Errorf("api error %+v", api)
	}
	var _ error = (*common.APIError503)(nil)
	// Пустой номер — нет попыток, значит и ошибки «не настроено» нет
	rows, err := c.GetClientOrder(context.Background(), "   ")
	if err != nil || rows == nil || len(rows) != 0 {
		t.Errorf("blank number: rows=%#v err=%v", rows, err)
	}
	ok, msg = c.Ping(context.Background(), "")
	if !ok || msg != "Ответ получен: 0 запис(и)" {
		t.Errorf("blank ping = %v %q", ok, msg)
	}
}

type call struct {
	path, query, auth, accept string
}

func newServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*httptest.Server, *[]call) {
	calls := &[]call{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls = append(*calls, call{r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), r.Header.Get("Accept")})
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ONEC_BASE_URL", srv.URL+"/") // хвостовой слэш срезается
	t.Setenv("ONEC_LOGIN", "1С_ERP_709")
	t.Setenv("ONEC_PASSWORD", "pw")
	t.Setenv("ONEC_TURNOVER_LOGIN", "turn")
	t.Setenv("ONEC_TURNOVER_PASSWORD", "tpw")
	return srv, calls
}

func TestGetClientOrderFallsBackToSecondAttempt(t *testing.T) {
	_, calls := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("clientorder_adem") != "" {
			_, _ = w.Write([]byte("\xef\xbb\xbf[{\"clientorder_num\":\"X\",\"items\":[{\"qty\":\"1.50\"}],\"n\":1151185}, null]"))
			return
		}
		_, _ = w.Write([]byte("   ")) // пустое тело → []
	})
	c := NewClient()
	rows, err := c.GetClientOrder(context.Background(), "Т7АА-002345-2026")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0]["clientorder_num"] != "X" || rows[0]["n"] != float64(1151185) {
		t.Errorf("rows = %#v", rows)
	}
	if len(*calls) != 2 {
		t.Fatalf("calls = %#v", *calls)
	}
	first, second := (*calls)[0], (*calls)[1]
	if first.path != "/erp/hs/fm/orders" || first.query != "clientorder_num=%D0%A27%D0%90%D0%90-002345&clientorder_year=2026" {
		t.Errorf("first call %+v", first)
	}
	year := strconv.Itoa(time.Now().Year())
	if second.query != "clientorder_adem=%D0%A27%D0%90%D0%90-002345-2026&clientorder_year="+year {
		t.Errorf("second call %+v", second)
	}
	// Basic из UTF-8 (кириллический логин), не turnover-учётка
	if first.auth != "Basic MdCh X0VSUF83MDk6cHc=" && first.auth != "Basic "+b64("1С_ERP_709:pw") {
		t.Errorf("auth = %q", first.auth)
	}
	if first.accept != "application/json" {
		t.Errorf("accept = %q", first.accept)
	}

	raw := c.LastRaw()
	entry, ok := raw["/erp/hs/fm/orders"].(map[string]interface{})
	if !ok {
		t.Fatalf("lastRaw = %#v", raw)
	}
	b, _ := json.Marshal(entry)
	s := string(b)
	if !strings.Contains(s, `"params":{"clientorder_adem":"Т7АА-002345-2026","clientorder_year":"`+year+`"}`) ||
		!strings.Contains(s, `"sample":{"clientorder_num":"X","items":[{"qty":"1.50"}],"n":1151185}`) ||
		!strings.Contains(s, `"at":"`) || !strings.HasSuffix(entry["at"].(string), "Z") || len(entry["at"].(string)) != 24 {
		t.Errorf("lastRaw entry = %s", s)
	}
}

func b64(s string) string {
	const tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var out []byte
	b := []byte(s)
	for i := 0; i < len(b); i += 3 {
		var n uint32
		rem := len(b) - i
		for j := 0; j < 3; j++ {
			n <<= 8
			if j < rem {
				n |= uint32(b[i+j])
			}
		}
		for j := 0; j < 4; j++ {
			if j <= rem {
				out = append(out, tbl[(n>>(18-6*uint(j)))&63])
			} else {
				out = append(out, '=')
			}
		}
	}
	return string(out)
}

func TestErrorCarrierAndLastError(t *testing.T) {
	_, calls := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("supplier_invoice_adem") != "" {
			_, _ = w.Write([]byte(`[{"error":"Заказ поставщику не найден"}]`))
			return
		}
		_, _ = w.Write([]byte(`{"error": null, "Error": 12.5}`))
	})
	c := NewClient()
	year := "2024"
	_, err := c.GetSupplierOrder(context.Background(), "LVАА-000135", &year)
	if err == nil || err.Error() != "1С /erp/hs/TurnOver/v1/get_c: Заказ поставщику не найден" {
		t.Errorf("err = %v", err)
	}
	if len(*calls) != 2 || (*calls)[0].query != "supplier_invoice_num=LV%D0%90%D0%90-000135&supplier_invoice_year=2024" ||
		(*calls)[1].query != "supplier_invoice_adem=LV%D0%90%D0%90-000135" {
		t.Errorf("calls = %#v", *calls)
	}
	if (*calls)[0].auth != "Basic "+b64("turn:tpw") {
		t.Errorf("turnover auth = %q", (*calls)[0].auth)
	}
	if len(c.LastRaw()) != 0 {
		t.Error("failed attempts must not be remembered")
	}
	// Первая попытка: error null → смотрим Error (число 12.5 → "12.5")
	c2 := NewClient()
	_, err = c2.GetTurnover(context.Background(), "LVАА-000135")
	if err == nil || !strings.HasPrefix(err.Error(), "1С /erp/hs/TurnOver/v1/get_d: ") {
		t.Errorf("err = %v", err)
	}
}

func TestHTTPErrorsAndNonJSON(t *testing.T) {
	mode := "500"
	_, _ = newServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch mode {
		case "500":
			w.WriteHeader(500)
			_, _ = w.Write([]byte(strings.Repeat("я", 400)))
		case "html":
			_, _ = w.Write([]byte("<html>oops"))
		case "scalar":
			_, _ = w.Write([]byte("null"))
		}
	})
	c := NewClient()
	_, err := c.GetInvoices(context.Background(), "1151185")
	if err == nil || err.Error() != "1С /erp/hs/fm/invoices вернула 500: "+strings.Repeat("я", 300) {
		t.Errorf("500 err = %v", err)
	}
	mode = "html"
	_, err = c.GetInvoices(context.Background(), "1151185")
	if err == nil || err.Error() != "1С /erp/hs/fm/invoices: ответ не JSON — <html>oops" {
		t.Errorf("html err = %v", err)
	}
	mode = "scalar"
	rows, err := c.GetInvoices(context.Background(), "П-100014-22")
	if err != nil || len(rows) != 0 {
		t.Errorf("null body: rows=%v err=%v", rows, err)
	}
	if e := c.LastRaw()["/erp/hs/fm/invoices"].(map[string]interface{}); e["sample"] != nil {
		t.Errorf("sample must be null, got %#v", e["sample"])
	}
	ok, msg := c.Ping(context.Background(), "П-100014-22")
	if !ok || msg != "Ответ получен: 0 запис(и)" {
		t.Errorf("ping = %v %q", ok, msg)
	}
}

func TestTransportErrors(t *testing.T) {
	srv, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte("[]"))
	})
	t.Setenv("ONEC_TIMEOUT_MS", "50")
	c := NewClient()
	_, err := c.GetTurnover(context.Background(), "1151185")
	if err == nil || err.Error() != "The operation was aborted due to timeout" || errors.Unwrap(err) == nil {
		t.Errorf("timeout err = %v", err)
	}
	srv.Close()
	t.Setenv("ONEC_TIMEOUT_MS", "")
	_, err = c.GetTurnover(context.Background(), "1151185")
	if err == nil || err.Error() != "fetch failed" {
		t.Errorf("closed server err = %v", err)
	}
}
