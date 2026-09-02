// Package onec — перенос onec-client.service.ts: HTTP-клиент четырёх
// точечных GET-сервисов 1С (ТЗ v10) и разбор нашего номера заказа в
// варианты запроса:
//
//	A — заказ клиента      /erp/hs/fm/orders
//	B — счета и акты       /erp/hs/fm/invoices
//	C — заказ поставщику   /erp/hs/TurnOver/v1/get_c
//	D — обороты по заказу  /erp/hs/TurnOver/v1/get_d
//
// Все они точечные: принимают конкретный номер документа, списка «всё, что
// изменилось с даты» в ТЗ нет — отсюда перебор вариантов номера в tryLookup.
package onec

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"cmk-avrora-erp/backend-go/internal/common"
)

// ---------------------------------------------------------------------------
// Разбор номера
// ---------------------------------------------------------------------------

// LookupAttempt — вариант запроса к 1С: набор query-параметров, которым
// можно попробовать найти документ. Kind: "onec" | "adem". Year nil ==
// undefined в оригинале (ключ не попадает ни в URL, ни в lastRaw.params).
type LookupAttempt struct {
	Kind string
	Num  string
	Year *string
}

// JS `.` без флага s не матчит терминаторы строк (\n \r U+2028 U+2029),
// Go-шная `.` не матчит только \n — класс выписан явно, чтобы совпасть.
const jsDot = `[^\n\r\x{2028}\x{2029}]`

var (
	onecWithYear  = regexp.MustCompile(`^(` + jsDot + `+?)-((?:19|20)\d{2})$`) // Т7АА-002345-2026
	ademShortYear = regexp.MustCompile(`^` + jsDot + `+-\d{2}$`)               // П-100014-22
	numeric       = regexp.MustCompile(`^\d{4,10}$`)                           // 1151185 (supplier_invoice_adem из Лист3)
	shortYearTail = regexp.MustCompile(`-(\d{2})$`)
)

// LookupAttempts — во что превратить наш номер, чтобы найти документ в 1С.
//
// Форматы, которые реально встречаются:
//
//	«Т7АА-002345-2026» — номер 1С + год: последняя группа из четырёх цифр это год;
//	«П-100014-22»      — прежняя система (Адем), год двузначный и частью номера не является;
//	«LVАА-000135»      — номер 1С без года — года мы не знаем;
//	«1151185»          — чисто цифровой идентификатор Адем.
//
// Возвращаем НЕСКОЛЬКО вариантов: клиент пробует их по очереди и берёт
// первый непустой ответ.
func LookupAttempts(orderNumber string) []LookupAttempt {
	trimmed := jsTrim(orderNumber)
	if trimmed == "" {
		return []LookupAttempt{}
	}

	// Чисто цифровой — это идентификатор прежней системы
	if numeric.MatchString(trimmed) {
		return []LookupAttempt{{Kind: "adem", Num: trimmed}}
	}

	if m := onecWithYear.FindStringSubmatch(trimmed); m != nil {
		year := m[2]
		// Основная догадка — «номер + год», запасная — весь текст как номер Адем
		return []LookupAttempt{
			{Kind: "onec", Num: m[1], Year: &year},
			{Kind: "adem", Num: trimmed},
		}
	}

	if ademShortYear.MatchString(trimmed) {
		return []LookupAttempt{{Kind: "adem", Num: trimmed}}
	}

	// Номер без года: сначала как документ 1С (год не указываем), затем как Адем
	return []LookupAttempt{
		{Kind: "onec", Num: trimmed},
		{Kind: "adem", Num: trimmed},
	}
}

// ParseOrderNumber — совместимость: первый вариант разбора. Фолбэк
// оригинала берёт СЫРОЙ (не обрезанный) номер.
func ParseOrderNumber(orderNumber string) LookupAttempt {
	if a := LookupAttempts(orderNumber); len(a) > 0 {
		return a[0]
	}
	return LookupAttempt{Kind: "adem", Num: orderNumber}
}

// ---------------------------------------------------------------------------
// Конфигурация
// ---------------------------------------------------------------------------

// BaseURL — ONEC_BASE_URL ("" = 1С не настроена).
func BaseURL() string { return os.Getenv("ONEC_BASE_URL") }

// Configured — задан ли адрес 1С.
func Configured() bool { return BaseURL() != "" }

// timeout — ONEC_TIMEOUT_MS, по умолчанию 20 000 мс (Number(env || 20_000)).
func timeout() time.Duration {
	const def = 20000 * time.Millisecond
	v := os.Getenv("ONEC_TIMEOUT_MS")
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(jsTrim(v), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return def
	}
	return time.Duration(f * float64(time.Millisecond))
}

// credentials — сервисы /TurnOver/ опубликованы под отдельной учёткой
// (учётка от /fm/ получает на них 401). Не задана — работаем общей.
func credentials(path string) (login, password string) {
	if strings.Contains(path, "/TurnOver/") && os.Getenv("ONEC_TURNOVER_LOGIN") != "" {
		return os.Getenv("ONEC_TURNOVER_LOGIN"), os.Getenv("ONEC_TURNOVER_PASSWORD")
	}
	return os.Getenv("ONEC_LOGIN"), os.Getenv("ONEC_PASSWORD")
}

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

const (
	NotConfiguredCode    = "ONEC_NOT_CONFIGURED"
	NotConfiguredMessage = "Адрес 1С не задан (ONEC_BASE_URL)"
)

// NotConfiguredError — перенос ServiceUnavailableException({code:
// 'ONEC_NOT_CONFIGURED', ...}). Возвращается ЗНАЧЕНИЕМ; проверять
// `errors.Is(err, onec.NotConfiguredError{})` (работает и с указателем) или
// `errors.As(err, &onec.NotConfiguredError{})`. HTTP-обработчик отдаёт 503
// через APIError().
type NotConfiguredError struct{}

func (NotConfiguredError) Error() string { return NotConfiguredMessage }

func (NotConfiguredError) Is(target error) bool {
	switch target.(type) {
	case NotConfiguredError, *NotConfiguredError:
		return true
	}
	return false
}

// APIError — типизированная 503 для слоя HTTP.
func (NotConfiguredError) APIError() *common.APIError503 {
	return &common.APIError503{Code: NotConfiguredCode, Message: NotConfiguredMessage}
}

// fetchError — текст как у Node fetch (undici), потому что именно e.message
// уходит клиенту (ping, отчёт синхронизации): «fetch failed» на сетевой
// ошибке, «The operation was aborted due to timeout» на таймауте,
// «Invalid URL» если из ONEC_BASE_URL не собрался URL. Реальная причина —
// в Unwrap и в DebugLog.
type fetchError struct {
	msg   string
	cause error
}

func (e *fetchError) Error() string { return e.msg }
func (e *fetchError) Unwrap() error { return e.cause }

func transportError(ctx context.Context, err error) error {
	common.DebugLog(err)
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded ||
		(errors.As(err, &ne) && ne.Timeout()) {
		return &fetchError{msg: "The operation was aborted due to timeout", cause: err}
	}
	return &fetchError{msg: "fetch failed", cause: err}
}

// ---------------------------------------------------------------------------
// Клиент
// ---------------------------------------------------------------------------

// rawEntry — последний сырой ответ по пути: {at, params, sample}.
type rawEntry struct {
	at     string
	params map[string]string
	sample interface{}
}

// Client — HTTP-клиент сервисов 1С. lastRaw — последний сырой ответ по
// каждому пути, чтобы при первом включении увидеть фактическую структуру
// JSON, а не гадать по документации.
type Client struct {
	mu      sync.Mutex
	lastRaw map[string]rawEntry
	http    *http.Client
}

func NewClient() *Client {
	return &Client{lastRaw: map[string]rawEntry{}, http: &http.Client{}}
}

// LastRaw — getLastRaw(): путь → {at, params, sample}. Ключи верхнего
// уровня и params в JSON выйдут отсортированными (Go map), у оригинала —
// порядок вставки; sample хранит порядок ключей ответа 1С (orderedObject).
func (c *Client) LastRaw() map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]interface{}, len(c.lastRaw))
	for path, e := range c.lastRaw {
		out[path] = map[string]interface{}{"at": e.at, "params": e.params, "sample": e.sample}
	}
	return out
}

func (c *Client) remember(path string, params map[string]string, sample interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastRaw[path] = rawEntry{
		at:     time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), // new Date().toISOString()
		params: params,
		sample: sample,
	}
}

// get — один GET к 1С. params: ключ отсутствует == undefined в оригинале;
// пустые значения в URL не попадают (как `url.searchParams.set` под
// `v !== ”`). Возвращает разобранный JSON (orderedObject / []interface{} /
// скаляр) или пустой массив на пустое тело.
func (c *Client) get(ctx context.Context, path string, params map[string]string) (interface{}, error) {
	if !Configured() {
		return nil, NotConfiguredError{}
	}
	u, err := url.Parse(strings.TrimSuffix(BaseURL(), "/") + path)
	if err != nil {
		common.DebugLog(err)
		return nil, &fetchError{msg: "Invalid URL", cause: err}
	}
	u.RawQuery = encodeQuery(params)

	ctx, cancel := context.WithTimeout(ctx, timeout())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		common.DebugLog(err)
		return nil, &fetchError{msg: "Invalid URL", cause: err}
	}
	req.Header.Set("Accept", "application/json")
	// Логин может быть кириллическим (1С_ERP_709) — Basic кодируем из UTF-8:
	// cp1251 тот же сервер отвергает с 401.
	if login, password := credentials(path); login != "" {
		req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(login+":"+password)))
	}

	res, err := c.http.Do(req)
	if err != nil {
		return nil, transportError(ctx, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, transportError(ctx, err)
	}
	text := decodeText(body)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("1С %s вернула %d: %s", path, res.StatusCode, jsSlice(text, 300))
	}
	if jsTrim(text) == "" {
		return []interface{}{}, nil
	}
	parsed, err := parseJSON(text)
	if err != nil {
		return nil, fmt.Errorf("1С %s: ответ не JSON — %s", path, jsSlice(text, 200))
	}
	// 1С нередко отвечает 200 с телом-ошибкой: не принимаем это за данные
	// …в том числе завёрнутым в массив: get_c на ненайденный документ отвечает
	// 200 и [{"error": "Заказ поставщику не найден"}]
	carrier := parsed
	if arr, ok := parsed.([]interface{}); ok {
		carrier = nil
		if len(arr) > 0 {
			carrier = arr[0]
		}
	}
	if obj, ok := carrier.(*orderedObject); ok {
		// `obj.error ?? obj.Error` — Error смотрится только если error null/отсутствует
		errVal, present := obj.get("error")
		if !present || errVal == nil {
			errVal, _ = obj.get("Error")
		}
		if jsTruthy(errVal) {
			return nil, fmt.Errorf("1С %s: %s", path, jsSlice(jsString(errVal), 200))
		}
	}
	return parsed, nil
}

// tryLookup — перебор вариантов номера: берём первый непустой ответ; если
// все пустые и была ошибка — отдаём ПОСЛЕДНЮЮ ошибку.
func (c *Client) tryLookup(ctx context.Context, path, number string, build func(LookupAttempt) map[string]string) ([]map[string]interface{}, error) {
	var lastErr error
	for _, a := range LookupAttempts(number) {
		params := build(a)
		data, err := c.get(ctx, path, params)
		if err != nil {
			lastErr = err
			continue
		}
		rows, sample := splitRows(data)
		c.remember(path, params, sample)
		if len(rows) > 0 {
			return rows, nil
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return []map[string]interface{}{}, nil
}

// splitRows — `(Array.isArray(data) ? data : [data]).filter(Boolean)`.
// sample — первый truthy элемент (rows[0] ?? null), в порядке ключей 1С.
// Строки — только объекты: truthy скаляр/вложенный массив оригинал оставил
// бы «строкой», но в []map его не положить (см. заметки к модулю).
func splitRows(data interface{}) ([]map[string]interface{}, interface{}) {
	list, ok := data.([]interface{})
	if !ok {
		list = []interface{}{data}
	}
	rows := make([]map[string]interface{}, 0, len(list))
	var sample interface{}
	for _, item := range list {
		if !jsTruthy(item) {
			continue
		}
		if sample == nil {
			sample = item
		}
		if obj, ok := item.(*orderedObject); ok {
			rows = append(rows, obj.plain())
		}
	}
	return rows, sample
}

func currentYear() string { return strconv.Itoa(time.Now().Year()) } // String(new Date().getFullYear())

// GetClientOrder — GET A: заказ клиента со строками и оплатами. Реальный
// /fm/orders отвечает 500 на любой запрос без clientorder_year, поэтому год
// передаём всегда: для «П-121794-24» — из двузначного хвоста, иначе текущий.
func (c *Client) GetClientOrder(ctx context.Context, orderNumber string) ([]map[string]interface{}, error) {
	return c.tryLookup(ctx, "/erp/hs/fm/orders", orderNumber, func(a LookupAttempt) map[string]string {
		if a.Kind == "onec" {
			year := currentYear()
			if a.Year != nil {
				year = *a.Year
			}
			return map[string]string{"clientorder_num": a.Num, "clientorder_year": year}
		}
		year := currentYear()
		if m := shortYearTail.FindStringSubmatch(a.Num); m != nil {
			year = "20" + m[1]
		}
		return map[string]string{"clientorder_adem": a.Num, "clientorder_year": year}
	})
}

// GetInvoices — GET B: счета и акты по документу.
func (c *Client) GetInvoices(ctx context.Context, invoiceNumber string) ([]map[string]interface{}, error) {
	return c.tryLookup(ctx, "/erp/hs/fm/invoices", invoiceNumber, func(a LookupAttempt) map[string]string {
		p := map[string]string{"invoice_num": a.Num}
		if a.Kind == "onec" && a.Year != nil {
			p["invoice_year"] = *a.Year
		}
		return p
	})
}

// GetSupplierOrder — GET C: заказ поставщику (закуп, оплаты, закрывающие).
// Год берём из строки get_d (supplier_invoice_year) — без него реальный
// get_c документ по одному номеру не находит. year nil == undefined.
func (c *Client) GetSupplierOrder(ctx context.Context, number string, year *string) ([]map[string]interface{}, error) {
	return c.tryLookup(ctx, "/erp/hs/TurnOver/v1/get_c", number, func(a LookupAttempt) map[string]string {
		if a.Kind != "onec" {
			return map[string]string{"supplier_invoice_adem": a.Num}
		}
		p := map[string]string{"supplier_invoice_num": a.Num}
		if a.Year != nil {
			p["supplier_invoice_year"] = *a.Year
		} else if year != nil {
			p["supplier_invoice_year"] = *year
		}
		return p
	})
}

// GetTurnover — GET D: обороты — какие заказы поставщику идут под этот заказ.
func (c *Client) GetTurnover(ctx context.Context, orderNumber string) ([]map[string]interface{}, error) {
	return c.tryLookup(ctx, "/erp/hs/TurnOver/v1/get_d", orderNumber, func(a LookupAttempt) map[string]string {
		if a.Kind != "onec" {
			return map[string]string{"clientorder_adem": a.Num}
		}
		p := map[string]string{"clientorder_num": a.Num}
		if a.Year != nil {
			p["clientorder_year"] = *a.Year
		}
		return p
	})
}

// Ping — проверка связи для экрана «Обмен с 1С».
func (c *Client) Ping(ctx context.Context, sampleOrderNumber string) (ok bool, message string) {
	rows, err := c.GetClientOrder(ctx, sampleOrderNumber)
	if err != nil {
		return false, err.Error()
	}
	return true, fmt.Sprintf("Ответ получен: %d запис(и)", len(rows))
}

// ---------------------------------------------------------------------------
// JS-семантика: trim, slice по UTF-16, truthy, String(), URLSearchParams
// ---------------------------------------------------------------------------

// isJSWhitespace — WhiteSpace + LineTerminator из String.prototype.trim:
// \t \v \f пробел U+00A0 U+FEFF + категория Zs, плюс \n \r U+2028 U+2029.
// (U+0085 NEL Go считает пробелом, JS — нет; U+FEFF — наоборот.)
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0xFEFF, 0x2028, 0x2029:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSWhitespace) }

// jsSlice — `s.slice(0, n)`: n считается в UTF-16 code units, не в рунах.
func jsSlice(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

// decodeText — Response.text(): UTF-8 с отбрасыванием BOM, невалидные
// байты → U+FFFD.
func decodeText(b []byte) string {
	b = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF})
	return strings.ToValidUTF8(string(b), "�")
}

func jsTruthy(v interface{}) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case string:
		return t != ""
	}
	return true // объекты и массивы (даже пустые) — truthy
}

// jsString — String(v) для значений из JSON.parse.
func jsString(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return jsNumber(t)
	case string:
		return t
	case []interface{}:
		parts := make([]string, len(t))
		for i, e := range t {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	case *orderedObject, map[string]interface{}:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}

// jsNumber — Number.prototype.toString(): кратчайшая запись, экспонента при
// порядке ≥ 21 или ≤ −7.
func jsNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	neg := f < 0
	if neg {
		f = -f
	}
	mant, expStr, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expStr)
	k, n := len(digits), exp+1
	var s string
	switch {
	case k <= n && n <= 21:
		s = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		s = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		s = "0." + strings.Repeat("0", -n) + digits
	default:
		sign, e := "+", n-1
		if e < 0 {
			sign, e = "-", -e
		}
		if k == 1 {
			s = digits + "e" + sign + strconv.Itoa(e)
		} else {
			s = digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(e)
		}
	}
	if neg {
		s = "-" + s
	}
	return s
}

// encodeQuery — сериализация URLSearchParams: только непустые значения.
// Ключи отсортированы: у всех билдеров выше они и так идут по алфавиту, так
// что порядок совпадает с порядком вставки оригинала.
func encodeQuery(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k, v := range params {
		if v != "" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		if b.Len() > 0 {
			b.WriteByte('&')
		}
		b.WriteString(formEncode(k))
		b.WriteByte('=')
		b.WriteString(formEncode(params[k]))
	}
	return b.String()
}

// formEncode — application/x-www-form-urlencoded как у URLSearchParams:
// без экранирования только [A-Za-z0-9*-._], пробел → «+». (Go-шный
// QueryEscape экранирует «*» и оставляет «~» — наоборот.)
func formEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == ' ':
			b.WriteByte('+')
		case ('A' <= c && c <= 'Z') || ('a' <= c && c <= 'z') || ('0' <= c && c <= '9') ||
			c == '*' || c == '-' || c == '.' || c == '_':
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// JSON с сохранением порядка ключей (для sample в lastRaw)
// ---------------------------------------------------------------------------

// orderedObject — объект JSON в порядке первого появления ключа (как JS:
// дубль ключа перезаписывает значение, позицию не меняет).
type orderedObject struct {
	keys []string
	vals map[string]interface{}
}

func newOrderedObject() *orderedObject {
	return &orderedObject{vals: map[string]interface{}{}}
}

func (o *orderedObject) set(k string, v interface{}) {
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

func (o *orderedObject) get(k string) (interface{}, bool) {
	v, ok := o.vals[k]
	return v, ok
}

// plain — map[string]interface{} рекурсивно (для строк ответа).
func (o *orderedObject) plain() map[string]interface{} {
	out := make(map[string]interface{}, len(o.keys))
	for _, k := range o.keys {
		out[k] = toPlain(o.vals[k])
	}
	return out
}

func toPlain(v interface{}) interface{} {
	switch t := v.(type) {
	case *orderedObject:
		return t.plain()
	case []interface{}:
		out := make([]interface{}, len(t))
		for i, e := range t {
			out[i] = toPlain(e)
		}
		return out
	}
	return v
}

func (o *orderedObject) MarshalJSON() ([]byte, error) {
	if o == nil {
		return []byte("null"), nil
	}
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		vb, err := json.Marshal(o.vals[k])
		if err != nil {
			return nil, err
		}
		b.Write(kb)
		b.WriteByte(':')
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// parseJSON — JSON.parse: объекты → *orderedObject, массивы →
// []interface{}, числа → float64, строки/bool/null как есть.
func parseJSON(text string) (interface{}, error) {
	if !json.Valid([]byte(text)) {
		return nil, errors.New("invalid JSON")
	}
	return readValue(json.NewDecoder(strings.NewReader(text)))
}

func readValue(dec *json.Decoder) (interface{}, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	d, ok := tok.(json.Delim)
	if !ok {
		return tok, nil // string, float64, bool, nil
	}
	switch d {
	case '{':
		obj := newOrderedObject()
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, _ := kt.(string)
			val, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			obj.set(key, val)
		}
		if _, err := dec.Token(); err != nil { // '}'
			return nil, err
		}
		return obj, nil
	case '[':
		arr := []interface{}{}
		for dec.More() {
			val, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			arr = append(arr, val)
		}
		if _, err := dec.Token(); err != nil { // ']'
			return nil, err
		}
		return arr, nil
	}
	return nil, fmt.Errorf("unexpected delimiter %v", d)
}
