package finance

import (
	"math"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
)

// Перенос purchases.controller.ts — раздел «Закупки» (ДО из 1С).
type PurchasesHandler struct{ pool *pgxpool.Pool }

func NewPurchasesHandler(pool *pgxpool.Pool) *PurchasesHandler { return &PurchasesHandler{pool: pool} }

const dayMs = 24 * 60 * 60 * 1000

type pdoc struct {
	ID, DoNumber, ContractorID, Currency, Status                      string
	ContractorName                                                    *string
	DoDate, ApprovedAt, SupplierDocDate                               *time.Time
	Total, Paid, Unpaid                                               float64
	BusinessDirection, ProjectName, CostCategory, Author, ManagerName *string
	WarehouseName, Division, Approver                                 *string
	Batches, Lines                                                    int
}

const pdocSelect = `SELECT pd.id, pd.do_number, pd.contractor_id, pd.currency, pd.status, cu.name, pd.do_date, pd.approved_at, pd.supplier_doc_date,
	pd.total_amount, pd.paid_amount, pd.unpaid_amount, pd.business_direction, pd.project_name, pd.cost_category, pd.author, pd.manager_name,
	pd.warehouse_name, pd.division, pd.approver,
	(SELECT count(*) FROM material_batches b WHERE b.payment_document_id = pd.id),
	(SELECT count(*) FROM payment_document_lines l WHERE l.payment_document_id = pd.id)
	FROM payment_documents pd LEFT JOIN customers cu ON cu.id = pd.contractor_id`

func (h *PurchasesHandler) load(c *gin.Context, where string, args ...interface{}) ([]pdoc, error) {
	rows, err := h.pool.Query(c.Request.Context(), pdocSelect+" "+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []pdoc
	for rows.Next() {
		var d pdoc
		if err := rows.Scan(&d.ID, &d.DoNumber, &d.ContractorID, &d.Currency, &d.Status, &d.ContractorName, &d.DoDate, &d.ApprovedAt, &d.SupplierDocDate,
			&d.Total, &d.Paid, &d.Unpaid, &d.BusinessDirection, &d.ProjectName, &d.CostCategory, &d.Author, &d.ManagerName,
			&d.WarehouseName, &d.Division, &d.Approver, &d.Batches, &d.Lines); err != nil {
			return nil, err
		}
		d.Status = models.PaymentDocStatusDBToAPI(d.Status)
		out = append(out, d)
	}
	return out, rows.Err()
}

func jsonRawUnused() {}

func supplierName(d pdoc) string {
	if d.ContractorName != nil {
		return *d.ContractorName
	}
	return "—"
}

// Dashboard — GET /purchases/dashboard (procurement/accountant/director/admin).
func (h *PurchasesHandler) Dashboard(c *gin.Context) {
	docs, err := h.load(c, "")
	if err != nil {
		respondErr(c, err)
		return
	}
	nowMs := time.Now().UnixMilli()
	ageOf := func(d pdoc) int {
		if d.DoDate == nil {
			return 0
		}
		return int(math.Floor(float64(nowMs-d.DoDate.UnixMilli()) / dayMs))
	}
	var kzt, other, unpaid []pdoc
	for _, d := range docs {
		if d.Currency == "KZT" {
			kzt = append(kzt, d)
			if d.Unpaid > 0 {
				unpaid = append(unpaid, d)
			}
		} else {
			other = append(other, d)
		}
	}
	filter := func(list []pdoc, f func(pdoc) bool) []pdoc {
		var r []pdoc
		for _, d := range list {
			if f(d) {
				r = append(r, d)
			}
		}
		return r
	}
	sum := func(list []pdoc, f func(pdoc) float64) float64 {
		s := 0.0
		for _, d := range list {
			s += f(d)
		}
		return s
	}
	overdue30 := filter(unpaid, func(d pdoc) bool { return ageOf(d) > 30 })
	bucket := func(from, to int) []pdoc {
		return filter(unpaid, func(d pdoc) bool { a := ageOf(d); return a > from && a <= to })
	}
	monthAgo, prevMonth := nowMs-30*dayMs, nowMs-60*dayMs
	inRange := func(d pdoc, from, to int64) bool {
		return d.DoDate != nil && d.DoDate.UnixMilli() > from && d.DoDate.UnixMilli() <= to
	}
	spendMonth := filter(kzt, func(d pdoc) bool { return inRange(d, monthAgo, nowMs) })
	spendPrev := filter(kzt, func(d pdoc) bool { return inRange(d, prevMonth, monthAgo) })
	noReceipt := filter(docs, func(d pdoc) bool { return d.Batches == 0 })

	cut := func(key func(pdoc) *string) []gin.H {
		type acc struct {
			Docs                  int
			Total, Telecom, Other float64
		}
		m := map[string]*acc{}
		var order []string
		for _, d := range kzt {
			k := "__none__"
			if v := key(d); v != nil {
				k = *v
			}
			a, ok := m[k]
			if !ok {
				a = &acc{}
				m[k] = a
				order = append(order, k)
			}
			a.Docs++
			a.Total += d.Total
			if d.BusinessDirection != nil && *d.BusinessDirection == "ЦМК Телекоммуникации" {
				a.Telecom += d.Total
			} else {
				a.Other += d.Total
			}
		}
		sort.SliceStable(order, func(i, j int) bool { return m[order[i]].Total > m[order[j]].Total })
		out := make([]gin.H, 0, len(order))
		for _, k := range order {
			var kk interface{} = k
			if k == "__none__" {
				kk = nil
			}
			a := m[k]
			out = append(out, gin.H{"key": kk, "docs": a.Docs, "total": a.Total, "telecom": a.Telecom, "other": a.Other})
		}
		return out
	}

	type sup struct {
		ID, Name            string
		Docs, NoReceipt     int
		Total, Paid, Unpaid float64
		LastDate            *time.Time
	}
	bySup := map[string]*sup{}
	var supOrder []string
	for _, d := range docs {
		s, ok := bySup[d.ContractorID]
		if !ok {
			s = &sup{ID: d.ContractorID, Name: supplierName(d)}
			bySup[d.ContractorID] = s
			supOrder = append(supOrder, d.ContractorID)
		}
		s.Docs++
		if d.Currency == "KZT" {
			s.Total += d.Total
			s.Paid += d.Paid
			s.Unpaid += d.Unpaid
		}
		if d.Batches == 0 {
			s.NoReceipt++
		}
		if d.DoDate != nil && (s.LastDate == nil || d.DoDate.After(*s.LastDate)) {
			s.LastDate = d.DoDate
		}
	}
	suppliers := make([]*sup, 0, len(supOrder))
	for _, id := range supOrder {
		suppliers = append(suppliers, bySup[id])
	}
	sort.SliceStable(suppliers, func(i, j int) bool { return suppliers[i].Total > suppliers[j].Total })
	totalKzt := sum(kzt, func(d pdoc) float64 { return d.Total })

	noApprover := filter(docs, func(d pdoc) bool { return d.Approver == nil || *d.Approver == "" })
	slowApproval := filter(docs, func(d pdoc) bool {
		return d.ApprovedAt != nil && d.DoDate != nil && float64(d.ApprovedAt.UnixMilli()-d.DoDate.UnixMilli())/dayMs > 30
	})
	dayOf := func(t time.Time) int64 {
		l := t.In(time.Local)
		return time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, time.UTC).UnixMilli()
	}
	backdated := filter(docs, func(d pdoc) bool {
		return d.SupplierDocDate != nil && d.DoDate != nil && dayOf(*d.SupplierDocDate) < dayOf(*d.DoDate)
	})
	noWarehouse := filter(docs, func(d pdoc) bool { return d.WarehouseName == nil || *d.WarehouseName == "" })
	overpaid := filter(docs, func(d pdoc) bool { return d.Paid > d.Total })

	otherCur := map[string]float64{}
	var curOrder []string
	for _, d := range other {
		if _, ok := otherCur[d.Currency]; !ok {
			curOrder = append(curOrder, d.Currency)
		}
		otherCur[d.Currency] += d.Unpaid
	}
	otherCurrencies := []gin.H{}
	for _, cur := range curOrder {
		if otherCur[cur] > 0 {
			otherCurrencies = append(otherCurrencies, gin.H{"currency": cur, "amount": otherCur[cur]})
		}
	}
	agg := func(list []pdoc) (int, float64) {
		return len(list), sum(list, func(d pdoc) float64 { return d.Unpaid })
	}
	bucketH := func(label string, list []pdoc) gin.H {
		n, a := agg(list)
		return gin.H{"label": label, "docs": n, "amount": a}
	}
	unpaidSorted := append([]pdoc{}, unpaid...)
	sort.SliceStable(unpaidSorted, func(i, j int) bool { return ageOf(unpaidSorted[i]) > ageOf(unpaidSorted[j]) })
	unpaidDocs := make([]gin.H, 0, len(unpaidSorted))
	for _, d := range unpaidSorted {
		unpaidDocs = append(unpaidDocs, gin.H{"id": d.ID, "doNumber": d.DoNumber, "doDate": pd(d.DoDate), "ageDays": ageOf(d), "supplier": supplierName(d),
			"supplierId": d.ContractorID, "currency": d.Currency, "totalAmount": d.Total, "paidAmount": d.Paid, "unpaidAmount": d.Unpaid})
	}
	topN := func(n int) []gin.H {
		if n > len(suppliers) {
			n = len(suppliers)
		}
		out := make([]gin.H, 0, n)
		for _, s := range suppliers[:n] {
			out = append(out, gin.H{"id": s.ID, "name": s.Name, "docs": s.Docs, "total": s.Total, "paid": s.Paid, "unpaid": s.Unpaid, "noReceipt": s.NoReceipt, "lastDate": pd(s.LastDate)})
		}
		return out
	}
	share := func(n int) float64 {
		if totalKzt == 0 {
			return 0
		}
		if n > len(suppliers) {
			n = len(suppliers)
		}
		s := 0.0
		for _, x := range suppliers[:n] {
			s += x.Total
		}
		return s / totalKzt
	}
	oneOff := 0
	for _, s := range suppliers {
		if s.Docs == 1 {
			oneOff++
		}
	}
	ctl := func(code, label string, list []pdoc, f func(pdoc) float64) gin.H {
		return gin.H{"code": code, "label": label, "docs": len(list), "amount": sum(list, f)}
	}
	over90 := bucket(90, 1e9)
	paidNoReceipt := filter(noReceipt, func(d pdoc) bool { return d.Paid > 0 })
	c.JSON(http.StatusOK, gin.H{
		"kpi": gin.H{
			"owed":       gin.H{"amount": sum(unpaid, func(d pdoc) float64 { return d.Unpaid }), "docs": len(unpaid), "totalDocs": len(docs), "otherCurrencies": otherCurrencies},
			"overdue30":  gin.H{"amount": sum(overdue30, func(d pdoc) float64 { return d.Unpaid }), "docs": len(overdue30), "over90": len(over90), "over90Amount": sum(over90, func(d pdoc) float64 { return d.Unpaid })},
			"spendMonth": gin.H{"amount": sum(spendMonth, func(d pdoc) float64 { return d.Total }), "docs": len(spendMonth), "prevAmount": sum(spendPrev, func(d pdoc) float64 { return d.Total })},
			"noReceipt":  gin.H{"docs": len(noReceipt), "totalDocs": len(docs), "paidDocs": len(paidNoReceipt), "paidAmount": sum(paidNoReceipt, func(d pdoc) float64 { return d.Paid })},
		},
		"totalKzt": totalKzt,
		"dimensions": gin.H{
			"project": cut(func(d pdoc) *string { return d.ProjectName }), "costCategory": cut(func(d pdoc) *string { return d.CostCategory }),
			"author": cut(func(d pdoc) *string { return d.Author }), "manager": cut(func(d pdoc) *string { return d.ManagerName }),
			"warehouse": cut(func(d pdoc) *string { return d.WarehouseName }), "division": cut(func(d pdoc) *string { return d.Division }),
		},
		"buckets":       []gin.H{bucketH("90+ дней", over90), bucketH("61–90 дней", bucket(60, 90)), bucketH("31–60 дней", bucket(30, 60)), bucketH("до 30 дней", bucket(-1, 30))},
		"unpaidDocs":    unpaidDocs,
		"suppliers":     topN(10),
		"supplierStats": gin.H{"total": len(suppliers), "top5Share": share(5), "top10Share": share(10), "oneOff": oneOff},
		"control": []gin.H{
			ctl("noApprover", "без утвердителя", noApprover, func(d pdoc) float64 { return d.Total }),
			ctl("slowApproval", "согласование дольше 30 дней", slowApproval, func(d pdoc) float64 { return d.Total }),
			ctl("backdated", "документ поставщика раньше нашего заказа", backdated, func(d pdoc) float64 { return d.Total }),
			ctl("noWarehouse", "без склада", noWarehouse, func(d pdoc) float64 { return d.Total }),
			ctl("overpaid", "оплачено больше суммы документа", overpaid, func(d pdoc) float64 { return d.Paid - d.Total }),
		},
	})
}

func pd(t *time.Time) interface{} {
	if t == nil {
		return nil
	}
	return common.NewPDate(*t)
}

// Documents — GET /purchases/documents (реестр ДО с фильтрами).
func (h *PurchasesHandler) Documents(c *gin.Context) {
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(c.Query("pageSize"))
	if pageSize < 1 {
		pageSize = 50
	}
	if pageSize > 200 {
		pageSize = 200
	}
	where, args := "WHERE 1=1", []interface{}{}
	add := func(v interface{}) string { args = append(args, v); return "$" + strconv.Itoa(len(args)) }
	if q := c.Query("search"); q != "" {
		p := add("%" + q + "%")
		where += " AND (pd.do_number ILIKE " + p + " OR pd.supplier_doc_number ILIKE " + p + " OR cu.name ILIKE " + p + ")"
	}
	if v := c.Query("direction"); v != "" {
		where += " AND pd.business_direction = " + add(v)
	}
	nullable := func(col, v string) {
		if v == "__none__" {
			where += " AND pd." + col + " IS NULL"
		} else {
			where += " AND pd." + col + " = " + add(v)
		}
	}
	if v := c.Query("project"); v != "" {
		nullable("project_name", v)
	}
	if v := c.Query("costCategory"); v != "" {
		nullable("cost_category", v)
	}
	if v := c.Query("warehouse"); v != "" {
		nullable("warehouse_name", v)
	}
	if v := c.Query("supplierId"); v != "" {
		where += " AND pd.contractor_id = " + add(v)
	}
	if c.Query("unpaidOnly") == "1" {
		where += " AND pd.unpaid_amount > 0"
	}
	if c.Query("hasBatches") == "0" {
		where += " AND NOT EXISTS (SELECT 1 FROM material_batches b WHERE b.payment_document_id = pd.id)"
	}
	if c.Query("hasBatches") == "1" {
		where += " AND EXISTS (SELECT 1 FROM material_batches b WHERE b.payment_document_id = pd.id)"
	}
	if c.Query("control") == "noApprover" {
		where += " AND pd.approver IS NULL"
	}
	if c.Query("control") == "noWarehouse" {
		where += " AND pd.warehouse_name IS NULL"
	}
	if v := c.Query("overdueDays"); v != "" {
		n, _ := strconv.ParseFloat(v, 64)
		cutoff := time.UnixMilli(time.Now().UnixMilli() - int64(n*dayMs)).UTC()
		where += " AND pd.do_date < " + add(cutoff) + " AND pd.unpaid_amount > 0"
	}
	ctx := c.Request.Context()
	var total int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM payment_documents pd LEFT JOIN customers cu ON cu.id = pd.contractor_id "+where, args...).Scan(&total); err != nil {
		respondErr(c, err)
		return
	}
	lim, off := add(pageSize), add((page-1)*pageSize)
	docs, err := h.load(c, where+" ORDER BY pd.do_date DESC LIMIT "+lim+" OFFSET "+off, args...)
	if err != nil {
		respondErr(c, err)
		return
	}
	data := make([]gin.H, 0, len(docs))
	for _, d := range docs {
		data = append(data, gin.H{"id": d.ID, "doNumber": d.DoNumber, "doDate": pd(d.DoDate), "status": d.Status, "supplier": supplierName(d),
			"supplierId": d.ContractorID, "currency": d.Currency, "totalAmount": d.Total, "paidAmount": d.Paid, "unpaidAmount": d.Unpaid,
			"businessDirection": d.BusinessDirection, "projectName": d.ProjectName, "costCategory": d.CostCategory, "warehouseName": d.WarehouseName,
			"linesCount": d.Lines, "batchesCount": d.Batches})
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "meta": gin.H{"page": page, "pageSize": pageSize, "total": total}})
}
