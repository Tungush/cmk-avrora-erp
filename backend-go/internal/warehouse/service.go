// DB-обёртка над pricing.go — перенос material-batch.service.ts:
// BatchesOf/PriceFor (нужны order-costing), AnomalyReport/ClearAnomaly
// (карантин цены, 09 §4.5), ConsumeFifo/CreateFromMovement/
// CreateTollingReceipt (приход и списание партий). BackfillFromMovements
// (разовая идемпотентная миграция остатков) осознанно НЕ портирован.
package warehouse

import (
	"context"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/models"
)

const MaterialBatchCols = `id, material_id, warehouse_id, receipt_date, unit_price, qty_received, qty_remaining,
	supplier_name, document_number, source_movement_id, payment_document_id, origin, external_id,
	batch_type, owner_order_id, price_anomaly, anomaly_factor, anomaly_cleared_at, anomaly_cleared_by_id, created_at`

func ScanBatch(rows interface {
	Scan(dest ...interface{}) error
}) (models.MaterialBatch, error) {
	var b models.MaterialBatch
	err := rows.Scan(
		&b.ID, &b.MaterialID, &b.WarehouseID, &b.ReceiptDate, &b.UnitPrice, &b.QtyReceived, &b.QtyRemaining,
		&b.SupplierName, &b.DocumentNumber, &b.SourceMovementID, &b.PaymentDocumentID, &b.Origin, &b.ExternalID,
		&b.BatchType, &b.OwnerOrderID, &b.PriceAnomaly, &b.AnomalyFactor, &b.AnomalyClearedAt, &b.AnomalyClearedByID, &b.CreatedAt,
	)
	return b, err
}

// BatchesOf — партии материала, свежие сначала. Давальческие партии видит
// только заказ-владелец (forOrderID): чужой металл не должен даже
// показываться как доступный.
func BatchesOf(ctx context.Context, pool *pgxpool.Pool, materialID string, includeEmpty bool, forOrderID *string) ([]models.MaterialBatch, error) {
	sql := `SELECT ` + MaterialBatchCols + ` FROM material_batches WHERE material_id = $1`
	args := []interface{}{materialID}
	if !includeEmpty {
		sql += ` AND qty_remaining > 0`
	}
	if forOrderID != nil && *forOrderID != "" {
		args = append(args, *forOrderID)
		sql += ` AND (batch_type = 'OWN' OR (batch_type = 'TOLLING' AND owner_order_id = $2))`
	} else {
		sql += ` AND batch_type = 'OWN'`
	}
	sql += ` ORDER BY receipt_date DESC`

	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.MaterialBatch{}
	for rows.Next() {
		b, serr := ScanBatch(rows)
		if serr != nil {
			return nil, serr
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func toBatchLike(rows []models.MaterialBatch) []BatchLike {
	out := make([]BatchLike, len(rows))
	for i, b := range rows {
		unitPrice, _ := b.UnitPrice.Float64()
		qtyRemaining, _ := b.QtyRemaining.Float64()
		out[i] = BatchLike{
			ID: b.ID, ReceiptDate: b.ReceiptDate.Time.UnixMilli(), UnitPrice: unitPrice,
			QtyRemaining: qtyRemaining, PriceAnomaly: b.PriceAnomaly,
		}
	}
	return out
}

// PriceFor — цена под объём с раскладкой по партиям. Партий нет вовсе
// (материал ни разу не приходовали) — падаем на учётную цену справочника,
// иначе калькуляция обнулилась бы там, где раньше работала.
func PriceFor(ctx context.Context, pool *pgxpool.Pool, materialID string, req PriceRequest, forOrderID *string) (PriceResolution, error) {
	rows, err := BatchesOf(ctx, pool, materialID, true, forOrderID)
	if err != nil {
		return PriceResolution{}, err
	}
	batches := toBatchLike(rows)

	if len(batches) == 0 {
		var lastPurchasePrice, purchasePrice float64
		qerr := pool.QueryRow(ctx, "SELECT last_purchase_price, purchase_price FROM materials WHERE id = $1", materialID).
			Scan(&lastPurchasePrice, &purchasePrice)
		fallback := 0.0
		if qerr == nil {
			if lastPurchasePrice != 0 {
				fallback = lastPurchasePrice
			} else {
				fallback = purchasePrice
			}
		}
		if req.FallbackPrice == nil {
			req.FallbackPrice = &fallback
		}
		return ResolvePrice(nil, req)
	}
	return ResolvePrice(batches, req)
}

type AnomalyRow struct {
	BatchID        string          `json:"batchId"`
	Material       AnomalyMaterial `json:"material"`
	ReceiptDate    string          `json:"receiptDate"`
	UnitPrice      float64         `json:"unitPrice"`
	QtyRemaining   float64         `json:"qtyRemaining"`
	AnomalyFactor  *float64        `json:"anomalyFactor"`
	DocumentNumber *string         `json:"documentNumber"`
	SupplierName   *string         `json:"supplierName"`
	Hint           string          `json:"hint"`
}

type AnomalyMaterial struct {
	ID           string `json:"id"`
	MaterialCode string `json:"materialCode"`
	Name         string `json:"name"`
	Unit         string `json:"unit"`
}

// AnomalyReport — экран «Материалы с подозрительными ценами» (09 §4.5).
func AnomalyReport(ctx context.Context, pool *pgxpool.Pool) ([]AnomalyRow, error) {
	rows, err := pool.Query(ctx, `
		SELECT b.id, m.id, m.material_code, m.name, m.unit, b.receipt_date, b.unit_price, b.qty_remaining,
		       b.anomaly_factor, b.document_number, b.supplier_name
		FROM material_batches b JOIN materials m ON m.id = b.material_id
		WHERE b.price_anomaly = true AND b.anomaly_cleared_at IS NULL
		ORDER BY b.anomaly_factor DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AnomalyRow{}
	for rows.Next() {
		var r AnomalyRow
		var receiptDate time.Time
		if err := rows.Scan(&r.BatchID, &r.Material.ID, &r.Material.MaterialCode, &r.Material.Name, &r.Material.Unit,
			&receiptDate, &r.UnitPrice, &r.QtyRemaining, &r.AnomalyFactor, &r.DocumentNumber, &r.SupplierName); err != nil {
			return nil, err
		}
		r.ReceiptDate = receiptDate.UTC().Format("2006-01-02T15:04:05.000Z")
		r.Hint = "Похоже на разные единицы измерения в одной номенклатуре"
		out = append(out, r)
	}
	return out, rows.Err()
}

// ClearAnomaly — снабжение подтвердило цену, партия возвращается в автоподбор.
func ClearAnomaly(ctx context.Context, pool *pgxpool.Pool, batchID, userID string) (models.MaterialBatch, error) {
	now := time.Now().UTC()
	var clearedByID *string
	if userID != "" && !strings.HasPrefix(userID, "usr-") {
		clearedByID = &userID
	}
	row := pool.QueryRow(ctx, `
		UPDATE material_batches SET price_anomaly = false, anomaly_cleared_at = $1, anomaly_cleared_by_id = $2
		WHERE id = $3 RETURNING `+MaterialBatchCols, now, clearedByID, batchID)
	return ScanBatch(row)
}

const DefaultAnomalyThreshold = 5.0

type ConsumedBatch struct {
	BatchID string  `json:"batchId"`
	Qty     float64 `json:"qty"`
}

type FifoConsumption struct {
	Consumed     []ConsumedBatch `json:"consumed"`
	UncoveredQty float64         `json:"uncoveredQty"`
}

// ConsumeFifo — списание в производство расходует партии по FIFO, давальческий
// металл заказа — первым (он принесён под этот заказ, свой склад не трогаем,
// пока он есть). Непокрытый расход не гасится молча — виден в ответе.
func ConsumeFifo(ctx context.Context, pool *pgxpool.Pool, materialID string, qty float64, forOrderID *string) (FifoConsumption, error) {
	sql := `SELECT id, qty_remaining, batch_type FROM material_batches WHERE material_id = $1 AND qty_remaining > 0`
	args := []interface{}{materialID}
	if forOrderID != nil && *forOrderID != "" {
		args = append(args, *forOrderID)
		sql += ` AND (batch_type = 'OWN' OR (batch_type = 'TOLLING' AND owner_order_id = $2))`
	} else {
		sql += ` AND batch_type = 'OWN'`
	}
	sql += ` ORDER BY receipt_date ASC, id ASC`

	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return FifoConsumption{}, err
	}
	type row struct {
		ID           string
		QtyRemaining float64
		BatchType    string
	}
	var tolling, own []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.ID, &r.QtyRemaining, &r.BatchType); err != nil {
			rows.Close()
			return FifoConsumption{}, err
		}
		if r.BatchType == "TOLLING" {
			tolling = append(tolling, r)
		} else {
			own = append(own, r)
		}
	}
	rows.Close()
	ordered := append(tolling, own...)

	left := qty
	consumed := []ConsumedBatch{}
	for _, b := range ordered {
		if left <= 0 {
			break
		}
		take := math.Min(left, b.QtyRemaining)
		if take <= 0 {
			continue
		}
		if _, err := pool.Exec(ctx, "UPDATE material_batches SET qty_remaining = qty_remaining - $1 WHERE id = $2", take, b.ID); err != nil {
			return FifoConsumption{}, err
		}
		consumed = append(consumed, ConsumedBatch{BatchID: b.ID, Qty: take})
		left = round3(left - take)
	}
	uncovered := math.Max(0, left)
	return FifoConsumption{Consumed: consumed, UncoveredQty: uncovered}, nil
}

type CreateFromMovementInput struct {
	MovementID     string
	MaterialID     string
	Qty            float64
	UnitPrice      float64
	MovementDate   time.Time
	SupplierName   *string
	DocumentNumber *string
	BatchType      string // "" -> "OWN"
	OwnerOrderID   *string
}

// CreateFromMovement — партия из прихода. Идемпотентна по движению:
// повторная обработка того же документа из 1С не создаёт вторую партию.
func CreateFromMovement(ctx context.Context, pool *pgxpool.Pool, in CreateFromMovementInput, threshold float64) (models.MaterialBatch, error) {
	var existingID string
	err := pool.QueryRow(ctx, "SELECT id FROM material_batches WHERE source_movement_id = $1", in.MovementID).Scan(&existingID)
	if err == nil {
		row := pool.QueryRow(ctx, "SELECT "+MaterialBatchCols+" FROM material_batches WHERE id = $1", existingID)
		return ScanBatch(row)
	}
	if err != pgx.ErrNoRows {
		return models.MaterialBatch{}, err
	}

	isTolling := in.BatchType == "TOLLING"

	// Сравниваем с уже проверенными партиями: одна ошибка ввода не должна
	// утаскивать за собой оценку следующих. Давальческие с их нулевой ценой
	// в сравнении не участвуют и в карантин не попадают.
	var others []float64
	if !isTolling {
		rows, err := pool.Query(ctx, "SELECT unit_price FROM material_batches WHERE material_id = $1 AND price_anomaly = false AND batch_type = 'OWN'", in.MaterialID)
		if err != nil {
			return models.MaterialBatch{}, err
		}
		for rows.Next() {
			var p float64
			if err := rows.Scan(&p); err != nil {
				rows.Close()
				return models.MaterialBatch{}, err
			}
			others = append(others, p)
		}
		rows.Close()
	}
	anomaly := !isTolling && IsPriceAnomaly(in.UnitPrice, others, threshold)
	var anomalyFactorVal *float64
	if anomaly {
		if f, ok := AnomalyFactor(in.UnitPrice, others); ok {
			anomalyFactorVal = &f
		}
	}

	unitPrice := in.UnitPrice
	if isTolling {
		unitPrice = 0
	}
	batchType := in.BatchType
	if batchType == "" {
		batchType = "OWN"
	}
	var ownerOrderID *string
	if isTolling {
		ownerOrderID = in.OwnerOrderID
	}

	row := pool.QueryRow(ctx, `
		INSERT INTO material_batches
			(id, material_id, receipt_date, unit_price, qty_received, qty_remaining, supplier_name, document_number,
			 source_movement_id, batch_type, owner_order_id, price_anomaly, anomaly_factor)
		VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12)
		RETURNING `+MaterialBatchCols,
		uuid.NewString(), in.MaterialID, in.MovementDate, unitPrice, in.Qty, in.SupplierName, in.DocumentNumber,
		in.MovementID, batchType, ownerOrderID, anomaly, anomalyFactorVal)
	return ScanBatch(row)
}

type TollingReceiptInput struct {
	MaterialID     string
	OrderID        string
	Qty            float64
	ReceiptDate    *time.Time
	DocumentNumber *string
	SupplierName   *string
}

// CreateTollingReceipt — приход давальческого сырья вручную: пока не
// подтверждено, что 1С ведёт давальческий склад (счёт 002), кладовщик
// фиксирует его у нас. Партия принадлежит заказу, цена 0.
func CreateTollingReceipt(ctx context.Context, pool *pgxpool.Pool, in TollingReceiptInput) (models.MaterialBatch, error) {
	receiptDate := time.Now().UTC()
	if in.ReceiptDate != nil {
		receiptDate = *in.ReceiptDate
	}
	movementID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO material_stock_movements (id, item_id, movement_type, qty, unit_price, movement_date)
		VALUES ($1,$2,'приход',$3,0,$4)`,
		movementID, in.MaterialID, in.Qty, receiptDate); err != nil {
		return models.MaterialBatch{}, err
	}
	return CreateFromMovement(ctx, pool, CreateFromMovementInput{
		MovementID: movementID, MaterialID: in.MaterialID, Qty: in.Qty, UnitPrice: 0, MovementDate: receiptDate,
		SupplierName: in.SupplierName, DocumentNumber: in.DocumentNumber, BatchType: "TOLLING", OwnerOrderID: &in.OrderID,
	}, DefaultAnomalyThreshold)
}

type Shortage struct {
	MaterialID     string  `json:"materialId"`
	MaterialCode   string  `json:"materialCode"`
	Name           string  `json:"name"`
	Unit           string  `json:"unit"`
	Need           float64 `json:"need"`
	Available      float64 `json:"available"`
	Shortage       float64 `json:"shortage"`
	EstimatedPrice float64 `json:"estimatedPrice"`
}

type OrderAvailability struct {
	OK               bool       `json:"ok"`
	CheckedMaterials int        `json:"checkedMaterials"`
	Shortages        []Shortage `json:"shortages"`
	Note             *string    `json:"note,omitempty"`
}

// OrderMaterialAvailability — обеспеченность заказа сырьём, read-only:
// потребность = Σ BOM × qty (с суммированием по материалу), покрытие =
// живые партии без карантина минус ACTIVE-резервы чужих заказов.
func OrderMaterialAvailability(ctx context.Context, pool *pgxpool.Pool, orderID string) (OrderAvailability, error) {
	// Порядок вставки в need важен: сортировка ниже стабильна, и при равном
	// shortage×price (цена 0 у половины сырья) выигрывает порядок появления.
	// Prisma: позиции в физическом порядке order_lines, потом bomItems одной
	// выборкой WHERE article_id IN (...) — воспроизводим теми же двумя запросами.
	type line struct {
		qty       float64
		articleID string
	}
	lrows, err := pool.Query(ctx, `SELECT ol.qty, ol.article_id, a.is_material_resale FROM order_lines ol JOIN articles a ON a.id = ol.article_id
		WHERE ol.order_id = $1 AND ol.article_id IS NOT NULL`, orderID)
	if err != nil {
		return OrderAvailability{}, err
	}
	var lines []line
	var articleIDs []string
	seenArt := map[string]bool{}
	for lrows.Next() {
		var l line
		var resale bool
		if err := lrows.Scan(&l.qty, &l.articleID, &resale); err != nil {
			lrows.Close()
			return OrderAvailability{}, err
		}
		if resale {
			continue
		}
		lines = append(lines, l)
		if !seenArt[l.articleID] {
			seenArt[l.articleID] = true
			articleIDs = append(articleIDs, l.articleID)
		}
	}
	lrows.Close()
	type bomRow struct {
		materialID string
		perUnit    float64
	}
	bomByArticle := map[string][]bomRow{}
	if len(articleIDs) > 0 {
		brows, err := pool.Query(ctx, "SELECT article_id, material_id, qty_per_unit FROM bom_items WHERE article_id = ANY($1)", articleIDs)
		if err != nil {
			return OrderAvailability{}, err
		}
		for brows.Next() {
			var aid string
			var b bomRow
			if err := brows.Scan(&aid, &b.materialID, &b.perUnit); err != nil {
				brows.Close()
				return OrderAvailability{}, err
			}
			bomByArticle[aid] = append(bomByArticle[aid], b)
		}
		brows.Close()
	}
	need := map[string]float64{}
	var order []string
	for _, l := range lines {
		for _, b := range bomByArticle[l.articleID] {
			if _, ok := need[b.materialID]; !ok {
				order = append(order, b.materialID)
			}
			need[b.materialID] += b.perUnit * l.qty
		}
	}
	if len(need) == 0 {
		note := "У позиций заказа нет состава — проверять нечего"
		return OrderAvailability{OK: true, CheckedMaterials: 0, Shortages: []Shortage{}, Note: &note}, nil
	}
	avail := map[string]float64{}
	brows, err := pool.Query(ctx, `SELECT b.material_id, b.qty_remaining, coalesce((SELECT sum(r.qty) FROM batch_reservations r WHERE r.batch_id = b.id AND r.status = 'ACTIVE' AND r.order_id <> $2), 0)
		FROM material_batches b WHERE b.material_id = ANY($1) AND b.qty_remaining > 0 AND b.price_anomaly = false`, order, orderID)
	if err != nil {
		return OrderAvailability{}, err
	}
	for brows.Next() {
		var mid string
		var rem, reserved float64
		if err := brows.Scan(&mid, &rem, &reserved); err != nil {
			brows.Close()
			return OrderAvailability{}, err
		}
		avail[mid] += math.Max(0, rem-reserved)
	}
	brows.Close()
	type mat struct {
		Code, Name, Unit       string
		Purchase, LastPurchase float64
	}
	mats := map[string]mat{}
	mrows, err := pool.Query(ctx, "SELECT id, material_code, name, unit, purchase_price, last_purchase_price FROM materials WHERE id = ANY($1)", order)
	if err != nil {
		return OrderAvailability{}, err
	}
	for mrows.Next() {
		var id string
		var m mat
		if err := mrows.Scan(&id, &m.Code, &m.Name, &m.Unit, &m.Purchase, &m.LastPurchase); err != nil {
			mrows.Close()
			return OrderAvailability{}, err
		}
		mats[id] = m
	}
	mrows.Close()
	shortages := []Shortage{}
	for _, mid := range order {
		n := need[mid]
		a := avail[mid]
		if a+1e-9 >= n {
			continue
		}
		m, ok := mats[mid]
		s := Shortage{MaterialID: mid, MaterialCode: "—", Name: "—", Unit: "шт", Need: round3(n), Available: round3(a), Shortage: round3(n - a)}
		if ok {
			s.MaterialCode, s.Name, s.Unit, s.EstimatedPrice = m.Code, m.Name, m.Unit, m.LastPurchase
		}
		shortages = append(shortages, s)
	}
	sortShortages(shortages)
	return OrderAvailability{OK: len(shortages) == 0, CheckedMaterials: len(need), Shortages: shortages}, nil
}
