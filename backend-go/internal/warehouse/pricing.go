// Package warehouse — точный перенос backend/src/common/material-batches.ts
// (партии материала, подбор закупочной цены) и labor.ts (штат/подряд на
// переделе) — вместе с costing.service.ts, самая проверенная арифметика в
// системе: разброс между приходами одного материала доходит до +37%, и
// заказ, посчитанный по разным партиям, отличается на треть.
package warehouse

import (
	"math"
	"sort"
)

type PriceSource string

const (
	PriceSourceFIFOStock     PriceSource = "FIFO_STOCK"
	PriceSourceSpecificBatch PriceSource = "SPECIFIC_BATCH"
	PriceSourceWeightedAvg   PriceSource = "WEIGHTED_AVG"
	PriceSourceLastPurchase  PriceSource = "LAST_PURCHASE"
	PriceSourcePriceList     PriceSource = "PRICE_LIST"
	PriceSourceManual        PriceSource = "MANUAL"
)

// BatchSelectionError — перенос BatchSelectionError. Как CostingConfigError
// в модуле себестоимости: плейн Error в оригинале, не HttpException — до
// клиента долетает как голый 500 (см. costing/pure.go ConfigError).
type BatchSelectionError struct {
	Code    string
	Message string
}

func (e *BatchSelectionError) Error() string { return e.Message }

type BatchLike struct {
	ID           string
	ReceiptDate  int64 // unix millis, для сравнения дат без time.Time зависимостей
	UnitPrice    float64
	QtyRemaining float64
	PriceAnomaly bool
}

type BatchAllocation struct {
	BatchID   string  `json:"batchId"`
	Qty       float64 `json:"qty"`
	UnitPrice float64 `json:"unitPrice"`
	LineCost  float64 `json:"lineCost"`
}

type PriceRequest struct {
	Qty            float64
	Source         PriceSource
	BatchID        *string
	ExplicitPrice  *float64
	FallbackPrice  *float64
	AllowAnomalies bool
}

type PriceResolution struct {
	Source                  PriceSource       `json:"source"`
	UnitPrice               float64           `json:"unitPrice"`
	TotalCost               float64           `json:"totalCost"`
	Allocations             []BatchAllocation `json:"allocations"`
	CoveredQty              float64           `json:"coveredQty"`
	ShortageQty             float64           `json:"shortageQty"`
	ShortageUnitPrice       float64           `json:"shortageUnitPrice"`
	ShortageCost            float64           `json:"shortageCost"`
	IsShortage              bool              `json:"isShortage"`
	ExcludedAnomalyBatchIDs []string          `json:"excludedAnomalyBatchIds"`
	Basis                   string            `json:"basis"` // 'batches' | 'explicit' | 'last_purchase' | 'none'
}

func round2(n float64) float64 { return math.Round(n*100) / 100 }
func round3(n float64) float64 { return math.Round(n*1000) / 1000 }

func Median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64{}, values...)
	sort.Float64s(sorted)
	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}

// AnomalyFactor — во сколько раз цена расходится с медианой — в любую
// сторону. nil (через ok=false), если сравнивать не с чем.
func AnomalyFactor(price float64, otherPrices []float64) (float64, bool) {
	positive := make([]float64, 0, len(otherPrices))
	for _, p := range otherPrices {
		if p > 0 {
			positive = append(positive, p)
		}
	}
	base := Median(positive)
	if base <= 0 || price <= 0 {
		return 0, false
	}
	ratio := price / base
	inv := base / price
	if inv > ratio {
		ratio = inv
	}
	return round2(ratio), true
}

// IsPriceAnomaly — карантин цены (09 §4.5): порог 5× ловит перепутанные
// единицы измерения, но не обычный рыночный разброс в 25-37%.
func IsPriceAnomaly(price float64, otherPrices []float64, threshold float64) bool {
	factor, ok := AnomalyFactor(price, otherPrices)
	return ok && factor > threshold
}

// LastPurchasePriceOf — цена последнего прихода.
func LastPurchasePriceOf(batches []BatchLike) (price float64, batchID *string) {
	if len(batches) == 0 {
		return 0, nil
	}
	latest := batches[0]
	for _, b := range batches[1:] {
		if b.ReceiptDate > latest.ReceiptDate {
			latest = b
		}
	}
	id := latest.ID
	return latest.UnitPrice, &id
}

// ResolvePrice — подбор цены под требуемый объём, с раскладкой по партиям.
func ResolvePrice(batches []BatchLike, req PriceRequest) (PriceResolution, error) {
	qty := req.Qty
	if qty < 0 {
		qty = 0
	}
	allowAnomalies := req.AllowAnomalies

	var excludedAnomalyBatchIDs []string
	for _, b := range batches {
		if b.PriceAnomaly && !allowAnomalies && b.QtyRemaining > 0 {
			excludedAnomalyBatchIDs = append(excludedAnomalyBatchIDs, b.ID)
		}
	}
	if excludedAnomalyBatchIDs == nil {
		excludedAnomalyBatchIDs = []string{}
	}

	var usable []BatchLike
	for _, b := range batches {
		if b.QtyRemaining > 0 && (allowAnomalies || !b.PriceAnomaly) {
			usable = append(usable, b)
		}
	}

	fallback := 0.0
	if req.FallbackPrice != nil {
		fallback = *req.FallbackPrice
	} else {
		var forFallback []BatchLike
		if allowAnomalies {
			forFallback = batches
		} else {
			for _, b := range batches {
				if !b.PriceAnomaly {
					forFallback = append(forFallback, b)
				}
			}
		}
		fallback, _ = LastPurchasePriceOf(forFallback)
	}

	finish := func(allocations []BatchAllocation, basis string) PriceResolution {
		coveredQty := 0.0
		lineCostSum := 0.0
		for _, a := range allocations {
			coveredQty += a.Qty
			lineCostSum += a.LineCost
		}
		coveredQty = round3(coveredQty)
		shortageQty := round3(math.Max(0, qty-coveredQty))
		shortageUnitPrice := 0.0
		if shortageQty > 0 {
			shortageUnitPrice = round2(fallback)
		}
		shortageCost := round2(shortageQty * shortageUnitPrice)
		totalCost := round2(lineCostSum + shortageCost)
		unitPrice := 0.0
		if qty > 0 {
			unitPrice = round2(totalCost / qty)
		}
		if allocations == nil {
			allocations = []BatchAllocation{}
		}
		return PriceResolution{
			Source: req.Source, UnitPrice: unitPrice, TotalCost: totalCost, Allocations: allocations,
			CoveredQty: coveredQty, ShortageQty: shortageQty, ShortageUnitPrice: shortageUnitPrice,
			ShortageCost: shortageCost, IsShortage: shortageQty > 0,
			ExcludedAnomalyBatchIDs: excludedAnomalyBatchIDs, Basis: basis,
		}
	}

	flat := func(price float64, basis string) PriceResolution {
		totalCost := round2(qty * price)
		return PriceResolution{
			Source: req.Source, UnitPrice: round2(price), TotalCost: totalCost, Allocations: []BatchAllocation{},
			CoveredQty: qty, ShortageQty: 0, ShortageUnitPrice: 0, ShortageCost: 0, IsShortage: false,
			ExcludedAnomalyBatchIDs: excludedAnomalyBatchIDs, Basis: basis,
		}
	}

	switch req.Source {
	case PriceSourceManual, PriceSourcePriceList:
		if req.ExplicitPrice == nil {
			return PriceResolution{}, &BatchSelectionError{
				Code: "EXPLICIT_PRICE_REQUIRED", Message: "Для источника " + string(req.Source) + " нужно указать цену",
			}
		}
		return flat(*req.ExplicitPrice, "explicit"), nil

	case PriceSourceLastPurchase:
		var forLast []BatchLike
		if allowAnomalies {
			forLast = batches
		} else {
			for _, b := range batches {
				if !b.PriceAnomaly {
					forLast = append(forLast, b)
				}
			}
		}
		price, _ := LastPurchasePriceOf(forLast)
		basis := "none"
		if price > 0 {
			basis = "last_purchase"
		}
		return flat(price, basis), nil

	case PriceSourceSpecificBatch:
		if req.BatchID == nil || *req.BatchID == "" {
			return PriceResolution{}, &BatchSelectionError{Code: "BATCH_REQUIRED", Message: "Не указана партия"}
		}
		var batch *BatchLike
		for i := range batches {
			if batches[i].ID == *req.BatchID {
				batch = &batches[i]
				break
			}
		}
		if batch == nil {
			return PriceResolution{}, &BatchSelectionError{Code: "BATCH_NOT_FOUND", Message: "Партия " + *req.BatchID + " не найдена"}
		}
		if batch.PriceAnomaly && !allowAnomalies {
			return PriceResolution{}, &BatchSelectionError{Code: "BATCH_IN_QUARANTINE", Message: "Партия на карантине по цене — нужно подтверждение снабжения"}
		}
		take := round3(math.Min(qty, math.Max(0, batch.QtyRemaining)))
		var allocations []BatchAllocation
		basis := "none"
		if take > 0 {
			allocations = []BatchAllocation{{BatchID: batch.ID, Qty: take, UnitPrice: batch.UnitPrice, LineCost: round2(take * batch.UnitPrice)}}
			basis = "batches"
		}
		return finish(allocations, basis), nil

	case PriceSourceWeightedAvg:
		totalRemaining := 0.0
		for _, b := range usable {
			totalRemaining += b.QtyRemaining
		}
		if totalRemaining <= 0 {
			return finish(nil, "none"), nil
		}
		weightedSum := 0.0
		for _, b := range usable {
			weightedSum += b.QtyRemaining * b.UnitPrice
		}
		avg := weightedSum / totalRemaining
		covered := round3(math.Min(qty, totalRemaining))
		var allocations []BatchAllocation
		basis := "none"
		if covered > 0 {
			allocations = []BatchAllocation{{BatchID: "", Qty: covered, UnitPrice: round2(avg), LineCost: round2(covered * avg)}}
			basis = "batches"
		}
		return finish(allocations, basis), nil

	case PriceSourceFIFOStock:
		fallthrough
	default:
		queue := append([]BatchLike{}, usable...)
		sort.Slice(queue, func(i, j int) bool {
			if queue[i].ReceiptDate != queue[j].ReceiptDate {
				return queue[i].ReceiptDate < queue[j].ReceiptDate
			}
			return queue[i].ID < queue[j].ID
		})
		var allocations []BatchAllocation
		left := qty
		for _, b := range queue {
			if left <= 0 {
				break
			}
			take := round3(math.Min(left, b.QtyRemaining))
			if take <= 0 {
				continue
			}
			allocations = append(allocations, BatchAllocation{BatchID: b.ID, Qty: take, UnitPrice: b.UnitPrice, LineCost: round2(take * b.UnitPrice)})
			left = round3(left - take)
		}
		basis := "none"
		if len(allocations) > 0 {
			basis = "batches"
		}
		return finish(allocations, basis), nil
	}
}
