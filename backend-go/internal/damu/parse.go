// Пакет damu — кредитные линии фонда «Даму»: разбор выгрузки из личного
// кабинета банка и запись её в базу.
//
// Раньше разбор жил отдельным скриптом (backend/prisma/import-damu.ts) и
// требовал доступа к машине с исходниками. Владелец 07.09.2026: файл должен
// загружаться прямо в разделе, а разбирать его должен сам сервис. Правила
// разбора перенесены один в один — формат задаёт банк, а не мы.
//
// Что в файле:
//   - листы «график …» — по одному на выборку: в шапке лимит, использовано и
//     доступно, ниже блоки траншей по четыре строки (итого / основной долг /
//     проценты / договор поручительства) и колонки дат платежей вправо;
//   - лист «Лист1» — фактические погашения с отметкой банка.
package damu

import (
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

// ScheduleEntry — одна плановая выплата транша.
type ScheduleEntry struct {
	DueDate         time.Time
	TotalAmount     float64
	PrincipalAmount float64
	InterestAmount  float64
}

// Tranche — одна выборка внутри кредитной линии.
type Tranche struct {
	ContractNumber string
	Amount         float64
	StartDate      time.Time
	EndDate        time.Time
	Schedule       []ScheduleEntry
}

// Payment — фактическое погашение с листа «Лист1».
type Payment struct {
	PaymentDate     time.Time
	TotalAmount     float64
	PrincipalAmount float64
	InterestAmount  float64
	Status          string
}

// Line — кредитная линия, разобранная с одного листа «график …».
type Line struct {
	SheetName       string
	ContractNumber  string
	LimitAmount     float64
	UsedAmount      float64
	AvailableAmount float64
	Tranches        []Tranche
	// Payments заполняются только у последнего листа «график …» файла: лист
	// «Лист1» один на весь файл, и если крепить его к каждому листу, факт
	// погашений задвоится
	Payments []Payment
}

// Parsed — итог разбора одного файла.
type Parsed struct {
	Lines []Line
	// Skipped — листы «график …», в которых не нашлось лимита или номера
	// договора: показываем человеку, а не проглатываем молча
	Skipped []string
	// PaymentSheet — имя листа с фактом погашений, если он был
	PaymentSheet string
}

// excelDate — дата из ячейки: и как число Excel, и как текст.
func excelDate(v string) (time.Time, bool) {
	s := strings.TrimSpace(v)
	if s == "" {
		return time.Time{}, false
	}
	// Число — серийная дата Excel (система 1900), как и в прежнем разборе
	if n, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", "."), 64); err == nil {
		if n > 20000 && n < 90000 {
			t, err := excelize.ExcelDateToTime(n, false)
			if err == nil {
				return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC), true
			}
		}
		return time.Time{}, false
	}
	for _, layout := range []string{"2006-01-02", "02.01.2006", "01/02/06", "2006-01-02T15:04:05Z07:00", "01-02-06"} {
		if t, err := time.Parse(layout, s); err == nil {
			return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC), true
		}
	}
	return time.Time{}, false
}

// num — число из ячейки; пробелы-разделители разрядов и запятая допускаются.
func num(v string) float64 {
	s := strings.TrimSpace(v)
	if s == "" {
		return 0
	}
	s = strings.NewReplacer(" ", "", " ", "", " ", "", ",", ".").Replace(s)
	n, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0
	}
	return n
}

func cell(rows [][]string, r, c int) string {
	if r < 0 || r >= len(rows) || c < 0 || c >= len(rows[r]) {
		return ""
	}
	return rows[r][c]
}

// parseScheduleSheet — один лист «график …»: шапка лимитов и блоки траншей.
func parseScheduleSheet(rows [][]string) *Line {
	limit := num(cell(rows, 0, 1))
	used := num(cell(rows, 1, 1))
	available := num(cell(rows, 2, 1))
	contract := strings.TrimSpace(cell(rows, 3, 0))
	if contract == "" || limit <= 0 {
		return nil
	}

	// Седьмая строка — даты платежей начиная с шестой колонки
	type dateCol struct {
		col  int
		date time.Time
	}
	var dateCols []dateCol
	if len(rows) > 6 {
		for c := 5; c < len(rows[6]); c++ {
			if d, ok := excelDate(rows[6][c]); ok {
				dateCols = append(dateCols, dateCol{c, d})
			}
		}
	}

	line := &Line{ContractNumber: contract, LimitAmount: limit, UsedAmount: used, AvailableAmount: available}
	for r := 7; r < len(rows); r++ {
		trancheContract := strings.TrimSpace(cell(rows, r, 0))
		if trancheContract == "" {
			continue
		}
		amount := num(cell(rows, r, 1))
		start, okStart := excelDate(cell(rows, r, 2))
		end, okEnd := excelDate(cell(rows, r, 3))
		if amount <= 0 || !okStart || !okEnd {
			continue
		}

		// Блок транша — четыре строки: итого, основной долг, проценты, поручительство
		t := Tranche{ContractNumber: trancheContract, Amount: amount, StartDate: start, EndDate: end}
		for _, dc := range dateCols {
			total := num(cell(rows, r, dc.col))
			if total <= 0 {
				continue
			}
			t.Schedule = append(t.Schedule, ScheduleEntry{
				DueDate:         dc.date,
				TotalAmount:     total,
				PrincipalAmount: num(cell(rows, r+1, dc.col)),
				InterestAmount:  num(cell(rows, r+2, dc.col)),
			})
		}
		line.Tranches = append(line.Tranches, t)
		r += 3
	}
	return line
}

// parsePaymentLog — лист «Лист1»: дата, общая сумма, проценты, основной долг, статус.
func parsePaymentLog(rows [][]string) []Payment {
	// Шапку ищем по колонке B: в колонке A слово «Дата» есть не во всех файлах
	header := -1
	for r := 0; r < len(rows) && r < 10; r++ {
		if strings.EqualFold(strings.TrimSpace(cell(rows, r, 1)), "общая сумма") {
			header = r
			break
		}
	}
	if header < 0 {
		return nil
	}

	var out []Payment
	for r := header + 1; r < len(rows); r++ {
		date, ok := excelDate(cell(rows, r, 0))
		total := num(cell(rows, r, 1))
		status := strings.TrimSpace(cell(rows, r, 4))
		// Строки-разделители месяцев несут только текст без суммы; пустой
		// статус — это будущий платёж графика, продублированный здесь же,
		// а не факт: банк подписывает статус только у прошедших
		if !ok || total <= 0 || status == "" {
			continue
		}
		out = append(out, Payment{
			PaymentDate:     date,
			TotalAmount:     total,
			InterestAmount:  num(cell(rows, r, 2)),
			PrincipalAmount: num(cell(rows, r, 3)),
			Status:          status,
		})
	}
	return out
}

// Parse — разбор всего файла. Ничего не пишет: результат показывается
// человеку до записи.
func Parse(r io.Reader) (*Parsed, error) {
	f, err := excelize.OpenReader(r)
	if err != nil {
		return nil, fmt.Errorf("файл не читается как Excel: %w", err)
	}
	defer f.Close()

	var scheduleSheets []string
	paymentSheet := ""
	for _, name := range f.GetSheetList() {
		trimmed := strings.TrimSpace(name)
		if strings.HasPrefix(strings.ToLower(trimmed), "график") {
			scheduleSheets = append(scheduleSheets, name)
		}
		if trimmed == "Лист1" {
			paymentSheet = name
		}
	}
	if len(scheduleSheets) == 0 {
		return nil, fmt.Errorf("в файле нет ни одного листа «график …» — это не выгрузка Даму")
	}

	out := &Parsed{PaymentSheet: paymentSheet}
	for i, name := range scheduleSheets {
		// Сырые значения, а не отформатированные: иначе excelize отдаёт
		// «100,000,000.00» и даты в американском «01-09-26» — числа и даты
		// в них не разобрать. Тот же режим, что и raw:true в прежнем скрипте.
		rows, err := f.GetRows(name, excelize.Options{RawCellValue: true})
		if err != nil {
			return nil, fmt.Errorf("лист «%s» не читается: %w", name, err)
		}
		parsed := parseScheduleSheet(rows)
		if parsed == nil {
			out.Skipped = append(out.Skipped, name)
			continue
		}
		parsed.SheetName = name
		// Факт погашений крепим только к последнему листу графика
		if paymentSheet != "" && i == len(scheduleSheets)-1 {
			logRows, err := f.GetRows(paymentSheet, excelize.Options{RawCellValue: true})
			if err == nil {
				parsed.Payments = parsePaymentLog(logRows)
			}
		}
		out.Lines = append(out.Lines, *parsed)
	}
	if len(out.Lines) == 0 {
		return nil, fmt.Errorf("листы «график …» есть, но ни в одном нет лимита и номера договора")
	}
	return out, nil
}
