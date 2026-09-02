// Package ordercosting — перенос order-costing.service.ts: калькуляция
// заказа как ДОКУМЕНТА (09_COSTING_AND_STAGES.md §3). ArticleCosting
// (internal/costing) отвечает «сколько стоит изделие вообще»; здесь —
// «сколько стоит это изделие в этом заказе, посчитанное тогда-то и по
// таким-то партиям» — снимок, который не имеет права поехать задним числом.
package ordercosting

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/costing"
	"cmk-avrora-erp/backend-go/internal/models"
	"cmk-avrora-erp/backend-go/internal/warehouse"
)

func round2(n float64) float64 { return math.Round(n*100) / 100 }
func round3(n float64) float64 { return math.Round(n*1000) / 1000 }

// Доля объёма передела — Decimal(6,4) в базе
func round4(n float64) float64 { return math.Round(n*10000) / 10000 }

func decimalOf(n float64) decimal.Decimal { return decimal.NewFromFloat(n) }

// MaterialOverride — точечное переопределение по материалу (своя партия,
// своя цена) при построении калькуляции.
type MaterialOverride struct {
	PriceSource    *warehouse.PriceSource
	BatchID        *string
	ExplicitPrice  *float64
	AllowAnomalies bool
}

// RateOverrides — ручные коэффициенты; вместе с обязательной причиной.
type RateOverrides struct {
	HourlyRate     *float64
	LogisticsPct   *float64
	LogisticsMode  *costing.LogisticsMode
	LogisticsFixed *float64
	LogisticsPerKg *float64
	UtilitiesPct   *float64
	MarginPct      *float64
	MarginMode     *costing.MarginMode
}

func (r RateOverrides) isEmpty() bool {
	return r.HourlyRate == nil && r.LogisticsPct == nil && r.LogisticsMode == nil &&
		r.LogisticsFixed == nil && r.LogisticsPerKg == nil && r.UtilitiesPct == nil &&
		r.MarginPct == nil && r.MarginMode == nil
}

func applyOverrides(base costing.CostingRates, o RateOverrides) costing.CostingRates {
	r := base
	if o.HourlyRate != nil {
		r.HourlyRate = *o.HourlyRate
	}
	if o.LogisticsPct != nil {
		r.LogisticsPct = *o.LogisticsPct
	}
	if o.LogisticsMode != nil {
		r.LogisticsMode = *o.LogisticsMode
	}
	if o.LogisticsFixed != nil {
		r.LogisticsFixed = *o.LogisticsFixed
	}
	if o.LogisticsPerKg != nil {
		r.LogisticsPerKg = *o.LogisticsPerKg
	}
	if o.UtilitiesPct != nil {
		r.UtilitiesPct = *o.UtilitiesPct
	}
	if o.MarginPct != nil {
		r.MarginPct = *o.MarginPct
	}
	if o.MarginMode != nil {
		r.MarginMode = *o.MarginMode
	}
	return r
}

type BuildOptions struct {
	PriceSource       *warehouse.PriceSource
	MaterialOverrides map[string]MaterialOverride
	RateOverrides     RateOverrides
	RatesReason       string
	Note              string
}

func dbUserID(userID string) *string {
	if userID == "" || strings.HasPrefix(userID, "usr-") {
		return nil
	}
	return &userID
}

// AllocationFactors — какая доля заказ-уровневой работы приходится на эту
// позицию, по каждому переделу отдельно. База — нормативные часы передела;
// норм нет — делим по количеству; нет и его — поровну.
func AllocationFactors(ctx context.Context, pool *pgxpool.Pool, orderID, thisLineID string) (map[warehouse.Stage]float64, error) {
	result := map[warehouse.Stage]float64{}

	rows, err := pool.Query(ctx, "SELECT id, qty, article_id FROM order_lines WHERE order_id = $1", orderID)
	if err != nil {
		return nil, err
	}
	type lineRow struct {
		ID        string
		Qty       float64
		ArticleID *string
	}
	var lines []lineRow
	for rows.Next() {
		var l lineRow
		if err := rows.Scan(&l.ID, &l.Qty, &l.ArticleID); err != nil {
			rows.Close()
			return nil, err
		}
		lines = append(lines, l)
	}
	rows.Close()
	if len(lines) <= 1 {
		return result, nil
	}

	var articleIDs []string
	for _, l := range lines {
		if l.ArticleID != nil {
			articleIDs = append(articleIDs, *l.ArticleID)
		}
	}
	normPerUnit := map[string]float64{} // "articleId:STAGE" -> workers*hoursPerUnit
	if len(articleIDs) > 0 {
		orows, err := pool.Query(ctx, "SELECT article_id, stage, workers, hours_per_unit FROM routing_operations WHERE article_id = ANY($1)", articleIDs)
		if err != nil {
			return nil, err
		}
		for orows.Next() {
			var articleID, stageDB string
			var workers, hoursPerUnit float64
			if err := orows.Scan(&articleID, &stageDB, &workers, &hoursPerUnit); err != nil {
				orows.Close()
				return nil, err
			}
			stage := models.RoutingStageDBToAPI(stageDB)
			normPerUnit[articleID+":"+stage] = workers * hoursPerUnit
		}
		orows.Close()
	}

	var thisLine *lineRow
	for i := range lines {
		if lines[i].ID == thisLineID {
			thisLine = &lines[i]
			break
		}
	}

	for _, stage := range []warehouse.Stage{warehouse.StageCutting, warehouse.StageAssembly, warehouse.StagePainting} {
		weightOf := func(l lineRow) float64 {
			perUnit := 0.0
			if l.ArticleID != nil {
				perUnit = normPerUnit[*l.ArticleID+":"+string(stage)]
			}
			return perUnit * l.Qty
		}
		total := 0.0
		for _, l := range lines {
			total += weightOf(l)
		}
		mine := 0.0
		if thisLine != nil {
			mine = weightOf(*thisLine)
		}
		if total <= 0 {
			total = 0
			for _, l := range lines {
				total += l.Qty
			}
			if thisLine != nil {
				mine = thisLine.Qty
			}
		}
		if total > 0 {
			result[stage] = mine / total
		} else {
			result[stage] = 1.0 / float64(len(lines))
		}
	}
	return result, nil
}

// AssignmentsFor — строки исполнения позиции заказа (решение 23.08.2026:
// «норматив молчит, подряд говорит»). Норма изделия — всегда основа: по
// умолчанию весь объём каждого передела делает штат. Строка подряда
// вычитает свою долю на СВОЁМ переделе; остаток достаётся штату автоматически.
func AssignmentsFor(ctx context.Context, pool *pgxpool.Pool, orderLineID string, articleID *string, rates costing.CostingRates) ([]warehouse.LaborAssignment, error) {
	var orderID string
	var lineExists bool
	err := pool.QueryRow(ctx, "SELECT order_id FROM order_lines WHERE id = $1", orderLineID).Scan(&orderID)
	if err == nil {
		lineExists = true
	} else if err != pgx.ErrNoRows {
		return nil, err
	}

	type workRow struct {
		ID           string
		OrderLineID  *string
		RoutingStage string
		Share        float64
		RateType     string
		Rate         float64
		WorkLocation string
		PlannedHours *float64
		ActualQty    *float64
		ActualAmount *float64
		ContractorID string
	}
	var works []workRow
	if lineExists {
		rows, err := pool.Query(ctx, `
			SELECT id, order_line_id, routing_stage, share, rate_type, rate, work_location,
			       planned_hours, actual_qty, actual_amount, contractor_id
			FROM contractor_works WHERE order_line_id = $1 OR (order_id = $2 AND order_line_id IS NULL)`,
			orderLineID, orderID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var w workRow
			var stageDB string
			if err := rows.Scan(&w.ID, &w.OrderLineID, &stageDB, &w.Share, &w.RateType, &w.Rate, &w.WorkLocation,
				&w.PlannedHours, &w.ActualQty, &w.ActualAmount, &w.ContractorID); err != nil {
				rows.Close()
				return nil, err
			}
			w.RoutingStage = models.RoutingStageDBToAPI(stageDB)
			works = append(works, w)
		}
		rows.Close()
	}

	needsAllocation := false
	for _, w := range works {
		if w.OrderLineID == nil {
			needsAllocation = true
			break
		}
	}
	var allocByStage map[warehouse.Stage]float64
	if needsAllocation && lineExists {
		allocByStage, err = AllocationFactors(ctx, pool, orderID, orderLineID)
		if err != nil {
			return nil, err
		}
	}

	var norms []warehouse.NormLike
	if articleID != nil {
		rows, err := pool.Query(ctx, `
			SELECT ro.stage, ro.workers, ro.hours_per_unit, ro.work_center_id, wc.hourly_rate
			FROM routing_operations ro LEFT JOIN work_centers wc ON wc.id = ro.work_center_id
			WHERE ro.article_id = $1
			ORDER BY ro.sort_order ASC`, *articleID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var stageDB string
			var workers, hoursPerUnit float64
			var workCenterID *string
			var wcHourlyRate *float64
			if err := rows.Scan(&stageDB, &workers, &hoursPerUnit, &workCenterID, &wcHourlyRate); err != nil {
				rows.Close()
				return nil, err
			}
			stage := costing.Stage(models.RoutingStageDBToAPI(stageDB))
			rate := costing.RateForStage(stage, rates, wcHourlyRate)
			norms = append(norms, warehouse.NormLike{
				Stage: warehouse.Stage(stage), Workers: workers, HoursPerUnit: hoursPerUnit,
				HourlyRate: rate, WorkCenterID: workCenterID,
			})
		}
		rows.Close()
	}
	staffByNorm := warehouse.DefaultStaffAssignments(norms)

	if len(works) == 0 {
		return staffByNorm, nil
	}

	contractorRows := make([]warehouse.LaborAssignment, len(works))
	for i, w := range works {
		alloc := 1.0
		if w.OrderLineID == nil {
			if allocByStage != nil {
				if v, ok := allocByStage[warehouse.Stage(w.RoutingStage)]; ok {
					alloc = v
				}
			}
		}
		contractorID := w.ContractorID
		contractorRows[i] = warehouse.LaborAssignment{
			ID: w.ID, Stage: warehouse.Stage(w.RoutingStage), LaborKind: warehouse.LaborKindContractor,
			Share: w.Share, RateType: warehouse.RateType(w.RateType), Rate: w.Rate,
			CountInShopHours: w.WorkLocation == "OUR_SHOP", PlannedHours: w.PlannedHours,
			ActualQty: w.ActualQty, ActualAmount: w.ActualAmount, AllocationFactor: &alloc,
			ContractorID: &contractorID, WorkCenterID: nil, Workers: 0, HoursPerUnit: 0,
		}
	}

	takenByStage := map[warehouse.Stage]float64{}
	for _, r := range contractorRows {
		takenByStage[r.Stage] += r.Share
	}

	var result []warehouse.LaborAssignment
	for _, staff := range staffByNorm {
		rest := round4(math.Max(0, 1-takenByStage[staff.Stage]))
		if rest > 0 {
			s := staff
			s.Share = rest
			result = append(result, s)
		}
	}
	result = append(result, contractorRows...)
	return result, nil
}

// WithNorms — сохранённые строки исполнения не знают норм изделия. Для
// почасовых ставок подмешиваем их сюда, иначе трудоёмкость обнулится.
func WithNorms(ctx context.Context, pool *pgxpool.Pool, assignments []warehouse.LaborAssignment, articleID *string) ([]warehouse.LaborAssignment, error) {
	needsNorms := false
	for _, a := range assignments {
		if a.RateType == warehouse.RateTypePerHour && a.HoursPerUnit == 0 {
			needsNorms = true
			break
		}
	}
	if !needsNorms || articleID == nil {
		return assignments, nil
	}
	rows, err := pool.Query(ctx, "SELECT stage, workers, hours_per_unit FROM routing_operations WHERE article_id = $1", *articleID)
	if err != nil {
		return nil, err
	}
	byStage := map[warehouse.Stage]struct{ Workers, HoursPerUnit float64 }{}
	for rows.Next() {
		var stageDB string
		var workers, hoursPerUnit float64
		if err := rows.Scan(&stageDB, &workers, &hoursPerUnit); err != nil {
			rows.Close()
			return nil, err
		}
		byStage[warehouse.Stage(models.RoutingStageDBToAPI(stageDB))] = struct{ Workers, HoursPerUnit float64 }{workers, hoursPerUnit}
	}
	rows.Close()

	out := make([]warehouse.LaborAssignment, len(assignments))
	for i, a := range assignments {
		if a.RateType != warehouse.RateTypePerHour || a.HoursPerUnit != 0 {
			out[i] = a
			continue
		}
		if op, ok := byStage[a.Stage]; ok {
			a.Workers, a.HoursPerUnit = op.Workers, op.HoursPerUnit
		}
		out[i] = a
	}
	return out, nil
}

type materialRow struct {
	MaterialID           string
	MaterialCodeSnapshot string
	MaterialNameSnapshot string
	QtyPerUnit           float64
	QtyTotal             float64
	UnitPrice            float64
	LineCost             float64
	PriceSource          string
	BatchID              *string
	IsShortage           bool
	ShortageQty          float64
	ShortageUnitPrice    float64
	PriceState           string
	Allocations          []warehouse.BatchAllocation
	// PriceDate/PriceStateChangedAt — оригинал вызывает new Date() ОТДЕЛЬНО
	// на каждой итерации цикла по BOM (не один снимок времени на всю
	// калькуляцию), поэтому у соседних строк материалов метки времени
	// на доли миллисекунды отличаются — повторяем, а не берём одно now()
	PriceDate           time.Time
	PriceStateChangedAt time.Time
}

// Build — собрать новую версию калькуляции. Каждый вызов создаёт версию —
// прежние не переписываются никогда, в этом весь смысл документа.
func Build(ctx context.Context, pool *pgxpool.Pool, orderLineID string, opts BuildOptions, userID string) (models.OrderCosting, []models.OrderCostingMaterial, []models.OrderCostingLabor, error) {
	var lineOrderID, lineOrderNumber string
	var qty float64
	var articleID *string
	var articleCode, articleName *string
	var weightKg float64
	var isResale bool
	err := pool.QueryRow(ctx, `
		SELECT o.id, o.order_number, ol.qty, ol.article_id, a.article_code, a.name, a.weight_kg, a.is_material_resale
		FROM order_lines ol
		JOIN orders o ON o.id = ol.order_id
		LEFT JOIN articles a ON a.id = ol.article_id
		WHERE ol.id = $1`, orderLineID).
		Scan(&lineOrderID, &lineOrderNumber, &qty, &articleID, &articleCode, &articleName, &weightKg, &isResale)
	if err == pgx.ErrNoRows {
		return models.OrderCosting{}, nil, nil, &common.APIError404{Code: "NOT_FOUND", Message: "Позиция заказа " + orderLineID + " не найдена"}
	}
	if err != nil {
		return models.OrderCosting{}, nil, nil, err
	}
	hasArticle := articleID != nil

	if !opts.RateOverrides.isEmpty() && strings.TrimSpace(opts.RatesReason) == "" {
		return models.OrderCosting{}, nil, nil, &common.APIError400{
			Code:    "RATES_REASON_REQUIRED",
			Message: "Ручное изменение коэффициентов требует причину — иначе через месяц никто не вспомнит, почему тут эта цифра",
		}
	}

	baseRates, err := costing.ActiveRates(ctx, pool)
	if err != nil {
		return models.OrderCosting{}, nil, nil, err
	}
	rates := applyOverrides(baseRates, opts.RateOverrides)

	// ---- материалы: цена берётся из партий и запоминается со ссылкой на приход
	var bom []materialRow
	if hasArticle {
		if isResale {
			var matID, matCode, matName string
			var matPrice float64
			merr := pool.QueryRow(ctx, "SELECT id, material_code, name, purchase_price FROM materials WHERE material_code = $1", *articleCode).
				Scan(&matID, &matCode, &matName, &matPrice)
			if merr == nil {
				bom = []materialRow{{MaterialID: matID, MaterialCodeSnapshot: matCode, MaterialNameSnapshot: matName, QtyPerUnit: 1}}
			}
		} else {
			rows, berr := pool.Query(ctx, `
				SELECT bi.material_id, m.material_code, m.name, bi.qty_per_unit
				FROM bom_items bi JOIN materials m ON m.id = bi.material_id
				WHERE bi.article_id = $1`, *articleID)
			if berr != nil {
				return models.OrderCosting{}, nil, nil, berr
			}
			for rows.Next() {
				var r materialRow
				if serr := rows.Scan(&r.MaterialID, &r.MaterialCodeSnapshot, &r.MaterialNameSnapshot, &r.QtyPerUnit); serr != nil {
					rows.Close()
					return models.OrderCosting{}, nil, nil, serr
				}
				bom = append(bom, r)
			}
			rows.Close()
		}
	}

	defaultSource := warehouse.PriceSourceFIFOStock
	if opts.PriceSource != nil {
		defaultSource = *opts.PriceSource
	}
	materialCost := 0.0
	hasShortage := false
	materialRows := make([]materialRow, 0, len(bom))
	for _, item := range bom {
		override := opts.MaterialOverrides[item.MaterialID]
		qtyTotal := round3(item.QtyPerUnit * qty)
		source := defaultSource
		if override.PriceSource != nil {
			source = *override.PriceSource
		}
		resolution, perr := warehouse.PriceFor(ctx, pool, item.MaterialID, warehouse.PriceRequest{
			Qty: qtyTotal, Source: source, BatchID: override.BatchID,
			ExplicitPrice: override.ExplicitPrice, AllowAnomalies: override.AllowAnomalies,
		}, &lineOrderID)
		if perr != nil {
			return models.OrderCosting{}, nil, nil, perr
		}
		materialCost += resolution.TotalCost
		if resolution.IsShortage {
			hasShortage = true
		}
		var batchID *string
		if len(resolution.Allocations) > 0 && resolution.Allocations[0].BatchID != "" {
			b := resolution.Allocations[0].BatchID
			batchID = &b
		}
		priceState := "ESTIMATE"
		if batchID != nil && !resolution.IsShortage {
			priceState = "ACTUAL"
		}
		rowTime := time.Now().UTC()
		materialRows = append(materialRows, materialRow{
			MaterialID: item.MaterialID, MaterialCodeSnapshot: item.MaterialCodeSnapshot, MaterialNameSnapshot: item.MaterialNameSnapshot,
			QtyPerUnit: item.QtyPerUnit, QtyTotal: qtyTotal, UnitPrice: resolution.UnitPrice, LineCost: resolution.TotalCost,
			PriceDate: rowTime, PriceStateChangedAt: rowTime,
			PriceSource: string(resolution.Source), BatchID: batchID, IsShortage: resolution.IsShortage,
			ShortageQty: resolution.ShortageQty, ShortageUnitPrice: resolution.ShortageUnitPrice, PriceState: priceState,
			Allocations: resolution.Allocations,
		})
	}
	materialCost = round2(materialCost)

	// ---- труд: штат по нормам, подряд вычитает свою долю
	var assignments []warehouse.LaborAssignment
	if !isResale {
		raw, aerr := AssignmentsFor(ctx, pool, orderLineID, articleID, rates)
		if aerr != nil {
			return models.OrderCosting{}, nil, nil, aerr
		}
		assignments, aerr = WithNorms(ctx, pool, raw, articleID)
		if aerr != nil {
			return models.OrderCosting{}, nil, nil, aerr
		}
	}
	var labor warehouse.LaborSummary
	if len(assignments) > 0 {
		labor, err = warehouse.SummarizeLabor(assignments, warehouse.LaborContext{Qty: qty, WeightKg: weightKg})
		if err != nil {
			return models.OrderCosting{}, nil, nil, err
		}
	} else {
		labor = warehouse.LaborSummary{Lines: []warehouse.LaborLineCost{}, ByStage: []warehouse.StageCostSummary{}}
	}

	hasStaffLine := false
	for _, a := range assignments {
		if a.LaborKind == warehouse.LaborKindStaff {
			hasStaffLine = true
			break
		}
	}
	hasMissingNorm := !isResale && !hasStaffLine && labor.StaffCost == 0
	hasMissingBom := !isResale && hasArticle && len(bom) == 0

	logisticsCost, lerr := costing.LogisticsCostOf(materialCost, rates, &costing.CostingContext{WeightKg: weightKg})
	if lerr != nil {
		return models.OrderCosting{}, nil, nil, lerr
	}
	utilitiesCost := round2(materialCost * rates.UtilitiesPct)
	totalCost := round2(materialCost + labor.TotalCost + logisticsCost + utilitiesCost)
	margin, price, merr := costing.MarginAndPrice(totalCost, rates)
	if merr != nil {
		return models.OrderCosting{}, nil, nil, merr
	}

	var prevVersion int
	var prevID *string
	perr := pool.QueryRow(ctx, "SELECT version, id FROM order_costings WHERE order_line_id = $1 ORDER BY version DESC LIMIT 1", orderLineID).
		Scan(&prevVersion, &prevID)
	if perr != nil && perr != pgx.ErrNoRows {
		return models.OrderCosting{}, nil, nil, perr
	}

	createdByID := dbUserID(userID)
	ratesSource := "config"
	var ratesReason *string
	if !opts.RateOverrides.isEmpty() {
		ratesSource = "manual"
		reason := strings.TrimSpace(opts.RatesReason)
		ratesReason = &reason
	}
	var note *string
	if trimmed := strings.TrimSpace(opts.Note); trimmed != "" {
		note = &trimmed
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return models.OrderCosting{}, nil, nil, err
	}
	defer tx.Rollback(ctx)

	costingID := uuid.NewString()
	now := time.Now().UTC()
	row := tx.QueryRow(ctx, `
		INSERT INTO order_costings
			(id, order_id, order_line_id, article_id, qty, version, base_costing_id, created_by_id,
			 hourly_rate, logistics_pct, logistics_mode, logistics_fixed, logistics_per_kg, utilities_pct,
			 margin_pct, margin_mode, rates_source, rates_reason,
			 material_cost, labor_cost, contractor_cost, logistics_cost, utilities_cost, total_cost, margin, price,
			 total_man_hours, has_shortage, has_missing_norm, has_missing_bom, note, calculated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
		RETURNING `+orderCostingCols,
		costingID, lineOrderID, orderLineID, articleID, qty, prevVersion+1, prevID, createdByID,
		rates.HourlyRate, rates.LogisticsPct, string(rates.LogisticsMode), rates.LogisticsFixed, rates.LogisticsPerKg, rates.UtilitiesPct,
		rates.MarginPct, string(rates.MarginMode), ratesSource, ratesReason,
		materialCost, labor.TotalCost, labor.ContractorCost, logisticsCost, utilitiesCost, totalCost, margin, price,
		labor.ShopManHours, hasShortage, hasMissingNorm, hasMissingBom, note, now)
	out, err := scanOrderCosting(row)
	if err != nil {
		return models.OrderCosting{}, nil, nil, err
	}

	outMaterials := make([]models.OrderCostingMaterial, 0, len(materialRows))
	for _, m := range materialRows {
		allocJSON, jerr := json.Marshal(m.Allocations)
		if jerr != nil {
			return models.OrderCosting{}, nil, nil, jerr
		}
		mid := uuid.NewString()
		_, err = tx.Exec(ctx, `
			INSERT INTO order_costing_materials
				(id, costing_id, material_id, material_code_snapshot, material_name_snapshot, qty_per_unit, qty_total,
				 unit_price, line_cost, price_source, batch_id, price_date, allocations, price_state,
				 price_state_changed_at, is_shortage, shortage_qty, shortage_unit_price)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
			mid, costingID, m.MaterialID, m.MaterialCodeSnapshot, m.MaterialNameSnapshot, m.QtyPerUnit, m.QtyTotal,
			m.UnitPrice, m.LineCost, m.PriceSource, m.BatchID, m.PriceDate, allocJSON, m.PriceState,
			m.PriceStateChangedAt, m.IsShortage, m.ShortageQty, m.ShortageUnitPrice)
		if err != nil {
			return models.OrderCosting{}, nil, nil, err
		}
		outMaterials = append(outMaterials, models.OrderCostingMaterial{
			ID: mid, CostingID: costingID, MaterialID: &m.MaterialID, MaterialCodeSnapshot: &m.MaterialCodeSnapshot,
			MaterialNameSnapshot: m.MaterialNameSnapshot, QtyPerUnit: decimalOf(m.QtyPerUnit), QtyTotal: decimalOf(m.QtyTotal),
			UnitPrice: decimalOf(m.UnitPrice), LineCost: decimalOf(m.LineCost), PriceSource: m.PriceSource, BatchID: m.BatchID,
			PriceDate: common.NewPDate(m.PriceDate), Allocations: allocJSON, PriceState: m.PriceState,
			PriceStateChangedAt: common.NewPDate(m.PriceStateChangedAt), IsShortage: m.IsShortage, ShortageQty: decimalOf(m.ShortageQty),
			ShortageUnitPrice: decimalOf(m.ShortageUnitPrice),
		})
	}

	outLabor := make([]models.OrderCostingLabor, 0, len(labor.Lines))
	for i, l := range labor.Lines {
		lid := uuid.NewString()
		workers, hoursPerUnit := 0.0, 0.0
		if i < len(assignments) {
			workers, hoursPerUnit = assignments[i].Workers, assignments[i].HoursPerUnit
		}
		stageDB := models.RoutingStageAPIToDB(string(l.Stage))
		_, err = tx.Exec(ctx, `
			INSERT INTO order_costing_labor
				(id, costing_id, stage, "laborKind", work_center_id, contractor_id, share, rate_type, rate,
				 count_in_shop_hours, workers, hours_per_unit, man_hours, line_cost)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
			lid, costingID, stageDB, string(l.LaborKind), l.WorkCenterID, l.ContractorID, l.Share, string(l.RateType), l.Rate,
			l.CountedInShopHours, workers, hoursPerUnit, l.ManHours, l.Cost)
		if err != nil {
			return models.OrderCosting{}, nil, nil, err
		}
		outLabor = append(outLabor, models.OrderCostingLabor{
			ID: lid, CostingID: costingID, Stage: string(l.Stage), LaborKind: string(l.LaborKind),
			WorkCenterID: l.WorkCenterID, ContractorID: l.ContractorID, Share: decimalOf(l.Share), RateType: string(l.RateType),
			Rate: decimalOf(l.Rate), CountInShopHours: l.CountedInShopHours, Workers: decimalOf(workers),
			HoursPerUnit: decimalOf(hoursPerUnit), ManHours: decimalOf(l.ManHours), LineCost: decimalOf(l.Cost),
		})
	}

	if err := tx.Commit(ctx); err != nil {
		return models.OrderCosting{}, nil, nil, err
	}

	return out, outMaterials, outLabor, nil
}

const orderCostingCols = `id, order_id, order_line_id, article_id, qty, version, status, calculated_at, approved_at,
	approved_by_id, created_by_id, base_costing_id, hourly_rate, logistics_pct, logistics_mode, logistics_fixed,
	logistics_per_kg, utilities_pct, margin_pct, margin_mode, vat_pct, rates_source, rates_reason, material_cost,
	labor_cost, contractor_cost, logistics_cost, utilities_cost, total_cost, margin, price, total_man_hours,
	has_shortage, has_missing_norm, has_missing_bom, note`

func scanOrderCosting(row interface {
	Scan(dest ...interface{}) error
}) (models.OrderCosting, error) {
	var c models.OrderCosting
	err := row.Scan(
		&c.ID, &c.OrderID, &c.OrderLineID, &c.ArticleID, &c.Qty, &c.Version, &c.Status, &c.CalculatedAt, &c.ApprovedAt,
		&c.ApprovedByID, &c.CreatedByID, &c.BaseCostingID, &c.HourlyRate, &c.LogisticsPct, &c.LogisticsMode, &c.LogisticsFixed,
		&c.LogisticsPerKg, &c.UtilitiesPct, &c.MarginPct, &c.MarginMode, &c.VatPct, &c.RatesSource, &c.RatesReason, &c.MaterialCost,
		&c.LaborCost, &c.ContractorCost, &c.LogisticsCost, &c.UtilitiesCost, &c.TotalCost, &c.Margin, &c.Price, &c.TotalManHours,
		&c.HasShortage, &c.HasMissingNorm, &c.HasMissingBom, &c.Note,
	)
	return c, err
}

// Approve — согласование версии. Прежняя согласованная уходит в архив, но
// не удаляется: по ней считались уже отданные клиенту цены. Отдаёт ГОЛУЮ
// запись OrderCosting без materials/labor — оригинал их не инклюдит здесь
// (в отличие от Build), ни в раннем возврате «уже APPROVED», ни в апдейте.
func Approve(ctx context.Context, pool *pgxpool.Pool, costingID, userID string) (models.OrderCosting, error) {
	row := pool.QueryRow(ctx, "SELECT "+orderCostingCols+" FROM order_costings WHERE id = $1", costingID)
	c, err := scanOrderCosting(row)
	if err == pgx.ErrNoRows {
		return models.OrderCosting{}, &common.APIError404{Code: "NOT_FOUND", Message: "Калькуляция " + costingID + " не найдена"}
	}
	if err != nil {
		return models.OrderCosting{}, err
	}
	if c.Status == "APPROVED" {
		return c, nil
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return models.OrderCosting{}, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, "UPDATE order_costings SET status = 'ARCHIVED' WHERE order_line_id = $1 AND status = 'APPROVED'", c.OrderLineID); err != nil {
		return models.OrderCosting{}, err
	}
	now := time.Now().UTC()
	approvedByID := dbUserID(userID)
	row = tx.QueryRow(ctx, `
		UPDATE order_costings SET status = 'APPROVED', approved_at = $1, approved_by_id = $2
		WHERE id = $3 RETURNING `+orderCostingCols, now, approvedByID, costingID)
	updated, uerr := scanOrderCosting(row)
	if uerr != nil {
		return models.OrderCosting{}, uerr
	}
	if err := tx.Commit(ctx); err != nil {
		return models.OrderCosting{}, err
	}
	return updated, nil
}

type VersionSummary struct {
	Costing        models.OrderCosting
	MaterialsCount int
}

// VersionsOf — версии калькуляции позиции заказа, новые сначала.
func VersionsOf(ctx context.Context, pool *pgxpool.Pool, orderLineID string) ([]VersionSummary, error) {
	rows, err := pool.Query(ctx, "SELECT "+orderCostingCols+" FROM order_costings WHERE order_line_id = $1 ORDER BY version DESC", orderLineID)
	if err != nil {
		return nil, err
	}
	var out []VersionSummary
	var ids []string
	for rows.Next() {
		c, serr := scanOrderCosting(rows)
		if serr != nil {
			rows.Close()
			return nil, serr
		}
		out = append(out, VersionSummary{Costing: c})
		ids = append(ids, c.ID)
	}
	rows.Close()
	if len(out) == 0 {
		return []VersionSummary{}, nil
	}

	counts := map[string]int{}
	crows, cerr := pool.Query(ctx, "SELECT costing_id, count(*) FROM order_costing_materials WHERE costing_id = ANY($1) GROUP BY costing_id", ids)
	if cerr != nil {
		return nil, cerr
	}
	for crows.Next() {
		var id string
		var n int
		if err := crows.Scan(&id, &n); err != nil {
			crows.Close()
			return nil, err
		}
		counts[id] = n
	}
	crows.Close()

	for i := range out {
		out[i].MaterialsCount = counts[out[i].Costing.ID]
	}
	return out, nil
}
