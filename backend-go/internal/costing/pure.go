// Package costing — точный перенос backend/src/services/costing.service.ts.
// Байт-в-байт та же арифметика (порядок операций, округления), потому что
// это самая проверенная и самая рискованная часть системы: маржа 35% от
// цены (не наценка), логистика в трёх режимах, ставка участок→передел→общая.
package costing

import (
	"math"
	"strconv"
)

// trimFloat — как JS String(number): "35", не "35.00"; "1.5", не "1.500000".
// Используется только внутри человекочитаемых строк formula/label — сами
// числовые поля JSON остаются float64 и сериализуются как числа.
func trimFloat(n float64) string {
	return strconv.FormatFloat(n, 'f', -1, 64)
}

type Stage string

const (
	StageCutting  Stage = "CUTTING"
	StageAssembly Stage = "ASSEMBLY"
	StagePainting Stage = "PAINTING"
)

type MarginMode string

const (
	MarginModeMargin MarginMode = "MARGIN" // 35% от цены: price = cost / (1 - pct)
	MarginModeMarkup MarginMode = "MARKUP" // 35% сверх себестоимости: price = cost * (1 + pct)
)

type LogisticsMode string

const (
	LogisticsPercentOfMaterial LogisticsMode = "PERCENT_OF_MATERIAL"
	LogisticsFixedAmount       LogisticsMode = "FIXED_AMOUNT"
	LogisticsPerKg             LogisticsMode = "PER_KG"
)

// ConfigError — конфигурация расчёта невалидна (вес не заполнен для PER_KG,
// маржа от цены ≥ 100%). В оригинале это CostingConfigError — плейн Error,
// не HttpException, поэтому долетает до фильтра как непойманный exception.code
// без совпадения с известными кодами и превращается в голый 500
// INTERNAL_SERVER_ERROR с общим текстом (см. http-exception.filter.ts) —
// это баг оригинала, но повторять нужно именно это поведение (как с
// FIELD_WRITE_FORBIDDEN/details:null), не улучшать до красивого 400.
type ConfigError struct {
	Code    string
	Message string
}

func (e *ConfigError) Error() string { return e.Message }

// StageNorm — норма труда по переделу: сколько человек, сколько часов на
// единицу, и (если операция привязана к участку) ставка этого участка.
type StageNorm struct {
	Stage        Stage
	Workers      float64
	HoursPerUnit float64
	HourlyRate   *float64 // nil = не задана, спускаемся ниже по каскаду ставок
}

// StageRates — своя ставка на передел; nil-поле = берётся общая hourlyRate.
type StageRates struct {
	Cutting  *float64
	Assembly *float64
	Painting *float64
}

type CostingRates struct {
	HourlyRate     float64 // 2040 в исходнике
	StageRates     StageRates
	LogisticsPct   float64 // 0.03
	UtilitiesPct   float64 // 0.01
	MarginPct      float64 // 0.35 в новой схеме, 0.10 в исходнике
	MarginMode     MarginMode
	LogisticsMode  LogisticsMode // "" трактуется как PERCENT_OF_MATERIAL
	LogisticsFixed float64       // для FIXED_AMOUNT
	LogisticsPerKg float64       // для PER_KG
}

type CostingContext struct {
	WeightKg float64 // нужен только для логистики PER_KG
}

type StageCostLine struct {
	Stage        Stage   `json:"stage"`
	Workers      float64 `json:"workers"`
	HoursPerUnit float64 `json:"hoursPerUnit"`
	HourlyRate   float64 `json:"hourlyRate"`
	ManHours     float64 `json:"manHours"`  // workers × hours
	StageCost    float64 `json:"stageCost"` // manHours × rate
}

type CostingResult struct {
	MaterialCost  float64         `json:"materialCost"`
	Stages        []StageCostLine `json:"stages"`
	TotalManHours float64         `json:"totalManHours"`
	LaborCost     float64         `json:"laborCost"`
	LogisticsCost float64         `json:"logisticsCost"`
	UtilitiesCost float64         `json:"utilitiesCost"`
	TotalCost     float64         `json:"totalCost"`
	Margin        float64         `json:"margin"`
	Price         float64         `json:"price"`
	MarginMode    MarginMode      `json:"marginMode"`
	MarginPct     float64         `json:"marginPct"`
	// Доля маржи в цене — то, что обычно называют «маржинальностью»
	MarginOfPricePct float64 `json:"marginOfPricePct"`
	// Наценка на себестоимость — то, что обычно называют «накрутили N %»
	MarkupPct float64 `json:"markupPct"`
}

func round2(n float64) float64 { return math.Round(n*100) / 100 }
func round3(n float64) float64 { return math.Round(n*1000) / 1000 }

// RateForStage — ставка для передела: передел → общая.
//
// Участок (workCenterRate) БОЛЬШЕ НЕ УЧИТЫВАЕТСЯ (04.09.2026, решение
// владельца: «Участок можно убрать, вообще не вижу смысла в нём»).
//
// Аргумент оставлен в сигнатуре намеренно: колонка work_center_id в
// routing_operations никуда не делась, и у части изделий она заполнена.
// Если бы мы просто убрали поле с экрана, у этих изделий себестоимость
// продолжила бы считаться по ставке участка (1268,92 ₸/час против общей
// 2040 ₸/час) — невидимый вход, который молча меняет цифры. Поэтому
// ставка участка игнорируется здесь, в одном месте, а не вычищается из
// базы: решение обратимо, и общая база не трогается.
//
// Чтобы вернуть участки, достаточно снять этот игнор и вернуть поле на
// экран норм — данные на месте.
func RateForStage(stage Stage, rates CostingRates, workCenterRate *float64) float64 {
	_ = workCenterRate
	var perStage *float64
	switch stage {
	case StageCutting:
		perStage = rates.StageRates.Cutting
	case StageAssembly:
		perStage = rates.StageRates.Assembly
	case StagePainting:
		perStage = rates.StageRates.Painting
	}
	if perStage != nil {
		return *perStage
	}
	return rates.HourlyRate
}

// LogisticsCostOf — логистика по выбранному режиму. Нулевой вес при режиме
// PER_KG — не «ноль ₸», а незаполненные данные: молчаливый ноль ушёл бы
// прямо в цену, поэтому это ошибка конфигурации, а не 0.
func LogisticsCostOf(materialCost float64, rates CostingRates, ctx *CostingContext) (float64, error) {
	mode := rates.LogisticsMode
	if mode == "" {
		mode = LogisticsPercentOfMaterial
	}
	switch mode {
	case LogisticsFixedAmount:
		return round2(rates.LogisticsFixed), nil
	case LogisticsPerKg:
		weightKg := 0.0
		if ctx != nil {
			weightKg = ctx.WeightKg
		}
		if weightKg <= 0 {
			return 0, &ConfigError{
				Code:    "LOGISTICS_PER_KG_WITHOUT_WEIGHT",
				Message: "Логистика «за кг» требует заполненного веса изделия",
			}
		}
		return round2(weightKg * rates.LogisticsPerKg), nil
	default:
		return round2(materialCost * rates.LogisticsPct), nil
	}
}

// MarginAndPrice — маржа и цена по выбранному режиму (09 §3.2).
func MarginAndPrice(totalCost float64, rates CostingRates) (margin, price float64, err error) {
	if rates.MarginMode == MarginModeMargin {
		// Доля маржи в цене не может быть 100% и выше — это деление на ноль
		if !(rates.MarginPct < 1) {
			return 0, 0, &ConfigError{
				Code:    "MARGIN_PCT_OUT_OF_RANGE",
				Message: "Маржинальность от цены должна быть меньше 100%, получено " + trimFloat(round2(rates.MarginPct*100)) + " %",
			}
		}
		price = round2(totalCost / (1 - rates.MarginPct))
		margin = round2(price - totalCost)
		return margin, price, nil
	}
	margin = round2(totalCost * rates.MarginPct)
	price = round2(totalCost + margin)
	return margin, price, nil
}

// CalculateArticleCosting — полный расчёт себестоимости изделия по нормам
// переделов и цене материалов.
func CalculateArticleCosting(materialCost float64, norms []StageNorm, rates CostingRates, ctx *CostingContext) (CostingResult, error) {
	stages := make([]StageCostLine, 0, len(norms))
	for _, n := range norms {
		hourlyRate := RateForStage(n.Stage, rates, n.HourlyRate)
		manHours := round3(n.Workers * n.HoursPerUnit)
		stages = append(stages, StageCostLine{
			Stage:        n.Stage,
			Workers:      n.Workers,
			HoursPerUnit: n.HoursPerUnit,
			HourlyRate:   hourlyRate,
			ManHours:     manHours,
			StageCost:    round2(manHours * hourlyRate),
		})
	}

	totalManHours := 0.0
	laborCost := 0.0
	for _, s := range stages {
		totalManHours += s.ManHours
		laborCost += s.StageCost
	}
	totalManHours = round3(totalManHours)
	laborCost = round2(laborCost)

	logisticsCost, err := LogisticsCostOf(materialCost, rates, ctx)
	if err != nil {
		return CostingResult{}, err
	}
	utilitiesCost := round2(materialCost * rates.UtilitiesPct)
	totalCost := round2(materialCost + laborCost + logisticsCost + utilitiesCost)
	margin, price, err := MarginAndPrice(totalCost, rates)
	if err != nil {
		return CostingResult{}, err
	}

	marginOfPricePct := 0.0
	if price > 0 {
		marginOfPricePct = round2((margin / price) * 100)
	}
	markupPct := 0.0
	if totalCost > 0 {
		markupPct = round2((margin / totalCost) * 100)
	}

	return CostingResult{
		MaterialCost:     round2(materialCost),
		Stages:           stages,
		TotalManHours:    totalManHours,
		LaborCost:        laborCost,
		LogisticsCost:    logisticsCost,
		UtilitiesCost:    utilitiesCost,
		TotalCost:        totalCost,
		Margin:           margin,
		Price:            price,
		MarginMode:       rates.MarginMode,
		MarginPct:        rates.MarginPct,
		MarginOfPricePct: marginOfPricePct,
		MarkupPct:        markupPct,
	}, nil
}

// ActualDeviationPct — отклонение факта от нормы в процентах; nil — факта нет.
func ActualDeviationPct(normManHours float64, actualWorkers, actualHours *float64) *float64 {
	if actualWorkers == nil || actualHours == nil || normManHours <= 0 {
		return nil
	}
	actualManHours := *actualWorkers * *actualHours
	v := round2(((actualManHours - normManHours) / normManHours) * 100)
	return &v
}

type CostingImpactLine struct {
	Label    string   `json:"label"`
	Before   float64  `json:"before"`
	After    float64  `json:"after"`
	Delta    float64  `json:"delta"`
	DeltaPct *float64 `json:"deltaPct"`
	Unit     string   `json:"unit"`
}

func impactLine(label string, before, after float64, unit string) CostingImpactLine {
	var deltaPct *float64
	if before != 0 {
		v := round2(((after - before) / before) * 100)
		deltaPct = &v
	}
	return CostingImpactLine{
		Label:    label,
		Before:   before,
		After:    after,
		Delta:    round2(after - before),
		DeltaPct: deltaPct,
		Unit:     unit,
	}
}

// CostingImpact — сравнение «до / после» для предпросмотра влияния: что
// именно пересчитается при правке нормы — до сохранения.
func CostingImpact(current, proposed CostingResult) []CostingImpactLine {
	return []CostingImpactLine{
		impactLine("Трудоёмкость", current.TotalManHours, proposed.TotalManHours, "чел/час"),
		impactLine("Себестоимость труда", current.LaborCost, proposed.LaborCost, "₸"),
		impactLine("Себестоимость", current.TotalCost, proposed.TotalCost, "₸"),
		impactLine("Расчётная цена", current.Price, proposed.Price, "₸"),
	}
}

type ExplainLine struct {
	Label   string  `json:"label"`
	Value   float64 `json:"value"`
	Unit    string  `json:"unit"`
	Source  string  `json:"source,omitempty"`
	Formula string  `json:"formula,omitempty"`
}

type PriceCheck struct {
	ApprovedPrice float64 `json:"approvedPrice"`
	DeviationPct  float64 `json:"deviationPct"`
	BelowCost     bool    `json:"belowCost"`
}

type MarginSummary struct {
	Mode             MarginMode `json:"mode"`
	Pct              float64    `json:"pct"`
	MarginOfPricePct float64    `json:"marginOfPricePct"`
	MarkupPct        float64    `json:"markupPct"`
	Label            string     `json:"label"`
}

type Explanation struct {
	Lines         []ExplainLine `json:"lines"`
	TotalManHours float64       `json:"totalManHours"`
	PriceCheck    *PriceCheck   `json:"priceCheck"`
	MarginSummary MarginSummary `json:"marginSummary"`
}

var stageLabels = map[Stage]string{
	StageCutting:  "Резка",
	StageAssembly: "Сборка / сварка / обшивка",
	StagePainting: "Зачистка / покраска",
}

// pctFormula — процент выводится из факта, если ставки не переданы —
// цифра в подписи всегда честная.
func pctFormula(value, base float64, pct *float64) string {
	shown := 0.0
	if pct != nil {
		shown = *pct * 100
	} else if base > 0 {
		shown = (value / base) * 100
	}
	return "материалы × " + trimFloat(round2(shown)) + " %"
}

func logisticsFormula(result CostingResult, rates *CostingRates) string {
	mode := LogisticsPercentOfMaterial
	if rates != nil && rates.LogisticsMode != "" {
		mode = rates.LogisticsMode
	}
	switch mode {
	case LogisticsFixedAmount:
		return "фиксированная сумма на заказ"
	case LogisticsPerKg:
		perKg := 0.0
		if rates != nil {
			perKg = rates.LogisticsPerKg
		}
		return trimFloat(round2(perKg)) + " ₸/кг × вес изделия"
	default:
		var pct *float64
		if rates != nil {
			p := rates.LogisticsPct
			pct = &p
		}
		return pctFormula(result.LogisticsCost, result.MaterialCost, pct)
	}
}

func marginFormula(result CostingResult) string {
	pct := trimFloat(round2(result.MarginPct * 100))
	if result.MarginMode == MarginModeMargin {
		return pct + " % от цены"
	}
	return pct + " % от себестоимости"
}

// ExplainCosting — «разбор формулы» для UI: человекочитаемые строки
// расчёта со ссылками на источники — вместо =IF(IFERROR(VLOOKUP(...))).
func ExplainCosting(result CostingResult, approvedPrice *float64, rates *CostingRates) Explanation {
	lines := []ExplainLine{
		{Label: "Материалы", Value: result.MaterialCost, Unit: "₸", Source: "bom"},
	}
	for _, s := range result.Stages {
		lines = append(lines, ExplainLine{
			Label:   stageLabels[s.Stage],
			Value:   s.StageCost,
			Unit:    "₸",
			Source:  "routing",
			Formula: trimFloat(s.Workers) + " чел × " + trimFloat(s.HoursPerUnit) + " ч × " + trimFloat(s.HourlyRate) + " ₸/час",
		})
	}
	var utilPct *float64
	if rates != nil {
		p := rates.UtilitiesPct
		utilPct = &p
	}
	lines = append(lines,
		ExplainLine{Label: "Логистика", Value: result.LogisticsCost, Unit: "₸", Source: "costingConfig", Formula: logisticsFormula(result, rates)},
		ExplainLine{Label: "Вода / газ / электричество", Value: result.UtilitiesCost, Unit: "₸", Source: "costingConfig", Formula: pctFormula(result.UtilitiesCost, result.MaterialCost, utilPct)},
		ExplainLine{Label: "Себестоимость", Value: result.TotalCost, Unit: "₸"},
		ExplainLine{Label: "Маржа", Value: result.Margin, Unit: "₸", Formula: marginFormula(result)},
		ExplainLine{Label: "Расчётная цена", Value: result.Price, Unit: "₸"},
	)

	var priceCheck *PriceCheck
	if approvedPrice != nil && *approvedPrice > 0 {
		priceCheck = &PriceCheck{
			ApprovedPrice: *approvedPrice,
			DeviationPct:  round2(((*approvedPrice - result.Price) / result.Price) * 100),
			BelowCost:     *approvedPrice < result.TotalCost,
		}
	}

	// Обе трактовки процента рядом — иначе «35%» читается как угодно (09 §3.2)
	label := ""
	if result.MarginMode == MarginModeMargin {
		label = "маржа " + trimFloat(result.MarginOfPricePct) + " % от цены = наценка " + trimFloat(result.MarkupPct) + " %"
	} else {
		label = "наценка " + trimFloat(result.MarkupPct) + " % = маржа " + trimFloat(result.MarginOfPricePct) + " % от цены"
	}

	return Explanation{
		Lines:         lines,
		TotalManHours: result.TotalManHours,
		PriceCheck:    priceCheck,
		MarginSummary: MarginSummary{
			Mode:             result.MarginMode,
			Pct:              round2(result.MarginPct * 100),
			MarginOfPricePct: result.MarginOfPricePct,
			MarkupPct:        result.MarkupPct,
			Label:            label,
		},
	}
}
