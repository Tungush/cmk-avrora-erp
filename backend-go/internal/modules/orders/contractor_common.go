package orders

// Общее для подряда: перенос backend/src/common/contractor-requests.ts
// (арифметика разнесения заявки по заказам) + сканеры/сырой JSON для
// contractors / contractor_works / contractor_requests. Инвариант один:
// сумма долей копейка в копейку равна принятой сумме акта.

import (
	"context"
	"math"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
)

var rateTypes = map[string]bool{"PER_HOUR": true, "PER_UNIT": true, "PER_KG": true, "PER_TON": true, "FIXED": true}
var contractorStages = map[string]bool{"CUTTING": true, "ASSEMBLY": true, "PAINTING": true}

var rateUnits = map[string]string{"PER_HOUR": "ч", "PER_UNIT": "шт", "PER_KG": "кг", "PER_TON": "т", "FIXED": "ед."}
var stageLabels = map[string]string{
	"CUTTING":  "Резка",
	"ASSEMBLY": "Сборка / сварка / обшивка",
	"PAINTING": "Зачистка / покраска",
}

func stageLabel(s string) string {
	if v, ok := stageLabels[s]; ok {
		return v
	}
	return s
}

// round2/round3 — Math.round(n*100)/100: JS округляет .5 к +∞, math.Round —
// от нуля; на отрицательных суммах (возвраты) это расходится.
func round2(n float64) float64 { return common.JsRound(n*100) / 100 }
func round3(n float64) float64 { return common.JsRound(n*1000) / 1000 }

func fnum(d *decimal.Decimal) *float64 {
	if d == nil {
		return nil
	}
	v := d.InexactFloat64()
	return &v
}

func fval(d *decimal.Decimal) float64 {
	if d == nil {
		return 0
	}
	return d.InexactFloat64()
}

// splitAmount — разделить СУММУ по объёмам так, чтобы части сошлись в
// исходную копейка в копейку: последняя ненулевая доля забирает остаток.
func splitAmount(total float64, qtys []float64) []float64 {
	sum := 0.0
	for _, q := range qtys {
		sum += math.Max(0, q)
	}
	parts := make([]float64, len(qtys))
	if !(sum > 0) {
		return parts
	}
	for i, q := range qtys {
		parts[i] = round2((total * math.Max(0, q)) / sum)
	}
	lastIdx := -1
	for i := len(qtys) - 1; i >= 0; i-- {
		if qtys[i] > 0 {
			lastIdx = i
			break
		}
	}
	if lastIdx >= 0 {
		others := 0.0
		for i, p := range parts {
			if i != lastIdx {
				others += p
			}
		}
		parts[lastIdx] = round2(total - others)
	}
	return parts
}

// splitProportional — величина без требования точного схождения (часы).
func splitProportional(total float64, qtys []float64) []float64 {
	sum := 0.0
	for _, q := range qtys {
		sum += math.Max(0, q)
	}
	parts := make([]float64, len(qtys))
	if !(sum > 0) {
		return parts
	}
	for i, q := range qtys {
		parts[i] = round3((total * math.Max(0, q)) / sum)
	}
	return parts
}

// ---- contractors ----

type contractorRow struct {
	ID                  string          `json:"id"`
	Name                string          `json:"name"`
	BinIin              *string         `json:"binIin"`
	DefaultRateType     string          `json:"defaultRateType"`
	DefaultRate         decimal.Decimal `json:"defaultRate"`
	DefaultWorkLocation string          `json:"defaultWorkLocation"`
	IsActive            bool            `json:"isActive"`
	Notes               *string         `json:"notes"`
	CreatedAt           common.PDate    `json:"createdAt"`
}

const contractorCols = "id, name, bin_iin, default_rate_type, default_rate, default_work_location, is_active, notes, created_at"

func scanContractor(row pgx.Row) (contractorRow, error) {
	var r contractorRow
	err := row.Scan(&r.ID, &r.Name, &r.BinIin, &r.DefaultRateType, &r.DefaultRate, &r.DefaultWorkLocation, &r.IsActive, &r.Notes, &r.CreatedAt)
	return r, err
}

// ---- contractor_works ----

type contractorWorkRow struct {
	ID            string
	OrderID       string
	OrderLineID   *string
	RoutingStage  string // API-код
	ContractorID  string
	Share         decimal.Decimal
	RateType      string
	Rate          decimal.Decimal
	ActualQty     *decimal.Decimal
	ActualWorkers *int
	ActualAmount  *decimal.Decimal
	WorkLocation  string
	PlannedHours  *decimal.Decimal
	RequestID     *string
	DecidedByID   *string
	DecidedAt     common.PDate
	Reason        *string
	AcceptedByID  *string
	AcceptedAt    common.PDate
	ContractDocID *string
	Note          *string
}

const cwCols = "w.id, w.order_id, w.order_line_id, w.routing_stage, w.contractor_id, w.share, w.rate_type, w.rate, w.actual_qty, w.actual_workers, w.actual_amount, w.work_location, w.planned_hours, w.request_id, w.decided_by_id, w.decided_at, w.reason, w.accepted_by_id, w.accepted_at, w.contract_doc_id, w.note"

func scanContractorWork(row pgx.Row) (contractorWorkRow, error) {
	var w contractorWorkRow
	var stage string
	err := row.Scan(&w.ID, &w.OrderID, &w.OrderLineID, &stage, &w.ContractorID, &w.Share, &w.RateType, &w.Rate, &w.ActualQty, &w.ActualWorkers, &w.ActualAmount,
		&w.WorkLocation, &w.PlannedHours, &w.RequestID, &w.DecidedByID, &w.DecidedAt, &w.Reason, &w.AcceptedByID, &w.AcceptedAt, &w.ContractDocID, &w.Note)
	w.RoutingStage = models.RoutingStageDBToAPI(stage)
	return w, err
}

// cwRaw — запись как её отдаёт Prisma без include (Decimal — строками).
func cwRaw(w contractorWorkRow) gin.H {
	return gin.H{
		"id": w.ID, "orderId": w.OrderID, "orderLineId": w.OrderLineID, "routingStage": w.RoutingStage, "contractorId": w.ContractorID,
		"share": w.Share, "rateType": w.RateType, "rate": w.Rate, "actualQty": w.ActualQty, "actualWorkers": w.ActualWorkers,
		"actualAmount": w.ActualAmount, "workLocation": w.WorkLocation, "plannedHours": w.PlannedHours, "requestId": w.RequestID,
		"decidedById": w.DecidedByID, "decidedAt": w.DecidedAt, "reason": w.Reason, "acceptedById": w.AcceptedByID,
		"acceptedAt": w.AcceptedAt, "contractDocId": w.ContractDocID, "note": w.Note,
	}
}

// workAmount — сколько должны подрядчику: принятая сумма, иначе расчёт по
// объёму; FIXED — сумма за объём целиком (умножать на actualQty нельзя).
// nil — когда ни суммы, ни объёма нет (allWork отдаёт null, orderWork — 0).
func workAmount(w contractorWorkRow) *float64 {
	if w.ActualAmount != nil {
		return fnum(w.ActualAmount)
	}
	if w.RateType == "FIXED" {
		v := w.Rate.InexactFloat64()
		return &v
	}
	if w.ActualQty != nil {
		v := w.ActualQty.InexactFloat64() * w.Rate.InexactFloat64()
		return &v
	}
	return nil
}

// ---- contractor_requests ----

type contractorRequestRow struct {
	ID                string
	Number            string
	RoutingStage      string // API-код
	Description       string
	RateType          string
	PlannedQty        *decimal.Decimal
	Rate              *decimal.Decimal
	EstimatedAmount   *decimal.Decimal
	ContractorID      *string
	WorkLocation      string
	PlannedHours      *decimal.Decimal
	Status            string
	BitrixDealID      *string
	BitrixSentAt      common.PDate
	ActualQty         *decimal.Decimal
	ActualAmount      *decimal.Decimal
	AcceptedAt        common.PDate
	AcceptedByID      *string
	PaymentDocumentID *string
	CreatedByID       *string
	CreatedAt         common.PDate
	UpdatedAt         common.PDate
	Note              *string
}

const crCols = "r.id, r.number, r.routing_stage, r.description, r.rate_type, r.planned_qty, r.rate, r.estimated_amount, r.contractor_id, r.work_location, r.planned_hours, r.status, r.bitrix_deal_id, r.bitrix_sent_at, r.actual_qty, r.actual_amount, r.accepted_at, r.accepted_by_id, r.payment_document_id, r.created_by_id, r.created_at, r.updated_at, r.note"

func scanContractorRequest(row pgx.Row) (contractorRequestRow, error) {
	var r contractorRequestRow
	var stage string
	err := row.Scan(&r.ID, &r.Number, &stage, &r.Description, &r.RateType, &r.PlannedQty, &r.Rate, &r.EstimatedAmount, &r.ContractorID, &r.WorkLocation,
		&r.PlannedHours, &r.Status, &r.BitrixDealID, &r.BitrixSentAt, &r.ActualQty, &r.ActualAmount, &r.AcceptedAt, &r.AcceptedByID, &r.PaymentDocumentID,
		&r.CreatedByID, &r.CreatedAt, &r.UpdatedAt, &r.Note)
	r.RoutingStage = models.RoutingStageDBToAPI(stage)
	return r, err
}

func crRaw(r contractorRequestRow) gin.H {
	return gin.H{
		"id": r.ID, "number": r.Number, "routingStage": r.RoutingStage, "description": r.Description, "rateType": r.RateType,
		"plannedQty": r.PlannedQty, "rate": r.Rate, "estimatedAmount": r.EstimatedAmount, "contractorId": r.ContractorID,
		"workLocation": r.WorkLocation, "plannedHours": r.PlannedHours, "status": r.Status, "bitrixDealId": r.BitrixDealID,
		"bitrixSentAt": r.BitrixSentAt, "actualQty": r.ActualQty, "actualAmount": r.ActualAmount, "acceptedAt": r.AcceptedAt,
		"acceptedById": r.AcceptedByID, "paymentDocumentId": r.PaymentDocumentID, "createdById": r.CreatedByID,
		"createdAt": r.CreatedAt, "updatedAt": r.UpdatedAt, "note": r.Note,
	}
}

type contractorBrief struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	BinIin *string `json:"binIin"`
}

// orderBrief — вложенный order строки как его выбрал include конкретной
// ручки: findAll — {id, orderNumber}, findOne — ещё status и дата; в
// allocationSummary он уходит как есть.
type orderBrief struct {
	ID   string
	JSON gin.H
}

// workBrief — строка разнесения в том объёме, который нужен allocationSummary.
type workBrief struct {
	ID           string
	OrderID      string
	OrderLineID  *string
	ActualQty    *decimal.Decimal
	ActualAmount *decimal.Decimal
	Share        decimal.Decimal
	PlannedHours *decimal.Decimal
	Order        *orderBrief
}

// loadWorkBriefs — строки заявок пачкой (Prisma include без orderBy —
// физический порядок, тот же SELECT ... WHERE request_id IN).
func loadWorkBriefs(ctx context.Context, pool *pgxpool.Pool, requestIDs []string) (map[string][]workBrief, error) {
	out := map[string][]workBrief{}
	if len(requestIDs) == 0 {
		return out, nil
	}
	rows, err := pool.Query(ctx, `SELECT w.request_id, w.id, w.order_id, w.order_line_id, w.actual_qty, w.actual_amount, w.share, w.planned_hours, o.id, o.order_number
		FROM contractor_works w LEFT JOIN orders o ON o.id = w.order_id WHERE w.request_id = ANY($1)`, requestIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var reqID string
		var w workBrief
		var oid, onum *string
		if err := rows.Scan(&reqID, &w.ID, &w.OrderID, &w.OrderLineID, &w.ActualQty, &w.ActualAmount, &w.Share, &w.PlannedHours, &oid, &onum); err != nil {
			return nil, err
		}
		if oid != nil {
			w.Order = &orderBrief{ID: *oid, JSON: gin.H{"id": *oid, "orderNumber": *onum}}
		}
		out[reqID] = append(out[reqID], w)
	}
	return out, rows.Err()
}

// allocationSummary — строка списка заявок: что отдано, что разнесено, что
// висит. needsAllocation — принято и оплачивается, но не сидит ни в одном
// заказе; тишины здесь быть не должно.
func allocationSummary(r contractorRequestRow, contractor *contractorBrief, works []workBrief, nowMs int64) gin.H {
	const staleDays = 7
	allocatedQty, allocatedAmount := 0.0, 0.0
	for _, w := range works {
		allocatedQty += fval(w.ActualQty)
		allocatedAmount += fval(w.ActualAmount)
	}
	actualQty, actualAmount := fnum(r.ActualQty), fnum(r.ActualAmount)
	plannedQty, rate, estimatedAmount := fnum(r.PlannedQty), fnum(r.Rate), fnum(r.EstimatedAmount)

	var totalAmount *float64
	switch {
	case actualAmount != nil:
		totalAmount = actualAmount
	case estimatedAmount != nil:
		totalAmount = estimatedAmount
	case plannedQty != nil && rate != nil:
		v := round2(*plannedQty * *rate)
		totalAmount = &v
	}

	targetQty := actualQty
	if targetQty == nil {
		targetQty = plannedQty
	}
	var unallocatedQty *float64
	if targetQty != nil {
		v := round3(math.Max(0, *targetQty-allocatedQty))
		unallocatedQty = &v
	}
	var daysSinceAccepted *int
	if r.AcceptedAt.Valid {
		d := int(math.Floor(float64(nowMs-r.AcceptedAt.Time.UnixMilli()) / 86400000))
		daysSinceAccepted = &d
	}

	var unallocatedAmount *float64
	if totalAmount != nil {
		var v float64
		if targetQty != nil && *targetQty > 0 && unallocatedQty != nil {
			v = round2((*totalAmount * *unallocatedQty) / *targetQty)
		} else if len(works) == 0 {
			v = round2(*totalAmount)
		} else {
			v = round2(math.Max(0, *totalAmount-allocatedAmount))
		}
		unallocatedAmount = &v
	}

	hasUnallocated := r.Status != "CANCELLED" && (len(works) == 0 ||
		(unallocatedQty != nil && *unallocatedQty > 1e-6) ||
		(unallocatedAmount != nil && *unallocatedAmount > 0.005))

	// Заказов, а не строк: Map по order.id сохраняет порядок первого появления
	seen := map[string]bool{}
	orders := []gin.H{}
	for _, w := range works {
		if w.Order == nil || seen[w.Order.ID] {
			continue
		}
		seen[w.Order.ID] = true
		orders = append(orders, w.Order.JSON)
	}

	unallocAmountOut := 0.0
	if unallocatedAmount != nil {
		unallocAmountOut = *unallocatedAmount
	}
	days := 0
	if daysSinceAccepted != nil {
		days = *daysSinceAccepted
	}
	var contractorOut interface{}
	if contractor != nil {
		contractorOut = contractor
	}
	return gin.H{
		"id": r.ID, "number": r.Number, "routingStage": r.RoutingStage, "stageLabel": stageLabel(r.RoutingStage),
		"status": r.Status, "rateType": r.RateType, "unit": rateUnits[r.RateType],
		"rate": rate, "plannedQty": plannedQty, "estimatedAmount": estimatedAmount, "actualQty": actualQty, "actualAmount": actualAmount,
		"totalAmount": totalAmount, "workLocation": r.WorkLocation, "plannedHours": fnum(r.PlannedHours),
		"contractor": contractorOut, "bitrixDealId": r.BitrixDealID, "bitrixSentAt": r.BitrixSentAt, "acceptedAt": r.AcceptedAt,
		"createdAt": r.CreatedAt, "daysSinceAccepted": daysSinceAccepted,
		"ordersCount": len(orders), "orders": orders,
		"allocatedQty": round3(allocatedQty), "allocatedAmount": round2(allocatedAmount),
		"unallocatedQty": unallocatedQty, "unallocatedAmount": unallocAmountOut,
		"amountUnknown":   totalAmount == nil,
		"needsAllocation": r.AcceptedAt.Valid && hasUnallocated,
		"isStale":         r.AcceptedAt.Valid && hasUnallocated && days >= staleDays,
	}
}

// redistribute — пересчёт пропорций по ВСЕМ строкам заявки после любого
// изменения состава. Знаменатель — ПРИНЯТЫЙ объём, а не разнесённый:
// хвост «не разнесено» участвует в делении и выбрасывается.
func redistribute(ctx context.Context, pool *pgxpool.Pool, requestID string) (int, error) {
	req, err := scanContractorRequest(pool.QueryRow(ctx, "SELECT "+crCols+" FROM contractor_requests r WHERE r.id = $1", requestID))
	if err == pgx.ErrNoRows {
		return 0, nil
	} else if err != nil {
		return 0, err
	}
	rows, err := pool.Query(ctx, "SELECT w.id, w.actual_qty FROM contractor_works w WHERE w.request_id = $1 ORDER BY w.decided_at ASC", requestID)
	if err != nil {
		return 0, err
	}
	var ids []string
	var qtys []float64
	for rows.Next() {
		var id string
		var q *decimal.Decimal
		if err := rows.Scan(&id, &q); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
		qtys = append(qtys, fval(q))
	}
	rows.Close()
	if len(ids) == 0 {
		return 0, nil
	}
	total := 0.0
	for _, q := range qtys {
		total += q
	}
	if !(total > 0) {
		return 0, nil
	}
	denomQty := math.Max(total, fval(req.ActualQty))
	tail := round3(math.Max(0, denomQty-total))
	withTail := qtys
	if tail > 1e-9 {
		withTail = append(append([]float64{}, qtys...), tail)
	}
	n := len(qtys)
	var amounts, hours, fixedRates []float64
	if req.ActualAmount != nil {
		amounts = splitAmount(req.ActualAmount.InexactFloat64(), withTail)[:n]
	}
	if req.PlannedHours != nil {
		hours = splitProportional(req.PlannedHours.InexactFloat64(), withTail)[:n]
	}
	if req.RateType == "FIXED" && req.EstimatedAmount != nil {
		fixedRates = splitAmount(req.EstimatedAmount.InexactFloat64(), withTail)[:n]
	}
	for i, id := range ids {
		set, args := "", []interface{}{}
		add := func(col string, v float64) {
			args = append(args, v)
			if set != "" {
				set += ", "
			}
			set += col + " = $" + itoa(len(args))
		}
		if amounts != nil {
			add("actual_amount", amounts[i])
		}
		if hours != nil {
			add("planned_hours", round3(hours[i]))
		}
		if fixedRates != nil {
			if amounts != nil {
				add("rate", amounts[i])
			} else {
				add("rate", fixedRates[i])
			}
		}
		if set == "" {
			continue
		}
		args = append(args, id)
		if _, err := pool.Exec(ctx, "UPDATE contractor_works SET "+set+" WHERE id = $"+itoa(len(args)), args...); err != nil {
			return 0, err
		}
	}
	return n, nil
}
