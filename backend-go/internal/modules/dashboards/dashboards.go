// Перенос dashboards.controller.ts — ролевые виджеты, экран директора,
// ряды по месяцам, загрузка цеха, деньги, сводки.
package dashboards

import (
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
)

type Handler struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Handler { return &Handler{pool: pool} }

func fail(c *gin.Context, err error) {
	common.DebugLog(err)
	common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
}

// jsRound — Math.round: половинки вверх (к +∞), не «от нуля».
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

var routingStages = []string{"CUTTING", "ASSEMBLY", "PAINTING"}

type orderBrief struct {
	ID                  string       `json:"id"`
	OrderNumber         string       `json:"orderNumber"`
	OverdueDays         int          `json:"overdueDays,omitempty"`
	PlannedShipmentDate common.PDate `json:"plannedShipmentDate"`
	Customer            gin.H        `json:"customer"`
}

// RoleWidgets — GET /dashboards/role-widgets
func (h *Handler) RoleWidgets(c *gin.Context) {
	user := authpkg.CurrentUser(c)
	perms := authpkg.PermissionsForRoles(user.Roles)
	has := func(p string) bool { return authpkg.HasPermission(perms, p) }
	ctx := c.Request.Context()
	widgets := gin.H{}

	if has("order.core:read") {
		rows, err := h.pool.Query(ctx, "SELECT status, count(*) FROM orders GROUP BY status")
		if err != nil {
			fail(c, err)
			return
		}
		funnel := []gin.H{}
		for rows.Next() {
			var st string
			var n int
			if err := rows.Scan(&st, &n); err != nil {
				rows.Close()
				fail(c, err)
				return
			}
			funnel = append(funnel, gin.H{"status": st, "count": n})
		}
		rows.Close()
		widgets["orderFunnel"] = funnel
		var cnt int
		if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM orders WHERE overdue_days > 0").Scan(&cnt); err != nil {
			fail(c, err)
			return
		}
		top, err := h.orderTop(c, "SELECT o.id, o.order_number, o.overdue_days, o.planned_shipment_date, cu.name FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE o.overdue_days > 0 ORDER BY o.overdue_days DESC LIMIT 5", true, true)
		if err != nil {
			fail(c, err)
			return
		}
		widgets["overdueOrders"] = gin.H{"count": cnt, "top": top}
	}
	if has("order.commercial:read") {
		var n int
		var sum *float64
		if err := h.pool.QueryRow(ctx, "SELECT count(*), sum(balance_due) FROM order_lines WHERE balance_due > 0").Scan(&n, &sum); err != nil {
			fail(c, err)
			return
		}
		total := 0.0
		if sum != nil {
			total = *sum
		}
		widgets["awaitingPayment"] = gin.H{"linesCount": n, "totalDue": total}
	}
	if has("routing.norm:read") {
		var cnt int
		if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM articles a WHERE a.is_active AND NOT EXISTS (SELECT 1 FROM routing_operations r WHERE r.article_id = a.id)").Scan(&cnt); err != nil {
			fail(c, err)
			return
		}
		rows, err := h.pool.Query(ctx, "SELECT a.id, a.article_code, a.name FROM articles a WHERE a.is_active AND NOT EXISTS (SELECT 1 FROM routing_operations r WHERE r.article_id = a.id) ORDER BY a.updated_at DESC LIMIT 5")
		if err != nil {
			fail(c, err)
			return
		}
		top := []gin.H{}
		for rows.Next() {
			var id, code, name string
			if err := rows.Scan(&id, &code, &name); err != nil {
				rows.Close()
				fail(c, err)
				return
			}
			top = append(top, gin.H{"id": id, "articleCode": code, "name": name})
		}
		rows.Close()
		widgets["specsWithoutNorms"] = gin.H{"count": cnt, "top": top}
	}
	if has("article.cost:read") {
		rows, err := h.pool.Query(ctx, "SELECT id, article_code, name, approved_price, spec_price, price_deviation_pct FROM articles WHERE approved_price > 0 AND spec_price > 0 AND is_active ORDER BY ABS(price_deviation_pct) DESC LIMIT 5")
		if err != nil {
			fail(c, err)
			return
		}
		top := []gin.H{}
		for rows.Next() {
			var id, code, name string
			var ap, sp, dev float64
			if err := rows.Scan(&id, &code, &name, &ap, &sp, &dev); err != nil {
				rows.Close()
				fail(c, err)
				return
			}
			top = append(top, gin.H{"id": id, "articleCode": code, "name": name, "approvedPrice": ap, "specPrice": sp, "deviationPct": dev})
		}
		rows.Close()
		widgets["priceDeviations"] = top
	}
	if has("material.core:read") {
		rows, err := h.pool.Query(ctx, "SELECT status, count(*) FROM purchase_requests WHERE status IN ('DRAFT','APPROVED','ORDERED') GROUP BY status")
		if err != nil {
			fail(c, err)
			return
		}
		out := []gin.H{}
		for rows.Next() {
			var st string
			var n int
			if err := rows.Scan(&st, &n); err != nil {
				rows.Close()
				fail(c, err)
				return
			}
			out = append(out, gin.H{"status": st, "count": n})
		}
		rows.Close()
		widgets["procurement"] = out
	}
	if has("order.logistics:read") {
		var cnt int
		if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM orders WHERE status = 'READY_TO_SHIP'").Scan(&cnt); err != nil {
			fail(c, err)
			return
		}
		top, err := h.orderTop(c, "SELECT o.id, o.order_number, 0, o.planned_shipment_date, cu.name FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE o.status = 'READY_TO_SHIP' ORDER BY o.planned_shipment_date ASC LIMIT 5", false, true)
		if err != nil {
			fail(c, err)
			return
		}
		widgets["readyToShip"] = gin.H{"count": cnt, "top": top}
	}
	var family interface{}
	if len(user.Roles) > 0 {
		family = user.Roles[0]
	}
	c.JSON(http.StatusOK, gin.H{"family": family, "widgets": widgets})
}

func (h *Handler) orderTop(c *gin.Context, sql string, withOverdue, withPlanned bool) ([]gin.H, error) {
	rows, err := h.pool.Query(c.Request.Context(), sql)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, num, cname string
		var overdue int
		var planned common.PDate
		if err := rows.Scan(&id, &num, &overdue, &planned, &cname); err != nil {
			return nil, err
		}
		row := gin.H{"id": id, "orderNumber": num, "customer": gin.H{"name": cname}}
		if withOverdue {
			row["overdueDays"] = overdue
		}
		if withPlanned {
			row["plannedShipmentDate"] = planned
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Director — GET /dashboards/director (director/admin)
func (h *Handler) Director(c *gin.Context) {
	ctx := c.Request.Context()
	now := time.Now().UTC()
	soon := now.Add(3 * 24 * time.Hour)
	type ao struct {
		ID, OrderNumber, Status string
		Planned                 common.PDate
		Overdue                 int
		Customer                string
	}
	rows, err := h.pool.Query(ctx, "SELECT o.id, o.order_number, o.status, o.planned_shipment_date, o.overdue_days, cu.name FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE o.status IN ('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP') AND o.is_archived = false")
	if err != nil {
		fail(c, err)
		return
	}
	var active []ao
	for rows.Next() {
		var o ao
		if err := rows.Scan(&o.ID, &o.OrderNumber, &o.Status, &o.Planned, &o.Overdue, &o.Customer); err != nil {
			rows.Close()
			fail(c, err)
			return
		}
		active = append(active, o)
	}
	rows.Close()
	crows, err := h.pool.Query(ctx, `SELECT oc.order_id, oc.order_line_id, oc.version, oc.total_cost, oc.price, oc.margin FROM order_costings oc
		JOIN order_lines ol ON ol.id = oc.order_line_id JOIN orders o ON o.id = ol.order_id
		WHERE oc.status = 'APPROVED' AND o.is_archived = false AND o.status IN ('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP')`)
	if err != nil {
		fail(c, err)
		return
	}
	type cst struct {
		OrderID             string
		Version             int
		Cost, Price, Margin float64
	}
	latest := map[string]cst{}
	var lineOrder []string
	for crows.Next() {
		var x cst
		var lineID string
		if err := crows.Scan(&x.OrderID, &lineID, &x.Version, &x.Cost, &x.Price, &x.Margin); err != nil {
			crows.Close()
			fail(c, err)
			return
		}
		prev, ok := latest[lineID]
		if !ok {
			lineOrder = append(lineOrder, lineID)
		}
		if !ok || x.Version > prev.Version {
			latest[lineID] = x
		}
	}
	crows.Close()
	type agg struct{ Cost, Price, Margin float64 }
	byOrder := map[string]*agg{}
	var tc, tp, tm float64
	for _, lid := range lineOrder {
		x := latest[lid]
		a, ok := byOrder[x.OrderID]
		if !ok {
			a = &agg{}
			byOrder[x.OrderID] = a
		}
		a.Cost += x.Cost
		a.Price += x.Price
		a.Margin += x.Margin
	}
	for _, a := range byOrder {
		tc += a.Cost
		tp += a.Price
		tm += a.Margin
	}
	type om struct {
		H   gin.H
		Pct *float64
	}
	oms := make([]om, 0, len(active))
	for _, o := range active {
		row := gin.H{"id": o.ID, "orderNumber": o.OrderNumber, "status": o.Status, "plannedShipmentDate": o.Planned, "overdueDays": o.Overdue, "customer": gin.H{"name": o.Customer}}
		m, ok := byOrder[o.ID]
		var pct *float64
		if ok && m.Price > 0 {
			v := (m.Margin / m.Price) * 100
			pct = &v
		}
		if ok {
			row["totalCost"], row["totalPrice"], row["margin"] = jsRound(m.Cost), jsRound(m.Price), jsRound(m.Margin)
		} else {
			row["totalCost"], row["totalPrice"], row["margin"] = nil, nil, nil
		}
		health := "NO_COSTING"
		if pct != nil {
			row["marginPct"] = jsRound(*pct*10) / 10
			switch {
			case *pct >= 30:
				health = "OK"
			case *pct >= 25:
				health = "WARN"
			default:
				health = "CRITICAL"
			}
		} else {
			row["marginPct"] = nil
		}
		row["marginHealth"] = health
		oms = append(oms, om{H: row, Pct: pct})
	}
	key := func(p *float64) float64 {
		if p == nil {
			return 999
		}
		return *p
	}
	sort.SliceStable(oms, func(i, j int) bool { return key(oms[i].Pct) < key(oms[j].Pct) })
	shown := len(oms)
	if shown > 50 {
		shown = 50
	}
	orders := make([]gin.H, 0, shown)
	for _, x := range oms[:shown] {
		orders = append(orders, x.H)
	}
	var actualPct interface{}
	if tp > 0 {
		actualPct = jsRound((tm/tp)*1000) / 10
	}
	count := func(sql string, args ...interface{}) (int, error) {
		var n int
		err := h.pool.QueryRow(ctx, sql, args...).Scan(&n)
		return n, err
	}
	pendingOverrides, err := count("SELECT count(*) FROM batch_override_requests WHERE status = 'PENDING'")
	if err != nil {
		fail(c, err)
		return
	}
	pendingReviews, _ := count("SELECT count(*) FROM price_review_requests WHERE status = 'PENDING'")
	nomStuck, _ := count("SELECT count(*) FROM nomenclature_requests WHERE status IN ('PENDING','APPROVED','WAITING_1C') AND sla_due_at < $1", now)
	quarantine, _ := count("SELECT count(*) FROM material_batches WHERE price_anomaly = true AND anomaly_cleared_at IS NULL")
	expiring, _ := count("SELECT count(*) FROM batch_reservations WHERE status = 'ACTIVE' AND expires_at < $1", soon)
	inbox, _ := count("SELECT count(*) FROM orders WHERE status = 'NEW' AND is_archived = false")
	var sumUnpaid, sumTotal, sumPaid *float64
	if err := h.pool.QueryRow(ctx, "SELECT sum(unpaid_amount), sum(total_amount), sum(paid_amount) FROM payment_documents").Scan(&sumUnpaid, &sumTotal, &sumPaid); err != nil {
		fail(c, err)
		return
	}
	nz := func(p *float64) float64 {
		if p == nil {
			return 0
		}
		return *p
	}
	prows, err := h.pool.Query(ctx, "SELECT status, count(*) FROM orders WHERE is_archived = false GROUP BY status")
	if err != nil {
		fail(c, err)
		return
	}
	pipeline := []gin.H{}
	for prows.Next() {
		var st string
		var n int
		if err := prows.Scan(&st, &n); err != nil {
			prows.Close()
			fail(c, err)
			return
		}
		pipeline = append(pipeline, gin.H{"status": st, "count": n})
	}
	prows.Close()
	overdue, err := h.orderTop(c, "SELECT o.id, o.order_number, o.overdue_days, NULL::date, cu.name FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE o.overdue_days > 0 AND o.is_archived = false ORDER BY o.overdue_days DESC LIMIT 5", true, false)
	if err != nil {
		fail(c, err)
		return
	}
	// Список — топ-5, счётчик — по всем: вкладка «Просрочено» подписывалась
	// длиной списка («5» при 56 просроченных, 06.09.2026)
	var overdueCount int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM orders WHERE overdue_days > 0 AND is_archived = false").Scan(&overdueCount); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"overdueCount": overdueCount,
		"margin": gin.H{"targetPct": 35, "totalPrice": jsRound(tp), "totalCost": jsRound(tc), "totalMargin": jsRound(tm), "actualPct": actualPct,
			"orders": orders, "ordersTotal": len(oms), "ordersShown": shown},
		"needsDecision": gin.H{"batchOverrides": pendingOverrides, "priceReviews": pendingReviews, "nomenclatureStuck": nomStuck,
			"quarantineBatches": quarantine, "expiringReservations": expiring, "inboxOrders": inbox},
		"money":    gin.H{"totalContracted": nz(sumTotal), "totalPaid": nz(sumPaid), "totalUnpaid": nz(sumUnpaid)},
		"pipeline": pipeline,
		"overdue":  overdue,
	})
}

var ruShortMonths = []string{"янв", "февр", "март", "апр", "май", "июнь", "июль", "авг", "сент", "окт", "нояб", "дек"}

// MonthlySeries — GET /dashboards/monthly-series — последние 6 месяцев по локальным границам.
func (h *Handler) MonthlySeries(c *gin.Context) {
	ctx := c.Request.Context()
	now := time.Now().In(time.Local)
	months := []gin.H{}
	for i := 5; i >= 0; i-- {
		from := time.Date(now.Year(), now.Month()-time.Month(i), 1, 0, 0, 0, 0, time.Local)
		to := time.Date(now.Year(), now.Month()-time.Month(i)+1, 1, 0, 0, 0, 0, time.Local)
		// Границы — календарные даты по местному времени. У NestJS здесь был
		// сдвиг на день (Prisma усекала локальную полночь до даты по UTC, и окно
		// начиналось с последнего дня прошлого месяца); после снятия Nest
		// повторять его незачем — исправлено 06.09.2026.
		fromT, toT := from.Format("2006-01-02"), to.Format("2006-01-02")
		var in, planned, shipped int
		if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM orders WHERE request_date >= $1::date AND request_date < $2::date", fromT, toT).Scan(&in); err != nil {
			fail(c, err)
			return
		}
		if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM orders WHERE planned_shipment_date >= $1::date AND planned_shipment_date < $2::date", fromT, toT).Scan(&planned); err != nil {
			fail(c, err)
			return
		}
		if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM orders WHERE actual_shipment_date >= $1::date AND actual_shipment_date < $2::date", fromT, toT).Scan(&shipped); err != nil {
			fail(c, err)
			return
		}
		months = append(months, gin.H{"label": ruShortMonths[from.Month()-1], "ordersIn": in, "planned": planned, "shipped": shipped})
	}
	c.JSON(http.StatusOK, gin.H{"months": months})
}

type workload struct {
	RequiredHours, WeeklyCapacity float64
	WeeksOfBacklog                interface{}
	ByStage                       []gin.H
	ActiveOrders, NoPlanned       int
	LinesWithoutNorm, LinesTotal  int
}

func (h *Handler) workload(c *gin.Context) (workload, error) {
	ctx := c.Request.Context()
	rows, err := h.pool.Query(ctx, `SELECT o.id, o.planned_shipment_date IS NULL, ol.id, ol.qty, ol.article_id, coalesce(a.is_material_resale, false)
		FROM orders o LEFT JOIN order_lines ol ON ol.order_id = o.id LEFT JOIN articles a ON a.id = ol.article_id
		WHERE o.status IN ('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP')`)
	if err != nil {
		return workload{}, err
	}
	type line struct {
		ID        string
		Qty       float64
		ArticleID *string
		Resale    bool
	}
	orders := map[string][]line{}
	noPlanned := map[string]bool{}
	var orderIDs []string
	for rows.Next() {
		var oid string
		var np bool
		var lid *string
		var qty *float64
		var aid *string
		var resale bool
		if err := rows.Scan(&oid, &np, &lid, &qty, &aid, &resale); err != nil {
			rows.Close()
			return workload{}, err
		}
		if _, ok := orders[oid]; !ok {
			orders[oid] = nil
			orderIDs = append(orderIDs, oid)
			noPlanned[oid] = np
		}
		if lid != nil {
			orders[oid] = append(orders[oid], line{ID: *lid, Qty: *qty, ArticleID: aid, Resale: resale})
		}
	}
	rows.Close()
	done := map[string]bool{}
	if len(orderIDs) > 0 {
		srows, err := h.pool.Query(ctx, "SELECT order_line_id FROM production_stages WHERE order_id = ANY($1) AND status = $2 AND order_line_id IS NOT NULL", orderIDs, models.StageStatusAPIToDB("DONE"))
		if err != nil {
			return workload{}, err
		}
		for srows.Next() {
			var lid string
			if err := srows.Scan(&lid); err != nil {
				srows.Close()
				return workload{}, err
			}
			done[lid] = true
		}
		srows.Close()
	}
	var articleIDs []string
	seen := map[string]bool{}
	for _, ls := range orders {
		for _, l := range ls {
			if l.ArticleID != nil && !seen[*l.ArticleID] {
				seen[*l.ArticleID] = true
				articleIDs = append(articleIDs, *l.ArticleID)
			}
		}
	}
	norm := map[string]float64{}
	if len(articleIDs) > 0 {
		nrows, err := h.pool.Query(ctx, "SELECT article_id, stage, workers, hours_per_unit FROM routing_operations WHERE article_id = ANY($1)", articleIDs)
		if err != nil {
			return workload{}, err
		}
		for nrows.Next() {
			var aid, st string
			var w, hpu float64
			if err := nrows.Scan(&aid, &st, &w, &hpu); err != nil {
				nrows.Close()
				return workload{}, err
			}
			norm[aid+":"+models.RoutingStageDBToAPI(st)] = w * hpu
		}
		nrows.Close()
	}
	byStage := map[string]float64{}
	var required float64
	var withoutNorm, total, np int
	for _, oid := range orderIDs {
		if noPlanned[oid] {
			np++
		}
		for _, l := range orders[oid] {
			if l.Resale || done[l.ID] {
				continue
			}
			total++
			if l.ArticleID == nil {
				withoutNorm++
				continue
			}
			lineHours := 0.0
			for _, st := range routingStages {
				pu, ok := norm[*l.ArticleID+":"+st]
				if !ok {
					continue
				}
				hrs := pu * l.Qty
				lineHours += hrs
				byStage[st] += hrs
			}
			if lineHours == 0 {
				withoutNorm++
				continue
			}
			required += lineHours
		}
	}
	var capSum *float64
	if err := h.pool.QueryRow(ctx, "SELECT sum(capacity_per_day) FROM work_centers").Scan(&capSum); err != nil {
		return workload{}, err
	}
	weekly := 0.0
	if capSum != nil {
		weekly = *capSum * 5
	}
	r1 := func(n float64) float64 { return jsRound(n*10) / 10 }
	w := workload{RequiredHours: r1(required), WeeklyCapacity: r1(weekly), ActiveOrders: len(orderIDs), NoPlanned: np, LinesWithoutNorm: withoutNorm, LinesTotal: total}
	if weekly > 0 {
		w.WeeksOfBacklog = r1(required / weekly)
	}
	for _, st := range routingStages {
		w.ByStage = append(w.ByStage, gin.H{"stage": st, "requiredHours": r1(byStage[st])})
	}
	return w, nil
}

// WorkloadForecast — GET /dashboards/workload-forecast
func (h *Handler) WorkloadForecast(c *gin.Context) {
	w, err := h.workload(c)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"requiredHours": w.RequiredHours, "weeklyCapacityHours": w.WeeklyCapacity, "weeksOfBacklog": w.WeeksOfBacklog, "byStage": w.ByStage,
		"activeOrders": w.ActiveOrders, "ordersWithoutPlannedDate": w.NoPlanned, "linesWithoutNorm": w.LinesWithoutNorm, "linesTotal": w.LinesTotal})
}

type cash struct {
	Contracted, Paid, Owed, PayOwed float64
	// NoDataAmount — сумма заказов, по которым 1С не прислала оплату: это не
	// долг, а неизвестность, и в «нам должны» она не входит (06.09.2026 —
	// раньше 1,02 млрд ₸ таких заказов показывались как долг целиком)
	NoDataAmount   float64
	Active, NoData int
}

func (h *Handler) cash(c *gin.Context) (cash, error) {
	ctx := c.Request.Context()
	var total, paid, unpaid, knownTotal, noDataAmount *float64
	var active, noData int
	if err := h.pool.QueryRow(ctx, `
		SELECT sum(onec_total_amount), sum(onec_paid_amount), count(*),
		       sum(onec_total_amount) FILTER (WHERE onec_paid_amount IS NOT NULL),
		       sum(onec_total_amount) FILTER (WHERE onec_paid_amount IS NULL)
		FROM orders WHERE status NOT IN ('CLOSED','CANCELLED')`).Scan(&total, &paid, &active, &knownTotal, &noDataAmount); err != nil {
		return cash{}, err
	}
	if err := h.pool.QueryRow(ctx, "SELECT sum(unpaid_amount) FROM payment_documents").Scan(&unpaid); err != nil {
		return cash{}, err
	}
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM orders WHERE status NOT IN ('CLOSED','CANCELLED') AND onec_paid_amount IS NULL").Scan(&noData); err != nil {
		return cash{}, err
	}
	nz := func(p *float64) float64 {
		if p == nil {
			return 0
		}
		return *p
	}
	owed := nz(knownTotal) - nz(paid)
	if owed < 0 {
		owed = 0
	}
	return cash{Contracted: nz(total), Paid: nz(paid), Owed: owed, PayOwed: nz(unpaid), NoDataAmount: nz(noDataAmount), Active: active, NoData: noData}, nil
}

// CashForecast — GET /dashboards/cash-forecast
func (h *Handler) CashForecast(c *gin.Context) {
	x, err := h.cash(c)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"receivables": gin.H{"contracted": x.Contracted, "paid": x.Paid, "owed": x.Owed, "activeOrders": x.Active, "ordersWithoutPaymentData": x.NoData, "withoutPaymentDataAmount": x.NoDataAmount}, "payables": gin.H{"owed": x.PayOwed}})
}

// ProductionSummary — GET /dashboards/production-summary
func (h *Handler) ProductionSummary(c *gin.Context) {
	ctx := c.Request.Context()
	var active, ready int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM orders WHERE status IN ('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP')").Scan(&active); err != nil {
		fail(c, err)
		return
	}
	h.pool.QueryRow(ctx, "SELECT count(*) FROM orders WHERE status = 'READY_TO_SHIP'").Scan(&ready)
	w, err := h.workload(c)
	if err != nil {
		fail(c, err)
		return
	}
	x, err := h.cash(c)
	if err != nil {
		fail(c, err)
		return
	}
	// take 100 без orderBy → неявный ORDER BY id
	rows, err := h.pool.Query(ctx, "SELECT target_qty, actual_qty FROM min_stock_levels ORDER BY id LIMIT 100")
	if err != nil {
		fail(c, err)
		return
	}
	var norm, inStock float64
	for rows.Next() {
		var t, a float64
		if err := rows.Scan(&t, &a); err != nil {
			rows.Close()
			fail(c, err)
			return
		}
		norm += t
		inStock += a
	}
	rows.Close()
	planned := active
	if planned < 1 {
		planned = 1
	}
	totalCap := w.WeeklyCapacity
	if totalCap < 1 {
		totalCap = 1
	}
	normOut := norm
	if normOut == 0 {
		normOut = 100
	}
	c.JSON(http.StatusOK, gin.H{
		"productionPlanFact": gin.H{"planned": planned, "actual": ready},
		"workshopLoadHours":  gin.H{"used": w.RequiredHours, "total": totalCap},
		"receivablesTotal":   x.Owed,
		"fgStockVsNorm":      gin.H{"inStock": inStock, "norm": normOut},
	})
}

// FinishedGoodsSummary — GET /dashboards/finished-goods-summary
func (h *Handler) FinishedGoodsSummary(c *gin.Context) {
	rows, err := h.pool.Query(c.Request.Context(), "SELECT approved_price FROM articles ORDER BY id LIMIT 20")
	if err != nil {
		fail(c, err)
		return
	}
	defer rows.Close()
	n, sum := 0, 0.0
	for rows.Next() {
		var p float64
		if err := rows.Scan(&p); err != nil {
			fail(c, err)
			return
		}
		n++
		sum += p
	}
	c.JSON(http.StatusOK, gin.H{"totalArticles": n, "totalApprovedPrice": sum})
}
