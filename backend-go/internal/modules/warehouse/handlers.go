// Точный перенос material-batches.controller.ts + batch-reservations.controller.ts.
// backfillFromMovements (разовая миграция остатков — админский инструмент,
// не часть повседневного API) осознанно НЕ портирован.
package warehouse

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	wh "cmk-avrora-erp/backend-go/internal/warehouse"
)

// --- MaterialBatchesController ---

type MaterialBatchesHandler struct {
	pool *pgxpool.Pool
}

func NewMaterialBatchesHandler(pool *pgxpool.Pool) *MaterialBatchesHandler {
	return &MaterialBatchesHandler{pool: pool}
}

func respondErr(c *gin.Context, err error) {
	switch e := err.(type) {
	case *common.APIError404:
		common.Fail(c, http.StatusNotFound, e.Code, e.Message)
	case *common.APIError400:
		common.Fail(c, http.StatusBadRequest, e.Code, e.Message)
	case *common.APIError403:
		common.Fail(c, http.StatusForbidden, e.Code, e.Message)
	case *common.APIError409:
		common.Fail(c, http.StatusConflict, e.Code, e.Message)
	default:
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
	}
}

// Anomalies — GET /material-batches/anomalies — материалы с подозрительными ценами.
func (h *MaterialBatchesHandler) Anomalies(c *gin.Context) {
	rows, err := wh.AnomalyReport(c.Request.Context(), h.pool)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rows, "total": len(rows)})
}

// ClearAnomaly — POST /material-batches/anomalies/:batchId/clear (procurement/planner/admin).
func (h *MaterialBatchesHandler) ClearAnomaly(c *gin.Context) {
	batchID := c.Param("batchId")
	user := authpkg.CurrentUser(c)
	b, err := wh.ClearAnomaly(c.Request.Context(), h.pool, batchID, user.UserID)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, b)
}

// List — GET /material-batches/:materialId — партии материала с живыми остатками.
func (h *MaterialBatchesHandler) List(c *gin.Context) {
	materialID := c.Param("materialId")
	includeEmpty := c.Query("includeEmpty") == "true"
	rows, err := wh.BatchesOf(c.Request.Context(), h.pool, materialID, includeEmpty, nil)
	if err != nil {
		respondErr(c, err)
		return
	}
	type batchOut struct {
		ID             string      `json:"id"`
		ReceiptDate    interface{} `json:"receiptDate"`
		UnitPrice      float64     `json:"unitPrice"`
		QtyReceived    float64     `json:"qtyReceived"`
		QtyRemaining   float64     `json:"qtyRemaining"`
		SupplierName   *string     `json:"supplierName"`
		DocumentNumber *string     `json:"documentNumber"`
		Origin         string      `json:"origin"`
		PriceAnomaly   bool        `json:"priceAnomaly"`
		AnomalyFactor  *float64    `json:"anomalyFactor"`
	}
	data := make([]batchOut, len(rows))
	totalRemaining := 0.0
	for i, b := range rows {
		unitPrice, _ := b.UnitPrice.Float64()
		qtyReceived, _ := b.QtyReceived.Float64()
		qtyRemaining, _ := b.QtyRemaining.Float64()
		var anomalyFactor *float64
		if b.AnomalyFactor != nil {
			v, _ := b.AnomalyFactor.Float64()
			anomalyFactor = &v
		}
		data[i] = batchOut{
			ID: b.ID, ReceiptDate: b.ReceiptDate, UnitPrice: unitPrice, QtyReceived: qtyReceived,
			QtyRemaining: qtyRemaining, SupplierName: b.SupplierName, DocumentNumber: b.DocumentNumber,
			Origin: b.Origin, PriceAnomaly: b.PriceAnomaly, AnomalyFactor: anomalyFactor,
		}
		totalRemaining += qtyRemaining
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "totalRemaining": totalRemaining})
}

var priceSources = map[string]bool{
	"FIFO_STOCK": true, "SPECIFIC_BATCH": true, "WEIGHTED_AVG": true,
	"LAST_PURCHASE": true, "PRICE_LIST": true, "MANUAL": true,
}

type priceBody struct {
	Qty            float64  `json:"qty"`
	Source         *string  `json:"source"`
	BatchID        *string  `json:"batchId"`
	ExplicitPrice  *float64 `json:"explicitPrice"`
	FallbackPrice  *float64 `json:"fallbackPrice"`
	AllowAnomalies bool     `json:"allowAnomalies"`
}

// Price — POST /material-batches/:materialId/price — подобрать цену под объём.
func (h *MaterialBatchesHandler) Price(c *gin.Context) {
	materialID := c.Param("materialId")
	var body priceBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	source := "FIFO_STOCK"
	if body.Source != nil {
		source = *body.Source
	}
	if !priceSources[source] {
		common.BadRequest(c, "INVALID_PRICE_SOURCE", "Неизвестный источник цены: "+source+". Допустимо: FIFO_STOCK, SPECIFIC_BATCH, WEIGHTED_AVG, LAST_PURCHASE, PRICE_LIST, MANUAL")
		return
	}
	if !(body.Qty > 0) {
		common.BadRequest(c, "INVALID_QTY", "Количество должно быть > 0")
		return
	}
	resolution, err := wh.PriceFor(c.Request.Context(), h.pool, materialID, wh.PriceRequest{
		Qty: body.Qty, Source: wh.PriceSource(source), BatchID: body.BatchID,
		ExplicitPrice: body.ExplicitPrice, FallbackPrice: body.FallbackPrice, AllowAnomalies: body.AllowAnomalies,
	}, nil)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, resolution)
}

// --- BatchReservationsController ---

type BatchReservationsHandler struct {
	pool *pgxpool.Pool
}

func NewBatchReservationsHandler(pool *pgxpool.Pool) *BatchReservationsHandler {
	return &BatchReservationsHandler{pool: pool}
}

// Availability — GET /batch-reservations/availability/:materialId.
func (h *BatchReservationsHandler) Availability(c *gin.Context) {
	materialID := c.Param("materialId")
	var orderID *string
	if v := c.Query("orderId"); v != "" {
		orderID = &v
	}
	data, err := wh.Availability(c.Request.Context(), h.pool, materialID, orderID)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "total": len(data)})
}

type assessBody struct {
	BatchID string  `json:"batchId"`
	OrderID string  `json:"orderId"`
	Qty     float64 `json:"qty"`
}

// Assess — POST /batch-reservations/assess.
func (h *BatchReservationsHandler) Assess(c *gin.Context) {
	var body assessBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	if body.BatchID == "" || body.OrderID == "" {
		common.BadRequest(c, "INVALID_INPUT", "Нужны batchId и orderId")
		return
	}
	availability, assessment, err := wh.Assess(c.Request.Context(), h.pool, body.BatchID, body.OrderID, body.Qty)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"availability": availability, "assessment": assessment})
}

// Reserve — POST /batch-reservations/from-costing/:costingId (procurement/planner/admin).
func (h *BatchReservationsHandler) Reserve(c *gin.Context) {
	costingID := c.Param("costingId")
	user := authpkg.CurrentUser(c)
	created, expiresAt, err := wh.ReserveForCosting(c.Request.Context(), h.pool, costingID, user.UserID, wh.DefaultReservationTTLDays)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"created": len(created), "expiresAt": expiresAt, "reservations": created})
}

type requestOverrideBody struct {
	ReservationID      string  `json:"reservationId"`
	RequestedByOrderID string  `json:"requestedByOrderId"`
	QtyRequested       float64 `json:"qtyRequested"`
	Reason             string  `json:"reason"`
}

// RequestOverride — POST /batch-reservations/overrides (sales_manager/planner/procurement/admin).
func (h *BatchReservationsHandler) RequestOverride(c *gin.Context) {
	var body requestOverrideBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	user := authpkg.CurrentUser(c)
	id, err := wh.RequestOverride(c.Request.Context(), h.pool, wh.OverrideRequestInput{
		ReservationID: body.ReservationID, RequestedByOrderID: body.RequestedByOrderID,
		QtyRequested: body.QtyRequested, Reason: body.Reason,
	}, user.UserID)
	if err != nil {
		respondErr(c, err)
		return
	}
	row := h.pool.QueryRow(c.Request.Context(), `
		SELECT id, reservation_id, requested_by_order_id, qty_requested, reason, status, requested_by_id, created_at
		FROM batch_override_requests WHERE id = $1`, id)
	var reqID, reservationID, requestedByOrderID, reason, status string
	var qtyRequested decimal.Decimal
	var requestedByID *string
	var createdAt time.Time
	if err := row.Scan(&reqID, &reservationID, &requestedByOrderID, &qtyRequested, &reason, &status, &requestedByID, &createdAt); err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": reqID, "reservationId": reservationID, "requestedByOrderId": requestedByOrderID,
		"qtyRequested": qtyRequested, "reason": reason, "status": status, "requestedById": requestedByID,
		"createdAt": createdAt.UTC().Format("2006-01-02T15:04:05.000Z"),
	})
}

// ListOverrides — GET /batch-reservations/overrides — очередь запросов на перехват.
func (h *BatchReservationsHandler) ListOverrides(c *gin.Context) {
	status := c.Query("status")
	if status == "" {
		status = "PENDING"
	}
	ctx := c.Request.Context()
	rows, err := h.pool.Query(ctx, `
		SELECT r.id, r.status, r.qty_requested, r.reason, r.created_at, r.requested_by_order_id,
		       res.order_id, res.qty, b.unit_price, m.material_code, m.name, m.unit
		FROM batch_override_requests r
		JOIN batch_reservations res ON res.id = r.reservation_id
		JOIN material_batches b ON b.id = res.batch_id
		JOIN materials m ON m.id = b.material_id
		WHERE r.status = $1
		ORDER BY r.created_at ASC`, status)
	if err != nil {
		respondErr(c, err)
		return
	}
	type rowT struct {
		ID, Status, Reason, RequestedByOrderID, HolderOrderID string
		QtyRequested, ReservedQty, UnitPrice                  float64
		CreatedAt                                             time.Time
		MaterialCode, MaterialName, MaterialUnit              string
	}
	var list []rowT
	orderIDSet := map[string]bool{}
	for rows.Next() {
		var r rowT
		if err := rows.Scan(&r.ID, &r.Status, &r.QtyRequested, &r.Reason, &r.CreatedAt, &r.RequestedByOrderID,
			&r.HolderOrderID, &r.ReservedQty, &r.UnitPrice, &r.MaterialCode, &r.MaterialName, &r.MaterialUnit); err != nil {
			rows.Close()
			respondErr(c, err)
			return
		}
		list = append(list, r)
		orderIDSet[r.RequestedByOrderID] = true
		orderIDSet[r.HolderOrderID] = true
	}
	rows.Close()

	orderByID := map[string]gin.H{}
	if len(orderIDSet) > 0 {
		ids := make([]string, 0, len(orderIDSet))
		for id := range orderIDSet {
			ids = append(ids, id)
		}
		orows, err := h.pool.Query(ctx, "SELECT id, order_number, planned_shipment_date FROM orders WHERE id = ANY($1)", ids)
		if err != nil {
			respondErr(c, err)
			return
		}
		for orows.Next() {
			var id, orderNumber string
			var planned *time.Time
			if err := orows.Scan(&id, &orderNumber, &planned); err != nil {
				orows.Close()
				respondErr(c, err)
				return
			}
			var plannedStr interface{}
			if planned != nil {
				plannedStr = planned.UTC().Format("2006-01-02T15:04:05.000Z")
			}
			orderByID[id] = gin.H{"id": id, "orderNumber": orderNumber, "plannedShipmentDate": plannedStr}
		}
		orows.Close()
	}

	now := time.Now()
	data := make([]gin.H, len(list))
	for i, r := range list {
		data[i] = gin.H{
			"id": r.ID, "status": r.Status, "qtyRequested": r.QtyRequested, "reason": r.Reason,
			"createdAt":          r.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
			"requestedByOrderId": r.RequestedByOrderID, "requestedByOrder": orderByID[r.RequestedByOrderID],
			"holderOrderId": r.HolderOrderID, "holderOrder": orderByID[r.HolderOrderID],
			"material":  gin.H{"materialCode": r.MaterialCode, "name": r.MaterialName, "unit": r.MaterialUnit},
			"unitPrice": r.UnitPrice, "reservedQty": r.ReservedQty,
			"ageHours": int(now.Sub(r.CreatedAt).Hours()),
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "total": len(data)})
}

// ListExpiring — GET /batch-reservations/expiring — резервы, истекающие в ближайшие дни.
func (h *BatchReservationsHandler) ListExpiring(c *gin.Context) {
	// Math.max(1, Number(days) || 3) в оригинале: пусто/не число/0 → 3,
	// иначе не меньше 1 (в т.ч. отрицательные округляются вверх до 1)
	horizon := 3
	if v, err := strconv.Atoi(c.Query("days")); err == nil && v != 0 {
		if v < 1 {
			v = 1
		}
		horizon = v
	}
	ctx := c.Request.Context()
	rows, err := h.pool.Query(ctx, `
		SELECT r.id, r.qty, r.expires_at, o.id, o.order_number, o.status, b.unit_price, m.material_code, m.name, m.unit
		FROM batch_reservations r
		JOIN orders o ON o.id = r.order_id
		JOIN material_batches b ON b.id = r.batch_id
		JOIN materials m ON m.id = b.material_id
		WHERE r.status = 'ACTIVE' AND r.expires_at < $1
		ORDER BY r.expires_at ASC
		LIMIT 100`, time.Now().UTC().Add(time.Duration(horizon)*24*time.Hour))
	if err != nil {
		respondErr(c, err)
		return
	}
	defer rows.Close()
	now := time.Now()
	data := []gin.H{}
	for rows.Next() {
		var id, orderID, orderNumber, orderStatus, materialCode, materialName, materialUnit string
		var qty, unitPrice float64
		var expiresAt time.Time
		if err := rows.Scan(&id, &qty, &expiresAt, &orderID, &orderNumber, &orderStatus, &unitPrice, &materialCode, &materialName, &materialUnit); err != nil {
			respondErr(c, err)
			return
		}
		daysLeft := int(math.Ceil(float64(expiresAt.Sub(now)) / float64(24*time.Hour)))
		if daysLeft < 0 {
			daysLeft = 0
		}
		data = append(data, gin.H{
			"id": id, "order": gin.H{"id": orderID, "orderNumber": orderNumber, "status": orderStatus},
			"material": gin.H{"materialCode": materialCode, "name": materialName, "unit": materialUnit},
			"qty":      qty, "unitPrice": unitPrice, "expiresAt": expiresAt.UTC().Format("2006-01-02T15:04:05.000Z"),
			"daysLeft": daysLeft,
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "total": len(data)})
}

// OverrideContext — GET /batch-reservations/overrides/:requestId — обе
// стороны на одном экране: чей резерв, оба заказа, во что обойдётся.
func (h *BatchReservationsHandler) OverrideContext(c *gin.Context) {
	requestID := c.Param("requestId")
	ctx := c.Request.Context()

	var reqQtyRequested float64
	var reqReason, reqStatus string
	var reqCreatedAt time.Time
	var reservationID, holderOrderID, batchID, materialID string
	var holderOrderNumber, holderStatus string
	var holderPlanned *time.Time
	var batchUnitPrice, batchQtyRemaining float64
	var batchReceiptDate time.Time
	var batchSupplierName *string
	var materialCode, materialName, materialUnit string
	var requestedByOrderID string

	err := h.pool.QueryRow(ctx, `
		SELECT r.qty_requested, r.reason, r.status, r.created_at, r.requested_by_order_id,
		       res.id, res.order_id, o.order_number, o.status, o.planned_shipment_date,
		       b.id, b.material_id, b.unit_price, b.qty_remaining, b.receipt_date, b.supplier_name,
		       m.material_code, m.name, m.unit
		FROM batch_override_requests r
		JOIN batch_reservations res ON res.id = r.reservation_id
		JOIN orders o ON o.id = res.order_id
		JOIN material_batches b ON b.id = res.batch_id
		JOIN materials m ON m.id = b.material_id
		WHERE r.id = $1`, requestID).Scan(
		&reqQtyRequested, &reqReason, &reqStatus, &reqCreatedAt, &requestedByOrderID,
		&reservationID, &holderOrderID, &holderOrderNumber, &holderStatus, &holderPlanned,
		&batchID, &materialID, &batchUnitPrice, &batchQtyRemaining, &batchReceiptDate, &batchSupplierName,
		&materialCode, &materialName, &materialUnit)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Запрос "+requestID+" не найден")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}

	var requester interface{}
	var reqOrderID, reqOrderNumber, reqStatus2 string
	var reqPlanned *time.Time
	rerr := h.pool.QueryRow(ctx, "SELECT id, order_number, status, planned_shipment_date FROM orders WHERE id = $1", requestedByOrderID).
		Scan(&reqOrderID, &reqOrderNumber, &reqStatus2, &reqPlanned)
	if rerr == nil {
		requester = gin.H{"id": reqOrderID, "orderNumber": reqOrderNumber, "status": reqStatus2, "plannedShipmentDate": pdateStr(reqPlanned)}
	} else if rerr != pgx.ErrNoRows {
		respondErr(c, rerr)
		return
	}

	type altRow struct {
		ID           string
		ReceiptDate  time.Time
		UnitPrice    float64
		QtyRemaining float64
	}
	var alternatives []altRow
	arows, err := h.pool.Query(ctx, `
		SELECT id, receipt_date, unit_price, qty_remaining FROM material_batches
		WHERE material_id = $1 AND id != $2 AND qty_remaining > 0 AND price_anomaly = false
		ORDER BY unit_price ASC LIMIT 3`, materialID, batchID)
	if err != nil {
		respondErr(c, err)
		return
	}
	for arows.Next() {
		var a altRow
		if err := arows.Scan(&a.ID, &a.ReceiptDate, &a.UnitPrice, &a.QtyRemaining); err != nil {
			arows.Close()
			respondErr(c, err)
			return
		}
		alternatives = append(alternatives, a)
	}
	arows.Close()

	var impact gin.H
	if len(alternatives) > 0 {
		cheapest := alternatives[0].UnitPrice
		deltaPerUnit := roundCents(cheapest - batchUnitPrice)
		totalDelta := roundCents((cheapest - batchUnitPrice) * reqQtyRequested)
		impact = gin.H{"alternativeUnitPrice": cheapest, "deltaPerUnit": deltaPerUnit, "totalDelta": totalDelta}
	} else {
		impact = gin.H{"alternativeUnitPrice": nil, "deltaPerUnit": nil, "totalDelta": nil, "note": "Других партий нет — придётся закупать"}
	}

	altOut := make([]gin.H, len(alternatives))
	for i, a := range alternatives {
		altOut[i] = gin.H{"id": a.ID, "receiptDate": a.ReceiptDate.UTC().Format("2006-01-02T15:04:05.000Z"), "unitPrice": a.UnitPrice, "qtyRemaining": a.QtyRemaining}
	}

	c.JSON(http.StatusOK, gin.H{
		"request": gin.H{
			"id": requestID, "qtyRequested": reqQtyRequested, "reason": reqReason, "status": reqStatus,
			"createdAt": reqCreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		},
		"material": gin.H{"materialCode": materialCode, "name": materialName, "unit": materialUnit},
		"batch": gin.H{
			"id": batchID, "receiptDate": batchReceiptDate.UTC().Format("2006-01-02T15:04:05.000Z"),
			"unitPrice": batchUnitPrice, "qtyRemaining": batchQtyRemaining, "supplierName": batchSupplierName,
		},
		"holder":       gin.H{"id": holderOrderID, "orderNumber": holderOrderNumber, "status": holderStatus, "plannedShipmentDate": pdateStr(holderPlanned)},
		"requester":    requester,
		"impact":       impact,
		"alternatives": altOut,
	})
}

func pdateStr(t *time.Time) interface{} {
	if t == nil {
		return nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func roundCents(n float64) float64 {
	return float64(int64(n*100+0.5)) / 100
}

type decideBody struct {
	Approve bool   `json:"approve"`
	Comment string `json:"comment"`
}

// Decide — POST /batch-reservations/overrides/:requestId/decide (director/admin).
func (h *BatchReservationsHandler) Decide(c *gin.Context) {
	requestID := c.Param("requestId")
	var body decideBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	user := authpkg.CurrentUser(c)
	updated, affectedCostingID, err := wh.DecideOverride(c.Request.Context(), h.pool, requestID, body.Approve, body.Comment, user.UserID, user.Roles)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"request": updated, "affectedCostingId": affectedCostingID})
}

// ExpireStale — POST /batch-reservations/expire-stale (admin).
func (h *BatchReservationsHandler) ExpireStale(c *gin.Context) {
	expired, warned, err := wh.ExpireStale(c.Request.Context(), h.pool, time.Now().UnixMilli(), wh.DefaultReservationWarnDays)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"expired": expired, "warned": warned})
}
