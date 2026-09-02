// DB-обёртка над reservations.go — перенос batch-reservation.service.ts.
// Согласование перехвата — за директором: это чужие деньги и чужой срок
// отгрузки.
package warehouse

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/events"
	"cmk-avrora-erp/backend-go/internal/models"
)

func dbUserID(userID string) *string {
	if userID == "" || strings.HasPrefix(userID, "usr-") {
		return nil
	}
	return &userID
}

type AvailabilityRow struct {
	BatchAvailability
	ReceiptDate    string  `json:"receiptDate"`
	UnitPrice      float64 `json:"unitPrice"`
	SupplierName   *string `json:"supplierName"`
	DocumentNumber *string `json:"documentNumber"`
	PriceAnomaly   bool    `json:"priceAnomaly"`
	BatchType      string  `json:"batchType"`
	OwnerOrderID   *string `json:"ownerOrderId"`
}

// Availability — доступность партий материала с учётом чужих резервов.
func Availability(ctx context.Context, pool *pgxpool.Pool, materialID string, forOrderID *string) ([]AvailabilityRow, error) {
	sql := `SELECT id, receipt_date, unit_price, qty_remaining, supplier_name, document_number, price_anomaly, batch_type, owner_order_id
		FROM material_batches WHERE material_id = $1 AND qty_remaining > 0`
	args := []interface{}{materialID}
	if forOrderID != nil && *forOrderID != "" {
		args = append(args, *forOrderID)
		sql += " AND (batch_type = 'OWN' OR (batch_type = 'TOLLING' AND owner_order_id = $2))"
	} else {
		sql += " AND batch_type = 'OWN'"
	}
	sql += " ORDER BY receipt_date ASC"

	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	type batchRow struct {
		ID             string
		ReceiptDate    time.Time
		UnitPrice      float64
		QtyRemaining   float64
		SupplierName   *string
		DocumentNumber *string
		PriceAnomaly   bool
		BatchType      string
		OwnerOrderID   *string
	}
	var batches []batchRow
	var batchIDs []string
	for rows.Next() {
		var b batchRow
		if err := rows.Scan(&b.ID, &b.ReceiptDate, &b.UnitPrice, &b.QtyRemaining, &b.SupplierName, &b.DocumentNumber,
			&b.PriceAnomaly, &b.BatchType, &b.OwnerOrderID); err != nil {
			rows.Close()
			return nil, err
		}
		batches = append(batches, b)
		batchIDs = append(batchIDs, b.ID)
	}
	rows.Close()

	var reservations []ReservationLike
	if len(batchIDs) > 0 {
		rrows, err := pool.Query(ctx, "SELECT id, batch_id, order_id, qty, status, expires_at FROM batch_reservations WHERE batch_id = ANY($1) AND status = 'ACTIVE'", batchIDs)
		if err != nil {
			return nil, err
		}
		for rrows.Next() {
			var r ReservationLike
			var expiresAt time.Time
			var status string
			if err := rrows.Scan(&r.ID, &r.BatchID, &r.OrderID, &r.Qty, &status, &expiresAt); err != nil {
				rrows.Close()
				return nil, err
			}
			r.Status = ReservationStatus(status)
			r.ExpiresAt = expiresAt.UnixMilli()
			reservations = append(reservations, r)
		}
		rrows.Close()
	}

	out := make([]AvailabilityRow, len(batches))
	for i, b := range batches {
		av := AvailabilityOf(b.ID, b.QtyRemaining, reservations, forOrderID)
		out[i] = AvailabilityRow{
			BatchAvailability: av, ReceiptDate: b.ReceiptDate.UTC().Format("2006-01-02T15:04:05.000Z"),
			UnitPrice: b.UnitPrice, SupplierName: b.SupplierName, DocumentNumber: b.DocumentNumber,
			PriceAnomaly: b.PriceAnomaly, BatchType: b.BatchType, OwnerOrderID: b.OwnerOrderID,
		}
	}
	return out, nil
}

// Assess — хватит ли объёма и нужно ли согласование, до создания резерва.
func Assess(ctx context.Context, pool *pgxpool.Pool, batchID, orderID string, wantQty float64) (BatchAvailability, AssessResult, error) {
	var qtyRemaining float64
	err := pool.QueryRow(ctx, "SELECT qty_remaining FROM material_batches WHERE id = $1", batchID).Scan(&qtyRemaining)
	if err == pgx.ErrNoRows {
		return BatchAvailability{}, AssessResult{}, &common.APIError404{Code: "NOT_FOUND", Message: "Партия " + batchID + " не найдена"}
	}
	if err != nil {
		return BatchAvailability{}, AssessResult{}, err
	}
	rows, err := pool.Query(ctx, "SELECT id, batch_id, order_id, qty, status, expires_at FROM batch_reservations WHERE batch_id = $1 AND status = 'ACTIVE'", batchID)
	if err != nil {
		return BatchAvailability{}, AssessResult{}, err
	}
	var reservations []ReservationLike
	for rows.Next() {
		var r ReservationLike
		var expiresAt time.Time
		var status string
		if err := rows.Scan(&r.ID, &r.BatchID, &r.OrderID, &r.Qty, &status, &expiresAt); err != nil {
			rows.Close()
			return BatchAvailability{}, AssessResult{}, err
		}
		r.Status = ReservationStatus(status)
		r.ExpiresAt = expiresAt.UnixMilli()
		reservations = append(reservations, r)
	}
	rows.Close()

	av := AvailabilityOf(batchID, qtyRemaining, reservations, &orderID)
	return av, AssessRequest(av, wantQty), nil
}

// ReserveForCosting — резервы под согласованную калькуляцию. Черновики не
// резервируют: иначе металл окажется занят коммерческими предложениями,
// которые никуда не пойдут.
const batchReservationCols = `id, batch_id, order_id, order_costing_id, qty, status, expires_at, created_at, created_by_id, released_at, released_by_id, release_reason`

func scanReservation(row interface {
	Scan(dest ...interface{}) error
}) (models.BatchReservation, error) {
	var r models.BatchReservation
	err := row.Scan(&r.ID, &r.BatchID, &r.OrderID, &r.OrderCostingID, &r.Qty, &r.Status, &r.ExpiresAt,
		&r.CreatedAt, &r.CreatedByID, &r.ReleasedAt, &r.ReleasedByID, &r.ReleaseReason)
	return r, err
}

func ReserveForCosting(ctx context.Context, pool *pgxpool.Pool, costingID, userID string, ttlDays int) ([]models.BatchReservation, time.Time, error) {
	var orderID, status string
	err := pool.QueryRow(ctx, "SELECT order_id, status FROM order_costings WHERE id = $1", costingID).Scan(&orderID, &status)
	if err == pgx.ErrNoRows {
		return nil, time.Time{}, &common.APIError404{Code: "NOT_FOUND", Message: "Калькуляция " + costingID + " не найдена"}
	}
	if err != nil {
		return nil, time.Time{}, err
	}
	if status != "APPROVED" {
		return nil, time.Time{}, &common.APIError400{Code: "COSTING_NOT_APPROVED", Message: "Резервировать партии можно только под согласованную калькуляцию"}
	}

	rows, err := pool.Query(ctx, "SELECT batch_id, qty_total, allocations FROM order_costing_materials WHERE costing_id = $1", costingID)
	if err != nil {
		return nil, time.Time{}, err
	}
	type allocEntry struct {
		BatchID string  `json:"batchId"`
		Qty     float64 `json:"qty"`
	}
	var allBatchIDQty []allocEntry
	for rows.Next() {
		var batchID *string
		var qtyTotal float64
		var allocationsRaw []byte
		if err := rows.Scan(&batchID, &qtyTotal, &allocationsRaw); err != nil {
			rows.Close()
			return nil, time.Time{}, err
		}
		var allocs []allocEntry
		if len(allocationsRaw) > 0 {
			_ = json.Unmarshal(allocationsRaw, &allocs)
		}
		allBatchIDQty = append(allBatchIDQty, allocs...)
	}
	rows.Close()

	now := time.Now().UTC()
	expiresAt := time.Unix(0, ReservationExpiry(now.UnixMilli(), ttlDays)*int64(time.Millisecond)).UTC()
	createdByID := dbUserID(userID)

	created := []models.BatchReservation{}
	for _, a := range allBatchIDQty {
		if a.BatchID == "" || a.Qty <= 0 {
			continue
		}
		var existingID string
		ferr := pool.QueryRow(ctx, "SELECT id FROM batch_reservations WHERE batch_id = $1 AND order_costing_id = $2 AND status = 'ACTIVE'", a.BatchID, costingID).Scan(&existingID)
		if ferr == nil {
			continue
		}
		if ferr != pgx.ErrNoRows {
			return created, expiresAt, ferr
		}
		orderCostingID := costingID
		row := pool.QueryRow(ctx, `
			INSERT INTO batch_reservations (id, batch_id, order_id, order_costing_id, qty, expires_at, created_by_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING `+batchReservationCols,
			uuid.NewString(), a.BatchID, orderID, orderCostingID, a.Qty, expiresAt, createdByID)
		r, err := scanReservation(row)
		if err != nil {
			return created, expiresAt, err
		}
		created = append(created, r)
	}
	return created, expiresAt, nil
}

type OverrideRequestInput struct {
	ReservationID      string
	RequestedByOrderID string
	QtyRequested       float64
	Reason             string
}

// RequestOverride — запрос на перехват: причина обязательна — директор
// решает не вслепую.
func RequestOverride(ctx context.Context, pool *pgxpool.Pool, in OverrideRequestInput, userID string) (string, error) {
	var reservationOrderID, reservationStatus string
	err := pool.QueryRow(ctx, "SELECT order_id, status FROM batch_reservations WHERE id = $1", in.ReservationID).Scan(&reservationOrderID, &reservationStatus)
	if err == pgx.ErrNoRows {
		return "", &common.APIError404{Code: "NOT_FOUND", Message: "Резерв " + in.ReservationID + " не найден"}
	}
	if err != nil {
		return "", err
	}
	if reservationStatus != "ACTIVE" {
		return "", &common.APIError400{Code: "RESERVATION_NOT_ACTIVE", Message: "Резерв уже " + reservationStatus + " — перехватывать нечего"}
	}
	if reservationOrderID == in.RequestedByOrderID {
		return "", &common.APIError400{Code: "SAME_ORDER", Message: "Это резерв того же заказа — перехват не нужен"}
	}
	if strings.TrimSpace(in.Reason) == "" {
		return "", &common.APIError400{Code: "REASON_REQUIRED", Message: "Нужна причина: директор решает, у кого забрать партию"}
	}

	id := uuid.NewString()
	_, err = pool.Exec(ctx, `
		INSERT INTO batch_override_requests (id, reservation_id, requested_by_order_id, qty_requested, reason, requested_by_id)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		id, in.ReservationID, in.RequestedByOrderID, in.QtyRequested, strings.TrimSpace(in.Reason), dbUserID(userID))
	if err != nil {
		return "", err
	}
	// Уведомление директору; менеджер при этом не заблокирован и считает дальше
	events.Emit("batch:override_requested", map[string]interface{}{
		"requestId":     id,
		"reservationId": in.ReservationID,
		"orderId":       in.RequestedByOrderID,
	})
	return id, nil
}

// DecideOverride — решение по перехвату. Только директор — проверка роли
// здесь, а не только в декораторе: метод вызывается и из фоновых сценариев.
const batchOverrideRequestCols = `id, reservation_id, requested_by_order_id, qty_requested, reason, status, requested_by_id, created_at, decided_by_id, decided_at, decision_comment`

func scanOverrideRequest(row interface {
	Scan(dest ...interface{}) error
}) (models.BatchOverrideRequest, error) {
	var r models.BatchOverrideRequest
	err := row.Scan(&r.ID, &r.ReservationID, &r.RequestedByOrderID, &r.QtyRequested, &r.Reason, &r.Status,
		&r.RequestedByID, &r.CreatedAt, &r.DecidedByID, &r.DecidedAt, &r.DecisionComment)
	return r, err
}

// DecideOverride — решение по перехвату: возвращает ПОЛНУЮ обновлённую
// запись (как оригинал — `updated` из tx.batchOverrideRequest.update()),
// не только статус.
func DecideOverride(ctx context.Context, pool *pgxpool.Pool, requestID string, approve bool, comment string, userID string, roles []string) (models.BatchOverrideRequest, *string, error) {
	isDirectorOrAdmin := false
	for _, r := range roles {
		if r == "director" || r == "admin" {
			isDirectorOrAdmin = true
			break
		}
	}
	if !isDirectorOrAdmin {
		return models.BatchOverrideRequest{}, nil, &common.APIError403{Code: "DIRECTOR_ONLY", Message: "Перехват партии согласует директор"}
	}

	var reservationID, status, reason string
	err := pool.QueryRow(ctx, "SELECT reservation_id, status, reason FROM batch_override_requests WHERE id = $1", requestID).Scan(&reservationID, &status, &reason)
	if err == pgx.ErrNoRows {
		return models.BatchOverrideRequest{}, nil, &common.APIError404{Code: "NOT_FOUND", Message: "Запрос " + requestID + " не найден"}
	}
	if err != nil {
		return models.BatchOverrideRequest{}, nil, err
	}
	if status != "PENDING" {
		return models.BatchOverrideRequest{}, nil, &common.APIError400{Code: "ALREADY_DECIDED", Message: "Запрос уже " + status}
	}

	decidedByID := dbUserID(userID)
	newStatus := "REJECTED"
	if approve {
		newStatus = "APPROVED"
	}
	trimmedComment := strings.TrimSpace(comment)
	var decisionComment *string
	if trimmedComment != "" {
		decisionComment = &trimmedComment
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return models.BatchOverrideRequest{}, nil, err
	}
	defer tx.Rollback(ctx)

	now := time.Now().UTC()
	row := tx.QueryRow(ctx, `
		UPDATE batch_override_requests SET status = $1, decided_by_id = $2, decided_at = $3, decision_comment = $4
		WHERE id = $5 RETURNING `+batchOverrideRequestCols,
		newStatus, decidedByID, now, decisionComment, requestID)
	updated, err := scanOverrideRequest(row)
	if err != nil {
		return models.BatchOverrideRequest{}, nil, err
	}

	if !approve {
		if err := tx.Commit(ctx); err != nil {
			return models.BatchOverrideRequest{}, nil, err
		}
		return updated, nil, nil
	}

	releaseReasonText := reason
	if trimmedComment != "" {
		releaseReasonText = trimmedComment
	}
	releaseReason := "Перехват по решению директора: " + releaseReasonText
	if _, err := tx.Exec(ctx, `
		UPDATE batch_reservations SET status = 'OVERRIDDEN', released_at = $1, released_by_id = $2, release_reason = $3
		WHERE id = $4`, now, decidedByID, releaseReason, reservationID); err != nil {
		return models.BatchOverrideRequest{}, nil, err
	}

	var affectedCostingID *string
	if err := tx.QueryRow(ctx, "SELECT order_costing_id FROM batch_reservations WHERE id = $1", reservationID).Scan(&affectedCostingID); err != nil {
		return models.BatchOverrideRequest{}, nil, err
	}
	if affectedCostingID != nil {
		if _, err := tx.Exec(ctx, "UPDATE order_costings SET note = $1 WHERE id = $2",
			"Требует пересчёта: партия передана другому заказу по решению директора", *affectedCostingID); err != nil {
			return models.BatchOverrideRequest{}, nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return models.BatchOverrideRequest{}, nil, err
	}
	return updated, affectedCostingID, nil
}

// ExpireStale — фоновое снятие протухших резервов и предупреждения за N дней.
func ExpireStale(ctx context.Context, pool *pgxpool.Pool, nowMillis int64, warnDays int) (expiredCount, warnedCount int, err error) {
	rows, err := pool.Query(ctx, "SELECT id, batch_id, order_id, qty, status, expires_at FROM batch_reservations WHERE status = 'ACTIVE'")
	if err != nil {
		return 0, 0, err
	}
	var active []ReservationLike
	for rows.Next() {
		var r ReservationLike
		var expiresAt time.Time
		var status string
		if err := rows.Scan(&r.ID, &r.BatchID, &r.OrderID, &r.Qty, &status, &expiresAt); err != nil {
			rows.Close()
			return 0, 0, err
		}
		r.Status = ReservationStatus(status)
		r.ExpiresAt = expiresAt.UnixMilli()
		active = append(active, r)
	}
	rows.Close()

	expired, expiringSoon := ClassifyReservations(active, nowMillis, warnDays)
	if len(expired) > 0 {
		ids := make([]string, len(expired))
		for i, r := range expired {
			ids[i] = r.ID
		}
		now := time.UnixMilli(nowMillis).UTC()
		if _, err := pool.Exec(ctx, `
			UPDATE batch_reservations SET status = 'EXPIRED', released_at = $1,
			       release_reason = 'Заказ не ушёл в производство в срок — резерв снят автоматически'
			WHERE id = ANY($2)`, now, ids); err != nil {
			return 0, 0, err
		}
	}
	// events.emit('batch:reservation_expiring', { reservationId, orderId, expiresAt }) —
	// expiresAt у оригинала Date из Prisma → в JSON ISO с миллисекундами (PDate)
	for _, r := range expiringSoon {
		events.Emit("batch:reservation_expiring", map[string]interface{}{
			"reservationId": r.ID,
			"orderId":       r.OrderID,
			"expiresAt":     common.NewPDate(time.UnixMilli(r.ExpiresAt).UTC()),
		})
	}
	return len(expired), len(expiringSoon), nil
}
