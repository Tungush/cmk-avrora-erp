// Перенос backend/src/common/costing-compare.ts — факторный разбор разницы
// между версиями калькуляции (09 §6): не «стало дороже», а «вот из-за чего».
// Разложение по материалу: q₂p₂ − q₁p₁ = q₁(p₂−p₁) + p₂(q₂−q₁).
package ordercosting

import (
	"math"
	"sort"
	"strconv"
	"strings"
)

type SnapshotMaterial struct {
	MaterialID *string
	Name       string
	QtyTotal   float64
	UnitPrice  float64
	LineCost   float64
	BatchID    *string
}

type SnapshotLabor struct {
	Stage     string
	LaborKind string
	RateType  string
	Rate      float64
	ManHours  float64
	LineCost  float64
}

type CostingSnapshot struct {
	Version       int
	CalculatedAt  interface{} // отдаётся как есть (PDate)
	Qty           float64
	MaterialCost  float64
	LaborCost     float64
	LogisticsCost float64
	UtilitiesCost float64
	TotalCost     float64
	Margin        float64
	Price         float64
	LogisticsPct  float64
	LogisticsMode string
	UtilitiesPct  float64
	MarginPct     float64
	MarginMode    string
	Materials     []SnapshotMaterial
	Labor         []SnapshotLabor
}

type FactorDetail struct {
	Key   string  `json:"key"`
	Label string  `json:"label"`
	Delta float64 `json:"delta"`
	Note  string  `json:"note,omitempty"`
}

func pctChange(from, to float64) *float64 {
	if from == 0 {
		return nil
	}
	v := round2(((to - from) / math.Abs(from)) * 100)
	return &v
}

// fmtRu — n.toLocaleString('ru-RU'): до 3 знаков после запятой (округление
// half-away-from-zero), запятая как десятичный, U+00A0 группами по три.
func fmtRu(n float64) string {
	neg := n < 0
	a := math.Abs(n)
	a = math.Round(a*1000) / 1000
	s := strconv.FormatFloat(a, 'f', -1, 64)
	intPart, frac := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart, frac = s[:i], s[i+1:]
	}
	var b strings.Builder
	for i, ch := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteString(" ")
		}
		b.WriteRune(ch)
	}
	out := b.String()
	if frac != "" {
		out += "," + frac
	}
	if neg {
		out = "-" + out
	}
	return out
}

func trimNum(n float64) string { return strconv.FormatFloat(n, 'f', -1, 64) }

// orderedMap — JS Map: порядок первой вставки, значение — последнее.
type orderedMap[T any] struct {
	keys []string
	vals map[string]T
}

func newOrderedMap[T any]() *orderedMap[T] { return &orderedMap[T]{vals: map[string]T{}} }
func (m *orderedMap[T]) set(k string, v T) {
	if _, ok := m.vals[k]; !ok {
		m.keys = append(m.keys, k)
	}
	m.vals[k] = v
}
func (m *orderedMap[T]) get(k string) (T, bool) { v, ok := m.vals[k]; return v, ok }

func materialKey(m SnapshotMaterial) string {
	if m.MaterialID != nil {
		return *m.MaterialID
	}
	return "name:" + strings.ToLower(strings.TrimSpace(m.Name))
}

func sortByAbsDelta(d []FactorDetail) []FactorDetail {
	if d == nil {
		return []FactorDetail{}
	}
	sort.SliceStable(d, func(i, j int) bool { return math.Abs(d[i].Delta) > math.Abs(d[j].Delta) })
	return d
}

type MaterialsComparison struct {
	Delta       float64        `json:"delta"`
	PriceEffect float64        `json:"priceEffect"`
	QtyEffect   float64        `json:"qtyEffect"`
	MixEffect   float64        `json:"mixEffect"`
	Details     []FactorDetail `json:"details"`
}

func CompareMaterials(base, target []SnapshotMaterial) MaterialsComparison {
	baseMap, targetMap := newOrderedMap[SnapshotMaterial](), newOrderedMap[SnapshotMaterial]()
	for _, m := range base {
		baseMap.set(materialKey(m), m)
	}
	for _, m := range target {
		targetMap.set(materialKey(m), m)
	}
	var priceEffect, qtyEffect, mixEffect float64
	var details []FactorDetail
	for _, key := range targetMap.keys {
		t := targetMap.vals[key]
		b, ok := baseMap.get(key)
		if !ok {
			mixEffect += t.LineCost
			details = append(details, FactorDetail{Key: key, Label: t.Name, Delta: round2(t.LineCost), Note: "добавлено в состав"})
			continue
		}
		price := b.QtyTotal * (t.UnitPrice - b.UnitPrice)
		qty := t.UnitPrice * (t.QtyTotal - b.QtyTotal)
		priceEffect += price
		qtyEffect += qty
		if round2(price) != 0 || round2(qty) != 0 {
			var parts []string
			if round2(price) != 0 {
				p := pctChange(b.UnitPrice, t.UnitPrice)
				ps := "null"
				if p != nil {
					ps = trimNum(*p)
				}
				parts = append(parts, "цена "+fmtRu(b.UnitPrice)+" → "+fmtRu(t.UnitPrice)+" ₸ ("+ps+" %)")
			}
			if round2(qty) != 0 {
				parts = append(parts, "расход "+trimNum(b.QtyTotal)+" → "+trimNum(t.QtyTotal))
			}
			if b.BatchID != nil && t.BatchID != nil && *b.BatchID != *t.BatchID {
				parts = append(parts, "другая партия")
			}
			details = append(details, FactorDetail{Key: key, Label: t.Name, Delta: round2(price + qty), Note: strings.Join(parts, "; ")})
		}
	}
	for _, key := range baseMap.keys {
		if _, ok := targetMap.get(key); ok {
			continue
		}
		b := baseMap.vals[key]
		mixEffect -= b.LineCost
		details = append(details, FactorDetail{Key: key, Label: b.Name, Delta: round2(-b.LineCost), Note: "убрано из состава"})
	}
	return MaterialsComparison{
		Delta: round2(priceEffect + qtyEffect + mixEffect), PriceEffect: round2(priceEffect),
		QtyEffect: round2(qtyEffect), MixEffect: round2(mixEffect), Details: sortByAbsDelta(details),
	}
}

type LaborComparison struct {
	Delta          float64        `json:"delta"`
	RateEffect     float64        `json:"rateEffect"`
	NormEffect     float64        `json:"normEffect"`
	ExecutorEffect float64        `json:"executorEffect"`
	MixEffect      float64        `json:"mixEffect"`
	Details        []FactorDetail `json:"details"`
}

func CompareLabor(base, target []SnapshotLabor) LaborComparison {
	baseMap, targetMap := newOrderedMap[SnapshotLabor](), newOrderedMap[SnapshotLabor]()
	for _, l := range base {
		baseMap.set(l.Stage, l)
	}
	for _, l := range target {
		targetMap.set(l.Stage, l)
	}
	var rateEffect, normEffect, executorEffect, mixEffect float64
	var details []FactorDetail
	for _, key := range targetMap.keys {
		t := targetMap.vals[key]
		b, ok := baseMap.get(key)
		if !ok {
			mixEffect += t.LineCost
			details = append(details, FactorDetail{Key: key, Label: t.Stage, Delta: round2(t.LineCost), Note: "передел добавлен"})
			continue
		}
		delta := t.LineCost - b.LineCost
		if round2(delta) == 0 {
			continue
		}
		if b.LaborKind != t.LaborKind || b.RateType != t.RateType {
			executorEffect += delta
			details = append(details, FactorDetail{Key: key, Label: t.Stage, Delta: round2(delta),
				Note: "исполнение " + b.LaborKind + " → " + t.LaborKind + ", ставка " + b.RateType + " → " + t.RateType})
			continue
		}
		if b.ManHours > 0 || t.ManHours > 0 {
			rate := b.ManHours * (t.Rate - b.Rate)
			norm := t.Rate * (t.ManHours - b.ManHours)
			rateEffect += rate
			normEffect += norm
			var parts []string
			if round2(rate) != 0 {
				parts = append(parts, "ставка "+fmtRu(b.Rate)+" → "+fmtRu(t.Rate)+" ₸")
			}
			if round2(norm) != 0 {
				parts = append(parts, "часы "+trimNum(b.ManHours)+" → "+trimNum(t.ManHours))
			}
			details = append(details, FactorDetail{Key: key, Label: t.Stage, Delta: round2(rate + norm), Note: strings.Join(parts, "; ")})
		} else {
			rateEffect += delta
			details = append(details, FactorDetail{Key: key, Label: t.Stage, Delta: round2(delta), Note: "ставка " + fmtRu(b.Rate) + " → " + fmtRu(t.Rate) + " ₸"})
		}
	}
	for _, key := range baseMap.keys {
		if _, ok := targetMap.get(key); ok {
			continue
		}
		b := baseMap.vals[key]
		mixEffect -= b.LineCost
		details = append(details, FactorDetail{Key: key, Label: b.Stage, Delta: round2(-b.LineCost), Note: "передел убран"})
	}
	return LaborComparison{
		Delta: round2(rateEffect + normEffect + executorEffect + mixEffect), RateEffect: round2(rateEffect),
		NormEffect: round2(normEffect), ExecutorEffect: round2(executorEffect), MixEffect: round2(mixEffect),
		Details: sortByAbsDelta(details),
	}
}

type VersionRef struct {
	Version      int         `json:"version"`
	CalculatedAt interface{} `json:"calculatedAt"`
	Price        float64     `json:"price"`
}

type PriceDelta struct {
	Before   float64  `json:"before"`
	After    float64  `json:"after"`
	Delta    float64  `json:"delta"`
	DeltaPct *float64 `json:"deltaPct"`
}

type CostDelta struct {
	Before float64 `json:"before"`
	After  float64 `json:"after"`
	Delta  float64 `json:"delta"`
}

type NotedDelta struct {
	Delta float64 `json:"delta"`
	Note  string  `json:"note"`
}

type Comparison struct {
	Base      VersionRef `json:"base"`
	Target    VersionRef `json:"target"`
	Price     PriceDelta `json:"price"`
	TotalCost CostDelta  `json:"totalCost"`
	Factors   struct {
		Materials MaterialsComparison `json:"materials"`
		Labor     LaborComparison     `json:"labor"`
		Logistics NotedDelta          `json:"logistics"`
		Utilities struct {
			Delta float64 `json:"delta"`
		} `json:"utilities"`
		Margin NotedDelta `json:"margin"`
	} `json:"factors"`
}

func CompareCostings(base, target CostingSnapshot) Comparison {
	var c Comparison
	c.Base = VersionRef{base.Version, base.CalculatedAt, base.Price}
	c.Target = VersionRef{target.Version, target.CalculatedAt, target.Price}
	c.Price = PriceDelta{base.Price, target.Price, round2(target.Price - base.Price), pctChange(base.Price, target.Price)}
	c.TotalCost = CostDelta{base.TotalCost, target.TotalCost, round2(target.TotalCost - base.TotalCost)}
	c.Factors.Materials = CompareMaterials(base.Materials, target.Materials)
	c.Factors.Labor = CompareLabor(base.Labor, target.Labor)

	logisticsNote := "процент не менялся, эффект базы"
	if base.LogisticsMode != target.LogisticsMode {
		logisticsNote = "режим " + base.LogisticsMode + " → " + target.LogisticsMode
	} else if base.LogisticsPct != target.LogisticsPct {
		logisticsNote = trimNum(round2(base.LogisticsPct*100)) + " % → " + trimNum(round2(target.LogisticsPct*100)) + " %"
	}
	marginNote := "процент не менялся, эффект базы"
	if base.MarginMode != target.MarginMode {
		marginNote = "режим " + base.MarginMode + " → " + target.MarginMode
	} else if base.MarginPct != target.MarginPct {
		marginNote = trimNum(round2(base.MarginPct*100)) + " % → " + trimNum(round2(target.MarginPct*100)) + " %"
	}
	c.Factors.Logistics = NotedDelta{round2(target.LogisticsCost - base.LogisticsCost), logisticsNote}
	c.Factors.Utilities.Delta = round2(target.UtilitiesCost - base.UtilitiesCost)
	c.Factors.Margin = NotedDelta{round2(target.Margin - base.Margin), marginNote}
	return c
}

// Reconcile — сумма факторов обязана давать разницу цены до копейки.
func Reconcile(c Comparison) float64 {
	f := c.Factors
	sum := f.Materials.Delta + f.Labor.Delta + f.Logistics.Delta + f.Utilities.Delta + f.Margin.Delta
	return round2(c.Price.Delta - sum)
}
