package onec

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func fptr(f float64) *float64 { return &f }

func TestNumOrNull(t *testing.T) {
	cases := []struct {
		in   interface{}
		want *float64
	}{
		{nil, nil},
		{"", nil},
		{float64(1234.5), fptr(1234.5)},
		{float64(0), fptr(0)},
		{"1 234,56", fptr(1234.56)},
		{"1 234.56", fptr(1234.56)},
		{"1.234.567,89", fptr(1234567.89)},
		{"1,234,567.89", fptr(1234567.89)},
		{"4 500,00 ₸", fptr(4500)},
		{"1 234", fptr(1234)},
		{"1 234,5", fptr(1234.5)},
		{"(1 000)", fptr(-1000)},
		{"-15,5", fptr(-15.5)},
		{"- 15", fptr(-15)},
		{"abc", nil},
		{".", nil},
		{",", nil},
		{"12", fptr(12)},
		{"12.", fptr(12)},
		{".5", fptr(0.5)},
		{"1e5", fptr(15)}, // буквы вырезаются: остаётся «15»
		{true, nil},
		{map[string]interface{}{}, nil},
		{[]interface{}{"1", "2"}, fptr(1.2)}, // String([1,2]) = "1,2" → последний разделитель десятичный
	}
	for _, c := range cases {
		got := numOrNull(c.in)
		switch {
		case c.want == nil && got != nil:
			t.Errorf("numOrNull(%q) = %v, want nil", c.in, *got)
		case c.want != nil && got == nil:
			t.Errorf("numOrNull(%q) = nil, want %v", c.in, *c.want)
		case c.want != nil && got != nil && *got != *c.want:
			t.Errorf("numOrNull(%q) = %v, want %v", c.in, *got, *c.want)
		}
	}
	if num("") != 0 || num("x") != 0 || num("7,5") != 7.5 {
		t.Errorf("num defaults wrong")
	}
}

func TestStrCutNormalizeStatus(t *testing.T) {
	if str(nil) != "" || str("  a b  ") != "a b" || str(float64(12)) != "12" {
		t.Errorf("str: %q %q %q", str(nil), str("  a b  "), str(float64(12)))
	}
	if c := cut("  абвгд  ", 3); c == nil || *c != "абв" {
		t.Errorf("cut runes: %v", c)
	}
	if cut("   ", 3) != nil || cut(nil, 3) != nil {
		t.Errorf("cut of empty must be nil")
	}
	if normalizeStatus(" К Отгрузке ") != "котгрузке" || normalizeStatus("КОбеспечению") != "кобеспечению" {
		t.Errorf("normalizeStatus: %q", normalizeStatus(" К Отгрузке "))
	}
	if statusMap[normalizeStatus("К выполнению")] != "CONFIRMED" || statusMap[normalizeStatus("Отменён")] != "CANCELLED" {
		t.Errorf("statusMap lookup")
	}
}

func utc(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

func TestParseDateISO(t *testing.T) {
	cases := map[string]*time.Time{
		"2026-09-30":                ptrTime(utc(2026, 9, 30)),
		"2026-09-30T00:00:00":       ptrTime(utc(2026, 9, 30)),
		"2026-09-30T00:00:00.000Z":  ptrTime(utc(2026, 9, 30)),
		"2026-05-12T23:30:00+00:00": ptrTime(utc(2026, 5, 12)), // календарный префикс, не мгновение
		" 2026-01-02 ":              ptrTime(utc(2026, 1, 2)),
		"0001-01-01":                nil, // «не заполнено»
		"2026-02-31":                nil,
		"2026-13-01":                nil,
		"2026-00-10":                nil,
		"":                          nil,
		"garbage":                   nil,
		"20260930":                  nil,
	}
	for in, want := range cases {
		got := parseDate(in)
		if (got == nil) != (want == nil) || (got != nil && !got.Equal(*want)) {
			t.Errorf("parseDate(%q) = %v, want %v", in, got, want)
		}
	}
	if parseDate(nil) != nil {
		t.Errorf("parseDate(nil) must be nil")
	}
}

func ptrTime(t time.Time) *time.Time { return &t }

func TestParseDateLoose(t *testing.T) {
	cases := map[string]time.Time{
		// формат Date#toString из ТЗ (GET C): 05:00 +05 → 2026-05-13 в Алматы
		"Wed May 13 2026 05:00:00 GMT+0500 (Kazakhstan Time)": utc(2026, 5, 13),
		// 01:00 +05 = 12 мая 20:00 UTC, но календарно в Алматы это 13 мая
		"Wed May 13 2026 01:00:00 GMT+0500 (Kazakhstan Time)": utc(2026, 5, 13),
		// 23:30 UTC 12 мая = 04:30 13 мая в Алматы
		"Tue May 12 2026 23:30:00 GMT+0000":        utc(2026, 5, 13),
		"Tue May 12 2026 23:30:00 GMT":             utc(2026, 5, 13),
		"Tue May 12 2026 23:30:00 UTC":             utc(2026, 5, 13),
		"Tue, 12 May 2026 23:30:00 +0000":          utc(2026, 5, 13),
		"12 May 2026 10:00:00 +0500":               utc(2026, 5, 12),
		"Wednesday May 13 2026 05:00:00 GMT+05:00": utc(2026, 5, 13),
	}
	for in, want := range cases {
		got := parseDate(in)
		if got == nil || !got.Equal(want) {
			t.Errorf("parseDate(%q) = %v, want %v", in, got, want)
		}
	}
	// без смещения — местное время сервера, затем календарная дата в Алматы
	local := time.Date(2026, 5, 13, 12, 0, 0, 0, time.Local)
	l := local.In(syncLocation())
	want := utc(l.Year(), l.Month(), l.Day())
	for _, in := range []string{"Wed May 13 2026 12:00:00", "May 13, 2026 12:00:00", "13 May 2026 12:00:00", "5/13/2026 12:00:00"} {
		if got := parseDate(in); got == nil || !got.Equal(want) {
			t.Errorf("parseDate(%q) = %v, want %v", in, got, want)
		}
	}
	if parseDate("Wed May 13 1800 05:00:00 GMT+0500") != nil {
		t.Errorf("year < 1900 must be nil")
	}
}

func TestAsRowArray(t *testing.T) {
	if rows, ok := asRowArray([]interface{}{1.0, "a"}); !ok || len(rows) != 2 {
		t.Errorf("real array")
	}
	if rows, ok := asRowArray(` [{"item_code":"A"},{"item_code":"B"}] `); !ok || len(rows) != 2 {
		t.Errorf("json in string: %v %v", rows, ok)
	}
	if rows, ok := asRowArray("[]"); !ok || len(rows) != 0 {
		t.Errorf("empty json array is still an array")
	}
	for _, bad := range []interface{}{`{"a":1}`, "[broken", "", "abc", 5.0, nil, map[string]interface{}{}, true} {
		if rows, ok := asRowArray(bad); ok {
			t.Errorf("asRowArray(%v) = %v, want nil", bad, rows)
		}
	}
}

func TestFindItemsArray(t *testing.T) {
	// известное имя, JSON-строкой
	data := map[string]interface{}{"clientorder_num": "X", "item_details": `[{"item_code":"A","qty":"1"}]`}
	rows, ok, keys := findItemsArray(data)
	if !ok || len(rows) != 1 || !reflect.DeepEqual(keys, []string{"clientorder_num", "item_details"}) {
		t.Errorf("known key: %v %v %v", rows, ok, keys)
	}
	// приоритет известных имён по порядку ITEM_ARRAY_KEYS
	data = map[string]interface{}{"items": []interface{}{1.0}, "item_details": "[1,2]"}
	rows, _, _ = findItemsArray(data)
	if len(rows) != 2 {
		t.Errorf("item_details must win over items")
	}
	// фолбэк: первый массив объектов с item_code/item в порядке ключей
	data = map[string]interface{}{
		"zzz":   []interface{}{map[string]interface{}{"item": "n"}},
		"aaa":   []interface{}{map[string]interface{}{"foo": 1.0}},
		"empty": []interface{}{},
		"nums":  []interface{}{1.0, 2.0},
	}
	rows, ok, keys = findItemsArray(data)
	if !ok || len(rows) != 1 || !reflect.DeepEqual(keys, []string{"aaa", "empty", "nums", "zzz"}) {
		t.Errorf("fallback sorted: %v %v %v", rows, ok, keys)
	}
	// с сохранённым порядком ключей — порядок исходного JSON
	data[KeyOrderField] = []string{"zzz", "nums", "empty", "aaa"}
	rows, ok, keys = findItemsArray(data)
	if !ok || len(rows) != 1 || !reflect.DeepEqual(keys, []string{"zzz", "nums", "empty", "aaa"}) {
		t.Errorf("fallback ordered: %v %v %v", rows, ok, keys)
	}
	// нет ничего похожего
	data = map[string]interface{}{"b": "x", "a": []interface{}{map[string]interface{}{"foo": 1.0}}}
	rows, ok, keys = findItemsArray(data)
	if ok || rows != nil || !reflect.DeepEqual(keys, []string{"a", "b"}) {
		t.Errorf("none: %v %v %v", rows, ok, keys)
	}
}

func TestReportJSONShape(t *testing.T) {
	b, _ := json.Marshal(EmptyReport())
	want := `{"requested":0,"found":0,"updated":0,"notFound":[],"missingLocally":[],"linesNotParsed":[],"unparsed":[],"unknownArticles":[],"unknownStatuses":[],"errors":[]}`
	if string(b) != want {
		t.Errorf("EmptyReport JSON = %s", b)
	}
	r := ProcurementResult{OrderNumber: "N", Errors: []string{}, Procurement: ProcurementStats{Unmatched: []string{}}}
	b, _ = json.Marshal(r)
	want = `{"orderNumber":"N","supplierOrders":0,"created":0,"updated":0,"errors":[],"procurement":{"matched":0,"unmatched":[],"receiptsCreated":0,"rowsOrdered":0,"rowsActual":0}}`
	if string(b) != want {
		t.Errorf("ProcurementResult JSON = %s", b)
	}
}
