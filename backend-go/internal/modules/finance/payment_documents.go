package finance

import (
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
	"cmk-avrora-erp/backend-go/internal/modules/catalog"
	"cmk-avrora-erp/backend-go/internal/warehouse"
)

type PaymentDocumentsHandler struct{ pool *pgxpool.Pool }

func NewPaymentDocumentsHandler(pool *pgxpool.Pool) *PaymentDocumentsHandler {
	return &PaymentDocumentsHandler{pool: pool}
}

func docWithIncludes(d models.PaymentDocument, cust map[string]models.Customer, ord map[string]models.Order) gin.H {
	h := gin.H{
		"id": d.ID, "doNumber": d.DoNumber, "doDate": d.DoDate, "contractorId": d.ContractorID, "currency": d.Currency,
		"totalAmount": d.TotalAmount, "paidAmount": d.PaidAmount, "unpaidAmount": d.UnpaidAmount, "category": d.Category,
		"status": d.Status, "orderId": d.OrderID, "rawColumns": d.RawColumns, "businessDirection": d.BusinessDirection,
		"projectName": d.ProjectName, "division": d.Division, "warehouseName": d.WarehouseName, "costCategory": d.CostCategory,
		"author": d.Author, "managerName": d.ManagerName, "approvedAt": d.ApprovedAt, "approver": d.Approver,
		"supplierDocNumber": d.SupplierDocNumber, "supplierDocDate": d.SupplierDocDate, "salesOrderNumber": d.SalesOrderNumber,
	}
	if cust != nil {
		if cu, ok := cust[d.ContractorID]; ok {
			h["contractor"] = cu
		} else {
			h["contractor"] = nil
		}
	}
	if ord != nil {
		if d.OrderID != nil {
			if o, ok := ord[*d.OrderID]; ok {
				h["order"] = o
			} else {
				h["order"] = nil
			}
		} else {
			h["order"] = nil
		}
	}
	return h
}

// FindAll — GET /payment-documents?status=&customerId=&page=&pageSize= (raw + contractor + order).
func (h *PaymentDocumentsHandler) FindAll(c *gin.Context) {
	page, pageSize := pageParams(c, 50)
	where, args := "WHERE 1=1", []interface{}{}
	if st := c.Query("status"); st != "" {
		args = append(args, models.PaymentDocStatusAPIToDB(st))
		where += " AND status = $1"
	}
	if cid := c.Query("customerId"); cid != "" {
		args = append(args, cid)
		where += " AND contractor_id = $" + itoa(len(args))
	}
	ctx := c.Request.Context()
	var total int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM payment_documents "+where, args...).Scan(&total); err != nil {
		respondErr(c, err)
		return
	}
	largs := append(append([]interface{}{}, args...), pageSize, (page-1)*pageSize)
	rows, err := h.pool.Query(ctx, "SELECT "+paymentDocCols+" FROM payment_documents "+where+" ORDER BY do_date DESC LIMIT $"+itoa(len(largs)-1)+" OFFSET $"+itoa(len(largs)), largs...)
	if err != nil {
		respondErr(c, err)
		return
	}
	var docs []models.PaymentDocument
	for rows.Next() {
		d, err := scanPaymentDoc(rows)
		if err != nil {
			rows.Close()
			respondErr(c, err)
			return
		}
		docs = append(docs, d)
	}
	rows.Close()
	var cids, oids []string
	for _, d := range docs {
		cids = append(cids, d.ContractorID)
		if d.OrderID != nil {
			oids = append(oids, *d.OrderID)
		}
	}
	cust, err := customersByID(ctx, h.pool, dedupe(cids))
	if err != nil {
		respondErr(c, err)
		return
	}
	ord, err := ordersByID(ctx, h.pool, dedupe(oids))
	if err != nil {
		respondErr(c, err)
		return
	}
	data := make([]gin.H, 0, len(docs))
	for _, d := range docs {
		data = append(data, docWithIncludes(d, cust, ord))
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "meta": gin.H{"page": page, "pageSize": pageSize, "total": total}})
}

func itoa(n int) string { return decimal.NewFromInt(int64(n)).String() }

// CustomerDebts — GET /payment-documents/customer-debts — дебиторка по заказчикам.
func (h *PaymentDocumentsHandler) CustomerDebts(c *gin.Context) {
	rows, err := h.pool.Query(c.Request.Context(), `
		SELECT o.onec_total_amount, o.onec_paid_amount, cu.id, cu.name
		FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE o.is_archived = false`)
	if err != nil {
		respondErr(c, err)
		return
	}
	type row struct {
		CustomerID, CustomerName              string
		Orders, UnknownOrders                 int
		Contracted, Paid, Debt, UnknownAmount float64
	}
	byCust := map[string]*row{}
	var order []string
	ordersCount := 0
	for rows.Next() {
		var total, paid *float64
		var cid, name string
		if err := rows.Scan(&total, &paid, &cid, &name); err != nil {
			rows.Close()
			respondErr(c, err)
			return
		}
		ordersCount++
		r, ok := byCust[cid]
		if !ok {
			r = &row{CustomerID: cid, CustomerName: name}
			byCust[cid] = r
			order = append(order, cid)
		}
		t := 0.0
		if total != nil {
			t = *total
		}
		r.Orders++
		r.Contracted += t
		if paid == nil {
			r.UnknownOrders++
			r.UnknownAmount += t
		} else {
			r.Paid += *paid
			r.Debt += math.Max(0, t-*paid)
		}
	}
	rows.Close()
	list := make([]*row, 0, len(order))
	for _, id := range order {
		r := byCust[id]
		r.Contracted, r.Paid, r.Debt, r.UnknownAmount = round2(r.Contracted), round2(r.Paid), round2(r.Debt), round2(r.UnknownAmount)
		list = append(list, r)
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Debt != list[j].Debt {
			return list[i].Debt > list[j].Debt
		}
		return list[i].UnknownAmount > list[j].UnknownAmount
	})
	var sc, sp, sd, su float64
	unknownOrders := 0
	customers := make([]gin.H, len(list))
	for i, r := range list {
		sc += r.Contracted
		sp += r.Paid
		sd += r.Debt
		su += r.UnknownAmount
		unknownOrders += r.UnknownOrders
		customers[i] = gin.H{"customerId": r.CustomerID, "customerName": r.CustomerName, "orders": r.Orders,
			"contracted": r.Contracted, "paid": r.Paid, "debt": r.Debt, "unknownOrders": r.UnknownOrders, "unknownAmount": r.UnknownAmount}
	}
	c.JSON(http.StatusOK, gin.H{"customers": customers, "totals": gin.H{
		"customers": len(list), "orders": ordersCount, "contracted": round2(sc), "paid": round2(sp), "debt": round2(sd),
		"unknownOrders": unknownOrders, "unknownAmount": round2(su),
	}})
}

// Receivables — GET /payment-documents/receivables (status != PAID, take 100).
// Prisma: take без orderBy → неявный ORDER BY id (стабильная пагинация) — найдено диффом.
func (h *PaymentDocumentsHandler) Receivables(c *gin.Context) {
	ctx := c.Request.Context()
	rows, err := h.pool.Query(ctx, "SELECT "+paymentDocCols+" FROM payment_documents WHERE status <> $1 ORDER BY id LIMIT 100", models.PaymentDocStatusAPIToDB("PAID"))
	if err != nil {
		respondErr(c, err)
		return
	}
	var docs []models.PaymentDocument
	for rows.Next() {
		d, err := scanPaymentDoc(rows)
		if err != nil {
			rows.Close()
			respondErr(c, err)
			return
		}
		docs = append(docs, d)
	}
	rows.Close()
	var cids []string
	for _, d := range docs {
		cids = append(cids, d.ContractorID)
	}
	cust, err := customersByID(ctx, h.pool, dedupe(cids))
	if err != nil {
		respondErr(c, err)
		return
	}
	out := make([]gin.H, 0, len(docs))
	for _, d := range docs {
		total, _ := d.TotalAmount.Float64()
		paid, _ := d.PaidAmount.Float64()
		var name interface{}
		if cu, ok := cust[d.ContractorID]; ok {
			name = cu.Name
		}
		out = append(out, gin.H{"id": d.ID, "customer": name, "docNumber": d.DoNumber, "totalAmount": total, "paidAmount": paid,
			"balanceDue": total - paid, "status": d.Status, "doDate": d.DoDate})
	}
	c.JSON(http.StatusOK, out)
}

// Reconciliation — GET /payment-documents/reconciliation — встречные долги.
func (h *PaymentDocumentsHandler) Reconciliation(c *gin.Context) {
	ctx := c.Request.Context()
	type acc struct {
		CustomerID, CustomerName                              string
		OrdersCount, PaymentDocsCount                         int
		BalanceDueOrders, UnknownAmount, UnpaidByDo, PaidByDo float64
	}
	accs := map[string]*acc{}
	var order []string
	get := func(id, name string) *acc {
		a, ok := accs[id]
		if !ok {
			a = &acc{CustomerID: id, CustomerName: name}
			accs[id] = a
			order = append(order, id)
		}
		return a
	}
	orows, err := h.pool.Query(ctx, `SELECT o.onec_total_amount, o.onec_paid_amount, cu.id, cu.name
		FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE o.is_archived = false`)
	if err != nil {
		respondErr(c, err)
		return
	}
	for orows.Next() {
		var total, paid *float64
		var cid, name string
		if err := orows.Scan(&total, &paid, &cid, &name); err != nil {
			orows.Close()
			respondErr(c, err)
			return
		}
		a := get(cid, name)
		t := 0.0
		if total != nil {
			t = *total
		}
		a.OrdersCount++
		if paid == nil {
			a.UnknownAmount += t
		} else {
			a.BalanceDueOrders += math.Max(0, t-*paid)
		}
	}
	orows.Close()
	drows, err := h.pool.Query(ctx, `SELECT pd.contractor_id, coalesce(sum(pd.unpaid_amount),0), coalesce(sum(pd.paid_amount),0), count(*), cu.name
		FROM payment_documents pd LEFT JOIN customers cu ON cu.id = pd.contractor_id GROUP BY pd.contractor_id, cu.name`)
	if err != nil {
		respondErr(c, err)
		return
	}
	for drows.Next() {
		var cid string
		var unpaid, paid float64
		var cnt int
		var name *string
		if err := drows.Scan(&cid, &unpaid, &paid, &cnt, &name); err != nil {
			drows.Close()
			respondErr(c, err)
			return
		}
		nm := "контрагент"
		if name != nil {
			nm = *name
		}
		a := get(cid, nm)
		a.PaymentDocsCount += cnt
		a.UnpaidByDo += unpaid
		a.PaidByDo += paid
	}
	drows.Close()
	type outRow struct {
		acc
		Discrepancy float64
	}
	var list []outRow
	for _, id := range order {
		a := accs[id]
		if a.BalanceDueOrders > 0 || a.UnpaidByDo > 0 || a.UnknownAmount > 0 {
			r := outRow{acc: *a}
			r.BalanceDueOrders, r.UnknownAmount, r.UnpaidByDo, r.PaidByDo = round2(a.BalanceDueOrders), round2(a.UnknownAmount), round2(a.UnpaidByDo), round2(a.PaidByDo)
			r.Discrepancy = round2(a.BalanceDueOrders - a.UnpaidByDo)
			list = append(list, r)
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return math.Abs(list[i].Discrepancy) > math.Abs(list[j].Discrepancy) })

	var shippedWithoutDo, docsWithoutOrder int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM orders o WHERE o.status IN ('SHIPPED','CLOSED') AND NOT EXISTS (SELECT 1 FROM payment_documents pd WHERE pd.order_id = o.id)`).Scan(&shippedWithoutDo); err != nil {
		respondErr(c, err)
		return
	}
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM payment_documents WHERE order_id IS NULL").Scan(&docsWithoutOrder); err != nil {
		respondErr(c, err)
		return
	}
	prows, err := h.pool.Query(ctx, `
		SELECT o.id AS order_id, o.order_number, c.name AS customer_name,
		       (SELECT coalesce(sum(ol.line_total_vat), 0) FROM order_lines ol WHERE ol.order_id = o.id) AS order_total,
		       sum(pd.total_amount) AS procurement_total, sum(pd.unpaid_amount) AS procurement_unpaid, count(pd.id) AS docs_count
		FROM payment_documents pd JOIN orders o ON o.id = pd.order_id JOIN customers c ON c.id = o.customer_id
		GROUP BY o.id, o.order_number, c.name
		ORDER BY sum(pd.unpaid_amount) DESC, sum(pd.total_amount) DESC LIMIT 20`)
	if err != nil {
		respondErr(c, err)
		return
	}
	byOrder := []gin.H{}
	for prows.Next() {
		var oid, onum, cname string
		var ot, pt, pu float64
		var cnt int64
		if err := prows.Scan(&oid, &onum, &cname, &ot, &pt, &pu, &cnt); err != nil {
			prows.Close()
			respondErr(c, err)
			return
		}
		byOrder = append(byOrder, gin.H{"orderId": oid, "orderNumber": onum, "customerName": cname, "orderTotal": ot,
			"procurementTotal": pt, "procurementUnpaid": pu, "docsCount": cnt})
	}
	prows.Close()
	var aggTotal, aggUnpaid float64
	var aggCount int
	if err := h.pool.QueryRow(ctx, "SELECT coalesce(sum(total_amount),0), coalesce(sum(unpaid_amount),0), count(*) FROM payment_documents").Scan(&aggTotal, &aggUnpaid, &aggCount); err != nil {
		respondErr(c, err)
		return
	}
	limit := len(list)
	if limit > 50 {
		limit = 50
	}
	customers := make([]gin.H, 0, limit)
	balSum := 0.0
	for _, r := range list {
		balSum += r.BalanceDueOrders
	}
	for _, r := range list[:limit] {
		customers = append(customers, gin.H{"customerId": r.CustomerID, "customerName": r.CustomerName, "ordersCount": r.OrdersCount,
			"paymentDocsCount": r.PaymentDocsCount, "balanceDueOrders": r.BalanceDueOrders, "unknownAmount": r.UnknownAmount,
			"unpaidByDo": r.UnpaidByDo, "paidByDo": r.PaidByDo, "discrepancy": r.Discrepancy})
	}
	c.JSON(http.StatusOK, gin.H{"customers": customers, "orders": byOrder, "totals": gin.H{
		"customersWithDebt": len(list), "balanceDueOrders": round2(balSum), "unpaidByDo": aggUnpaid,
		"procurementTotal": aggTotal, "docsCount": aggCount, "shippedWithoutDo": shippedWithoutDo, "docsWithoutOrder": docsWithoutOrder,
	}})
}

// FindOne — GET /payment-documents/:id — raw + contractor + order + batches(+material) + lines + payments.
func (h *PaymentDocumentsHandler) FindOne(c *gin.Context) {
	id := c.Param("id")
	ctx := c.Request.Context()
	d, err := scanPaymentDoc(h.pool.QueryRow(ctx, "SELECT "+paymentDocCols+" FROM payment_documents WHERE id = $1", id))
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Payment document "+id+" not found")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	cust, err := customersByID(ctx, h.pool, []string{d.ContractorID})
	if err != nil {
		respondErr(c, err)
		return
	}
	var oids []string
	if d.OrderID != nil {
		oids = []string{*d.OrderID}
	}
	ord, err := ordersByID(ctx, h.pool, oids)
	if err != nil {
		respondErr(c, err)
		return
	}
	out := docWithIncludes(d, cust, ord)

	brows, err := h.pool.Query(ctx, "SELECT "+warehouse.MaterialBatchCols+" FROM material_batches WHERE payment_document_id = $1 ORDER BY receipt_date DESC", id)
	if err != nil {
		respondErr(c, err)
		return
	}
	var batches []models.MaterialBatch
	for brows.Next() {
		b, err := warehouse.ScanBatch(brows)
		if err != nil {
			brows.Close()
			respondErr(c, err)
			return
		}
		batches = append(batches, b)
	}
	brows.Close()
	var mids []string
	for _, b := range batches {
		mids = append(mids, b.MaterialID)
	}
	mats := map[string]models.Material{}
	if len(mids) > 0 {
		mrows, err := h.pool.Query(ctx, "SELECT "+catalog.MaterialCols+" FROM materials WHERE id = ANY($1)", dedupe(mids))
		if err != nil {
			respondErr(c, err)
			return
		}
		for mrows.Next() {
			m, err := catalog.ScanMaterial(mrows)
			if err != nil {
				mrows.Close()
				respondErr(c, err)
				return
			}
			mats[m.ID] = m
		}
		mrows.Close()
	}
	batchOut := make([]gin.H, 0, len(batches))
	for _, b := range batches {
		bh := gin.H{"id": b.ID, "materialId": b.MaterialID, "warehouseId": b.WarehouseID, "receiptDate": b.ReceiptDate, "unitPrice": b.UnitPrice,
			"qtyReceived": b.QtyReceived, "qtyRemaining": b.QtyRemaining, "supplierName": b.SupplierName, "documentNumber": b.DocumentNumber,
			"sourceMovementId": b.SourceMovementID, "paymentDocumentId": b.PaymentDocumentID, "origin": b.Origin, "externalId": b.ExternalID,
			"batchType": b.BatchType, "ownerOrderId": b.OwnerOrderID, "priceAnomaly": b.PriceAnomaly, "anomalyFactor": b.AnomalyFactor,
			"anomalyClearedAt": b.AnomalyClearedAt, "anomalyClearedById": b.AnomalyClearedByID, "createdAt": b.CreatedAt}
		if m, ok := mats[b.MaterialID]; ok {
			bh["material"] = m
		} else {
			bh["material"] = nil
		}
		batchOut = append(batchOut, bh)
	}
	out["batches"] = batchOut

	lrows, err := h.pool.Query(ctx, `SELECT id, payment_document_id, line_no, item_name, qty, unit_price, amount, vat_rate, packaging, expense_item,
		purpose, customer_order_num, material_id, amount_mismatch, raw_columns FROM payment_document_lines WHERE payment_document_id = $1 ORDER BY line_no ASC`, id)
	if err != nil {
		respondErr(c, err)
		return
	}
	lines := []models.PaymentDocumentLine{}
	for lrows.Next() {
		var l models.PaymentDocumentLine
		if err := lrows.Scan(&l.ID, &l.PaymentDocumentID, &l.LineNo, &l.ItemName, &l.Qty, &l.UnitPrice, &l.Amount, &l.VatRate, &l.Packaging,
			&l.ExpenseItem, &l.Purpose, &l.CustomerOrderNum, &l.MaterialID, &l.AmountMismatch, &l.RawColumns); err != nil {
			lrows.Close()
			respondErr(c, err)
			return
		}
		lines = append(lines, l)
	}
	lrows.Close()
	out["lines"] = lines

	prows, err := h.pool.Query(ctx, "SELECT id, payment_document_id, amount, payment_date, payment_type, reference, created_at FROM payments WHERE payment_document_id = $1 ORDER BY payment_date DESC", id)
	if err != nil {
		respondErr(c, err)
		return
	}
	payments := []models.Payment{}
	for prows.Next() {
		var p models.Payment
		if err := prows.Scan(&p.ID, &p.PaymentDocumentID, &p.Amount, &p.PaymentDate, &p.PaymentType, &p.Reference, &p.CreatedAt); err != nil {
			prows.Close()
			respondErr(c, err)
			return
		}
		payments = append(payments, p)
	}
	prows.Close()
	out["payments"] = payments
	c.JSON(http.StatusOK, out)
}

// Create — POST /payment-documents (accountant/sales_manager/admin), body: any.
func (h *PaymentDocumentsHandler) Create(c *gin.Context) {
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	str := func(keys ...string) *string {
		for _, k := range keys {
			if v, ok := body[k].(string); ok && v != "" {
				return &v
			}
		}
		return nil
	}
	doNumber := str("doNumber", "docNumber")
	contractorID := str("contractorId", "customerId")
	doDate := time.Now().UTC()
	if s := str("doDate"); s != nil {
		if t, ok := parseJSDate(*s); ok {
			doDate = t
		}
	}
	var total interface{} = body["totalAmount"]
	ctx := c.Request.Context()
	row := h.pool.QueryRow(ctx, `INSERT INTO payment_documents (id, do_number, do_date, contractor_id, total_amount, order_id, category)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING `+paymentDocCols,
		uuid.NewString(), doNumber, doDate, contractorID, total, str("orderId"), str("category"))
	d, err := scanPaymentDoc(row)
	if err != nil {
		respondErr(c, err)
		return
	}
	cust, err := customersByID(ctx, h.pool, []string{d.ContractorID})
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, docWithIncludes(d, cust, nil))
}

type addPaymentBody struct {
	Amount    float64 `json:"amount"`
	PaidAt    *string `json:"paidAt"`
	Reference *string `json:"reference"`
}

// AddPayment — POST /payment-documents/:id/payments (accountant/admin).
func (h *PaymentDocumentsHandler) AddPayment(c *gin.Context) {
	id := c.Param("id")
	var body addPaymentBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	d, err := scanPaymentDoc(h.pool.QueryRow(ctx, "SELECT "+paymentDocCols+" FROM payment_documents WHERE id = $1", id))
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Payment document "+id+" not found")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	if !(body.Amount > 0) {
		common.BadRequest(c, "INVALID_AMOUNT", "Сумма оплаты должна быть больше нуля")
		return
	}
	paidAt := time.Now().UTC()
	if body.PaidAt != nil && *body.PaidAt != "" {
		t, ok := parseJSDate(*body.PaidAt)
		if !ok {
			common.BadRequest(c, "INVALID_DATE", "Дата оплаты не распознана")
			return
		}
		paidAt = t
	}
	paidBefore, _ := d.PaidAmount.Float64()
	total, _ := d.TotalAmount.Float64()
	newPaid := paidBefore + body.Amount
	newStatus := "PARTIALLY_PAID"
	if newPaid >= total {
		newStatus = "PAID"
	}
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		respondErr(c, err)
		return
	}
	defer tx.Rollback(ctx)
	var p models.Payment
	if err := tx.QueryRow(ctx, `INSERT INTO payments (id, payment_document_id, amount, payment_date, reference) VALUES ($1,$2,$3,$4,$5)
		RETURNING id, payment_document_id, amount, payment_date, payment_type, reference, created_at`,
		uuid.NewString(), id, body.Amount, paidAt, trimPtr(body.Reference)).
		Scan(&p.ID, &p.PaymentDocumentID, &p.Amount, &p.PaymentDate, &p.PaymentType, &p.Reference, &p.CreatedAt); err != nil {
		respondErr(c, err)
		return
	}
	updated, err := scanPaymentDoc(tx.QueryRow(ctx, `UPDATE payment_documents SET paid_amount = $1, unpaid_amount = $2, status = $3 WHERE id = $4 RETURNING `+paymentDocCols,
		newPaid, math.Max(0, total-newPaid), models.PaymentDocStatusAPIToDB(newStatus), id))
	if err != nil {
		respondErr(c, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		respondErr(c, err)
		return
	}
	out := docWithIncludes(updated, nil, nil)
	out["payment"] = p
	c.JSON(http.StatusCreated, out)
}
