// Перенос material-receipt.service.ts + нужный кусок cascade-recalc.service.ts
// (enqueueMaterialPriceRecalc → recalcBomCostsByMaterial → recalcArticleCost).
// Приход материала — единая точка для ручного ввода кладовщиком.
package warehouse

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/costing"
)

func mustJSON(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}

// cascadeUserID — createAuditLog в оригинале: userId только если
// triggeredBy не пуст и не литерал 'system' (тот же смысл, что dbUserID
// для usr-*, плюс ещё один зарезервированный случай).
func cascadeUserID(triggeredBy string) *string {
	if triggeredBy == "" || triggeredBy == "system" {
		return nil
	}
	return dbUserID(triggeredBy)
}

type ReceiptInput struct {
	MaterialID     string
	Qty            float64
	UnitPrice      float64
	MovementDate   *time.Time
	SupplierName   *string
	DocumentNumber *string
	Comment        *string
}

type ReceiptResult struct {
	MovementID         string
	MaterialID         string
	MaterialCode       string
	MaterialName       string
	MaterialUnit       string
	StockQtyAfter      float64
	PriceBefore        float64
	PriceAfter         float64
	PriceReceipt       float64
	PriceChanged       bool
	BatchID            string
	BatchUnitPrice     float64
	BatchQtyRemaining  float64
	BatchPriceAnomaly  bool
	BatchAnomalyFactor *float64
	AffectedArticles   int
	RecalcJobID        *string
	RecalcStatus       *string
}

// Receive — приход материала: остаток + средневзвешенная цена + партия +
// (асинхронный, fire-and-forget, как в оригинале — setTimeout(0)) каскад
// в себестоимость всех изделий, где материал используется в BOM.
func Receive(ctx context.Context, pool *pgxpool.Pool, in ReceiptInput, userID string) (ReceiptResult, error) {
	if !(in.Qty > 0) {
		return ReceiptResult{}, &common.APIError400{Code: "INVALID_QTY", Message: "Количество должно быть > 0"}
	}
	if !(in.UnitPrice >= 0) {
		return ReceiptResult{}, &common.APIError400{Code: "INVALID_PRICE", Message: "Цена не может быть отрицательной"}
	}

	var materialCode, materialName, unit string
	var stockQty, purchasePrice float64
	err := pool.QueryRow(ctx, "SELECT material_code, name, unit, stock_qty, purchase_price FROM materials WHERE id = $1", in.MaterialID).
		Scan(&materialCode, &materialName, &unit, &stockQty, &purchasePrice)
	if err == pgx.ErrNoRows {
		return ReceiptResult{}, &common.APIError404{Code: "NOT_FOUND", Message: "Material " + in.MaterialID + " not found"}
	}
	if err != nil {
		return ReceiptResult{}, err
	}

	stockBefore := stockQty
	priceBefore := purchasePrice
	// При нулевом/отрицательном остатке средневзвешенная не имеет смысла — берём цену прихода
	newAvgPrice := in.UnitPrice
	if stockBefore > 0 {
		newAvgPrice = round2(((stockBefore*priceBefore + in.Qty*in.UnitPrice) / (stockBefore + in.Qty)))
	}
	movementDate := time.Now().UTC()
	if in.MovementDate != nil {
		movementDate = *in.MovementDate
	}

	movementID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO material_stock_movements (id, item_id, movement_type, qty, unit_price, movement_date, supplier_name, document_number, comment)
		VALUES ($1,$2,'приход',$3,$4,$5,$6,$7,$8)`,
		movementID, in.MaterialID, in.Qty, in.UnitPrice, movementDate, in.SupplierName, in.DocumentNumber, in.Comment); err != nil {
		return ReceiptResult{}, err
	}
	newStockQty := stockBefore + in.Qty
	if _, err := pool.Exec(ctx, `
		UPDATE materials SET stock_qty = $1, purchase_price = $2, purchase_price_updated_at = $3,
		       last_purchase_price = $4, last_purchase_date = $5
		WHERE id = $6`,
		newStockQty, newAvgPrice, movementDate, in.UnitPrice, movementDate, in.MaterialID); err != nil {
		return ReceiptResult{}, err
	}

	// Приход — это партия со своей ценой и живым остатком (09 §4.1)
	batch, err := CreateFromMovement(ctx, pool, CreateFromMovementInput{
		MovementID: movementID, MaterialID: in.MaterialID, Qty: in.Qty, UnitPrice: in.UnitPrice, MovementDate: movementDate,
		SupplierName: in.SupplierName, DocumentNumber: in.DocumentNumber,
	}, DefaultAnomalyThreshold)
	if err != nil {
		return ReceiptResult{}, err
	}

	// Сколько изделий заденет пересчёт — видно сразу тому, кто заносит приход
	var affectedArticles int
	if err := pool.QueryRow(ctx, "SELECT count(DISTINCT article_id) FROM bom_items WHERE material_id = $1", in.MaterialID).Scan(&affectedArticles); err != nil {
		return ReceiptResult{}, err
	}

	var recalcJobID, recalcStatus *string
	if newAvgPrice != priceBefore && affectedArticles > 0 {
		jobID := uuid.NewString()
		status := "queued"
		recalcJobID, recalcStatus = &jobID, &status
		// Fire-and-forget — как оригинал (setTimeout(0)): ответ уходит клиенту
		// раньше, чем кончится пересчёт. Собственный контекст, не контекст запроса.
		go recalcBomCostsByMaterial(pool, in.MaterialID, userID)
	}

	batchUnitPrice, _ := batch.UnitPrice.Float64()
	batchQtyRemaining, _ := batch.QtyRemaining.Float64()
	var anomalyFactor *float64
	if batch.AnomalyFactor != nil {
		v, _ := batch.AnomalyFactor.Float64()
		anomalyFactor = &v
	}

	return ReceiptResult{
		MovementID: movementID, MaterialID: in.MaterialID, MaterialCode: materialCode, MaterialName: materialName,
		MaterialUnit: unit, StockQtyAfter: newStockQty, PriceBefore: priceBefore, PriceAfter: newAvgPrice,
		PriceReceipt: in.UnitPrice, PriceChanged: newAvgPrice != priceBefore, BatchID: batch.ID,
		BatchUnitPrice: batchUnitPrice, BatchQtyRemaining: batchQtyRemaining, BatchPriceAnomaly: batch.PriceAnomaly,
		BatchAnomalyFactor: anomalyFactor, AffectedArticles: affectedArticles, RecalcJobID: recalcJobID, RecalcStatus: recalcStatus,
	}, nil
}

// recalcBomCostsByMaterial — перенос CascadeRecalcService.recalcBomCostsByMaterial:
// пересчитать line_cost всех BOM-строк с этим материалом + точечный
// ArticleCostingService.recalculate на каждое затронутое изделие.
func recalcBomCostsByMaterial(pool *pgxpool.Pool, materialID, triggeredBy string) {
	ctx := context.Background()
	var purchasePrice float64
	if err := pool.QueryRow(ctx, "SELECT purchase_price FROM materials WHERE id = $1", materialID).Scan(&purchasePrice); err != nil {
		log.Printf("[cascade] material %s not found: %v", materialID, err)
		return
	}

	rows, err := pool.Query(ctx, "SELECT id, article_id, qty_per_unit FROM bom_items WHERE material_id = $1", materialID)
	if err != nil {
		log.Printf("[cascade] read bom_items for material %s: %v", materialID, err)
		return
	}
	type bomRow struct {
		ID         string
		ArticleID  string
		QtyPerUnit float64
	}
	var items []bomRow
	articleSet := map[string]bool{}
	for rows.Next() {
		var b bomRow
		if err := rows.Scan(&b.ID, &b.ArticleID, &b.QtyPerUnit); err != nil {
			rows.Close()
			log.Printf("[cascade] scan bom_items: %v", err)
			return
		}
		items = append(items, b)
		articleSet[b.ArticleID] = true
	}
	rows.Close()

	for _, b := range items {
		lineCost := round2(b.QtyPerUnit * purchasePrice)
		if _, err := pool.Exec(ctx, "UPDATE bom_items SET line_cost = $1 WHERE id = $2", lineCost, b.ID); err != nil {
			log.Printf("[cascade] update bom_item %s: %v", b.ID, err)
			return
		}
	}

	for articleID := range articleSet {
		result, err := costing.Recalculate(ctx, pool, articleID, "bom_change", triggeredBy)
		if err != nil {
			log.Printf("[cascade] recalc article %s: %v", articleID, err)
			continue
		}
		auditUserID := cascadeUserID(triggeredBy)
		if _, err := pool.Exec(ctx, `
			INSERT INTO audit_log (id, entity_type, entity_id, action, after, user_id, user_role, comment)
			VALUES ($1,'Article',$2,'RECALC_ARTICLE_COST',$3,$4,'system',$5)`,
			uuid.NewString(), articleID,
			mustJSON(map[string]interface{}{"specPrice": result.Price, "totalCost": result.TotalCost}),
			auditUserID, "Triggered by "+triggeredBy); err != nil {
			log.Printf("[cascade] audit log for article %s: %v", articleID, err)
		}
	}

	materialCode := ""
	_ = pool.QueryRow(ctx, "SELECT material_code FROM materials WHERE id = $1", materialID).Scan(&materialCode)
	articleIDs := make([]string, 0, len(articleSet))
	for id := range articleSet {
		articleIDs = append(articleIDs, id)
	}
	auditUserID := cascadeUserID(triggeredBy)
	if _, err := pool.Exec(ctx, `
		INSERT INTO audit_log (id, entity_type, entity_id, action, after, user_id, user_role, comment)
		VALUES ($1,'Material',$2,'RECALC_BOM_COSTS',$3,$4,'system',$5)`,
		uuid.NewString(), materialID,
		mustJSON(map[string]interface{}{"materialCode": materialCode, "affectedArticleIds": articleIDs}),
		auditUserID, "Triggered by "+triggeredBy); err != nil {
		log.Printf("[cascade] audit log for material %s: %v", materialID, err)
	}
}
