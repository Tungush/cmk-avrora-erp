// Перенос onec-sync.service.ts — приём данных из 1С (08_INTEGRATION_1C.md §4).
//
// Модель обмена — pull: HTTP-сервисы 1С отдают документ по конкретному
// номеру, списка «что изменилось» нет. Мы обходим номера, которые уже
// знаем, и обновляем их. Перезаписываем только поля, которыми владеет 1С
// (шапка, суммы, оплаты, контрагент); резерв, план и этапы цеха — наши.
//
// Порт «как есть»: все причуды оригинала (двойной upsertCustomer, строки
// калькуляции ESTIMATE→ORDERED→ACTUAL за один проход, отсутствие отката
// созданного NEW-заказа при нераспознанных строках) воспроизведены намеренно.
package onec

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/integration"
	"cmk-avrora-erp/backend-go/internal/models"
	"cmk-avrora-erp/backend-go/internal/nomenclature"
	"cmk-avrora-erp/backend-go/internal/warehouse"
)

// Статусы 1С → наши. Незнакомый статус не двигает заказ, а попадает в отчёт.
// Ключи — без пробелов: реальная 1С пишет статусы слитно («КОтгрузке»),
// ТЗ — раздельно; сравниваем после удаления пробелов.
var statusMap = map[string]string{
	"насогласовании": "DRAFT",
	"несогласован":   "DRAFT",
	"квыполнению":    "CONFIRMED",
	"кобеспечению":   "CONFIRMED", // снабжение — этап до производства
	"вработе":        "IN_PRODUCTION",
	"котгрузке":      "READY_TO_SHIP",
	"закрыт":         "CLOSED",
	"аннулирован":    "CANCELLED",
	"отменен":        "CANCELLED",
	"отменён":        "CANCELLED",
}

// Наши статусы, которые 1С не должна перебивать: производство ведём мы.
var ourProductionStatuses = map[string]bool{"IN_PRODUCTION": true, "READY_TO_SHIP": true, "SHIPPED": true}

// KeyOrderField — служебный ключ, под которым строка-объект ответа 1С может
// нести порядок своих ключей ([]string) в порядке исходного JSON. Go-map
// порядок не хранит, а отчёт (linesNotParsed.keys, текст ошибки get_c)
// и фолбэк findItemsArray в оригинале идут по Object.keys — порядку JSON.
// Клиент (splitRows в client.go) может положить сюда obj.keys; без него
// ключи берутся отсортированными (детерминированно, но не как в JS).
const KeyOrderField = "__keyOrder"

// JS-семантика примитивов (jsTrim/jsString/jsNumber/jsSlice/jsTruthy) — в client.go.

// field — row.key для «any»-строки: не объект → undefined.
func field(row interface{}, key string) interface{} {
	if m, ok := row.(map[string]interface{}); ok {
		return m[key]
	}
	return nil
}

// coalesce — оператор ?? : первое не-null значение.
func coalesce(vals ...interface{}) interface{} {
	for _, v := range vals {
		if v != nil {
			return v
		}
	}
	return nil
}

// ---------------------------------------------------------------------
// Разбор значений 1С

// numOrNull — разбор числа из 1С. nil, если разобрать не удалось: «не
// поняли значение» и «пришёл ноль» — разные вещи, путать их нельзя.
// Понимает «1 234,56», «1 234.56», «1.234.567,89», «1,234,567.89», «4 500,00 ₸».
func numOrNull(v interface{}) *float64 {
	if v == nil {
		return nil
	}
	var raw string
	switch x := v.(type) {
	case string:
		if x == "" {
			return nil
		}
		raw = x
	case float64:
		if math.IsInf(x, 0) || math.IsNaN(x) {
			return nil
		}
		return &x
	case json.Number:
		f, err := strconv.ParseFloat(x.String(), 64)
		if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			return nil
		}
		return &f
	case int:
		f := float64(x)
		return &f
	case int64:
		f := float64(x)
		return &f
	default:
		raw = jsString(v)
	}

	var sb strings.Builder
	for _, r := range raw {
		if !isJSWhitespace(r) {
			sb.WriteRune(r)
		}
	}
	raw = sb.String()
	negative := (len(raw) >= 2 && raw[0] == '(' && raw[len(raw)-1] == ')') || strings.HasPrefix(raw, "-")
	var db strings.Builder
	for _, r := range raw {
		if (r >= '0' && r <= '9') || r == '.' || r == ',' {
			db.WriteRune(r)
		}
	}
	raw = db.String()
	if raw == "" {
		return nil
	}

	// Последний разделитель считаем десятичным, остальные — разрядными
	stripSep := func(s string) string {
		return strings.NewReplacer(".", "", ",", "").Replace(s)
	}
	dec := strings.LastIndex(raw, ",")
	if d := strings.LastIndex(raw, "."); d > dec {
		dec = d
	}
	normalized := raw
	if dec >= 0 {
		normalized = stripSep(raw[:dec]) + "." + stripSep(raw[dec+1:])
	}

	n, err := strconv.ParseFloat(normalized, 64)
	if err != nil {
		// Переполнение → Infinity → null; потеря точности к нулю → 0, как Number()
		if !errors.Is(err, strconv.ErrRange) || math.IsInf(n, 0) {
			return nil
		}
	}
	if math.IsInf(n, 0) || math.IsNaN(n) {
		return nil
	}
	if negative {
		n = -math.Abs(n)
	}
	return &n
}

// num — число со значением по умолчанию 0.
func num(v interface{}) float64 {
	if n := numOrNull(v); n != nil {
		return *n
	}
	return 0
}

// str — v == null ? ” : String(v).trim()
func str(v interface{}) string {
	if v == nil {
		return ""
	}
	return jsTrim(jsString(v))
}

// normalizeStatus — str(v).toLowerCase().replace(/\s+/g, ”): ключ STATUS_MAP.
func normalizeStatus(v interface{}) string {
	return strings.Map(func(r rune) rune {
		if isJSWhitespace(r) {
			return -1
		}
		return r
	}, strings.ToLower(str(v)))
}

// cut — обрезка под VarChar: длинное значение из 1С не должно ронять заказ.
func cut(v interface{}, n int) *string {
	t := str(v)
	if t == "" {
		return nil
	}
	s := jsSlice(t, n)
	return &s
}

var (
	syncLocOnce sync.Once
	syncLoc     *time.Location
)

// syncLocation — часовой пояс предприятия (ONEC_TIMEZONE, по умолчанию
// Asia/Almaty): в нём 1С называет календарные даты.
func syncLocation() *time.Location {
	syncLocOnce.Do(func() {
		name := os.Getenv("ONEC_TIMEZONE")
		if name == "" {
			name = "Asia/Almaty"
		}
		if loc, err := time.LoadLocation(name); err == nil {
			syncLoc = loc
			return
		}
		if loc, err := time.LoadLocation("Asia/Almaty"); err == nil {
			syncLoc = loc
			return
		}
		syncLoc = time.FixedZone("+05", 5*3600)
	})
	return syncLoc
}

var (
	reISODatePrefix = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})`)
	reParenSuffix   = regexp.MustCompile(`\s*\([^)]*\)\s*$`)
	reNamedZone     = regexp.MustCompile(`\s*(?:GMT|UTC|UT)\s*([+-]\d{2}):?(\d{2})?\s*$`)
	reBareZone      = regexp.MustCompile(`\s*(?:GMT|UTC|UT|Z)$`)
	reDotYear       = regexp.MustCompile(`\.(\d{4})`)
)

// looseLayouts — форматы, которые понимает new Date() в V8 помимо ISO:
// «Wed May 13 2026 05:00:00 GMT+0500 (Kazakhstan Time)» (Date#toString,
// формат из ТЗ GET C), RFC 1123/2822, «May 13, 2026», «13 May 2026»,
// «05/13/2026». Со смещением — как есть, без него — местное время сервера.
var looseLayouts = func() (zoned, local []string) {
	zonedBase := []string{
		"Mon Jan 2 2006 15:04:05 -0700",
		"Mon Jan 2 2006 15:04 -0700",
		"Mon Jan 2 2006 -0700",
		"Mon, 2 Jan 2006 15:04:05 -0700",
		"Mon, 2 Jan 2006 15:04 -0700",
		"2 Jan 2006 15:04:05 -0700",
		"2 Jan 2006 -0700",
		"Jan 2 2006 15:04:05 -0700",
		"Jan 2, 2006 15:04:05 -0700",
		"Jan 2 2006 -0700",
		"2006-01-02T15:04:05-0700",
		"2006-01-02 15:04:05 -0700",
		"1/2/2006 15:04:05 -0700",
		"1/2/2006 -0700",
	}
	localBase := []string{
		"Mon Jan 2 2006 15:04:05",
		"Mon Jan 2 2006 15:04",
		"Mon Jan 2 2006",
		"Mon, 2 Jan 2006 15:04:05",
		"Mon, 2 Jan 2006",
		"2 Jan 2006 15:04:05",
		"2 Jan 2006 15:04",
		"2 Jan 2006",
		"Jan 2 2006 15:04:05",
		"Jan 2 2006 15:04",
		"Jan 2 2006",
		"Jan 2, 2006 15:04:05",
		"Jan 2, 2006",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
		"2006/01/02 15:04:05",
		"2006/01/02",
		"1/2/2006 15:04:05",
		"1/2/2006 15:04",
		"1/2/2006",
	}
	expand := func(base []string) []string {
		var out []string
		for _, l := range base {
			out = append(out, l)
			if strings.Contains(l, "Jan") {
				out = append(out, strings.Replace(l, "Jan", "January", 1))
			}
			if strings.Contains(l, "Mon") {
				out = append(out, strings.Replace(l, "Mon", "Monday", 1))
				if strings.Contains(l, "Jan") {
					out = append(out, strings.Replace(strings.Replace(l, "Mon", "Monday", 1), "Jan", "January", 1))
				}
			}
		}
		return out
	}
	return expand(zonedBase), expand(localBase)
}

// parseLooseDate — фолбэк new Date(raw) для не-ISO строк.
func parseLooseDate(raw string) (time.Time, bool) {
	s := strings.TrimSpace(reParenSuffix.ReplaceAllString(raw, ""))
	if s == "" {
		return time.Time{}, false
	}
	// «GMT+0500» / «GMT+05:00» → «+0500»; голые GMT/UTC/Z → «+0000»
	if m := reNamedZone.FindStringSubmatchIndex(s); m != nil {
		hh := s[m[2]:m[3]]
		mm := "00"
		if m[4] >= 0 {
			mm = s[m[4]:m[5]]
		}
		s = strings.TrimSpace(s[:m[0]]) + " " + hh + mm
	} else if m := reBareZone.FindStringIndex(s); m != nil && m[0] > 0 {
		s = strings.TrimSpace(s[:m[0]]) + " +0000"
	}
	zoned, local := looseLayouts()
	for _, l := range zoned {
		if t, err := time.Parse(l, s); err == nil {
			return t, true
		}
	}
	for _, l := range local {
		if t, err := time.ParseInLocation(l, s, time.Local); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// parseDate — разбор даты из 1С.
//
// 1С отдаёт «2026-09-30T00:00:00» без пояса; берём из строки календарную
// дату и сохраняем как UTC-полночь: «30 сентября» остаётся 30 сентября в
// любом поясе. Для строк со смещением (формат Date#toString из ТЗ) —
// календарная дата в поясе предприятия.
func parseDate(v interface{}) *time.Time {
	raw := str(v)
	if raw == "" {
		return nil
	}
	if m := reISODatePrefix.FindStringSubmatch(raw); m != nil {
		y, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		d, _ := strconv.Atoi(m[3])
		// 1С отдаёт пустую дату как 0001-01-01 — это не дата, а «не заполнено»
		if y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 {
			return nil
		}
		t := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
		// отсекает 31 февраля и подобное
		if t.Year() != y || int(t.Month()) != mo || t.Day() != d {
			return nil
		}
		return &t
	}
	t, ok := parseLooseDate(raw)
	if !ok {
		return nil
	}
	if uy := t.UTC().Year(); uy < 1900 || uy > 2100 {
		return nil
	}
	l := t.In(syncLocation())
	out := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, time.UTC)
	return &out
}

// ---------------------------------------------------------------------
// Строки документа

// Массив строк номенклатуры. Фактически 1С отдаёт его в item_details —
// причём НЕ массивом, а строкой с вложенным JSON. Прочие имена оставлены.
var itemArrayKeys = []string{"item_details", "items", "item_alldata", "item_data", "itemdata", "lines", "nomenclature"}

// asRowArray — значение поля как массив: и настоящий массив, и JSON в строке.
func asRowArray(v interface{}) ([]interface{}, bool) {
	switch x := v.(type) {
	case []interface{}:
		return x, true
	case string:
		t := jsTrim(x)
		if !strings.HasPrefix(t, "[") {
			return nil, false
		}
		var parsed interface{}
		if err := json.Unmarshal([]byte(t), &parsed); err != nil {
			return nil, false // битый JSON внутри строки — уйдёт в linesNotParsed
		}
		if arr, ok := parsed.([]interface{}); ok {
			return arr, true
		}
		return nil, false
	}
	return nil, false
}

// objectKeys — Object.keys(data): порядок исходного JSON, если он сохранён
// (KeyOrderField), иначе — отсортированный (детерминированный) порядок.
func objectKeys(data map[string]interface{}) []string {
	if ko, ok := data[KeyOrderField]; ok {
		var keys []string
		switch x := ko.(type) {
		case []string:
			keys = x
		case []interface{}:
			for _, k := range x {
				if s, ok := k.(string); ok {
					keys = append(keys, s)
				}
			}
		}
		out := make([]string, 0, len(keys))
		for _, k := range keys {
			if k != KeyOrderField {
				out = append(out, k)
			}
		}
		return out
	}
	keys := make([]string, 0, len(data))
	for k := range data {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// findItemsArray — массив строк по известным именам, иначе первый (в порядке
// ключей) непустой массив объектов с item_code/item.
func findItemsArray(data map[string]interface{}) (rows []interface{}, ok bool, keys []string) {
	keys = objectKeys(data)
	for _, k := range itemArrayKeys {
		if rows, ok := asRowArray(data[k]); ok {
			return rows, true, keys
		}
	}
	for _, k := range keys {
		arr, isArr := data[k].([]interface{})
		if !isArr || len(arr) == 0 {
			continue
		}
		first, isObj := arr[0].(map[string]interface{})
		if !isObj {
			continue
		}
		if _, has := first["item_code"]; has {
			return arr, true, keys
		}
		if _, has := first["item"]; has {
			return arr, true, keys
		}
	}
	return nil, false, keys
}

// ---------------------------------------------------------------------
// Отчёт

type SyncReport struct {
	Requested int `json:"requested"`
	Found     int `json:"found"`
	Updated   int `json:"updated"`
	// Не найдено в 1С
	NotFound []string `json:"notFound"`
	// Есть в 1С, но нет у нас — синхронизировать нечего
	MissingLocally []string `json:"missingLocally"`
	// Ответ получен, но массив строк не распознан: структура JSON иная
	LinesNotParsed []LinesNotParsed `json:"linesNotParsed"`
	// Значения, которые не удалось разобрать — в БД не записаны
	Unparsed        []Unparsed  `json:"unparsed"`
	UnknownArticles []string    `json:"unknownArticles"`
	UnknownStatuses []string    `json:"unknownStatuses"`
	Errors          []SyncError `json:"errors"`
	// Создано как NEW: заказ 1С, которого у нас не было, — ушёл в инбокс
	CreatedAsNew *int `json:"createdAsNew,omitempty"`
}

type LinesNotParsed struct {
	OrderNumber string   `json:"orderNumber"`
	Keys        []string `json:"keys"`
}

type Unparsed struct {
	OrderNumber string `json:"orderNumber"`
	Field       string `json:"field"`
	Raw         string `json:"raw"`
}

type SyncError struct {
	OrderNumber string `json:"orderNumber"`
	Error       string `json:"error"`
}

// EmptyReport — все массивы непустые указатели (в JSON — []), createdAsNew нет.
func EmptyReport() *SyncReport {
	return &SyncReport{
		NotFound: []string{}, MissingLocally: []string{}, LinesNotParsed: []LinesNotParsed{}, Unparsed: []Unparsed{},
		UnknownArticles: []string{}, UnknownStatuses: []string{}, Errors: []SyncError{},
	}
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------
// Контрагент

// upsertCustomer — контрагент по БИН: юридический реквизит, владелец 1С.
func upsertCustomer(ctx context.Context, pool *pgxpool.Pool, name, bin string) (*string, error) {
	cleanName := jsTrim(name)
	cleanBin := jsSlice(jsTrim(bin), 20)
	if cleanName == "" && cleanBin == "" {
		return nil, nil
	}

	if cleanBin != "" {
		var id, curName string
		err := pool.QueryRow(ctx, "SELECT id, name FROM customers WHERE bin_iin = $1", cleanBin).Scan(&id, &curName)
		if err == nil {
			if cleanName != "" && curName != cleanName {
				if _, err := pool.Exec(ctx, "UPDATE customers SET name = $1 WHERE id = $2", cleanName, id); err != nil {
					return nil, err
				}
			}
			return &id, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	var id, curBin string
	err := pool.QueryRow(ctx, "SELECT id, bin_iin FROM customers WHERE lower(name) = lower($1) ORDER BY id LIMIT 1", cleanName).Scan(&id, &curBin)
	if err == nil {
		// Дозаполняем БИН, если в нашей базе его не было
		if cleanBin != "" && curBin != cleanBin {
			var busy string
			berr := pool.QueryRow(ctx, "SELECT id FROM customers WHERE bin_iin = $1", cleanBin).Scan(&busy)
			if errors.Is(berr, pgx.ErrNoRows) {
				if _, err := pool.Exec(ctx, "UPDATE customers SET bin_iin = $1 WHERE id = $2", cleanBin, id); err != nil {
					return nil, err
				}
			} else if berr != nil {
				return nil, berr
			}
		}
		return &id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if cleanName == "" {
		return nil, nil
	}
	newID := uuid.NewString()
	binValue := cleanBin
	if binValue == "" {
		binValue = "1C-" + strconv.FormatInt(time.Now().UnixMilli(), 36)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO customers (id, name, bin_iin, customer_type) VALUES ($1,$2,$3,$4)",
		newID, cleanName, binValue, models.CustomerTypeAPIToDB("OUTSIDE")); err != nil {
		return nil, err
	}
	return &newID, nil
}

// ---------------------------------------------------------------------
// Заказ клиента (GET A)

type syncOrderLine struct {
	ID        string
	ArticleID *string
}

type syncOrder struct {
	ID                  string
	Status              string
	RequestDate         *time.Time
	PlannedShipmentDate *time.Time
	Region              *string
	OnecNum             *string
	FinalCustomer       *string
	CustomerOrderNum    *string
	Lines               []syncOrderLine
}

const syncOrderCols = "id, status, request_date, planned_shipment_date, region, onec_num, final_customer, customer_order_num"

func scanSyncOrder(row pgx.Row) (syncOrder, error) {
	var o syncOrder
	err := row.Scan(&o.ID, &o.Status, &o.RequestDate, &o.PlannedShipmentDate, &o.Region, &o.OnecNum, &o.FinalCustomer, &o.CustomerOrderNum)
	return o, err
}

func loadSyncOrderLines(ctx context.Context, pool *pgxpool.Pool, orderID string) ([]syncOrderLine, error) {
	rows, err := pool.Query(ctx, "SELECT id, article_id FROM order_lines WHERE order_id = $1", orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lines := []syncOrderLine{}
	for rows.Next() {
		var l syncOrderLine
		if err := rows.Scan(&l.ID, &l.ArticleID); err != nil {
			return nil, err
		}
		lines = append(lines, l)
	}
	return lines, rows.Err()
}

func firstWithAny(rows []map[string]interface{}, keys ...string) map[string]interface{} {
	for _, r := range rows {
		if r == nil {
			continue
		}
		for _, k := range keys {
			if jsTruthy(r[k]) {
				return r
			}
		}
	}
	return nil
}

// SyncClientOrder — синхронизировать один заказ клиента по номеру (GET A).
// Неизвестный нам заказ (рождён сделкой Б24 → документом 1С) создаётся в
// статусе NEW и попадает в инбокс «Новые заказы».
func SyncClientOrder(ctx context.Context, pool *pgxpool.Pool, client *Client, orderNumber string, report *SyncReport) (bool, error) {
	rows, err := client.GetClientOrder(ctx, orderNumber)
	if err != nil {
		return false, err
	}
	data := firstWithAny(rows, "clientorder_num", "clientorder_adem")
	if data == nil {
		report.NotFound = append(report.NotFound, orderNumber)
		return false, nil
	}

	// Ответ должен относиться к запрошенному документу: без сверки один
	// неверный номер запишет чужие данные в чужой заказ
	returnedNums := []string{}
	for _, n := range []string{str(data["clientorder_num"]), str(data["clientorder_adem"])} {
		if n != "" {
			returnedNums = append(returnedNums, n)
		}
	}
	asked := strings.ToLower(jsTrim(orderNumber))
	matches := false
	for _, n := range returnedNums {
		low := strings.ToLower(n)
		if low == asked || strings.HasPrefix(asked, low) || strings.HasPrefix(low, asked) {
			matches = true
			break
		}
	}
	if len(returnedNums) > 0 && !matches {
		report.Errors = append(report.Errors, SyncError{
			OrderNumber: orderNumber,
			Error:       "1С вернула другой документ: " + strings.Join(returnedNums, " / "),
		})
		return false, nil
	}
	report.Found++

	order, err := scanSyncOrder(pool.QueryRow(ctx, "SELECT "+syncOrderCols+" FROM orders WHERE order_number = $1", orderNumber))
	if err == nil {
		order.Lines, err = loadSyncOrderLines(ctx, pool, order.ID)
		if err != nil {
			return false, err
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		// Заказ рождён в 1С (сделка Б24) — заводим у нас в NEW, в инбокс.
		// Контрагент нужен сразу: без него запись не имеет смысла.
		newCustomerID, err := upsertCustomer(ctx, pool, str(data["client"]), str(data["client_bin"]))
		if err != nil {
			return false, err
		}
		if newCustomerID == nil {
			report.MissingLocally = append(report.MissingLocally, orderNumber)
			return false, nil
		}
		order, err = scanSyncOrder(pool.QueryRow(ctx, `
			INSERT INTO orders (id, order_number, customer_id, order_type, status, updated_at)
			VALUES ($1,$2,$3,$4,'NEW',now()) RETURNING `+syncOrderCols,
			uuid.NewString(), orderNumber, *newCustomerID, models.OrderTypeAPIToDB("FZ")))
		if err != nil {
			return false, err
		}
		order.Lines = []syncOrderLine{}
		n := 0
		if report.CreatedAsNew != nil {
			n = *report.CreatedAsNew
		}
		n++
		report.CreatedAsNew = &n
	} else {
		return false, err
	}

	// Строки: имя массива в ТЗ не указано — ищем по известным вариантам.
	// Не нашли — это НЕ успех: молча обнулять суммы нельзя.
	itemRows, ok, keys := findItemsArray(data)
	if !ok {
		report.LinesNotParsed = append(report.LinesNotParsed, LinesNotParsed{OrderNumber: orderNumber, Keys: keys})
		return false, nil
	}

	// Статус: 1С владеет согласованием и закрытием, но не производством —
	// если заказ у нас в цехе, статус 1С «К выполнению» его не откатывает
	rawStatus := normalizeStatus(data["clientorder_status"])
	mapped := statusMap[rawStatus]
	if rawStatus != "" && mapped == "" && !containsStr(report.UnknownStatuses, rawStatus) {
		report.UnknownStatuses = append(report.UnknownStatuses, rawStatus)
	}
	// NEW не подтверждается статусом 1С: из инбокса заказ выходит только
	// явным «Принять в производство», иначе инбокс превратится в фикцию
	keepOurs := (ourProductionStatuses[order.Status] && mapped == "CONFIRMED") ||
		(order.Status == "NEW" && mapped == "CONFIRMED")
	nextStatus := order.Status
	if mapped != "" && !keepOurs {
		nextStatus = mapped
	}

	customerID, err := upsertCustomer(ctx, pool, str(data["client"]), str(data["client_bin"]))
	if err != nil {
		return false, err
	}

	totalAmount := 0.0
	for _, it := range itemRows {
		totalAmount += num(field(it, "amount"))
	}
	// Оплаты: фактически 1С кладёт их в pay — JSON-строкой, как и item_details
	payments, ok := asRowArray(data["pay"])
	if !ok {
		payments, ok = asRowArray(data["clientorder_pay_data"])
		if !ok {
			payments = []interface{}{}
		}
	}
	paidAmount := 0.0
	for _, p := range payments {
		paidAmount += num(coalesce(field(p, "clientorder_paid_amount"), field(p, "pay_amount"), field(p, "amount")))
	}

	attempt := ParseOrderNumber(orderNumber)
	externalID := orderNumber
	if n := str(data["clientorder_num"]); n != "" {
		externalID = n
		if attempt.Year != nil {
			externalID += "-" + *attempt.Year
		}
	}

	// Всё одной транзакцией: иначе сбой на строках оставит шапку обновлённой,
	// а отметку синхронизации — проставленной, и заказ уйдёт из очереди
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	sets := []string{}
	args := []interface{}{}
	set := func(col string, v interface{}) {
		args = append(args, v)
		sets = append(sets, col+" = $"+strconv.Itoa(len(args)))
	}
	orDate := func(v *time.Time, fallback *time.Time) *time.Time {
		if v != nil {
			return v
		}
		return fallback
	}
	orStr := func(v *string, fallback *string) *string {
		if v != nil {
			return v
		}
		return fallback
	}
	set("status", nextStatus)
	if customerID != nil {
		set("customer_id", *customerID)
	}
	set("request_date", orDate(parseDate(data["clientorder_date"]), order.RequestDate))
	set("planned_shipment_date", orDate(parseDate(data["workplandate"]), order.PlannedShipmentDate))
	set("region", orStr(cut(data["region"], 50), order.Region))
	if attempt.Kind == "adem" {
		set("onec_num", cut(data["clientorder_num"], 30))
	} else {
		set("onec_num", order.OnecNum)
	}
	set("onec_status", cut(data["clientorder_status"], 50))
	set("onec_approval_status", cut(data["clientorder_approval_status"], 50))
	// Суммы пишем только если строки реально разобраны
	if len(itemRows) > 0 {
		set("onec_total_amount", totalAmount)
	}
	if len(payments) > 0 {
		set("onec_paid_amount", paidAmount)
	}
	// Конечный заказчик: 1С его отдаёт — для работы через генподрядчиков
	// это ключевой реквизит
	set("final_customer", orStr(cut(data["final_client"], 200), order.FinalCustomer))
	set("customer_order_num", orStr(cut(data["client_po"], 60), order.CustomerOrderNum))
	set("project_group", cut(data["project_group"], 100))
	set("project_site", cut(data["project_site"], 150))
	set("division_code", cut(data["division_code"], 20))
	set("client_agreement", cut(data["client_agreement"], 100))
	sets = append(sets, "onec_synced_at = now()", "updated_at = now()")
	args = append(args, order.ID)
	if _, err := tx.Exec(ctx, "UPDATE orders SET "+strings.Join(sets, ", ")+" WHERE id = $"+strconv.Itoa(len(args)), args...); err != nil {
		return false, err
	}

	// Смена статуса — событие: без записи в аудит непонятно, кто её сделал
	if nextStatus != order.Status {
		before, _ := json.Marshal(map[string]interface{}{"status": order.Status})
		after, _ := json.Marshal(map[string]interface{}{"status": nextStatus})
		if _, err := tx.Exec(ctx, `
			INSERT INTO audit_log (id, entity_type, entity_id, action, before, after, user_role, comment)
			VALUES ($1,'Order',$2,'status_change',$3,$4,'1С',$5)`,
			uuid.NewString(), order.ID, before, after, "Синхронизация с 1С: «"+str(data["clientorder_status"])+"»"); err != nil {
			return false, err
		}
	}

	// Строки заказа: цену и количество ведёт 1С; резерв и отгрузку — мы.
	// Сопоставляем по артикулу, не занимая одну строку дважды.
	usedLineIDs := map[string]bool{}
	for _, item := range itemRows {
		code := str(field(item, "item_code"))
		if code == "" {
			continue
		}
		var articleID string
		err := tx.QueryRow(ctx, "SELECT id FROM articles WHERE article_code = $1", code).Scan(&articleID)
		if errors.Is(err, pgx.ErrNoRows) {
			// Решение от 2026-08-19: артикулы ведём по кодам 1С — неизвестный код
			// заводим сразу, чтобы строка заказа не терялась. Имя берём из строки
			// 1С; цену не трогаем — прайс утверждается у нас.
			name := str(field(item, "item"))
			if name == "" {
				name = code
			}
			articleID = uuid.NewString()
			if _, err := tx.Exec(ctx, "INSERT INTO articles (id, article_code, name, updated_at) VALUES ($1,$2,$3,now())",
				articleID, jsSlice(code, 20), name); err != nil {
				return false, err
			}
			if !containsStr(report.UnknownArticles, code) {
				report.UnknownArticles = append(report.UnknownArticles, code)
			}
		} else if err != nil {
			return false, err
		}

		qty := numOrNull(field(item, "qty"))
		unitPrice := numOrNull(coalesce(field(item, "unitprice"), field(item, "unit_price"), field(item, "price")))
		amount := numOrNull(field(item, "amount"))
		for _, chk := range []struct {
			field  string
			parsed *float64
			raw    interface{}
		}{
			{"qty", qty, field(item, "qty")}, {"unitprice", unitPrice, field(item, "unitprice")}, {"amount", amount, field(item, "amount")},
		} {
			if chk.parsed == nil && chk.raw != nil && chk.raw != "" {
				report.Unparsed = append(report.Unparsed, Unparsed{OrderNumber: orderNumber, Field: chk.field, Raw: jsSlice(jsString(chk.raw), 40)})
			}
		}

		var candidate *syncOrderLine
		for i := range order.Lines {
			l := &order.Lines[i]
			if l.ArticleID != nil && *l.ArticleID == articleID && !usedLineIDs[l.ID] {
				candidate = l
				break
			}
		}

		if candidate != nil {
			usedLineIDs[candidate.ID] = true
			// null = не разобрали → оставляем прежнее значение, а не обнуляем
			lsets := []string{}
			largs := []interface{}{}
			if qty != nil {
				largs = append(largs, *qty)
				lsets = append(lsets, "qty = $"+strconv.Itoa(len(largs)))
			}
			if unitPrice != nil {
				largs = append(largs, *unitPrice)
				lsets = append(lsets, "unit_price = $"+strconv.Itoa(len(largs)))
			}
			if amount != nil {
				largs = append(largs, *amount)
				lsets = append(lsets, "line_total_vat = $"+strconv.Itoa(len(largs)))
			}
			if len(lsets) > 0 {
				largs = append(largs, candidate.ID)
				if _, err := tx.Exec(ctx, "UPDATE order_lines SET "+strings.Join(lsets, ", ")+" WHERE id = $"+strconv.Itoa(len(largs)), largs...); err != nil {
					return false, err
				}
			}
		} else if qty != nil && *qty > 0 {
			unit := "шт"
			if u := cut(field(item, "unit_measure"), 10); u != nil {
				unit = *u
			}
			price := 0.0
			if unitPrice != nil {
				price = *unitPrice
			}
			lineTotal := 0.0
			if amount != nil {
				lineTotal = *amount
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO order_lines (id, order_id, article_id, qty, unit, unit_price, line_total_vat)
				VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				uuid.NewString(), order.ID, articleID, *qty, unit, price, lineTotal); err != nil {
				return false, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}

	// Маппинг ID — вне транзакции: конфликт здесь не должен откатывать данные
	if externalID != "" {
		externalCode := str(data["clientorder_adem"])
		if externalCode == "" {
			externalCode = orderNumber
		}
		if err := integration.LinkExternal(ctx, pool, integration.LinkInput{
			EntityType: "Order", LocalID: order.ID, ExternalID: externalID, ExternalCode: &externalCode,
		}); err != nil {
			report.Errors = append(report.Errors, SyncError{
				OrderNumber: orderNumber,
				Error:       "Не удалось связать с 1С (" + externalID + "): " + err.Error(),
			})
		}
	}

	report.Updated++
	return true, nil
}

// SyncOrders — пакетная синхронизация: обходит активные заказы, у которых
// номер похож на документ 1С; служебные номера импорта (TC-ROW…) пропускает.
// Отрицательный limit — как Prisma take<0: последние |limit| в том же порядке.
func SyncOrders(ctx context.Context, pool *pgxpool.Pool, client *Client, limit int, onlyActive *bool) (*SyncReport, error) {
	report := EmptyReport()

	where := "NOT (order_number LIKE '%ROW%')"
	if onlyActive == nil || *onlyActive {
		where += " AND status IN ('NEW','DRAFT','CONFIRMED','IN_PRODUCTION','READY_TO_SHIP')"
	}
	orderBy := "onec_synced_at ASC NULLS FIRST, created_at DESC"
	take := limit
	if limit < 0 {
		orderBy = "onec_synced_at DESC NULLS LAST, created_at ASC"
		take = -limit
	}
	numbers := []string{}
	if limit != 0 {
		rows, err := pool.Query(ctx, "SELECT order_number FROM orders WHERE "+where+" ORDER BY "+orderBy+" LIMIT $1", take)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var n string
			if err := rows.Scan(&n); err != nil {
				rows.Close()
				return nil, err
			}
			numbers = append(numbers, n)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if limit < 0 {
			for i, j := 0, len(numbers)-1; i < j; i, j = i+1, j-1 {
				numbers[i], numbers[j] = numbers[j], numbers[i]
			}
		}
	}

	for _, n := range numbers {
		report.Requested++
		if _, err := SyncClientOrder(ctx, pool, client, n, report); err != nil {
			report.Errors = append(report.Errors, SyncError{OrderNumber: n, Error: err.Error()})
		}
	}
	return report, nil
}

// ---------------------------------------------------------------------
// Закуп под заказ (GET D → GET C)

type ProcurementStats struct {
	Matched         int      `json:"matched"`
	Unmatched       []string `json:"unmatched"`
	ReceiptsCreated int      `json:"receiptsCreated"`
	RowsOrdered     int      `json:"rowsOrdered"`
	RowsActual      int      `json:"rowsActual"`
}

type ProcurementResult struct {
	OrderNumber    string           `json:"orderNumber"`
	SupplierOrders int              `json:"supplierOrders"`
	Created        int              `json:"created"`
	Updated        int              `json:"updated"`
	Errors         []string         `json:"errors"`
	Procurement    ProcurementStats `json:"procurement"`
}

func asciiDigits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func hasInvoiceNum(r map[string]interface{}) bool {
	return r != nil && (jsTruthy(r["supplier_invoice_num"]) || jsTruthy(r["supplier_invoice_adem"]))
}

func anyInvoiceNum(rows []map[string]interface{}) bool {
	for _, r := range rows {
		if hasInvoiceNum(r) {
			return true
		}
	}
	return false
}

// SyncProcurementForOrder — закуп под заказ клиента (GET D → GET C): что
// снабжение заказало у поставщиков. Пишем в payment_documents.
func SyncProcurementForOrder(ctx context.Context, pool *pgxpool.Pool, client *Client, orderNumber string) (ProcurementResult, error) {
	res := ProcurementResult{OrderNumber: orderNumber, Errors: []string{}, Procurement: ProcurementStats{Unmatched: []string{}}}

	turnovers, err := client.GetTurnover(ctx, orderNumber)
	if err != nil {
		return res, err
	}
	var orderID *string
	{
		var id string
		err := pool.QueryRow(ctx, "SELECT id FROM orders WHERE order_number = $1", orderNumber).Scan(&id)
		if err == nil {
			orderID = &id
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return res, err
		}
	}

	// Номер счёта → год документа: get_c без года документ не находит,
	// а get_d год отдаёт («2 026» — с пробелом-разрядом). Map с порядком вставки.
	supplierKeys := []string{}
	supplierYears := map[string]*string{}
	for _, t := range turnovers {
		// Реальный get_d отдаёт плоские строки: номер счёта лежит прямо в строке
		// оборота, вложенного supplier_invoice_alldata (как в ТЗ) там нет
		var rows []interface{}
		if arr, ok := t["supplier_invoice_alldata"].([]interface{}); ok && len(arr) > 0 {
			rows = arr
		} else {
			rows = []interface{}{t}
		}
		for _, row := range rows {
			n := str(field(row, "supplier_invoice_num"))
			if n == "" {
				n = str(field(row, "supplier_invoice_adem"))
			}
			if n == "" {
				continue
			}
			// Год критичен: один номер счёта существует в РАЗНЫХ годах как разные
			// документы. Надёжнее всего год из даты документа; supplier_invoice_year — запасной.
			var y *string
			if m := reDotYear.FindStringSubmatch(str(field(row, "supplier_invoice_date"))); m != nil {
				v := m[1]
				y = &v
			} else if d := asciiDigits(str(field(row, "supplier_invoice_year"))); d != "" {
				y = &d
			}
			_, has := supplierYears[n]
			if !has || y != nil {
				var val *string
				if y != nil && len(*y) == 4 {
					val = y
				}
				if !has {
					supplierKeys = append(supplierKeys, n)
				}
				supplierYears[n] = val
			}
		}
	}
	res.SupplierOrders = len(supplierKeys)

	for _, supplierNumber := range supplierKeys {
		if err := syncSupplierOrder(ctx, pool, client, orderID, supplierNumber, supplierYears[supplierNumber], &res); err != nil {
			res.Errors = append(res.Errors, supplierNumber+": "+err.Error())
		}
	}
	return res, nil
}

// syncSupplierOrder — один заказ поставщику; «мягкие» пропуски пишет в
// res.Errors сам и возвращает nil, исключения — как error.
func syncSupplierOrder(ctx context.Context, pool *pgxpool.Pool, client *Client, orderID *string, supplierNumber string, supplierYear *string, res *ProcurementResult) error {
	// «Не найден» приходит исключением (200 + [{error}] → throw), поэтому
	// первую попытку тоже глушим и уходим в перебор годов
	rows := []map[string]interface{}{}
	if r, err := client.GetSupplierOrder(ctx, supplierNumber, supplierYear); err == nil {
		rows = r
	}
	if len(rows) == 0 || !anyInvoiceNum(rows) {
		// Год из get_d не подошёл (или его не было) — перебираем соседние
		base := time.Now().Year()
		for _, yv := range []int{base, base - 1, base - 2} {
			y := strconv.Itoa(yv)
			if supplierYear != nil && y == *supplierYear {
				continue
			}
			r, err := client.GetSupplierOrder(ctx, supplierNumber, &y)
			if err != nil {
				continue // «не найден» за этот год — пробуем следующий
			}
			rows = r
			if anyInvoiceNum(rows) {
				break
			}
		}
	}
	data := firstWithAny(rows, "supplier_invoice_num", "supplier_invoice_adem")
	if data == nil {
		res.Errors = append(res.Errors, supplierNumber+": не найден в 1С")
		return nil
	}

	items, ok := asRowArray(data["item_alldata"])
	if !ok {
		// Структуру строк не разобрали — записать «оплачено» было бы враньём
		res.Errors = append(res.Errors, supplierNumber+": массив строк не распознан (ключи: "+strings.Join(objectKeys(data), ", ")+")")
		return nil
	}

	contractorID, err := upsertCustomer(ctx, pool, str(data["supplier"]), str(data["supplier_bin"]))
	if err != nil {
		return err
	}
	if contractorID == nil {
		res.Errors = append(res.Errors, supplierNumber+": не удалось определить поставщика")
		return nil
	}

	totalAmount := 0.0
	for _, it := range items {
		totalAmount += num(field(it, "amount"))
	}
	paidRows, _ := data["supplier_invoice_alldata"].([]interface{})
	paid := 0.0
	for _, p := range paidRows {
		paid += num(field(p, "supplier_invoice_paid_amount"))
	}
	unpaidRaw := numOrNull(data["supplier_invoice_notpaid_amount"])
	unpaid := math.Max(0, totalAmount-paid)
	if unpaidRaw != nil {
		unpaid = *unpaidRaw
	}

	doNumber := str(data["supplier_invoice_num"])
	if doNumber == "" {
		doNumber = supplierNumber
	}
	doNumber = jsSlice(doNumber, 30)
	var existingID string
	var existingOrderID *string
	existing := true
	if err := pool.QueryRow(ctx, "SELECT id, order_id FROM payment_documents WHERE do_number = $1", doNumber).Scan(&existingID, &existingOrderID); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		existing = false
	}

	// Пустая сумма при непустом ответе — данные неполные: не трогаем оплаты
	if totalAmount <= 0 && (unpaidRaw == nil || *unpaidRaw == 0) {
		res.Errors = append(res.Errors, supplierNumber+": суммы не разобраны, документ пропущен")
		return nil
	}

	doDate := parseDate(data["supplier_invoice_date"])
	currency := str(data["currency"])
	if currency == "" {
		currency = "KZT"
	}
	currency = jsSlice(currency, 3)
	category := cut(data["supplier_invoice_category"], 30)
	status := "UNPAID"
	if unpaid <= 0 && totalAmount > 0 {
		status = "PAID"
	} else if paid > 0 {
		status = "PARTIALLY_PAID"
	}
	dbStatus := models.PaymentDocStatusAPIToDB(status)

	if existing {
		sql := `UPDATE payment_documents SET do_date = $1, contractor_id = $2, currency = $3, total_amount = $4,
			paid_amount = $5, unpaid_amount = $6, category = $7, status = $8`
		args := []interface{}{doDate, *contractorID, currency, totalAmount, paid, unpaid, category, dbStatus}
		// Привязку к заказу не переписываем: один счёт может закрывать
		// несколько заказов, и перекидывать его между ними нельзя
		if orderID != nil && existingOrderID == nil {
			args = append(args, *orderID)
			sql += ", order_id = $" + strconv.Itoa(len(args))
		}
		args = append(args, existingID)
		if _, err := pool.Exec(ctx, sql+" WHERE id = $"+strconv.Itoa(len(args)), args...); err != nil {
			return err
		}
		res.Updated++
	} else {
		if _, err := pool.Exec(ctx, `
			INSERT INTO payment_documents (id, do_number, do_date, contractor_id, currency, total_amount, paid_amount, unpaid_amount, category, status, order_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			uuid.NewString(), doNumber, doDate, *contractorID, currency, totalAmount, paid, unpaid, category, dbStatus, orderID); err != nil {
			return err
		}
		res.Created++
	}

	// Позиции заказа поставщику: сырьё, цены, факт поступления.
	// Отсюда рождаются партии с фактической ценой (решение 22.08.2026).
	applied, err := applyProcurementItems(ctx, pool, orderID, doNumber, data, items)
	if err != nil {
		return err
	}
	res.Procurement.Matched += applied.Matched
	res.Procurement.Unmatched = append(res.Procurement.Unmatched, applied.Unmatched...)
	res.Procurement.ReceiptsCreated += applied.ReceiptsCreated
	res.Procurement.RowsOrdered += applied.RowsOrdered
	res.Procurement.RowsActual += applied.RowsActual
	return nil
}

// matchMaterial — позиция 1С → наш материал. Три ступени: код 1С, точное
// имя, нормализованный алиас (§7.6).
func matchMaterial(ctx context.Context, pool *pgxpool.Pool, name, code string) (*string, error) {
	var id string
	if code != "" {
		err := pool.QueryRow(ctx, "SELECT id FROM materials WHERE material_code = $1 ORDER BY id LIMIT 1", code).Scan(&id)
		if err == nil {
			return &id, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	if name == "" {
		return nil, nil
	}
	err := pool.QueryRow(ctx, "SELECT id FROM materials WHERE lower(name) = lower($1) ORDER BY id LIMIT 1", name).Scan(&id)
	if err == nil {
		return &id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	err = pool.QueryRow(ctx, "SELECT material_id FROM material_aliases WHERE normalized = $1 ORDER BY id LIMIT 1", nomenclature.NormalizeName(name)).Scan(&id)
	if err == nil {
		return &id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return nil, nil
}

type costingMaterialRow struct {
	ID            string
	MaterialID    *string
	QtyTotal      float64
	PriceState    string
	CostingStatus string
}

func loadCostingRows(ctx context.Context, pool *pgxpool.Pool, orderID string) ([]costingMaterialRow, error) {
	rows, err := pool.Query(ctx, `
		SELECT id, material_id, qty_total, price_state, costing_id FROM order_costing_materials
		WHERE costing_id IN (SELECT id FROM order_costings WHERE order_id = $1)`, orderID)
	if err != nil {
		return nil, err
	}
	out := []costingMaterialRow{}
	costingIDs := []string{}
	byCosting := map[string][]int{}
	for rows.Next() {
		var r costingMaterialRow
		var costingID string
		if err := rows.Scan(&r.ID, &r.MaterialID, &r.QtyTotal, &r.PriceState, &costingID); err != nil {
			rows.Close()
			return nil, err
		}
		if _, seen := byCosting[costingID]; !seen {
			costingIDs = append(costingIDs, costingID)
		}
		byCosting[costingID] = append(byCosting[costingID], len(out))
		out = append(out, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(costingIDs) == 0 {
		return out, nil
	}
	srows, err := pool.Query(ctx, "SELECT id, status FROM order_costings WHERE id = ANY($1)", costingIDs)
	if err != nil {
		return nil, err
	}
	defer srows.Close()
	for srows.Next() {
		var id, status string
		if err := srows.Scan(&id, &status); err != nil {
			return nil, err
		}
		for _, i := range byCosting[id] {
			out[i].CostingStatus = status
		}
	}
	return out, srows.Err()
}

func updateCostingRow(ctx context.Context, pool *pgxpool.Pool, row costingMaterialRow, state, doNumber string, unitPrice float64) error {
	sql := "UPDATE order_costing_materials SET price_state = $1, supplier_order_number = $2, price_state_changed_at = $3"
	args := []interface{}{state, doNumber, time.Now().UTC()}
	// Снимок согласованной версии неприкосновенен — деньги меняем только в черновике
	if row.CostingStatus == "DRAFT" {
		args = append(args, unitPrice, common.JsRound(unitPrice*row.QtyTotal*100)/100)
		sql += ", unit_price = $4, line_cost = $5"
	}
	args = append(args, row.ID)
	_, err := pool.Exec(ctx, sql+" WHERE id = $"+strconv.Itoa(len(args)), args...)
	return err
}

// applyProcurementItems — что делает строка заказа поставщику у нас:
//  1. материал опознаётся (код → имя → алиас); неопознанные — в отчёт;
//  2. строки калькуляции заказа двигаются «оценка → заказано» с номером
//     документа; цена трогается только в черновиках;
//  3. если по документу есть акт (товар поступил) — создаётся приход и
//     партия с фактической ценой; строки калькуляции получают стадию «факт».
func applyProcurementItems(ctx context.Context, pool *pgxpool.Pool, orderID *string, doNumber string, data map[string]interface{}, items []interface{}) (ProcurementStats, error) {
	result := ProcurementStats{Unmatched: []string{}}

	// Акт по документу = сырьё физически поступило; его дата — дата прихода
	acts, _ := data["actdoc_alldata"].([]interface{})
	var actDate *time.Time
	for _, a := range acts {
		d := parseDate(coalesce(field(a, "actdoc_processed_date"), field(a, "actdoc_date")))
		if d != nil && (actDate == nil || d.Before(*actDate)) {
			actDate = d
		}
	}
	hasArrived := len(acts) > 0

	costingRows := []costingMaterialRow{}
	if orderID != nil {
		var err error
		costingRows, err = loadCostingRows(ctx, pool, *orderID)
		if err != nil {
			return result, err
		}
	}

	supplierName := str(data["supplier"])
	for _, it := range items {
		name := str(field(it, "item"))
		code := str(field(it, "item_code"))
		qty := num(field(it, "qty"))
		unitPrice := num(field(it, "unit_price"))
		if !(qty > 0) || !(unitPrice > 0) {
			continue
		}

		materialID, err := matchMaterial(ctx, pool, name, code)
		if err != nil {
			return result, err
		}
		if materialID == nil {
			label := name
			if label == "" {
				label = code
			}
			if label == "" {
				label = "—"
			}
			result.Unmatched = append(result.Unmatched, label)
			continue
		}
		result.Matched++

		// «Оценка → заказано»: цена уже известна из документа 1С
		for _, row := range costingRows {
			if row.MaterialID != nil && *row.MaterialID == *materialID && row.PriceState == "ESTIMATE" {
				if err := updateCostingRow(ctx, pool, row, "ORDERED", doNumber, unitPrice); err != nil {
					return result, err
				}
				result.RowsOrdered++
			}
		}

		if !hasArrived {
			continue
		}

		// Приход идемпотентен по (материал, документ): повторный синк
		// того же счёта не задваивает склад
		var already string
		err = pool.QueryRow(ctx, `
			SELECT id FROM material_stock_movements
			WHERE item_id = $1 AND document_number = $2 AND movement_type = $3 ORDER BY id LIMIT 1`,
			*materialID, doNumber, models.StockMovementTypeAPIToDB("RECEIPT")).Scan(&already)
		if errors.Is(err, pgx.ErrNoRows) {
			var supplier *string
			if supplierName != "" {
				supplier = &supplierName
			}
			doc := doNumber
			comment := "Заказ поставщику " + doNumber + " (синхронизация 1С)"
			if _, err := warehouse.Receive(ctx, pool, warehouse.ReceiptInput{
				MaterialID: *materialID, Qty: qty, UnitPrice: unitPrice, MovementDate: actDate,
				SupplierName: supplier, DocumentNumber: &doc, Comment: &comment,
			}, ""); err != nil {
				return result, err
			}
			result.ReceiptsCreated++
		} else if err != nil {
			return result, err
		}

		// «Заказано → факт»: партия с фактической ценой существует
		// (состояние строк в памяти не обновлялось — как в оригинале)
		for _, row := range costingRows {
			if row.MaterialID != nil && *row.MaterialID == *materialID && row.PriceState != "ACTUAL" {
				if err := updateCostingRow(ctx, pool, row, "ACTUAL", doNumber, unitPrice); err != nil {
					return result, err
				}
				result.RowsActual++
			}
		}
	}
	return result, nil
}
