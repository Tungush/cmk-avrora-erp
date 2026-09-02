package orderstate

import "math"

// orderStageCodes — ТОЛЬКО PRODUCTION: DESIGN/SUPPLY существуют как
// значения enum OrderStageCode в БД (легаси), но отметка цеха по вехам
// «убрана» решением 26.08.2026 — stageShapeError в оригинале принимает
// исключительно 'PRODUCTION', не все три значения enum.
var orderStageCodes = []string{"PRODUCTION"}
var routingStages = []string{"CUTTING", "ASSEMBLY", "PAINTING"}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// StageShapeError — код этапа всегда PRODUCTION/DESIGN/SUPPLY (API-код, уже
// переведённый из русской метки БД), вид работ CUTTING/ASSEMBLY/PAINTING
// необязателен. Возвращает "" (нет ошибки) или готовый текст сообщения.
func StageShapeError(code string, routingStage *string) string {
	if !contains(orderStageCodes, code) {
		return "Неизвестный этап: " + code + ". Допустимо: " + joinComma(orderStageCodes)
	}
	if routingStage != nil && *routingStage != "" && !contains(routingStages, *routingStage) {
		return "Неизвестный вид работ: " + *routingStage + ". Допустимо: " + joinComma(routingStages)
	}
	return ""
}

func joinComma(list []string) string {
	out := ""
	for i, s := range list {
		if i > 0 {
			out += ", "
		}
		out += s
	}
	return out
}

// StageRow — запись этапа для расчёта готовности (status уже в нижнем
// регистре API-значения: not_started/in_progress/done — как отдаёт
// StageStatusDBToAPI-обратное сравнение делает вызывающий код).
type StageRow struct {
	StageCode    string
	RoutingStage *string
	OrderLineID  *string
	Status       string // lowercase: "done" | "in_progress" | "not_started"
}

type StageProgressResult struct {
	AllDone    bool
	AnyStarted bool
	DoneCount  int
	TotalSteps int
}

// StageProgress — готовность заказа = сколько его ИЗДЕЛИЙ изготовлено.
// Мерой служит список изделий заказа (productLineIds), а не отметки в
// базе — они создаются лениво.
func StageProgress(rows []StageRow, productLineIDs []string) StageProgressResult {
	doneLines := map[string]bool{}
	anyStarted := false
	for _, r := range rows {
		st := r.Status
		if st == "done" || st == "in_progress" {
			anyStarted = true
		}
		if st == "done" && r.OrderLineID != nil {
			doneLines[*r.OrderLineID] = true
		}
	}
	needed := len(productLineIDs)
	doneCount := 0
	for _, id := range productLineIDs {
		if doneLines[id] {
			doneCount++
		}
	}
	return StageProgressResult{
		AllDone:    needed > 0 && doneCount == needed,
		AnyStarted: anyStarted,
		DoneCount:  doneCount,
		TotalSteps: needed,
	}
}

const DefaultStageTrackingThreshold = 5

func ResolveTrackingMode(lineCount, threshold int) string {
	if lineCount > threshold {
		return "LINE"
	}
	return "ORDER"
}

type LineNorm struct {
	OrderLineID  string
	NormManHours float64
}

type HoursAllocation struct {
	OrderLineID string  `json:"orderLineId"`
	SharePct    float64 `json:"sharePct"`
	Hours       float64 `json:"hours"`
}

func round3s(n float64) float64 { return math.Round(n*1000) / 1000 }

// AllocateActualHours — раскладка фактических часов по позициям
// пропорционально нормам; нет норм — делим поровну. Хвост округления
// уходит в самую крупную позицию, чтобы сумма долей сходилась до копейки.
func AllocateActualHours(actualHours float64, lines []LineNorm) []HoursAllocation {
	if len(lines) == 0 {
		return []HoursAllocation{}
	}
	totalNorm := 0.0
	for _, l := range lines {
		if l.NormManHours > 0 {
			totalNorm += l.NormManHours
		}
	}
	weights := make([]float64, len(lines))
	for i, l := range lines {
		if totalNorm > 0 {
			w := l.NormManHours
			if w < 0 {
				w = 0
			}
			weights[i] = w / totalNorm
		} else {
			weights[i] = 1.0 / float64(len(lines))
		}
	}

	allocated := make([]HoursAllocation, len(lines))
	sum := 0.0
	for i, l := range lines {
		hours := round3s(actualHours * weights[i])
		allocated[i] = HoursAllocation{
			OrderLineID: l.OrderLineID,
			SharePct:    math.Round(weights[i]*10000) / 100,
			Hours:       hours,
		}
		sum += hours
	}

	diff := round3s(actualHours - sum)
	if diff != 0 {
		biggest := 0
		for i := 1; i < len(allocated); i++ {
			if allocated[i].Hours > allocated[biggest].Hours {
				biggest = i
			}
		}
		allocated[biggest].Hours = round3s(allocated[biggest].Hours + diff)
	}
	return allocated
}
