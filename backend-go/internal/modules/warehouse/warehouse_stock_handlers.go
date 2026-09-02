// Вторая половина warehouse.controller.ts: остатки материалов, приход,
// история движений, склад ГП, журнал приходов, давальческое сырьё,
// справочник складов, списание в производство, остатки/движения ГП.
package warehouse

import (
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
	wh "cmk-avrora-erp/backend-go/internal/warehouse"
)

func pageParams(c *gin.Context, defaultSize int) (page, pageSize int) {
	page, _ = strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ = strconv.Atoi(c.Query("pageSize"))
	if pageSize < 1 {
		pageSize = defaultSize
	}
	return page, pageSize
}

// GetMaterialBalance — GET /warehouse/materials/balance — остатки (плоский массив, без meta).
func (h *WarehouseHandler) GetMaterialBalance(c *gin.Context) {
	page, pageSize := pageParams(c, 100)
	where := "WHERE 1=1"
	args := []interface{}{}
	if cat := c.Query("category"); cat != "" {
		args = append(args, models.CategoryAPIToDB(cat))
		where += " AND category = $" + strconv.Itoa(len(args))
	}
	if search := c.Query("search"); search != "" {
		args = append(args, "%"+search+"%")
		where += " AND (name ILIKE $" + strconv.Itoa(len(args)) + " OR material_code ILIKE $" + strconv.Itoa(len(args)) + ")"
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := h.pool.Query(c.Request.Context(),
		"SELECT id, material_code, name, category, unit, stock_qty, purchase_price FROM materials "+where+
			" ORDER BY name ASC LIMIT $"+strconv.Itoa(len(args)-1)+" OFFSET $"+strconv.Itoa(len(args)), args...)
	if err != nil {
		respondErr(c, err)
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, code, name, category, unit string
		var stockQty, purchasePrice float64
		if err := rows.Scan(&id, &code, &name, &category, &unit, &stockQty, &purchasePrice); err != nil {
			respondErr(c, err)
			return
		}
		out = append(out, gin.H{
			"materialId": id, "materialCode": code, "name": name, "category": models.CategoryDBToAPI(category),
			"unit": unit, "stockQty": stockQty, "purchasePrice": purchasePrice, "totalValue": stockQty * purchasePrice,
		})
	}
	c.JSON(http.StatusOK, out)
}

const movementCols = `id, item_id, warehouse_id, movement_type, qty, unit_price, movement_date, project,
	source_document_id, supplier_name, document_number, comment, created_at`

func scanMovement(row pgx.Row) (models.MaterialStockMovement, error) {
	var m models.MaterialStockMovement
	var mt string
	err := row.Scan(&m.ID, &m.ItemID, &m.WarehouseID, &mt, &m.Qty, &m.UnitPrice, &m.MovementDate, &m.Project,
		&m.SourceDocumentID, &m.SupplierName, &m.DocumentNumber, &m.Comment, &m.CreatedAt)
	m.MovementType = models.StockMovementTypeDBToAPI(mt)
	return m, err
}

type receiptBody struct {
	MaterialID     string  `json:"materialId"`
	Qty            float64 `json:"qty"`
	UnitPrice      float64 `json:"unitPrice"`
	MovementDate   *string `json:"movementDate"`
	SupplierName   *string `json:"supplierName"`
	DocumentNumber *string `json:"documentNumber"`
	Comment        *string `json:"comment"`
}

func trimPtr(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		return nil
	}
	return &t
}

func parseDatePtr(s *string) *time.Time {
	if s == nil || *s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02"} {
		if t, err := time.Parse(layout, *s); err == nil {
			t = t.UTC()
			return &t
		}
	}
	return nil
}

// PostMaterialReceipt — POST /warehouse/materials/receipt (warehouse_material/procurement/admin).
func (h *WarehouseHandler) PostMaterialReceipt(c *gin.Context) {
	var body receiptBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	user := authpkg.CurrentUser(c)
	ctx := c.Request.Context()
	res, err := wh.Receive(ctx, h.pool, wh.ReceiptInput{
		MaterialID: body.MaterialID, Qty: body.Qty, UnitPrice: body.UnitPrice, MovementDate: parseDatePtr(body.MovementDate),
		SupplierName: trimPtr(body.SupplierName), DocumentNumber: trimPtr(body.DocumentNumber), Comment: trimPtr(body.Comment),
	}, user.UserID)
	if err != nil {
		respondErr(c, err)
		return
	}
	movement, err := scanMovement(h.pool.QueryRow(ctx, "SELECT "+movementCols+" FROM material_stock_movements WHERE id = $1", res.MovementID))
	if err != nil {
		respondErr(c, err)
		return
	}
	var recalculation interface{}
	if res.RecalcJobID != nil {
		recalculation = gin.H{"jobId": *res.RecalcJobID, "status": *res.RecalcStatus}
	}
	c.JSON(http.StatusCreated, gin.H{
		"movement": movement,
		"material": gin.H{"id": res.MaterialID, "materialCode": res.MaterialCode, "name": res.MaterialName, "unit": res.MaterialUnit, "stockQty": res.StockQtyAfter},
		"price":    gin.H{"before": res.PriceBefore, "after": res.PriceAfter, "receipt": res.PriceReceipt, "changed": res.PriceChanged},
		"batch": gin.H{"id": res.BatchID, "unitPrice": res.BatchUnitPrice, "qtyRemaining": res.BatchQtyRemaining,
			"priceAnomaly": res.BatchPriceAnomaly, "anomalyFactor": res.BatchAnomalyFactor},
		"affectedArticles": res.AffectedArticles,
		"recalculation":    recalculation,
	})
}

// GetMaterialMovements — GET /warehouse/materials/:id/movements — история цены закупа,
// два источника (ручные движения + партии 1С) слиты в одну ленту.
func (h *WarehouseHandler) GetMaterialMovements(c *gin.Context) {
	id := c.Param("id")
	take, _ := strconv.Atoi(c.Query("limit"))
	if take < 1 {
		take = 50
	}
	ctx := c.Request.Context()
	type row struct {
		Out  gin.H
		Date time.Time
	}
	var all []row

	mrows, err := h.pool.Query(ctx, "SELECT id, movement_date, qty, unit_price, document_number, supplier_name, comment FROM material_stock_movements WHERE item_id = $1 ORDER BY movement_date DESC, created_at DESC LIMIT $2", id, take)
	if err != nil {
		respondErr(c, err)
		return
	}
	for mrows.Next() {
		var mid string
		var d time.Time
		var qty, price decimal.Decimal
		var doc, sup, comment *string
		if err := mrows.Scan(&mid, &d, &qty, &price, &doc, &sup, &comment); err != nil {
			mrows.Close()
			respondErr(c, err)
			return
		}
		all = append(all, row{Date: d, Out: gin.H{"id": mid, "movementDate": common.NewPDate(d), "qty": qty, "unitPrice": price,
			"documentNumber": doc, "supplierName": sup, "comment": comment, "origin": "MOVEMENT", "priceAnomaly": false}})
	}
	mrows.Close()

	brows, err := h.pool.Query(ctx, "SELECT id, receipt_date, qty_received, unit_price, document_number, supplier_name, origin, price_anomaly FROM material_batches WHERE material_id = $1 ORDER BY receipt_date DESC LIMIT $2", id, take)
	if err != nil {
		respondErr(c, err)
		return
	}
	for brows.Next() {
		var bid, origin string
		var d time.Time
		var qty, price decimal.Decimal
		var doc, sup *string
		var anomaly bool
		if err := brows.Scan(&bid, &d, &qty, &price, &doc, &sup, &origin, &anomaly); err != nil {
			brows.Close()
			respondErr(c, err)
			return
		}
		var comment *string
		if origin == "INVENTORY" {
			s := "Стартовый остаток (инвентаризация)"
			comment = &s
		}
		all = append(all, row{Date: d, Out: gin.H{"id": bid, "movementDate": common.NewPDate(d), "qty": qty, "unitPrice": price,
			"documentNumber": doc, "supplierName": sup, "comment": comment, "origin": origin, "priceAnomaly": anomaly}})
	}
	brows.Close()

	sort.SliceStable(all, func(i, j int) bool { return all[i].Date.After(all[j].Date) })
	if len(all) > take {
		all = all[:take]
	}
	out := make([]gin.H, len(all))
	for i, r := range all {
		out[i] = r.Out
	}
	c.JSON(http.StatusOK, out)
}

// GetFinishedGoods — GET /warehouse/finished-goods — движения ГП.
func (h *WarehouseHandler) GetFinishedGoods(c *gin.Context) {
	page, pageSize := pageParams(c, 100)
	ctx := c.Request.Context()
	var total int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM finished_goods_movements").Scan(&total); err != nil {
		respondErr(c, err)
		return
	}
	rows, err := h.pool.Query(ctx, `
		SELECT f.id, f.item_id, f.order_id, f.movement_type, f.qty, f.unit_price, f.movement_date, f.project, f.source_document_id,
		       a.article_code, a.name, o.order_number
		FROM finished_goods_movements f
		JOIN articles a ON a.id = f.item_id
		LEFT JOIN orders o ON o.id = f.order_id
		ORDER BY f.movement_date DESC LIMIT $1 OFFSET $2`, pageSize, (page-1)*pageSize)
	if err != nil {
		respondErr(c, err)
		return
	}
	defer rows.Close()
	data := []gin.H{}
	for rows.Next() {
		var m models.FinishedGoodsMovement
		var mt, articleCode, articleName string
		var orderNumber *string
		if err := rows.Scan(&m.ID, &m.ItemID, &m.OrderID, &mt, &m.Qty, &m.UnitPrice, &m.MovementDate, &m.Project, &m.SourceDocumentID,
			&articleCode, &articleName, &orderNumber); err != nil {
			respondErr(c, err)
			return
		}
		var order interface{}
		if orderNumber != nil {
			order = gin.H{"orderNumber": *orderNumber}
		}
		data = append(data, gin.H{
			"id": m.ID, "itemId": m.ItemID, "orderId": m.OrderID, "movementType": models.StockMovementTypeDBToAPI(mt),
			"qty": m.Qty, "unitPrice": m.UnitPrice, "movementDate": m.MovementDate, "project": m.Project,
			"sourceDocumentId": m.SourceDocumentID, "article": gin.H{"articleCode": articleCode, "name": articleName}, "order": order,
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "meta": gin.H{"page": page, "pageSize": pageSize, "total": total}})
}

// GetReceipts — GET /warehouse/receipts — журнал приходов (ручные + из 1С).
func (h *WarehouseHandler) GetReceipts(c *gin.Context) {
	page, pageSize := pageParams(c, 50)
	search := strings.TrimSpace(c.Query("search"))
	ctx := c.Request.Context()
	type row struct {
		Out  gin.H
		Date time.Time
	}
	var all []row

	msql := `SELECT s.id, s.movement_date, s.qty, s.unit_price, s.document_number, s.supplier_name,
		m.material_code, m.name, m.unit, m.category
		FROM material_stock_movements s JOIN materials m ON m.id = s.item_id WHERE s.movement_type = 'приход'`
	bsql := `SELECT b.id, b.receipt_date, b.qty_received, b.unit_price, b.document_number, b.supplier_name,
		m.material_code, m.name, m.unit, m.category, b.payment_document_id
		FROM material_batches b JOIN materials m ON m.id = b.material_id WHERE b.origin = 'ONEC'`
	var margs, bargs []interface{}
	if search != "" {
		like := "%" + search + "%"
		margs = append(margs, like)
		bargs = append(bargs, like)
		filter := " AND (m.name ILIKE $1 OR m.material_code ILIKE $1 OR %s.supplier_name ILIKE $1 OR %s.document_number ILIKE $1)"
		msql += strings.ReplaceAll(filter, "%s", "s")
		bsql += strings.ReplaceAll(filter, "%s", "b")
	}
	msql += " ORDER BY s.movement_date DESC, s.created_at DESC LIMIT 1000"
	bsql += " ORDER BY b.receipt_date DESC LIMIT 1000"

	mrows, err := h.pool.Query(ctx, msql, margs...)
	if err != nil {
		respondErr(c, err)
		return
	}
	for mrows.Next() {
		var id, code, name, unit, category string
		var d time.Time
		var qty, price decimal.Decimal
		var doc, sup *string
		if err := mrows.Scan(&id, &d, &qty, &price, &doc, &sup, &code, &name, &unit, &category); err != nil {
			mrows.Close()
			respondErr(c, err)
			return
		}
		all = append(all, row{Date: d, Out: gin.H{"id": id, "movementDate": common.NewPDate(d), "qty": qty, "unitPrice": price,
			"documentNumber": doc, "supplierName": sup,
			"material": gin.H{"materialCode": code, "name": name, "unit": unit, "category": models.CategoryDBToAPI(category)},
			"origin":   "MOVEMENT", "paymentDocumentId": nil}})
	}
	mrows.Close()

	brows, err := h.pool.Query(ctx, bsql, bargs...)
	if err != nil {
		respondErr(c, err)
		return
	}
	for brows.Next() {
		var id, code, name, unit, category string
		var d time.Time
		var qty, price decimal.Decimal
		var doc, sup, pd *string
		if err := brows.Scan(&id, &d, &qty, &price, &doc, &sup, &code, &name, &unit, &category, &pd); err != nil {
			brows.Close()
			respondErr(c, err)
			return
		}
		all = append(all, row{Date: d, Out: gin.H{"id": id, "movementDate": common.NewPDate(d), "qty": qty, "unitPrice": price,
			"documentNumber": doc, "supplierName": sup,
			"material": gin.H{"materialCode": code, "name": name, "unit": unit, "category": models.CategoryDBToAPI(category)},
			"origin":   "ONEC", "paymentDocumentId": pd}})
	}
	brows.Close()

	sort.SliceStable(all, func(i, j int) bool { return all[i].Date.After(all[j].Date) })
	total := len(all)
	start := (page - 1) * pageSize
	if start > total {
		start = total
	}
	end := start + pageSize
	if end > total {
		end = total
	}
	data := make([]gin.H, 0, end-start)
	for _, r := range all[start:end] {
		data = append(data, r.Out)
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "meta": gin.H{"page": page, "pageSize": pageSize, "total": total}})
}

type tollingBody struct {
	MaterialID     string  `json:"materialId"`
	OrderID        string  `json:"orderId"`
	Qty            float64 `json:"qty"`
	ReceiptDate    *string `json:"receiptDate"`
	DocumentNumber *string `json:"documentNumber"`
	SupplierName   *string `json:"supplierName"`
}

// PostTollingReceipt — POST /warehouse/materials/tolling-receipt (warehouse_material/admin).
func (h *WarehouseHandler) PostTollingReceipt(c *gin.Context) {
	var body tollingBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	var x string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM materials WHERE id = $1", body.MaterialID).Scan(&x); err == pgx.ErrNoRows {
		common.NotFound(c, "Material "+body.MaterialID+" not found")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	if err := h.pool.QueryRow(ctx, "SELECT id FROM orders WHERE id = $1", body.OrderID).Scan(&x); err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+body.OrderID+" not found")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	qty := math.Abs(body.Qty)
	if _, err := h.pool.Exec(ctx, "UPDATE materials SET stock_qty = stock_qty + $1 WHERE id = $2", qty, body.MaterialID); err != nil {
		respondErr(c, err)
		return
	}
	batch, err := wh.CreateTollingReceipt(ctx, h.pool, wh.TollingReceiptInput{
		MaterialID: body.MaterialID, OrderID: body.OrderID, Qty: qty, ReceiptDate: parseDatePtr(body.ReceiptDate),
		DocumentNumber: body.DocumentNumber, SupplierName: body.SupplierName,
	})
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, batch)
}

// Warehouses — GET /warehouse/warehouses — справочник складов, ЦМК первыми.
func (h *WarehouseHandler) Warehouses(c *gin.Context) {
	sql := "SELECT id, name, division FROM warehouses WHERE is_deleted = false"
	args := []interface{}{}
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		args = append(args, "%"+search+"%")
		sql += " AND name ILIKE $1"
	}
	sql += " ORDER BY name ASC"
	rows, err := h.pool.Query(c.Request.Context(), sql, args...)
	if err != nil {
		respondErr(c, err)
		return
	}
	defer rows.Close()
	type whRow struct {
		ID       string  `json:"id"`
		Name     string  `json:"name"`
		Division *string `json:"division"`
	}
	out := []whRow{}
	for rows.Next() {
		var w whRow
		if err := rows.Scan(&w.ID, &w.Name, &w.Division); err != nil {
			respondErr(c, err)
			return
		}
		out = append(out, w)
	}
	// JS: Number(isCmk(b)) - Number(isCmk(a)) || a.name.localeCompare(b.name).
	// localeCompare — ICU-коллация (строчная «п» раньше заглавной «П» при
	// равной базе), а не порядок Postgres ORDER BY — найдено диффом.
	isCmk := func(n string) bool { return strings.Contains(n, "74п") || strings.Contains(n, "ЦМК") }
	col := collate.New(language.Und)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := isCmk(out[i].Name), isCmk(out[j].Name)
		if a != b {
			return a
		}
		return col.CompareString(out[i].Name, out[j].Name) < 0
	})
	c.JSON(http.StatusOK, out)
}

// PostMaterialMovement — POST /warehouse/materials/movements (warehouse_material/admin):
// только списание; приход — из 1С. Три шага без общей транзакции — как в оригинале.
func (h *WarehouseHandler) PostMaterialMovement(c *gin.Context) {
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	materialID, _ := body["materialId"].(string)
	var matPurchasePrice decimal.Decimal
	var matCode, matName string
	if err := h.pool.QueryRow(ctx, "SELECT purchase_price, material_code, name FROM materials WHERE id = $1", materialID).Scan(&matPurchasePrice, &matCode, &matName); err == pgx.ErrNoRows {
		common.NotFound(c, "Material "+materialID+" not found")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	movementType, _ := body["movementType"].(string)
	isExpense := movementType == "EXPENSE" || movementType == "TO_PRODUCTION"
	if !isExpense {
		common.BadRequest(c, "RECEIPT_COMES_FROM_1C", "Приход материала не заводится руками — он приходит из «Заказа поставщику» 1С с фактической ценой")
		return
	}
	qty, _ := body["qty"].(float64)
	absQty := math.Abs(qty)

	var warehouseID *string
	var warehouseName *string
	if wid, ok := body["warehouseId"].(string); ok && wid != "" {
		var name string
		if err := h.pool.QueryRow(ctx, "SELECT name FROM warehouses WHERE id = $1", wid).Scan(&name); err == pgx.ErrNoRows {
			common.NotFound(c, "Склад не найден")
			return
		} else if err != nil {
			respondErr(c, err)
			return
		}
		warehouseID, warehouseName = &wid, &name
	}

	unitPrice := matPurchasePrice
	if up, ok := body["unitPrice"].(float64); ok && up != 0 {
		unitPrice = decimal.NewFromFloat(up)
	}
	movementDate := time.Now().UTC()
	if md, ok := body["movementDate"].(string); ok && md != "" {
		if t := parseDatePtr(&md); t != nil {
			movementDate = *t
		}
	}
	var project *string
	if p, ok := body["project"].(string); ok && p != "" {
		project = &p
	}

	id := uuid.NewString()
	if _, err := h.pool.Exec(ctx, `
		INSERT INTO material_stock_movements (id, item_id, warehouse_id, movement_type, qty, unit_price, movement_date, project)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		id, materialID, warehouseID, models.StockMovementTypeAPIToDB(movementType), absQty, unitPrice, movementDate, project); err != nil {
		respondErr(c, err)
		return
	}
	movement, err := scanMovement(h.pool.QueryRow(ctx, "SELECT "+movementCols+" FROM material_stock_movements WHERE id = $1", id))
	if err != nil {
		respondErr(c, err)
		return
	}
	if _, err := h.pool.Exec(ctx, "UPDATE materials SET stock_qty = stock_qty + $1 WHERE id = $2", -absQty, materialID); err != nil {
		respondErr(c, err)
		return
	}
	var forOrderID *string
	if oid, ok := body["orderId"].(string); ok && oid != "" {
		forOrderID = &oid
	}
	consumption, err := wh.ConsumeFifo(ctx, h.pool, materialID, absQty, forOrderID)
	if err != nil {
		respondErr(c, err)
		return
	}
	var warehouse interface{}
	if warehouseName != nil {
		warehouse = gin.H{"name": *warehouseName}
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": movement.ID, "itemId": movement.ItemID, "warehouseId": movement.WarehouseID, "movementType": movement.MovementType,
		"qty": movement.Qty, "unitPrice": movement.UnitPrice, "movementDate": movement.MovementDate, "project": movement.Project,
		"sourceDocumentId": movement.SourceDocumentID, "supplierName": movement.SupplierName, "documentNumber": movement.DocumentNumber,
		"comment": movement.Comment, "createdAt": movement.CreatedAt,
		"warehouse": warehouse, "material": gin.H{"materialCode": matCode, "name": matName},
		"batchConsumption": consumption,
	})
}

// GetFGBalance — GET /warehouse/finished-goods/balance — остатки ГП по движениям.
func (h *WarehouseHandler) GetFGBalance(c *gin.Context) {
	page, pageSize := pageParams(c, 100)
	ctx := c.Request.Context()
	rows, err := h.pool.Query(ctx, "SELECT item_id, movement_type, sum(qty), max(movement_date) FROM finished_goods_movements GROUP BY item_id, movement_type")
	if err != nil {
		respondErr(c, err)
		return
	}
	plus := map[string]bool{"RECEIPT": true, "FROM_PRODUCTION": true, "RETURN": true}
	minus := map[string]bool{"EXPENSE": true, "TO_PRODUCTION": true, "SHIPMENT": true}
	type acc struct {
		Qty  float64
		Last *time.Time
	}
	byItem := map[string]*acc{}
	for rows.Next() {
		var itemID, mt string
		var sum float64
		var last *time.Time
		if err := rows.Scan(&itemID, &mt, &sum, &last); err != nil {
			rows.Close()
			respondErr(c, err)
			return
		}
		cur, ok := byItem[itemID]
		if !ok {
			cur = &acc{}
			byItem[itemID] = cur
		}
		t := models.StockMovementTypeDBToAPI(mt)
		if plus[t] {
			cur.Qty += sum
		} else if minus[t] {
			cur.Qty -= sum
		} else {
			cur.Qty += sum
		}
		if last != nil && (cur.Last == nil || last.After(*cur.Last)) {
			cur.Last = last
		}
	}
	rows.Close()
	if len(byItem) == 0 {
		c.JSON(http.StatusOK, gin.H{"data": []interface{}{}, "totalValue": 0})
		return
	}
	ids := make([]string, 0, len(byItem))
	for id := range byItem {
		ids = append(ids, id)
	}
	arows, err := h.pool.Query(ctx, "SELECT id, article_code, name, approved_price FROM articles WHERE id = ANY($1)", ids)
	if err != nil {
		respondErr(c, err)
		return
	}
	type rowT struct {
		ArticleID, ArticleCode, Name   string
		StockQty, ApprovedPrice, Value float64
		Last                           *time.Time
	}
	var list []rowT
	search := strings.ToLower(strings.TrimSpace(c.Query("search")))
	for arows.Next() {
		var r rowT
		if err := arows.Scan(&r.ArticleID, &r.ArticleCode, &r.Name, &r.ApprovedPrice); err != nil {
			arows.Close()
			respondErr(c, err)
			return
		}
		b := byItem[r.ArticleID]
		r.StockQty = math.Round(b.Qty*1000) / 1000
		r.Value = math.Round(r.StockQty*r.ApprovedPrice*100) / 100
		r.Last = b.Last
		if search != "" && !strings.Contains(strings.ToLower(r.ArticleCode), search) && !strings.Contains(strings.ToLower(r.Name), search) {
			continue
		}
		list = append(list, r)
	}
	arows.Close()
	sort.SliceStable(list, func(i, j int) bool { return math.Abs(list[i].Value) > math.Abs(list[j].Value) })

	totalValue := 0.0
	for _, r := range list {
		totalValue += r.Value
	}
	start := (page - 1) * pageSize
	if start > len(list) {
		start = len(list)
	}
	end := start + pageSize
	if end > len(list) {
		end = len(list)
	}
	data := make([]gin.H, 0, end-start)
	for _, r := range list[start:end] {
		var last interface{}
		if r.Last != nil {
			last = common.NewPDate(*r.Last)
		}
		data = append(data, gin.H{"articleId": r.ArticleID, "articleCode": r.ArticleCode, "name": r.Name, "stockQty": r.StockQty,
			"approvedPrice": r.ApprovedPrice, "valueEstimate": r.Value, "lastMovementAt": last})
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "totalValue": math.Round(totalValue*100) / 100,
		"meta": gin.H{"page": page, "pageSize": pageSize, "total": len(list)}})
}

var fgTypeMap = map[string]string{
	"приход": "RECEIPT", "расход": "EXPENSE", "в_производство": "TO_PRODUCTION",
	"с_производства": "FROM_PRODUCTION", "возврат": "RETURN", "коррекция": "CORRECTION", "отгрузка": "SHIPMENT",
}
var fgKnown = map[string]bool{"RECEIPT": true, "EXPENSE": true, "TO_PRODUCTION": true, "FROM_PRODUCTION": true, "RETURN": true, "CORRECTION": true, "SHIPMENT": true}

// PostFGMovement — POST /warehouse/finished-goods/movements (warehouse_fg/shop_foreman/admin).
func (h *WarehouseHandler) PostFGMovement(c *gin.Context) {
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	articleID, _ := body["articleId"].(string)
	var approvedPrice decimal.Decimal
	var articleCode, articleName string
	if err := h.pool.QueryRow(ctx, "SELECT approved_price, article_code, name FROM articles WHERE id = $1", articleID).Scan(&approvedPrice, &articleCode, &articleName); err == pgx.ErrNoRows {
		common.NotFound(c, "Article "+articleID+" not found")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	rawType, _ := body["movementType"].(string)
	movementType := rawType
	if m, ok := fgTypeMap[rawType]; ok {
		movementType = m
	}
	if !fgKnown[movementType] {
		common.BadRequest(c, "INVALID_TYPE", "Неизвестный тип движения: "+rawType)
		return
	}
	qty, isNum := body["qty"].(float64)
	if !isNum || math.IsNaN(qty) || math.IsInf(qty, 0) || qty == 0 || (movementType != "CORRECTION" && qty < 0) {
		common.BadRequest(c, "INVALID_QTY", "Количество должно быть больше нуля")
		return
	}
	var orderID *string
	var orderNumber *string
	if oid, ok := body["orderId"].(string); ok && oid != "" {
		var num string
		if err := h.pool.QueryRow(ctx, "SELECT order_number FROM orders WHERE id = $1", oid).Scan(&num); err == pgx.ErrNoRows {
			common.NotFound(c, "Order "+oid+" not found")
			return
		} else if err != nil {
			respondErr(c, err)
			return
		}
		orderID, orderNumber = &oid, &num
	}
	unitPrice := approvedPrice
	if up, ok := body["unitPrice"].(float64); ok && up != 0 {
		unitPrice = decimal.NewFromFloat(up)
	}
	movementDate := time.Now().UTC()
	if md, ok := body["movementDate"].(string); ok && md != "" {
		if t := parseDatePtr(&md); t != nil {
			movementDate = *t
		}
	}
	id := uuid.NewString()
	row := h.pool.QueryRow(ctx, `
		INSERT INTO finished_goods_movements (id, item_id, order_id, movement_type, qty, unit_price, movement_date)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING id, item_id, order_id, movement_type, qty, unit_price, movement_date, project, source_document_id`,
		id, articleID, orderID, models.StockMovementTypeAPIToDB(movementType), qty, unitPrice, movementDate)
	var m models.FinishedGoodsMovement
	var mt string
	if err := row.Scan(&m.ID, &m.ItemID, &m.OrderID, &mt, &m.Qty, &m.UnitPrice, &m.MovementDate, &m.Project, &m.SourceDocumentID); err != nil {
		respondErr(c, err)
		return
	}
	var order interface{}
	if orderNumber != nil {
		order = gin.H{"orderNumber": *orderNumber}
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": m.ID, "itemId": m.ItemID, "orderId": m.OrderID, "movementType": models.StockMovementTypeDBToAPI(mt),
		"qty": m.Qty, "unitPrice": m.UnitPrice, "movementDate": m.MovementDate, "project": m.Project,
		"sourceDocumentId": m.SourceDocumentID, "article": gin.H{"articleCode": articleCode, "name": articleName}, "order": order,
	})
}
