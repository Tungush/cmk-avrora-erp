// Перенос backend/src/common/labor.ts — трудозатраты: штат и подряд на
// одном переделе. Норма — свойство изделия, исполнитель — свойство заказа.
package warehouse

import (
	"math"
	"strconv"
)

func trimFloat(n float64) string { return strconv.FormatFloat(n, 'f', -1, 64) }

type LaborKind string

const (
	LaborKindStaff      LaborKind = "STAFF"
	LaborKindContractor LaborKind = "CONTRACTOR"
)

type RateType string

const (
	RateTypePerHour RateType = "PER_HOUR"
	RateTypePerUnit RateType = "PER_UNIT"
	RateTypePerKg   RateType = "PER_KG"
	RateTypePerTon  RateType = "PER_TON"
	RateTypeFixed   RateType = "FIXED"
)

var weightBasedRates = map[RateType]bool{RateTypePerKg: true, RateTypePerTon: true}

var rateTypeLabels = map[RateType]string{
	RateTypePerHour: "₸ / час", RateTypePerUnit: "₸ / шт", RateTypePerKg: "₸ / кг",
	RateTypePerTon: "₸ / т", RateTypeFixed: "₸ за объём",
}

// LaborConfigError — перенос LaborConfigError (плейн Error, не HttpException
// — тот же класс поведения, что CostingConfigError/BatchSelectionError).
type LaborConfigError struct {
	Code    string
	Message string
}

func (e *LaborConfigError) Error() string { return e.Message }

type Stage string

const (
	StageCutting  Stage = "CUTTING"
	StageAssembly Stage = "ASSEMBLY"
	StagePainting Stage = "PAINTING"
)

// LaborAssignment — перенос LaborAssignment.
type LaborAssignment struct {
	ID               string
	Stage            Stage
	LaborKind        LaborKind
	Share            float64
	RateType         RateType
	Rate             float64
	CountInShopHours bool
	Workers          float64
	HoursPerUnit     float64
	PlannedHours     *float64
	ContractorID     *string
	WorkCenterID     *string
	ActualQty        *float64
	ActualAmount     *float64
	AllocationFactor *float64
}

type LaborContext struct {
	Qty      float64
	WeightKg float64
}

type LaborLineCost struct {
	Stage              Stage     `json:"stage"`
	LaborKind          LaborKind `json:"laborKind"`
	Share              float64   `json:"share"`
	RateType           RateType  `json:"rateType"`
	Rate               float64   `json:"rate"`
	Cost               float64   `json:"cost"`
	ManHours           float64   `json:"manHours"`
	CountedInShopHours bool      `json:"countedInShopHours"`
	ContractorID       *string   `json:"contractorId"`
	WorkCenterID       *string   `json:"workCenterId"`
}

const shareTolerance = 1e-4

// RateTypeAvailable — доступен ли тип ставки для этого изделия (09 §5.2).
func RateTypeAvailable(rateType RateType, weightKg float64) bool {
	return !weightBasedRates[rateType] || weightKg > 0
}

// CalcAssignmentCost — стоимость и трудоёмкость одной строки исполнения.
// Молчаливых нулей нет нигде: весовая ставка без веса и сдельный подряд в
// нашем цеху без оценки часов — это ошибки, не «ноль» и «свободный цех».
func CalcAssignmentCost(a LaborAssignment, ctx LaborContext) (cost, manHours float64, err error) {
	qty := math.Max(0, ctx.Qty)
	share := math.Max(0, a.Share)
	weightKg := ctx.WeightKg

	alloc := 1.0
	if a.AllocationFactor != nil && *a.AllocationFactor >= 0 {
		alloc = *a.AllocationFactor
	}

	var measured *float64
	if a.ActualQty != nil && *a.ActualQty >= 0 {
		v := *a.ActualQty * alloc
		measured = &v
	}

	if weightBasedRates[a.RateType] && weightKg <= 0 && a.ActualQty == nil {
		return 0, 0, &LaborConfigError{
			Code:    "RATE_REQUIRES_WEIGHT",
			Message: "Ставка " + rateTypeLabels[a.RateType] + " требует заполненного веса изделия",
		}
	}

	normManHours := round3(a.Workers * a.HoursPerUnit * qty * share)
	plannedHours := 0.0
	if a.PlannedHours != nil {
		plannedHours = *a.PlannedHours
	}

	switch a.RateType {
	case RateTypePerHour:
		if measured != nil {
			manHours = *measured
		} else {
			manHours = normManHours
		}
		cost = round2(manHours * a.Rate)
	case RateTypePerUnit:
		volume := qty * share
		if measured != nil {
			volume = *measured
		}
		cost = round2(volume * a.Rate)
		manHours = round3(plannedHours * alloc)
	case RateTypePerKg:
		volume := qty * share * weightKg
		if measured != nil {
			volume = *measured
		}
		cost = round2(volume * a.Rate)
		manHours = round3(plannedHours * alloc)
	case RateTypePerTon:
		volume := (qty * share * weightKg) / 1000
		if measured != nil {
			volume = *measured
		}
		cost = round2(volume * a.Rate)
		manHours = round3(plannedHours * alloc)
	case RateTypeFixed:
		fallthrough
	default:
		cost = round2(a.Rate * alloc)
		manHours = round3(plannedHours * alloc)
	}

	// Сумма, замороженная при приёмке, важнее пересчёта
	if a.ActualAmount != nil && *a.ActualAmount >= 0 {
		cost = round2(*a.ActualAmount * alloc)
	}

	if a.CountInShopHours && a.RateType != RateTypePerHour && manHours <= 0 {
		return 0, 0, &LaborConfigError{
			Code:    "SHOP_HOURS_ESTIMATE_REQUIRED",
			Message: "Работы идут в нашем цеху по сдельной ставке — нужна оценка часов",
		}
	}

	return cost, manHours, nil
}

// ValidateShares — сумма долей на переделе не может превышать единицу
// (объём посчитан дважды). Недобор до единицы ошибкой не является.
func ValidateShares(assignments []LaborAssignment) string {
	byStage := map[Stage]float64{}
	for _, a := range assignments {
		if a.Share < 0 {
			return "Доля не может быть отрицательной (" + string(a.Stage) + ")"
		}
		byStage[a.Stage] += a.Share
	}
	for stage, sum := range byStage {
		if sum-1 > shareTolerance {
			return "Доли на переделе " + string(stage) + " дают " + trimFloat(round2(sum*100)) + " % — объём посчитан дважды"
		}
	}
	return ""
}

type LaborSummary struct {
	Lines                 []LaborLineCost    `json:"lines"`
	ShopManHours          float64            `json:"shopManHours"`
	StaffCost             float64            `json:"staffCost"`
	ContractorCost        float64            `json:"contractorCost"`
	OffsiteContractorCost float64            `json:"offsiteContractorCost"`
	TotalCost             float64            `json:"totalCost"`
	ByStage               []StageCostSummary `json:"byStage"`
}

type StageCostSummary struct {
	Stage    Stage   `json:"stage"`
	Cost     float64 `json:"cost"`
	ManHours float64 `json:"manHours"`
}

// SummarizeLabor — сводка по всем строкам исполнения заказа.
func SummarizeLabor(assignments []LaborAssignment, ctx LaborContext) (LaborSummary, error) {
	if errMsg := ValidateShares(assignments); errMsg != "" {
		return LaborSummary{}, &LaborConfigError{Code: "INVALID_SHARES", Message: errMsg}
	}

	lines := make([]LaborLineCost, len(assignments))
	for i, a := range assignments {
		cost, manHours, err := CalcAssignmentCost(a, ctx)
		if err != nil {
			return LaborSummary{}, err
		}
		lines[i] = LaborLineCost{
			Stage: a.Stage, LaborKind: a.LaborKind, Share: a.Share, RateType: a.RateType, Rate: a.Rate,
			Cost: cost, ManHours: manHours, CountedInShopHours: a.CountInShopHours,
			ContractorID: a.ContractorID, WorkCenterID: a.WorkCenterID,
		}
	}

	shopManHours, staffCost, contractorCost, offsiteContractorCost, totalCost := 0.0, 0.0, 0.0, 0.0, 0.0
	byStageMap := map[Stage]*StageCostSummary{}
	var stageOrder []Stage
	for _, l := range lines {
		if l.CountedInShopHours {
			shopManHours += l.ManHours
		}
		if l.LaborKind == LaborKindStaff {
			staffCost += l.Cost
		}
		if l.LaborKind == LaborKindContractor {
			contractorCost += l.Cost
			if !l.CountedInShopHours {
				offsiteContractorCost += l.Cost
			}
		}
		totalCost += l.Cost
		s, ok := byStageMap[l.Stage]
		if !ok {
			s = &StageCostSummary{Stage: l.Stage}
			byStageMap[l.Stage] = s
			stageOrder = append(stageOrder, l.Stage)
		}
		s.Cost += l.Cost
		s.ManHours += l.ManHours
	}
	byStage := make([]StageCostSummary, 0, len(stageOrder))
	for _, s := range stageOrder {
		v := byStageMap[s]
		byStage = append(byStage, StageCostSummary{Stage: v.Stage, Cost: round2(v.Cost), ManHours: round3(v.ManHours)})
	}

	return LaborSummary{
		Lines: lines, ShopManHours: round3(shopManHours), StaffCost: round2(staffCost),
		ContractorCost: round2(contractorCost), OffsiteContractorCost: round2(offsiteContractorCost),
		TotalCost: round2(totalCost), ByStage: byStage,
	}, nil
}

// DefaultStaffAssignments — строки исполнения по умолчанию: целиком штат по нормам изделия.
type NormLike struct {
	Stage        Stage
	Workers      float64
	HoursPerUnit float64
	HourlyRate   float64
	WorkCenterID *string
}

func DefaultStaffAssignments(norms []NormLike) []LaborAssignment {
	out := make([]LaborAssignment, len(norms))
	for i, n := range norms {
		out[i] = LaborAssignment{
			Stage: n.Stage, LaborKind: LaborKindStaff, Share: 1, RateType: RateTypePerHour, Rate: n.HourlyRate,
			CountInShopHours: true, Workers: n.Workers, HoursPerUnit: n.HoursPerUnit, WorkCenterID: n.WorkCenterID,
		}
	}
	return out
}
