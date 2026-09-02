// Точный перенос order-costings.controller.ts — калькуляция позиции заказа
// как документ (версии, не перезаписываются никогда). compare/reconcile
// (costing-compare.ts — факторный разбор «почему через месяц дороже»)
// осознанно НЕ портирован в этот заход: аналитическая read-only ручка,
// самостоятельный кусок работы отдельно от денежного ядра build/approve.
package orders

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/costing"
	"cmk-avrora-erp/backend-go/internal/models"
	"cmk-avrora-erp/backend-go/internal/ordercosting"
	"cmk-avrora-erp/backend-go/internal/warehouse"
)

const orderCostingColsLocal = `id, order_id, order_line_id, article_id, qty, version, status, calculated_at, approved_at,
	approved_by_id, created_by_id, base_costing_id, hourly_rate, logistics_pct, logistics_mode, logistics_fixed,
	logistics_per_kg, utilities_pct, margin_pct, margin_mode, vat_pct, rates_source, rates_reason, material_cost,
	labor_cost, contractor_cost, logistics_cost, utilities_cost, total_cost, margin, price, total_man_hours,
	has_shortage, has_missing_norm, has_missing_bom, note`

func scanOrderCostingLocal(row interface {
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

func modelsRoutingStageDBToAPI(db string) string          { return models.RoutingStageDBToAPI(db) }
func costingLogisticsMode(s string) costing.LogisticsMode { return costing.LogisticsMode(s) }
func costingMarginMode(s string) costing.MarginMode       { return costing.MarginMode(s) }
func jsonRawMessage(b []byte) json.RawMessage             { return json.RawMessage(b) }

type OrderCostingsHandler struct {
	pool *pgxpool.Pool
}

func NewOrderCostingsHandler(pool *pgxpool.Pool) *OrderCostingsHandler {
	return &OrderCostingsHandler{pool: pool}
}

func respondOrderCostingErr(c *gin.Context, err error) {
	switch e := err.(type) {
	case *common.APIError404:
		common.Fail(c, http.StatusNotFound, e.Code, e.Message)
	case *common.APIError400:
		common.Fail(c, http.StatusBadRequest, e.Code, e.Message)
	case *common.APIError409:
		common.Fail(c, http.StatusConflict, e.Code, e.Message)
	default:
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
	}
}

// List — GET /order-lines/:orderLineId/costings — версии калькуляции позиции заказа.
func (h *OrderCostingsHandler) List(c *gin.Context) {
	orderLineID := c.Param("orderLineId")
	versions, err := ordercosting.VersionsOf(c.Request.Context(), h.pool, orderLineID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	data := make([]gin.H, len(versions))
	for i, v := range versions {
		cst := v.Costing
		totalCost, _ := cst.TotalCost.Float64()
		price, _ := cst.Price.Float64()
		marginPct, _ := cst.MarginPct.Float64()
		data[i] = gin.H{
			"id": cst.ID, "version": cst.Version, "status": cst.Status, "calculatedAt": cst.CalculatedAt,
			"approvedAt": cst.ApprovedAt, "totalCost": totalCost, "price": price, "marginMode": cst.MarginMode,
			"marginPct": marginPct, "ratesSource": cst.RatesSource, "ratesReason": cst.RatesReason,
			"hasShortage": cst.HasShortage, "hasMissingNorm": cst.HasMissingNorm, "hasMissingBom": cst.HasMissingBom,
			"materialsCount": v.MaterialsCount,
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "total": len(versions)})
}

// GetOne — GET /order-lines/:orderLineId/costings/:costingId — калькуляция
// целиком: материалы со стадией цены и партией, труд с подрядчиком.
func (h *OrderCostingsHandler) GetOne(c *gin.Context) {
	costingID := c.Param("costingId")
	ctx := c.Request.Context()

	row := h.pool.QueryRow(ctx, "SELECT "+orderCostingColsLocal+" FROM order_costings WHERE id = $1", costingID)
	cst, err := scanOrderCostingLocal(row)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Калькуляция "+costingID+" не найдена")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	mrows, err := h.pool.Query(ctx, `
		SELECT id, material_code_snapshot, material_name_snapshot, qty_total, unit_price, line_cost, price_state,
		       supplier_order_number, price_state_changed_at, is_shortage, batch_id
		FROM order_costing_materials WHERE costing_id = $1`, costingID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	type matRow struct {
		ID, MaterialCode, MaterialName string
		QtyTotal, UnitPrice, LineCost  float64
		PriceState                     string
		SupplierOrderNumber            *string
		PriceStateChangedAt            *time.Time
		IsShortage                     bool
		BatchID                        *string
	}
	var materials []matRow
	batchIDSet := map[string]bool{}
	for mrows.Next() {
		var m matRow
		var matCode, matName *string
		if err := mrows.Scan(&m.ID, &matCode, &matName, &m.QtyTotal, &m.UnitPrice, &m.LineCost, &m.PriceState,
			&m.SupplierOrderNumber, &m.PriceStateChangedAt, &m.IsShortage, &m.BatchID); err != nil {
			mrows.Close()
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		if matCode != nil {
			m.MaterialCode = *matCode
		}
		if matName != nil {
			m.MaterialName = *matName
		}
		materials = append(materials, m)
		if m.BatchID != nil {
			batchIDSet[*m.BatchID] = true
		}
	}
	mrows.Close()

	type batchInfo struct {
		ID             string  `json:"id"`
		ReceiptDate    string  `json:"receiptDate"`
		DocumentNumber *string `json:"documentNumber"`
		SupplierName   *string `json:"supplierName"`
		BatchType      string  `json:"batchType"`
	}
	batchByID := map[string]batchInfo{}
	if len(batchIDSet) > 0 {
		ids := make([]string, 0, len(batchIDSet))
		for id := range batchIDSet {
			ids = append(ids, id)
		}
		brows, err := h.pool.Query(ctx, "SELECT id, receipt_date, document_number, supplier_name, batch_type FROM material_batches WHERE id = ANY($1)", ids)
		if err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
		for brows.Next() {
			var b batchInfo
			var receiptDate time.Time
			if err := brows.Scan(&b.ID, &receiptDate, &b.DocumentNumber, &b.SupplierName, &b.BatchType); err != nil {
				brows.Close()
				common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
				return
			}
			b.ReceiptDate = receiptDate.UTC().Format("2006-01-02T15:04:05.000Z")
			batchByID[b.ID] = b
		}
		brows.Close()
	}

	materialsOut := make([]gin.H, len(materials))
	for i, m := range materials {
		var batch interface{}
		if m.BatchID != nil {
			if b, ok := batchByID[*m.BatchID]; ok {
				batch = b
			}
		}
		var changedAt *string
		if m.PriceStateChangedAt != nil {
			v := m.PriceStateChangedAt.UTC().Format("2006-01-02T15:04:05.000Z")
			changedAt = &v
		}
		materialsOut[i] = gin.H{
			"id": m.ID, "materialCode": m.MaterialCode, "materialName": m.MaterialName, "qtyTotal": m.QtyTotal,
			"unitPrice": m.UnitPrice, "lineCost": m.LineCost, "priceState": m.PriceState,
			"supplierOrderNumber": m.SupplierOrderNumber, "priceStateChangedAt": changedAt, "isShortage": m.IsShortage,
			"batch": batch,
		}
	}

	lrows, err := h.pool.Query(ctx, `
		SELECT l.id, l.stage, l."laborKind", l.contractor_id, ct.name, l.share, l.rate_type, l.rate, l.man_hours, l.line_cost
		FROM order_costing_labor l LEFT JOIN contractors ct ON ct.id = l.contractor_id
		WHERE l.costing_id = $1`, costingID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	laborOut := []gin.H{}
	for lrows.Next() {
		var id, stageDB, laborKind, rateType string
		var contractorID, contractorName *string
		var share, rate, manHours, lineCost float64
		if err := lrows.Scan(&id, &stageDB, &laborKind, &contractorID, &contractorName, &share, &rateType, &rate, &manHours, &lineCost); err != nil {
			lrows.Close()
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		var contractor interface{}
		if contractorID != nil {
			contractor = gin.H{"id": *contractorID, "name": derefOrEmpty(contractorName)}
		}
		laborOut = append(laborOut, gin.H{
			"id": id, "stage": modelsRoutingStageDBToAPI(stageDB), "laborKind": laborKind, "contractor": contractor,
			"share": share, "rateType": rateType, "rate": rate, "manHours": manHours, "lineCost": lineCost,
		})
	}
	lrows.Close()

	materialCost, _ := cst.MaterialCost.Float64()
	laborCost, _ := cst.LaborCost.Float64()
	contractorCost, _ := cst.ContractorCost.Float64()
	logisticsCost, _ := cst.LogisticsCost.Float64()
	utilitiesCost, _ := cst.UtilitiesCost.Float64()
	totalCost, _ := cst.TotalCost.Float64()
	margin, _ := cst.Margin.Float64()
	price, _ := cst.Price.Float64()
	marginPct, _ := cst.MarginPct.Float64()

	c.JSON(http.StatusOK, gin.H{
		"id": cst.ID, "version": cst.Version, "status": cst.Status, "calculatedAt": cst.CalculatedAt, "approvedAt": cst.ApprovedAt,
		"materialCost": materialCost, "laborCost": laborCost, "contractorCost": contractorCost, "logisticsCost": logisticsCost,
		"utilitiesCost": utilitiesCost, "totalCost": totalCost, "margin": margin, "price": price, "marginPct": marginPct,
		"hasShortage": cst.HasShortage, "hasMissingNorm": cst.HasMissingNorm, "hasMissingBom": cst.HasMissingBom,
		"materials": materialsOut, "labor": laborOut,
	})
}

type buildBody struct {
	PriceSource       *string                       `json:"priceSource"`
	MaterialOverrides map[string]materialOverrideIn `json:"materialOverrides"`
	RateOverrides     rateOverridesIn               `json:"rateOverrides"`
	RatesReason       *string                       `json:"ratesReason"`
	Note              *string                       `json:"note"`
}

type materialOverrideIn struct {
	PriceSource    *string  `json:"priceSource"`
	BatchID        *string  `json:"batchId"`
	ExplicitPrice  *float64 `json:"explicitPrice"`
	AllowAnomalies bool     `json:"allowAnomalies"`
}

type rateOverridesIn struct {
	HourlyRate     *float64 `json:"hourlyRate"`
	LogisticsPct   *float64 `json:"logisticsPct"`
	LogisticsMode  *string  `json:"logisticsMode"`
	LogisticsFixed *float64 `json:"logisticsFixed"`
	LogisticsPerKg *float64 `json:"logisticsPerKg"`
	UtilitiesPct   *float64 `json:"utilitiesPct"`
	MarginPct      *float64 `json:"marginPct"`
	MarginMode     *string  `json:"marginMode"`
}

// Build — POST /order-lines/:orderLineId/costings (planner/sales_manager/procurement/admin).
func (h *OrderCostingsHandler) Build(c *gin.Context) {
	orderLineID := c.Param("orderLineId")
	var body buildBody
	if err := c.ShouldBindJSON(&body); err != nil && err.Error() != "EOF" {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	user := authpkg.CurrentUser(c)

	opts := ordercosting.BuildOptions{}
	if body.PriceSource != nil {
		ps := warehouse.PriceSource(*body.PriceSource)
		opts.PriceSource = &ps
	}
	if len(body.MaterialOverrides) > 0 {
		opts.MaterialOverrides = map[string]ordercosting.MaterialOverride{}
		for materialID, ov := range body.MaterialOverrides {
			mo := ordercosting.MaterialOverride{BatchID: ov.BatchID, ExplicitPrice: ov.ExplicitPrice, AllowAnomalies: ov.AllowAnomalies}
			if ov.PriceSource != nil {
				ps := warehouse.PriceSource(*ov.PriceSource)
				mo.PriceSource = &ps
			}
			opts.MaterialOverrides[materialID] = mo
		}
	}
	opts.RateOverrides = toRateOverrides(body.RateOverrides)
	if body.RatesReason != nil {
		opts.RatesReason = *body.RatesReason
	}
	if body.Note != nil {
		opts.Note = *body.Note
	}

	cst, materials, labor, err := ordercosting.Build(c.Request.Context(), h.pool, orderLineID, opts, user.UserID)
	if err != nil {
		respondOrderCostingErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": cst.ID, "orderId": cst.OrderID, "orderLineId": cst.OrderLineID, "articleId": cst.ArticleID, "qty": cst.Qty,
		"version": cst.Version, "status": cst.Status, "calculatedAt": cst.CalculatedAt, "approvedAt": cst.ApprovedAt,
		"approvedById": cst.ApprovedByID, "createdById": cst.CreatedByID, "baseCostingId": cst.BaseCostingID,
		"hourlyRate": cst.HourlyRate, "logisticsPct": cst.LogisticsPct, "logisticsMode": cst.LogisticsMode,
		"logisticsFixed": cst.LogisticsFixed, "logisticsPerKg": cst.LogisticsPerKg, "utilitiesPct": cst.UtilitiesPct,
		"marginPct": cst.MarginPct, "marginMode": cst.MarginMode, "vatPct": cst.VatPct, "ratesSource": cst.RatesSource,
		"ratesReason": cst.RatesReason, "materialCost": cst.MaterialCost, "laborCost": cst.LaborCost,
		"contractorCost": cst.ContractorCost, "logisticsCost": cst.LogisticsCost, "utilitiesCost": cst.UtilitiesCost,
		"totalCost": cst.TotalCost, "margin": cst.Margin, "price": cst.Price, "totalManHours": cst.TotalManHours,
		"hasShortage": cst.HasShortage, "hasMissingNorm": cst.HasMissingNorm, "hasMissingBom": cst.HasMissingBom,
		"note": cst.Note, "materials": materials, "labor": labor,
	})
}

func toRateOverrides(in rateOverridesIn) ordercosting.RateOverrides {
	out := ordercosting.RateOverrides{
		HourlyRate: in.HourlyRate, LogisticsPct: in.LogisticsPct, LogisticsFixed: in.LogisticsFixed,
		LogisticsPerKg: in.LogisticsPerKg, UtilitiesPct: in.UtilitiesPct, MarginPct: in.MarginPct,
	}
	if in.LogisticsMode != nil {
		m := costingLogisticsMode(*in.LogisticsMode)
		out.LogisticsMode = &m
	}
	if in.MarginMode != nil {
		m := costingMarginMode(*in.MarginMode)
		out.MarginMode = &m
	}
	return out
}

// Approve — POST /order-lines/:orderLineId/costings/:costingId/approve (director/planner/admin).
func (h *OrderCostingsHandler) Approve(c *gin.Context) {
	costingID := c.Param("costingId")
	user := authpkg.CurrentUser(c)
	cst, err := ordercosting.Approve(c.Request.Context(), h.pool, costingID, user.UserID)
	if err != nil {
		respondOrderCostingErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, cst)
}

type markOrderedBody struct {
	SupplierOrderNumber string   `json:"supplierOrderNumber"`
	UnitPrice           *float64 `json:"unitPrice"`
}

// MarkOrdered — POST .../:costingId/materials/:rowId/ordered (planner/sales_manager/admin).
func (h *OrderCostingsHandler) MarkOrdered(c *gin.Context) {
	costingID := c.Param("costingId")
	rowID := c.Param("rowId")
	var body markOrderedBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	if strings.TrimSpace(body.SupplierOrderNumber) == "" {
		common.BadRequest(c, "MISSING_SUPPLIER_ORDER", "Укажите номер заказа поставщику — без него стадия «заказано» не имеет следа")
		return
	}

	ctx := c.Request.Context()
	var rowCostingID string
	var currentUnitPrice, qtyTotal float64
	var priceState string
	err := h.pool.QueryRow(ctx, "SELECT costing_id, unit_price, qty_total, price_state FROM order_costing_materials WHERE id = $1", rowID).
		Scan(&rowCostingID, &currentUnitPrice, &qtyTotal, &priceState)
	if err == pgx.ErrNoRows || (err == nil && rowCostingID != costingID) {
		common.NotFound(c, "Строка "+rowID+" в калькуляции "+costingID+" не найдена")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	if priceState == "ACTUAL" {
		common.BadRequest(c, "ALREADY_ACTUAL", "Цена уже фактическая (партия пришла) — стадия «заказано» позади")
		return
	}

	unitPrice := currentUnitPrice
	if body.UnitPrice != nil {
		unitPrice = *body.UnitPrice
	}
	supplierOrderNumber := strings.TrimSpace(body.SupplierOrderNumber)
	if len(supplierOrderNumber) > 30 {
		supplierOrderNumber = supplierOrderNumber[:30]
	}
	lineCost := roundToCents(unitPrice * qtyTotal)
	now := time.Now().UTC()

	row := h.pool.QueryRow(ctx, `
		UPDATE order_costing_materials
		SET price_state = 'ORDERED', supplier_order_number = $1, price_state_changed_at = $2, unit_price = $3, line_cost = $4
		WHERE id = $5
		RETURNING id, costing_id, material_id, material_code_snapshot, material_name_snapshot, qty_per_unit, qty_total,
		          unit_price, line_cost, price_source, batch_id, source_document_id, price_date, allocations, price_state,
		          supplier_order_number, price_state_changed_at, is_shortage, shortage_qty, shortage_unit_price`,
		supplierOrderNumber, now, unitPrice, lineCost, rowID)
	var out struct {
		ID, CostingID                             string
		MaterialID, MaterialCodeSnapshot          *string
		MaterialNameSnapshot                      string
		QtyPerUnit, QtyTotal, UnitPrice, LineCost float64
		PriceSource                               string
		BatchID, SourceDocumentID                 *string
		PriceDate                                 *time.Time
		Allocations                               []byte
		PriceState                                string
		SupplierOrderNumber                       *string
		PriceStateChangedAt                       *time.Time
		IsShortage                                bool
		ShortageQty, ShortageUnitPrice            float64
	}
	if err := row.Scan(&out.ID, &out.CostingID, &out.MaterialID, &out.MaterialCodeSnapshot, &out.MaterialNameSnapshot,
		&out.QtyPerUnit, &out.QtyTotal, &out.UnitPrice, &out.LineCost, &out.PriceSource, &out.BatchID, &out.SourceDocumentID,
		&out.PriceDate, &out.Allocations, &out.PriceState, &out.SupplierOrderNumber, &out.PriceStateChangedAt,
		&out.IsShortage, &out.ShortageQty, &out.ShortageUnitPrice); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Не удалось сохранить изменения")
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": out.ID, "costingId": out.CostingID, "materialId": out.MaterialID, "materialCodeSnapshot": out.MaterialCodeSnapshot,
		"materialNameSnapshot": out.MaterialNameSnapshot, "qtyPerUnit": out.QtyPerUnit, "qtyTotal": out.QtyTotal,
		"unitPrice": out.UnitPrice, "lineCost": out.LineCost, "priceSource": out.PriceSource, "batchId": out.BatchID,
		"sourceDocumentId": out.SourceDocumentID, "priceDate": out.PriceDate, "allocations": rawJSON(out.Allocations),
		"priceState": out.PriceState, "supplierOrderNumber": out.SupplierOrderNumber, "priceStateChangedAt": out.PriceStateChangedAt,
		"isShortage": out.IsShortage, "shortageQty": out.ShortageQty, "shortageUnitPrice": out.ShortageUnitPrice,
	})
}

func roundToCents(n float64) float64 {
	return float64(int64(n*100+0.5)) / 100
}

func derefOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func rawJSON(b []byte) interface{} {
	if len(b) == 0 {
		return nil
	}
	return jsonRawMessage(b)
}

// loadSnapshot — строка БД → снимок для факторного разбора (toSnapshot в оригинале).
func (h *OrderCostingsHandler) loadSnapshot(c *gin.Context, costingID string) (ordercosting.CostingSnapshot, string, bool, error) {
	ctx := c.Request.Context()
	cst, err := scanOrderCostingLocal(h.pool.QueryRow(ctx, "SELECT "+orderCostingColsLocal+" FROM order_costings WHERE id = $1", costingID))
	if err == pgx.ErrNoRows {
		return ordercosting.CostingSnapshot{}, "", false, nil
	}
	if err != nil {
		return ordercosting.CostingSnapshot{}, "", false, err
	}
	f := func(d decimal.Decimal) float64 { v, _ := d.Float64(); return v }
	snap := ordercosting.CostingSnapshot{
		Version: cst.Version, CalculatedAt: cst.CalculatedAt, Qty: f(cst.Qty), MaterialCost: f(cst.MaterialCost),
		LaborCost: f(cst.LaborCost), LogisticsCost: f(cst.LogisticsCost), UtilitiesCost: f(cst.UtilitiesCost),
		TotalCost: f(cst.TotalCost), Margin: f(cst.Margin), Price: f(cst.Price), LogisticsPct: f(cst.LogisticsPct),
		LogisticsMode: cst.LogisticsMode, UtilitiesPct: f(cst.UtilitiesPct), MarginPct: f(cst.MarginPct), MarginMode: cst.MarginMode,
		Materials: []ordercosting.SnapshotMaterial{}, Labor: []ordercosting.SnapshotLabor{},
	}
	mrows, err := h.pool.Query(ctx, "SELECT material_id, material_name_snapshot, qty_total, unit_price, line_cost, batch_id FROM order_costing_materials WHERE costing_id = $1", costingID)
	if err != nil {
		return snap, "", false, err
	}
	for mrows.Next() {
		var m ordercosting.SnapshotMaterial
		if err := mrows.Scan(&m.MaterialID, &m.Name, &m.QtyTotal, &m.UnitPrice, &m.LineCost, &m.BatchID); err != nil {
			mrows.Close()
			return snap, "", false, err
		}
		snap.Materials = append(snap.Materials, m)
	}
	mrows.Close()
	lrows, err := h.pool.Query(ctx, `SELECT stage, "laborKind", rate_type, rate, man_hours, line_cost FROM order_costing_labor WHERE costing_id = $1`, costingID)
	if err != nil {
		return snap, "", false, err
	}
	for lrows.Next() {
		var l ordercosting.SnapshotLabor
		var stageDB string
		if err := lrows.Scan(&stageDB, &l.LaborKind, &l.RateType, &l.Rate, &l.ManHours, &l.LineCost); err != nil {
			lrows.Close()
			return snap, "", false, err
		}
		l.Stage = models.RoutingStageDBToAPI(stageDB)
		snap.Labor = append(snap.Labor, l)
	}
	lrows.Close()
	return snap, cst.OrderLineID, true, nil
}

// Compare — GET /order-lines/:orderLineId/costings/compare/:baseId/:targetId —
// «почему через месяц дороже»: разложение разницы на факторы + residual.
func (h *OrderCostingsHandler) Compare(c *gin.Context) {
	base, baseLine, okB, err := h.loadSnapshot(c, c.Param("baseId"))
	if err != nil {
		respondOrderCostingErr(c, err)
		return
	}
	target, targetLine, okT, err := h.loadSnapshot(c, c.Param("targetId"))
	if err != nil {
		respondOrderCostingErr(c, err)
		return
	}
	if !okB || !okT {
		common.NotFound(c, "Одна из версий калькуляции не найдена")
		return
	}
	if baseLine != targetLine {
		common.BadRequest(c, "DIFFERENT_ORDER_LINES", "Сравнивать можно только версии одной позиции заказа")
		return
	}
	result := ordercosting.CompareCostings(base, target)
	c.JSON(http.StatusOK, gin.H{
		"base": result.Base, "target": result.Target, "price": result.Price, "totalCost": result.TotalCost,
		"factors": result.Factors, "residual": ordercosting.Reconcile(result),
	})
}
