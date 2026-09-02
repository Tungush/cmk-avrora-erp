package orders

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/common"
)

// Перенос orders-dashboard.controller.ts — дашборд заказов клиента.
type OrdersDashboardHandler struct{ pool *pgxpool.Pool }

func NewOrdersDashboardHandler(pool *pgxpool.Pool) *OrdersDashboardHandler {
	return &OrdersDashboardHandler{pool: pool}
}

const dashDayMs = 24 * 60 * 60 * 1000

func (h *OrdersDashboardHandler) Dashboard(c *gin.Context) {
	ctx := c.Request.Context()
	type ord struct {
		ID, OrderNumber, CustomerID, Status string
		CustomerName                        *string
		Total                               float64
		Paid                                *float64
		RequestDate                         *time.Time
		ProjectSite, Region, DivisionCode   *string
		Raw                                 map[string]interface{}
	}
	rows, err := h.pool.Query(ctx, `SELECT o.id, o.order_number, o.customer_id, o.status, cu.name, coalesce(o.onec_total_amount,0), o.onec_paid_amount,
		o.request_date, o.project_site, o.region, o.division_code, o.raw_columns FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id WHERE o.is_archived = false`)
	if err != nil {
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	var orders []ord
	for rows.Next() {
		var o ord
		var raw []byte
		if err := rows.Scan(&o.ID, &o.OrderNumber, &o.CustomerID, &o.Status, &o.CustomerName, &o.Total, &o.Paid, &o.RequestDate,
			&o.ProjectSite, &o.Region, &o.DivisionCode, &raw); err != nil {
			rows.Close()
			common.DebugLog(err)
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &o.Raw)
		}
		orders = append(orders, o)
	}
	rows.Close()
	nowMs := time.Now().UnixMilli()
	filter := func(list []ord, f func(ord) bool) []ord {
		var r []ord
		for _, o := range list {
			if f(o) {
				r = append(r, o)
			}
		}
		return r
	}
	sum := func(list []ord, f func(ord) float64) float64 {
		s := 0.0
		for _, o := range list {
			s += f(o)
		}
		return s
	}
	contracted := func(o ord) float64 { return o.Total }
	paidOf := func(o ord) float64 {
		if o.Paid == nil {
			return 0
		}
		return *o.Paid
	}
	active := filter(orders, func(o ord) bool { return o.Status != "CLOSED" && o.Status != "CANCELLED" })
	withPayment := filter(orders, func(o ord) bool { return o.Paid != nil })
	debtOrders := filter(withPayment, func(o ord) bool { return o.Total > paidOf(o) })
	unknownPayment := filter(active, func(o ord) bool { return o.Paid == nil })
	monthAgo, prevMonth := nowMs-30*dashDayMs, nowMs-60*dashDayMs
	inRange := func(o ord, from, to int64) bool {
		return o.RequestDate != nil && o.RequestDate.UnixMilli() > from && o.RequestDate.UnixMilli() <= to
	}
	month := filter(orders, func(o ord) bool { return inRange(o, monthAgo, nowMs) })
	prev := filter(orders, func(o ord) bool { return inRange(o, prevMonth, monthAgo) })
	var biggest interface{}
	if len(month) > 0 {
		sorted := append([]ord{}, month...)
		sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Total > sorted[j].Total })
		biggest = gin.H{"orderNumber": sorted[0].OrderNumber, "id": sorted[0].ID, "amount": sorted[0].Total}
	}
	rawStr := func(o ord, key string) *string {
		if o.Raw == nil {
			return nil
		}
		if v, ok := o.Raw[key]; ok && v != nil {
			s, ok := v.(string)
			if ok {
				return &s
			}
		}
		return nil
	}
	cut := func(key func(ord) *string) []gin.H {
		type acc struct {
			Orders int
			Total  float64
		}
		m := map[string]*acc{}
		var order []string
		for _, o := range orders {
			k := "__none__"
			if v := key(o); v != nil && strings.TrimSpace(*v) != "" {
				k = strings.TrimSpace(*v)
			}
			a, ok := m[k]
			if !ok {
				a = &acc{}
				m[k] = a
				order = append(order, k)
			}
			a.Orders++
			a.Total += o.Total
		}
		sort.SliceStable(order, func(i, j int) bool { return m[order[i]].Total > m[order[j]].Total })
		out := make([]gin.H, 0, len(order))
		for _, k := range order {
			var kk interface{} = k
			if k == "__none__" {
				kk = nil
			}
			out = append(out, gin.H{"key": kk, "orders": m[k].Orders, "total": m[k].Total})
		}
		return out
	}
	prows, err := h.pool.Query(ctx, "SELECT business_direction, coalesce(sum(total_amount),0) FROM payment_documents WHERE currency = 'KZT' GROUP BY business_direction")
	if err != nil {
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	procByDir := gin.H{}
	for prows.Next() {
		var dir *string
		var total float64
		if err := prows.Scan(&dir, &total); err != nil {
			prows.Close()
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
		k := "—"
		if dir != nil {
			k = *dir
		}
		procByDir[k] = total
	}
	prows.Close()
	type cust struct {
		ID, Name          string
		Orders, Unknown   int
		Total, Paid, Debt float64
	}
	byCust := map[string]*cust{}
	var custOrder []string
	for _, o := range orders {
		a, ok := byCust[o.CustomerID]
		if !ok {
			name := "—"
			if o.CustomerName != nil {
				name = *o.CustomerName
			}
			a = &cust{ID: o.CustomerID, Name: name}
			byCust[o.CustomerID] = a
			custOrder = append(custOrder, o.CustomerID)
		}
		a.Orders++
		a.Total += o.Total
		if o.Paid != nil {
			a.Paid += *o.Paid
			a.Debt += math.Max(0, o.Total-*o.Paid)
		} else {
			a.Unknown++
		}
	}
	custs := make([]*cust, 0, len(custOrder))
	for _, id := range custOrder {
		custs = append(custs, byCust[id])
	}
	sort.SliceStable(custs, func(i, j int) bool {
		if custs[i].Debt != custs[j].Debt {
			return custs[i].Debt > custs[j].Debt
		}
		return custs[i].Total > custs[j].Total
	})
	if len(custs) > 12 {
		custs = custs[:12]
	}
	custOut := make([]gin.H, 0, len(custs))
	for _, a := range custs {
		custOut = append(custOut, gin.H{"id": a.ID, "name": a.Name, "orders": a.Orders, "total": a.Total, "paid": a.Paid, "debt": a.Debt, "unknown": a.Unknown})
	}
	ageOf := func(o ord) int {
		if o.RequestDate == nil {
			return 0
		}
		return int(math.Floor(float64(nowMs-o.RequestDate.UnixMilli()) / dashDayMs))
	}
	ageBucket := func(label string, from, to int) gin.H {
		list := filter(active, func(o ord) bool { a := ageOf(o); return a >= from && a < to })
		return gin.H{"label": label, "orders": len(list), "amount": sum(list, contracted)}
	}
	var costings, approved, noBom int
	h.pool.QueryRow(ctx, "SELECT count(*) FROM order_costings").Scan(&costings)
	h.pool.QueryRow(ctx, "SELECT count(*) FROM order_costings WHERE status = 'APPROVED'").Scan(&approved)
	h.pool.QueryRow(ctx, "SELECT count(*) FROM articles a WHERE a.is_material_resale = false AND NOT EXISTS (SELECT 1 FROM bom_items b WHERE b.article_id = a.id)").Scan(&noBom)
	c.JSON(http.StatusOK, gin.H{
		"kpi": gin.H{
			"portfolio":       gin.H{"orders": len(active), "amount": sum(active, contracted)},
			"debt":            gin.H{"amount": sum(debtOrders, func(o ord) float64 { return o.Total - paidOf(o) }), "orders": len(debtOrders), "paymentKnownOrders": len(withPayment)},
			"unknownPayment":  gin.H{"amount": sum(unknownPayment, contracted), "orders": len(unknownPayment)},
			"contractedMonth": gin.H{"amount": sum(month, contracted), "orders": len(month), "prevAmount": sum(prev, contracted), "biggest": biggest},
		},
		"totalContracted": sum(orders, contracted),
		"dimensions": gin.H{
			"direction": cut(func(o ord) *string { return rawStr(o, "НаправлениеДеятельности") }),
			"manager":   cut(func(o ord) *string { return rawStr(o, "Менеджер") }),
			"warehouse": cut(func(o ord) *string { return rawStr(o, "Склад") }),
			"customer":  cut(func(o ord) *string { return o.CustomerName }),
			"project":   cut(func(o ord) *string { return o.ProjectSite }),
			"region":    cut(func(o ord) *string { return o.Region }),
			"division":  cut(func(o ord) *string { return o.DivisionCode }),
		},
		"procurementByDir": procByDir,
		"customers":        custOut,
		"ageBuckets":       []gin.H{ageBucket("до 30 дней", 0, 30), ageBucket("30–90 дней", 30, 90), ageBucket("90–180 дней", 90, 180), ageBucket("дольше 180 дней", 180, 100000)},
		"gaps":             gin.H{"costings": costings, "approvedCostings": approved, "ordersTotal": len(orders), "noBomArticles": noBom, "unknownPaymentOrders": len(unknownPayment)},
	})
}
