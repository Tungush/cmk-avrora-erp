package orders

// Перенос production-plan.controller.ts — этапы производства, цех
// (shop-floor), матрица «изделие × месяц», раскладка по неделям.

import (
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
	"cmk-avrora-erp/backend-go/internal/modules/catalog"
	"cmk-avrora-erp/backend-go/internal/orderstate"
)

type ProductionPlanHandler struct{ pool *pgxpool.Pool }

func NewProductionPlanHandler(pool *pgxpool.Pool) *ProductionPlanHandler {
	return &ProductionPlanHandler{pool: pool}
}

type stageRaw struct {
	ID              string
	OrderID         string
	OrderLineID     *string
	StageCode       string
	RoutingStage    *string
	Status          string
	ActualWorkers   *decimal.Decimal
	ActualHours     *decimal.Decimal
	LegacyStageCode *string
	CompletedAt     common.PDate
	CompletedByID   *string
	DefectPhotoURL  *string
}

const stageCols = "s.id, s.order_id, s.order_line_id, s.stage_code, s.routing_stage, s.status, s.actual_workers, s.actual_hours, s.legacy_stage_code, s.completed_at, s.completed_by_id, s.defect_photo_url"

func scanStageRaw(row pgx.Row) (stageRaw, error) {
	var s stageRaw
	var code, status string
	var routing *string
	err := row.Scan(&s.ID, &s.OrderID, &s.OrderLineID, &code, &routing, &status, &s.ActualWorkers, &s.ActualHours, &s.LegacyStageCode, &s.CompletedAt, &s.CompletedByID, &s.DefectPhotoURL)
	s.StageCode = models.OrderStageCodeDBToAPI(code)
	if routing != nil {
		v := models.RoutingStageDBToAPI(*routing)
		s.RoutingStage = &v
	}
	s.Status = models.StageStatusDBToAPI(status)
	return s, err
}

func stageRawJSON(s stageRaw) gin.H {
	return gin.H{
		"id": s.ID, "orderId": s.OrderID, "orderLineId": s.OrderLineID, "stageCode": s.StageCode, "routingStage": s.RoutingStage,
		"status": s.Status, "actualWorkers": s.ActualWorkers, "actualHours": s.ActualHours, "legacyStageCode": s.LegacyStageCode,
		"completedAt": s.CompletedAt, "completedById": s.CompletedByID, "defectPhotoUrl": s.DefectPhotoURL,
	}
}

// orderRawJSON — заказ как его отдаёт Prisma без include и без вырезания
// rawColumns (production-plan отдаёт вложенный заказ целиком).
func orderRawJSON(o models.Order) gin.H {
	return gin.H{
		"id": o.ID, "orderNumber": o.OrderNumber, "customerId": o.CustomerID, "region": o.Region,
		"managerId": o.ManagerID, "orderType": o.OrderType, "bitrixDealId": o.BitrixDealID, "bitrixStage": o.BitrixStage,
		"status": o.Status, "plannedShipmentDate": o.PlannedShipmentDate, "actualShipmentDate": o.ActualShipmentDate,
		"overdueDays": o.OverdueDays, "stageTrackingMode": o.StageTrackingMode, "acceptedAt": o.AcceptedAt,
		"acceptedById": o.AcceptedByID, "isArchived": o.IsArchived, "requestDate": o.RequestDate,
		"createdAt": o.CreatedAt, "updatedAt": o.UpdatedAt, "onecNum": o.OnecNum, "onecStatus": o.OnecStatus,
		"onecApprovalStatus": o.OnecApprovalStatus, "onecTotalAmount": o.OnecTotalAmount, "onecPaidAmount": o.OnecPaidAmount,
		"finalCustomer": o.FinalCustomer, "customerOrderNum": o.CustomerOrderNum, "projectGroup": o.ProjectGroup,
		"projectSite": o.ProjectSite, "divisionCode": o.DivisionCode, "clientAgreement": o.ClientAgreement,
		"onecSyncedAt": o.OnecSyncedAt, "productionDocNumber": o.ProductionDocNumber, "productionDocDate": o.ProductionDocDate,
		"sourceSheet": o.SourceSheet, "sourceRowNumber": o.SourceRowNumber, "rawColumns": o.RawColumns,
	}
}

func lineRawJSON(l orderLineOut) gin.H {
	return gin.H{
		"id": l.ID, "orderId": l.OrderID, "articleId": l.ArticleID, "qty": l.Qty, "unit": l.Unit,
		"unitPrice": l.UnitPrice, "lineTotalVat": l.LineTotalVat, "prepayment": l.Prepayment,
		"postPayment1": l.PostPayment1, "postPayment2": l.PostPayment2, "penalty": l.Penalty,
		"balanceDue": l.BalanceDue, "reservedQty": l.ReservedQty, "shippedQty": l.ShippedQty,
		"siteCode": l.SiteCode, "sourceSheet": l.SourceSheet, "sourceRowNumber": l.SourceRowNumber,
		"articleCodeRaw": l.ArticleCodeRaw, "productNameRaw": l.ProductNameRaw, "rawColumns": l.RawColumns,
		"article": l.Article,
	}
}

func (h *ProductionPlanHandler) loadOrder(c *gin.Context, id string) (models.Order, error) {
	var o models.Order
	err := scanOrderFields(h.pool.QueryRow(c.Request.Context(), "SELECT "+OrderCols+" FROM orders WHERE id = $1", id), &o)
	return o, err
}

// FindAll — GET /production-plan?orderId=&status=&page=&pageSize=
func (h *ProductionPlanHandler) FindAll(c *gin.Context) {
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(c.Query("pageSize"))
	if size < 1 {
		size = 50
	}
	where, args := "WHERE 1=1", []interface{}{}
	if v := c.Query("orderId"); v != "" {
		args = append(args, v)
		where += " AND s.order_id = $" + itoa(len(args))
	}
	if v := c.Query("status"); v != "" {
		args = append(args, models.StageStatusAPIToDB(v))
		where += " AND s.status = $" + itoa(len(args))
	}
	ctx := c.Request.Context()
	var total int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM production_stages s "+where, args...).Scan(&total); err != nil {
		dbErr(c, err)
		return
	}
	largs := append(append([]interface{}{}, args...), size, (page-1)*size)
	// take без orderBy — Prisma добавляет ORDER BY id
	rows, err := h.pool.Query(ctx, "SELECT "+stageCols+" FROM production_stages s "+where+" ORDER BY s.id LIMIT $"+itoa(len(largs)-1)+" OFFSET $"+itoa(len(largs)), largs...)
	if err != nil {
		dbErr(c, err)
		return
	}
	var stages []stageRaw
	for rows.Next() {
		s, err := scanStageRaw(rows)
		if err != nil {
			rows.Close()
			dbErr(c, err)
			return
		}
		stages = append(stages, s)
	}
	rows.Close()
	orders := map[string]gin.H{}
	data := make([]gin.H, 0, len(stages))
	for _, s := range stages {
		o, ok := orders[s.OrderID]
		if !ok {
			ord, err := h.loadOrder(c, s.OrderID)
			if err != nil {
				dbErr(c, err)
				return
			}
			cu, err := catalog.ScanCustomer(h.pool.QueryRow(ctx, "SELECT "+catalog.CustomerCols+" FROM customers WHERE id = $1", ord.CustomerID))
			if err != nil {
				dbErr(c, err)
				return
			}
			o = orderRawJSON(ord)
			o["customer"] = cu
			orders[s.OrderID] = o
		}
		m := stageRawJSON(s)
		m["order"] = o
		data = append(data, m)
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "meta": gin.H{"page": page, "pageSize": size, "total": total}})
}

const activeStatuses = "('CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP')"

// ShopFloor — GET /production-plan/shop-floor?search= — заказы в
// производстве по ИЗДЕЛИЯМ (сырьё и ТМЦ цех не изготавливает).
func (h *ProductionPlanHandler) ShopFloor(c *gin.Context) {
	ctx := c.Request.Context()
	fallback := gin.H{"orders": []interface{}{}, "total": 0, "totalProducts": 0, "doneProducts": 0, "waitingProducts": 0, "blockedProducts": 0, "openRequests": []interface{}{}}
	type ord struct {
		id, number, status string
		customerID         string
		planned            common.PDate
		overdue            int
	}
	orows, err := h.pool.Query(ctx, "SELECT id, order_number, status, customer_id, planned_shipment_date, overdue_days FROM orders WHERE status IN "+activeStatuses+" ORDER BY planned_shipment_date ASC, created_at DESC LIMIT 500")
	if err != nil {
		common.DebugLog(err)
		c.JSON(http.StatusOK, fallback)
		return
	}
	var orders []ord
	var ids []string
	for orows.Next() {
		var o ord
		if err := orows.Scan(&o.id, &o.number, &o.status, &o.customerID, &o.planned, &o.overdue); err != nil {
			orows.Close()
			dbErr(c, err)
			return
		}
		orders = append(orders, o)
		ids = append(ids, o.id)
	}
	orows.Close()

	customerName := map[string]string{}
	if len(ids) > 0 {
		crows, err := h.pool.Query(ctx, "SELECT id, name FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE id = ANY($1))", ids)
		if err != nil {
			dbErr(c, err)
			return
		}
		for crows.Next() {
			var id, name string
			if err := crows.Scan(&id, &name); err != nil {
				crows.Close()
				dbErr(c, err)
				return
			}
			customerName[id] = name
		}
		crows.Close()
	}

	// Статус позиции: DONE важнее IN_PROGRESS — одна закрывающая отметка решает
	statusByLine := map[string]string{}
	hoursByLine := map[string]float64{}
	if len(ids) > 0 {
		srows, err := h.pool.Query(ctx, "SELECT order_line_id, status, actual_hours FROM production_stages WHERE order_id = ANY($1)", ids)
		if err != nil {
			dbErr(c, err)
			return
		}
		for srows.Next() {
			var lineID *string
			var status string
			var hours *decimal.Decimal
			if err := srows.Scan(&lineID, &status, &hours); err != nil {
				srows.Close()
				dbErr(c, err)
				return
			}
			if lineID == nil {
				continue
			}
			st := models.StageStatusDBToAPI(status)
			if _, has := statusByLine[*lineID]; st == "DONE" || !has {
				statusByLine[*lineID] = st
			}
			if hours != nil {
				hoursByLine[*lineID] = hours.InexactFloat64()
			}
		}
		srows.Close()
	}

	type line struct {
		id, unit          string
		qty               float64
		articleID         *string
		siteCode          *string
		artID, code, name string
		resale            bool
		bomCount, opCount int
	}
	linesByOrder := map[string][]line{}
	var articleIDs []string
	seenArt := map[string]bool{}
	if len(ids) > 0 {
		lrows, err := h.pool.Query(ctx, `SELECT ol.order_id, ol.id, ol.qty, ol.unit, ol.article_id, ol.site_code, a.id, a.article_code, a.name, a.is_material_resale,
			(SELECT count(*) FROM bom_items b WHERE b.article_id = a.id), (SELECT count(*) FROM routing_operations r WHERE r.article_id = a.id)
			FROM order_lines ol LEFT JOIN articles a ON a.id = ol.article_id WHERE ol.order_id = ANY($1)`, ids)
		if err != nil {
			dbErr(c, err)
			return
		}
		for lrows.Next() {
			var oid string
			var l line
			var qty decimal.Decimal
			var artID, code, name *string
			var resale *bool
			var bomCount, opCount *int
			if err := lrows.Scan(&oid, &l.id, &qty, &l.unit, &l.articleID, &l.siteCode, &artID, &code, &name, &resale, &bomCount, &opCount); err != nil {
				lrows.Close()
				dbErr(c, err)
				return
			}
			l.qty = qty.InexactFloat64()
			if artID != nil {
				l.artID, l.code, l.name, l.resale, l.bomCount, l.opCount = *artID, *code, *name, *resale, *bomCount, *opCount
				if !seenArt[*artID] {
					seenArt[*artID] = true
					articleIDs = append(articleIDs, *artID)
				}
			}
			linesByOrder[oid] = append(linesByOrder[oid], l)
		}
		lrows.Close()
	}

	type cwork struct {
		stage    string
		share    float64
		name     string
		accepted bool
	}
	worksByOrder := map[string][]cwork{}
	if len(ids) > 0 {
		wrows, err := h.pool.Query(ctx, "SELECT w.order_id, w.routing_stage, w.share, ct.name, w.accepted_at FROM contractor_works w JOIN contractors ct ON ct.id = w.contractor_id WHERE w.order_id = ANY($1)", ids)
		if err != nil {
			dbErr(c, err)
			return
		}
		for wrows.Next() {
			var oid string
			var w cwork
			var share decimal.Decimal
			var acceptedAt *time.Time
			if err := wrows.Scan(&oid, &w.stage, &share, &w.name, &acceptedAt); err != nil {
				wrows.Close()
				dbErr(c, err)
				return
			}
			w.share, w.accepted = share.InexactFloat64(), acceptedAt != nil
			worksByOrder[oid] = append(worksByOrder[oid], w)
		}
		wrows.Close()
	}

	// Нормативные часы изделия — сумма по всем видам работ
	normByArticle := map[string]float64{}
	if len(articleIDs) > 0 {
		nrows, err := h.pool.Query(ctx, "SELECT article_id, workers, hours_per_unit FROM routing_operations WHERE article_id = ANY($1)", articleIDs)
		if err != nil {
			dbErr(c, err)
			return
		}
		for nrows.Next() {
			var aid string
			var workers, hpu decimal.Decimal
			if err := nrows.Scan(&aid, &workers, &hpu); err != nil {
				nrows.Close()
				dbErr(c, err)
				return
			}
			normByArticle[aid] += workers.InexactFloat64() * hpu.InexactFloat64()
		}
		nrows.Close()
	}

	search := strings.ToLower(strings.TrimSpace(c.Query("search")))
	rows := []gin.H{}
	totalProducts, doneProducts, blockedProducts := 0, 0, 0
	for _, o := range orders {
		var productLines []line
		resaleCount := 0
		for _, l := range linesByOrder[o.id] {
			if l.articleID != nil && l.resale {
				resaleCount++
			}
			if l.articleID != nil && !l.resale {
				productLines = append(productLines, l)
			}
		}
		if len(productLines) == 0 {
			continue
		}
		codeSeen := map[string]int{}
		for _, l := range productLines {
			codeSeen[l.code]++
		}
		contractors := []gin.H{}
		for _, w := range worksByOrder[o.id] {
			contractors = append(contractors, gin.H{"name": w.name, "sharePct": common.JsRound(w.share * 100), "isAccepted": w.accepted})
		}
		products := make([]gin.H, 0, len(productLines))
		done, blocked := 0, 0
		matches := search == "" || strings.Contains(strings.ToLower(o.number), search) || strings.Contains(strings.ToLower(customerName[o.customerID]), search)
		for idx, l := range productLines {
			status := "NOT_STARTED"
			if st, ok := statusByLine[l.id]; ok {
				status = st
			}
			var actualHours *float64
			if v, ok := hoursByLine[l.id]; ok {
				actualHours = &v
			}
			missingBom, missingNorms := l.bomCount == 0, l.opCount == 0
			if status == "DONE" {
				done++
			}
			if missingBom || missingNorms {
				blocked++
			}
			if !matches && (strings.Contains(strings.ToLower(l.code), search) || strings.Contains(strings.ToLower(l.name), search)) {
				matches = true
			}
			products = append(products, gin.H{
				"id": l.id, "lineNo": idx + 1, "isDuplicateCode": codeSeen[l.code] > 1,
				"articleId": l.artID, "articleCode": l.code, "articleName": l.name, "siteCode": l.siteCode,
				"missingBom": missingBom, "missingNorms": missingNorms,
				"qty": l.qty, "unit": l.unit, "status": status,
				"normHours": round3(normByArticle[l.artID] * l.qty), "actualHours": actualHours,
				"contractors": contractors,
			})
		}
		if !matches {
			continue
		}
		var cname interface{}
		if n, ok := customerName[o.customerID]; ok {
			cname = n
		}
		rows = append(rows, gin.H{
			"id": o.id, "orderNumber": o.number, "customerName": cname, "status": o.status,
			"plannedShipmentDate": o.planned, "overdueDays": o.overdue, "products": products,
			"doneCount": done, "totalProducts": len(products), "blockedCount": blocked, "resaleCount": resaleCount,
		})
		totalProducts += len(products)
		doneProducts += done
		blockedProducts += blocked
	}

	// Открытые заявки на подряд — на уровне ответа: привязать заявку к заказу
	// заранее нельзя, мастер разносит её сам
	openRequests := []gin.H{}
	rrows, err := h.pool.Query(ctx, "SELECT "+crCols+", ct.name FROM contractor_requests r LEFT JOIN contractors ct ON ct.id = r.contractor_id WHERE r.status IN ('SENT','ACCEPTED','ALLOCATED') AND r.contractor_id IS NOT NULL ORDER BY r.created_at DESC LIMIT 50")
	if err != nil {
		dbErr(c, err)
		return
	}
	type reqLite struct {
		r    contractorRequestRow
		name *string
	}
	var reqs []reqLite
	var reqIDs []string
	for rrows.Next() {
		var rl reqLite
		var stage string
		r := &rl.r
		if err := rrows.Scan(&r.ID, &r.Number, &stage, &r.Description, &r.RateType, &r.PlannedQty, &r.Rate, &r.EstimatedAmount, &r.ContractorID, &r.WorkLocation,
			&r.PlannedHours, &r.Status, &r.BitrixDealID, &r.BitrixSentAt, &r.ActualQty, &r.ActualAmount, &r.AcceptedAt, &r.AcceptedByID, &r.PaymentDocumentID,
			&r.CreatedByID, &r.CreatedAt, &r.UpdatedAt, &r.Note, &rl.name); err != nil {
			rrows.Close()
			dbErr(c, err)
			return
		}
		r.RoutingStage = models.RoutingStageDBToAPI(stage)
		reqs = append(reqs, rl)
		reqIDs = append(reqIDs, r.ID)
	}
	rrows.Close()
	allocatedBy := map[string]float64{}
	if len(reqIDs) > 0 {
		arows, err := h.pool.Query(ctx, "SELECT request_id, actual_qty FROM contractor_works WHERE request_id = ANY($1)", reqIDs)
		if err != nil {
			dbErr(c, err)
			return
		}
		for arows.Next() {
			var rid string
			var q *decimal.Decimal
			if err := arows.Scan(&rid, &q); err != nil {
				arows.Close()
				dbErr(c, err)
				return
			}
			allocatedBy[rid] += fval(q)
		}
		arows.Close()
	}
	for _, rl := range reqs {
		r := rl.r
		allocated := allocatedBy[r.ID]
		var target *float64
		if r.ActualQty != nil {
			target = fnum(r.ActualQty)
		} else if r.PlannedQty != nil {
			target = fnum(r.PlannedQty)
		}
		var remaining *float64
		if target != nil {
			v := round3(max0(*target - allocated))
			remaining = &v
		}
		// Разнесённая до конца заявка мастеру больше не нужна
		if remaining != nil && !(*remaining > 0) {
			continue
		}
		openRequests = append(openRequests, gin.H{
			"id": r.ID, "number": r.Number, "routingStage": r.RoutingStage, "description": r.Description,
			"contractorName": rl.name, "rateType": r.RateType, "unit": rateUnits[r.RateType],
			"allocatedQty": round3(allocated), "targetQty": target, "remainingQty": remaining, "isAccepted": r.AcceptedAt.Valid,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"orders": rows, "total": len(rows), "totalProducts": totalProducts, "doneProducts": doneProducts,
		"waitingProducts": totalProducts - doneProducts, "blockedProducts": blockedProducts, "openRequests": openRequests,
	})
}

func max0(v float64) float64 {
	if v < 0 {
		return 0
	}
	return v
}

// matrixArticle — объект article той выборки, которая создала строку:
// из плана/выпуска — {id, articleCode, name}, из потребности заказов —
// ещё isMaterialResale (select оригинала различается, строка хранит первый)
type matrixArticle struct {
	ID               string `json:"id"`
	ArticleCode      string `json:"articleCode"`
	Name             string `json:"name"`
	IsMaterialResale *bool  `json:"isMaterialResale,omitempty"`
}

type matrixCell struct {
	Plan   float64 `json:"plan"`
	Fact   float64 `json:"fact"`
	Demand float64 `json:"demand"`
}

type matrixRow struct {
	article matrixArticle
	cells   map[string]*matrixCell
}

// Matrix — GET /production-plan/matrix?year= — план / факт / потребность
// по месяцам. Факт и потребность считаются на лету, храним только план.
func (h *ProductionPlanHandler) Matrix(c *gin.Context) {
	year, _ := strconv.Atoi(strings.TrimSpace(c.Query("year")))
	if year == 0 {
		year = time.Now().In(time.Local).Year()
	}
	months := make([]string, 12)
	for i := range months {
		months[i] = strconv.Itoa(year) + "-" + pad2(i+1)
	}
	ctx := c.Request.Context()
	fallback := gin.H{"year": year, "months": months, "data": []interface{}{}}

	// Окно — календарный год по местным датам [1 янв, 1 янв следующего).
	// У NestJS здесь был сдвиг на день (Prisma усекала локальную полночь до
	// даты по UTC → окно с 31 декабря прошлого года, и движение за это число
	// роняло матрицу ошибкой ключа месяца); исправлено 06.09.2026.
	from := time.Date(year, 1, 1, 0, 0, 0, 0, time.Local).Format("2006-01-02")
	to := time.Date(year+1, 1, 1, 0, 0, 0, 0, time.Local).Format("2006-01-02")

	rows := map[string]*matrixRow{}
	var order []string
	rowFor := func(a matrixArticle) *matrixRow {
		r, ok := rows[a.ID]
		if !ok {
			r = &matrixRow{article: a, cells: map[string]*matrixCell{}}
			for _, m := range months {
				r.cells[m] = &matrixCell{}
			}
			rows[a.ID] = r
			order = append(order, a.ID)
		}
		return r
	}

	prows, err := h.pool.Query(ctx, "SELECT p.period_key, p.qty_to_produce, a.id, a.article_code, a.name FROM production_plan_items p JOIN articles a ON a.id = p.article_id WHERE p.period_type = 'MONTH' AND p.period_key = ANY($1)", months)
	if err != nil {
		common.DebugLog(err)
		c.JSON(http.StatusOK, fallback)
		return
	}
	for prows.Next() {
		var key string
		var qty decimal.Decimal
		var a matrixArticle
		if err := prows.Scan(&key, &qty, &a.ID, &a.ArticleCode, &a.Name); err != nil {
			prows.Close()
			dbErr(c, err)
			return
		}
		rowFor(a).cells[key].Plan = qty.InexactFloat64()
	}
	prows.Close()

	// Факт: выпуск ГП по месяцам; изделие без плана тоже показываем
	frows, err := h.pool.Query(ctx, "SELECT item_id, qty, movement_date FROM finished_goods_movements WHERE movement_type = $1 AND movement_date >= $2::date AND movement_date < $3::date", models.StockMovementTypeAPIToDB("FROM_PRODUCTION"), from, to)
	if err != nil {
		dbErr(c, err)
		return
	}
	type release struct {
		itemID string
		qty    float64
		key    string
	}
	var releases []release
	for frows.Next() {
		var r release
		var qty decimal.Decimal
		var d time.Time
		if err := frows.Scan(&r.itemID, &qty, &d); err != nil {
			frows.Close()
			dbErr(c, err)
			return
		}
		r.qty, r.key = qty.InexactFloat64(), d.Format("2006-01")
		releases = append(releases, r)
	}
	frows.Close()
	for _, m := range releases {
		r, ok := rows[m.itemID]
		if !ok {
			var a matrixArticle
			err := h.pool.QueryRow(ctx, "SELECT id, article_code, name FROM articles WHERE id = $1", m.itemID).Scan(&a.ID, &a.ArticleCode, &a.Name)
			if err == pgx.ErrNoRows {
				continue
			} else if err != nil {
				dbErr(c, err)
				return
			}
			r = rowFor(a)
		}
		cell, ok := r.cells[m.key]
		if !ok {
			// Страховка: окно выше совпадает с месяцами матрицы, сюда попадать
			// нечему; если движение всё же вне года — пропускаем, а не роняем экран
			continue
		}
		cell.Fact += m.qty
	}

	// Потребность: позиции активных заказов по месяцу плана вывоза
	drows, err := h.pool.Query(ctx, "SELECT ol.qty, o.planned_shipment_date, a.id, a.article_code, a.name, a.is_material_resale FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN articles a ON a.id = ol.article_id WHERE ol.article_id IS NOT NULL AND o.status IN "+activeStatuses+" AND o.planned_shipment_date >= $1::date AND o.planned_shipment_date < $2::date", from, to)
	if err != nil {
		dbErr(c, err)
		return
	}
	type demand struct {
		qty    float64
		key    string
		a      matrixArticle
		resale bool
	}
	var demands []demand
	for drows.Next() {
		var d demand
		var qty decimal.Decimal
		var date time.Time
		if err := drows.Scan(&qty, &date, &d.a.ID, &d.a.ArticleCode, &d.a.Name, &d.resale); err != nil {
			drows.Close()
			dbErr(c, err)
			return
		}
		d.qty, d.key = qty.InexactFloat64(), date.Format("2006-01")
		demands = append(demands, d)
	}
	drows.Close()
	for _, d := range demands {
		if d.resale {
			continue
		}
		resale := d.resale
		d.a.IsMaterialResale = &resale
		r := rowFor(d.a)
		cell, ok := r.cells[d.key]
		if !ok {
			dbErr(c, errMatrixKey(d.key))
			return
		}
		cell.Demand += d.qty
	}

	col := collate.New(language.Und)
	sort.SliceStable(order, func(i, j int) bool {
		return col.CompareString(rows[order[i]].article.ArticleCode, rows[order[j]].article.ArticleCode) < 0
	})
	data := make([]gin.H, 0, len(order))
	for _, id := range order {
		r := rows[id]
		cells := gin.H{}
		for _, m := range months {
			cl := r.cells[m]
			cells[m] = gin.H{"plan": round3(cl.Plan), "fact": round3(cl.Fact), "demand": round3(cl.Demand)}
		}
		data = append(data, gin.H{"article": r.article, "cells": cells})
	}
	c.JSON(http.StatusOK, gin.H{"year": year, "months": months, "data": data})
}

type matrixKeyError struct{ key string }

func (e matrixKeyError) Error() string {
	return "matrix: месяц " + e.key + " вне года — оригинал падает TypeError"
}
func errMatrixKey(key string) error { return matrixKeyError{key: key} }

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

var periodKeyRe = regexp.MustCompile(`^\d{4}-\d{2}$`)

// SetPlanCell — PATCH /production-plan/matrix — ноль стирает запись.
func (h *ProductionPlanHandler) SetPlanCell(c *gin.Context) {
	var body struct {
		ArticleID string          `json:"articleId"`
		PeriodKey string          `json:"periodKey"`
		Qty       json.RawMessage `json:"qty"`
	}
	_ = c.ShouldBindJSON(&body)
	if !periodKeyRe.MatchString(body.PeriodKey) {
		common.BadRequest(c, "INVALID_PERIOD", "Период — в формате ГГГГ-ММ")
		return
	}
	ctx := c.Request.Context()
	var articleCode string
	if err := h.pool.QueryRow(ctx, "SELECT article_code FROM articles WHERE id = $1", body.ArticleID).Scan(&articleCode); err == pgx.ErrNoRows {
		common.NotFound(c, "Article "+body.ArticleID+" not found")
		return
	} else if err != nil {
		dbErr(c, err)
		return
	}
	qty := jsNumber(body.Qty)
	if !(qty >= 0) {
		common.BadRequest(c, "INVALID_QTY", "План не может быть отрицательным")
		return
	}
	if qty == 0 {
		if _, err := h.pool.Exec(ctx, "DELETE FROM production_plan_items WHERE article_id = $1 AND period_type = 'MONTH' AND period_key = $2", body.ArticleID, body.PeriodKey); err != nil {
			dbErr(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"articleCode": articleCode, "periodKey": body.PeriodKey, "qty": 0, "cleared": true})
		return
	}
	if _, err := h.pool.Exec(ctx, "INSERT INTO production_plan_items (id, article_id, period_type, period_key, qty_to_produce) VALUES ($1,$2,'MONTH',$3,$4) ON CONFLICT (article_id, period_type, period_key) DO UPDATE SET qty_to_produce = EXCLUDED.qty_to_produce",
		uuid.NewString(), body.ArticleID, body.PeriodKey, qty); err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"articleCode": articleCode, "periodKey": body.PeriodKey, "qty": qty})
}

// Weekly — GET /production-plan/weekly — агрегат активных заказов по
// ISO-неделе плановой отгрузки; заказы без даты — отдельной строкой.
func (h *ProductionPlanHandler) Weekly(c *gin.Context) {
	rows, err := h.pool.Query(c.Request.Context(), `
		SELECT date_trunc('week', o.planned_shipment_date)::date AS week_start,
		       count(DISTINCT o.id) AS orders_count,
		       coalesce(sum(ol.qty), 0) AS total_qty,
		       coalesce(sum(ol.reserved_qty), 0) AS reserved_qty,
		       -- Отгружено — по актам, а не по колонке: она заполнена у 2
		       -- строк из 1814, потому что её пишет только форма внутри
		       -- сервиса, а 228 актов приехали импортом из 1С (04.09.2026)
		       coalesce(sum(coalesce(nullif(sh.shipped, 0), ol.shipped_qty)), 0) AS shipped_qty
		FROM orders o
		LEFT JOIN order_lines ol ON ol.order_id = o.id
		LEFT JOIN LATERAL (
		      SELECT coalesce(sum(al.qty), 0) AS shipped
		        FROM acceptance_act_lines al
		        JOIN orders ao ON ao.order_number = al.order_number
		       WHERE ao.id = ol.order_id AND al.article_id = ol.article_id
		) sh ON TRUE
		WHERE o.status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP')
		GROUP BY 1
		ORDER BY 1 NULLS LAST`)
	if err != nil {
		common.DebugLog(err)
		c.JSON(http.StatusOK, gin.H{"weeks": []interface{}{}, "noDate": nil})
		return
	}
	defer rows.Close()
	weeks := []gin.H{}
	var noDate interface{}
	for rows.Next() {
		var weekStart common.PDate
		var count int64
		var total, reserved, shipped decimal.Decimal
		if err := rows.Scan(&weekStart, &count, &total, &reserved, &shipped); err != nil {
			dbErr(c, err)
			return
		}
		t, r, s := total.InexactFloat64(), reserved.InexactFloat64(), shipped.InexactFloat64()
		w := gin.H{
			"weekStart": weekStart, "ordersCount": count, "totalQty": t, "reservedQty": r, "shippedQty": s,
			"toProduce": max0(t - r - s),
		}
		if !weekStart.Valid {
			if noDate == nil {
				noDate = w
			}
			continue
		}
		weeks = append(weeks, w)
	}
	c.JSON(http.StatusOK, gin.H{"weeks": weeks, "noDate": noDate})
}

// FindOne — GET /production-plan/:id — этап с заказом, заказчиком и позициями.
func (h *ProductionPlanHandler) FindOne(c *gin.Context) {
	id := c.Param("id")
	ctx := c.Request.Context()
	s, err := scanStageRaw(h.pool.QueryRow(ctx, "SELECT "+stageCols+" FROM production_stages s WHERE s.id = $1", id))
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Production stage "+id+" not found")
		return
	} else if err != nil {
		dbErr(c, err)
		return
	}
	ord, err := h.loadOrder(c, s.OrderID)
	if err != nil {
		dbErr(c, err)
		return
	}
	cu, err := catalog.ScanCustomer(h.pool.QueryRow(ctx, "SELECT "+catalog.CustomerCols+" FROM customers WHERE id = $1", ord.CustomerID))
	if err != nil {
		dbErr(c, err)
		return
	}
	lines, err := loadOrderLines(ctx, h.pool, []string{s.OrderID})
	if err != nil {
		dbErr(c, err)
		return
	}
	linesOut := []gin.H{}
	for _, l := range lines[s.OrderID] {
		linesOut = append(linesOut, lineRawJSON(l))
	}
	o := orderRawJSON(ord)
	o["customer"] = cu
	o["orderLines"] = linesOut
	m := stageRawJSON(s)
	m["order"] = o
	c.JSON(http.StatusOK, m)
}

// Create — POST /production-plan — prisma.productionStage.create({data: body}).
func (h *ProductionPlanHandler) Create(c *gin.Context) {
	body := rawBody{}
	_ = json.NewDecoder(c.Request.Body).Decode(&body)
	code := "undefined"
	if v, ok := body.str("stageCode"); ok {
		code = v
	}
	var routing *string
	if v, ok := body.str("routingStage"); ok {
		routing = &v
	}
	if msg := orderstate.StageShapeError(code, routing); msg != "" {
		common.BadRequest(c, "INVALID_STAGE_CODE", msg)
		return
	}
	cols, vals, args := []string{"id"}, []string{"$1"}, []interface{}{uuid.NewString()}
	add := func(col string, v interface{}) {
		args = append(args, v)
		cols = append(cols, col)
		vals = append(vals, "$"+itoa(len(args)))
	}
	for k, raw := range body {
		var s *string
		var str string
		if json.Unmarshal(raw, &str) == nil {
			s = &str
		}
		switch k {
		case "orderId":
			add("order_id", s)
		case "orderLineId":
			add("order_line_id", s)
		case "stageCode":
			add("stage_code", models.OrderStageCodeAPIToDB(code))
		case "routingStage":
			if s != nil {
				add("routing_stage", models.RoutingStageAPIToDB(*s))
			} else {
				add("routing_stage", nil)
			}
		case "status":
			if s != nil {
				add("status", models.StageStatusAPIToDB(*s))
			} else {
				add("status", nil)
			}
		case "actualWorkers", "actualHours":
			col := "actual_workers"
			if k == "actualHours" {
				col = "actual_hours"
			}
			if strings.TrimSpace(string(raw)) == "null" {
				add(col, nil)
			} else {
				add(col, jsNumber(raw))
			}
		case "legacyStageCode":
			add("legacy_stage_code", s)
		case "completedAt":
			if s != nil {
				if t, ok := parseJSDateAny(*s); ok {
					add("completed_at", t)
				} else {
					dbErr(c, errMatrixKey("completedAt: "+*s))
					return
				}
			} else {
				add("completed_at", nil)
			}
		case "completedById":
			add("completed_by_id", s)
		case "defectPhotoUrl":
			add("defect_photo_url", s)
		default:
			// Неизвестное поле — PrismaClientValidationError → 500
			dbErr(c, errMatrixKey("unknown field "+k))
			return
		}
	}
	ctx := c.Request.Context()
	s, err := scanStageRaw(h.pool.QueryRow(ctx, "INSERT INTO production_stages AS s ("+strings.Join(cols, ", ")+") VALUES ("+strings.Join(vals, ", ")+") RETURNING "+stageCols, args...))
	if err != nil {
		dbErr(c, err)
		return
	}
	ord, err := h.loadOrder(c, s.OrderID)
	if err != nil {
		dbErr(c, err)
		return
	}
	m := stageRawJSON(s)
	m["order"] = orderRawJSON(ord)
	c.JSON(http.StatusCreated, m)
}

func parseJSDateAny(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// UpdateStatus — PATCH /production-plan/:id/status
func (h *ProductionPlanHandler) UpdateStatus(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Status string `json:"status"`
	}
	_ = c.ShouldBindJSON(&body)
	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM production_stages WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Stage "+id+" not found")
		return
	} else if err != nil {
		dbErr(c, err)
		return
	}
	s, err := scanStageRaw(h.pool.QueryRow(ctx, "UPDATE production_stages AS s SET status = $1 WHERE id = $2 RETURNING "+stageCols, models.StageStatusAPIToDB(body.Status), id))
	if err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusOK, stageRawJSON(s))
}
