// Перенос sales/deals.controller.ts — прогноз спроса до формального заказа.
package sales

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
	"cmk-avrora-erp/backend-go/internal/modules/catalog"
)

type Handler struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Handler { return &Handler{pool: pool} }

func fail(c *gin.Context, err error) {
	common.DebugLog(err)
	common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
}

const dealCols = "id, source, customer_id, article_id, manager_id, qty_ordered, qty_shipped, amount_ordered, amount_paid, status, period_key, shipment_date, site_code, region, manager_name, planned_dispatch_month, has_formal_request"

func scanDeal(row pgx.Row) (models.Deal, error) {
	var d models.Deal
	err := row.Scan(&d.ID, &d.Source, &d.CustomerID, &d.ArticleID, &d.ManagerID, &d.QtyOrdered, &d.QtyShipped, &d.AmountOrdered, &d.AmountPaid,
		&d.Status, &d.PeriodKey, &d.ShipmentDate, &d.SiteCode, &d.Region, &d.ManagerName, &d.PlannedDispatchMonth, &d.HasFormalRequest)
	return d, err
}

func dealJSON(d models.Deal) gin.H {
	b, _ := json.Marshal(d)
	var m gin.H
	_ = json.Unmarshal(b, &m)
	return m
}

// withIncludes — customer/article/manager как raw-записи.
func (h *Handler) withIncludes(c *gin.Context, deals []models.Deal) ([]gin.H, error) {
	ctx := c.Request.Context()
	out := make([]gin.H, 0, len(deals))
	for _, d := range deals {
		m := dealJSON(d)
		cu, err := catalog.ScanCustomer(h.pool.QueryRow(ctx, "SELECT "+catalog.CustomerCols+" FROM customers WHERE id = $1", d.CustomerID))
		if err != nil {
			return nil, err
		}
		m["customer"] = cu
		m["article"] = nil
		if d.ArticleID != nil {
			a, err := catalog.ScanArticle(h.pool.QueryRow(ctx, "SELECT "+catalog.ArticleCols+" FROM articles WHERE id = $1", *d.ArticleID))
			if err == nil {
				m["article"] = a
			} else if err != pgx.ErrNoRows {
				return nil, err
			}
		}
		m["manager"] = nil
		if d.ManagerID != nil {
			var e models.Employee
			err := h.pool.QueryRow(ctx, "SELECT id, name, role, department, telegram_id, created_at FROM employees WHERE id = $1", *d.ManagerID).
				Scan(&e.ID, &e.Name, &e.Role, &e.Department, &e.TelegramID, &e.CreatedAt)
			if err == nil {
				m["manager"] = e
			} else if err != pgx.ErrNoRows {
				return nil, err
			}
		}
		out = append(out, m)
	}
	return out, nil
}

// FindAll — GET /deals?source=&status=&page=&pageSize=
func (h *Handler) FindAll(c *gin.Context) {
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(c.Query("pageSize"))
	if size < 1 {
		size = 50
	}
	where, args := "WHERE 1=1", []interface{}{}
	if v := c.Query("source"); v != "" {
		args = append(args, v)
		where += " AND source = $" + strconv.Itoa(len(args))
	}
	if v := c.Query("status"); v != "" {
		args = append(args, v)
		where += " AND status = $" + strconv.Itoa(len(args))
	}
	ctx := c.Request.Context()
	var total int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM deals "+where, args...).Scan(&total); err != nil {
		fail(c, err)
		return
	}
	largs := append(append([]interface{}{}, args...), size, (page-1)*size)
	rows, err := h.pool.Query(ctx, "SELECT "+dealCols+" FROM deals "+where+" ORDER BY shipment_date DESC, amount_ordered DESC LIMIT $"+strconv.Itoa(len(largs)-1)+" OFFSET $"+strconv.Itoa(len(largs)), largs...)
	if err != nil {
		fail(c, err)
		return
	}
	var deals []models.Deal
	for rows.Next() {
		d, err := scanDeal(rows)
		if err != nil {
			rows.Close()
			fail(c, err)
			return
		}
		deals = append(deals, d)
	}
	rows.Close()
	data, err := h.withIncludes(c, deals)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "meta": gin.H{"page": page, "pageSize": size, "total": total}})
}

func str(v interface{}) string {
	if v == nil {
		return ""
	}
	if f, ok := v.(float64); ok {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}
func truthy(v interface{}) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	}
	return true
}
func num(v interface{}) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	case bool:
		if x {
			return 1
		}
	}
	return 0
}
func dlCode(name string) string {
	h := sha1.Sum([]byte(name))
	return "DL-" + strings.ToUpper(hex.EncodeToString(h[:])[:10])
}

func (h *Handler) resolveCustomer(c *gin.Context, body map[string]interface{}) (string, bool) {
	if truthy(body["customerId"]) {
		return str(body["customerId"]), true
	}
	name := strings.TrimSpace(str(body["customerName"]))
	if name == "" {
		common.Fail(c, http.StatusNotFound, "INVALID_INPUT", "Нужен заказчик: customerId или customerName")
		return "", false
	}
	ctx := c.Request.Context()
	var id string
	err := h.pool.QueryRow(ctx, "SELECT id FROM customers WHERE lower(name) = lower($1) LIMIT 1", name).Scan(&id)
	if err == nil {
		return id, true
	}
	if err != pgx.ErrNoRows {
		fail(c, err)
		return "", false
	}
	id = uuid.NewString()
	if _, err := h.pool.Exec(ctx, "INSERT INTO customers (id, name, bin_iin, customer_type) VALUES ($1,$2,$3,$4)", id, name, dlCode(name), models.CustomerTypeAPIToDB("OUTSIDE")); err != nil {
		fail(c, err)
		return "", false
	}
	return id, true
}

func (h *Handler) resolveArticle(c *gin.Context, body map[string]interface{}) (*string, bool) {
	if truthy(body["articleId"]) {
		s := str(body["articleId"])
		return &s, true
	}
	name := strings.TrimSpace(str(body["articleName"]))
	if name == "" {
		return nil, true
	}
	ctx := c.Request.Context()
	var id string
	err := h.pool.QueryRow(ctx, "SELECT id FROM articles WHERE lower(name) = lower($1) LIMIT 1", name).Scan(&id)
	if err == nil {
		return &id, true
	}
	if err != pgx.ErrNoRows {
		fail(c, err)
		return nil, false
	}
	id = uuid.NewString()
	if _, err := h.pool.Exec(ctx, "INSERT INTO articles (id, article_code, name, updated_at) VALUES ($1,$2,$3,now())", id, dlCode(name), name); err != nil {
		fail(c, err)
		return nil, false
	}
	return &id, true
}

func parseDate(v interface{}) *time.Time {
	s := str(v)
	if s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			t = t.UTC()
			return &t
		}
	}
	return nil
}

func optStr(v interface{}) *string {
	if !truthy(v) {
		return nil
	}
	s := str(v)
	return &s
}

// Create — POST /deals
func (h *Handler) Create(c *gin.Context) {
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	customerID, ok := h.resolveCustomer(c, body)
	if !ok {
		return
	}
	articleID, ok := h.resolveArticle(c, body)
	if !ok {
		return
	}
	source := "Telecom"
	if truthy(body["source"]) {
		source = str(body["source"])
	}
	status := "прогноз"
	if truthy(body["status"]) {
		status = str(body["status"])
	}
	d, err := scanDeal(h.pool.QueryRow(c.Request.Context(), `INSERT INTO deals (id, source, customer_id, article_id, manager_id, qty_ordered, qty_shipped, amount_ordered, amount_paid, status,
		period_key, shipment_date, site_code, region, manager_name, planned_dispatch_month, has_formal_request)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING `+dealCols,
		uuid.NewString(), source, customerID, articleID, optStr(body["managerId"]), num(body["qtyOrdered"]), num(body["qtyShipped"]), num(body["amountOrdered"]), num(body["amountPaid"]), status,
		optStr(body["periodKey"]), parseDate(body["shipmentDate"]), optStr(body["siteCode"]), optStr(body["region"]), optStr(body["managerName"]), optStr(body["plannedDispatchMonth"]), truthy(body["hasFormalRequest"])))
	if err != nil {
		fail(c, err)
		return
	}
	out, err := h.withIncludes(c, []models.Deal{d})
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, out[0])
}

// Update — PATCH /deals/:id
func (h *Handler) Update(c *gin.Context) {
	id := c.Param("id")
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	var x string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM deals WHERE id = $1", id).Scan(&x); err == pgx.ErrNoRows {
		common.NotFound(c, "Deal "+id+" not found")
		return
	} else if err != nil {
		fail(c, err)
		return
	}
	sets, args := []string{}, []interface{}{}
	add := func(col string, v interface{}) {
		args = append(args, v)
		sets = append(sets, col+" = $"+strconv.Itoa(len(args)))
	}
	for f, col := range map[string]string{"source": "source", "customerId": "customer_id", "articleId": "article_id", "siteCode": "site_code", "region": "region", "managerName": "manager_name", "plannedDispatchMonth": "planned_dispatch_month", "periodKey": "period_key"} {
		if v, ok := body[f]; ok {
			add(col, optStr(v))
		}
	}
	for f, col := range map[string]string{"qtyOrdered": "qty_ordered", "qtyShipped": "qty_shipped", "amountOrdered": "amount_ordered", "amountPaid": "amount_paid"} {
		if v, ok := body[f]; ok {
			add(col, num(v))
		}
	}
	if v, ok := body["hasFormalRequest"]; ok {
		add("has_formal_request", truthy(v))
	}
	if v, ok := body["shipmentDate"]; ok {
		add("shipment_date", parseDate(v))
	}
	var d models.Deal
	var err error
	if len(sets) == 0 {
		d, err = scanDeal(h.pool.QueryRow(ctx, "SELECT "+dealCols+" FROM deals WHERE id = $1", id))
	} else {
		args = append(args, id)
		d, err = scanDeal(h.pool.QueryRow(ctx, "UPDATE deals SET "+strings.Join(sets, ", ")+" WHERE id = $"+strconv.Itoa(len(args))+" RETURNING "+dealCols, args...))
	}
	if err != nil {
		fail(c, err)
		return
	}
	out, err := h.withIncludes(c, []models.Deal{d})
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, out[0])
}

// Remove — DELETE /deals/:id (несуществующий → P2025 → 500 в оригинале)
func (h *Handler) Remove(c *gin.Context) {
	tag, err := h.pool.Exec(c.Request.Context(), "DELETE FROM deals WHERE id = $1", c.Param("id"))
	if err != nil {
		fail(c, err)
		return
	}
	if tag.RowsAffected() == 0 {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// UpdateStatus — PATCH /deals/:id/status
func (h *Handler) UpdateStatus(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Status       string   `json:"status"`
		ShipmentDate *string  `json:"shipmentDate"`
		AmountPaid   *float64 `json:"amountPaid"`
		QtyShipped   *float64 `json:"qtyShipped"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	deal, err := scanDeal(h.pool.QueryRow(ctx, "SELECT "+dealCols+" FROM deals WHERE id = $1", id))
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Deal "+id+" not found")
		return
	} else if err != nil {
		fail(c, err)
		return
	}
	qtyOrdered, _ := deal.QtyOrdered.Float64()
	amountOrdered, _ := deal.AmountOrdered.Float64()
	nextQty := qtyOrdered
	if body.QtyShipped != nil {
		nextQty = *body.QtyShipped
	}
	nextDate := time.Now().UTC()
	if body.ShipmentDate != nil && *body.ShipmentDate != "" {
		if t := parseDate(*body.ShipmentDate); t != nil {
			nextDate = *t
		}
	} else if deal.ShipmentDate.Valid {
		nextDate = deal.ShipmentDate.Time
	}
	var amountPaid interface{} = deal.AmountPaid
	if body.AmountPaid != nil {
		amountPaid = *body.AmountPaid
	}
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	defer tx.Rollback(ctx)
	updated, err := scanDeal(tx.QueryRow(ctx, "UPDATE deals SET status = $1, shipment_date = $2, qty_shipped = $3, amount_paid = $4 WHERE id = $5 RETURNING "+dealCols, body.Status, nextDate, nextQty, amountPaid, id))
	if err != nil {
		fail(c, err)
		return
	}
	if body.Status == "отгружено" && deal.ArticleID != nil {
		unit := amountOrdered / max1(qtyOrdered)
		if _, err := tx.Exec(ctx, `INSERT INTO finished_goods_movements (id, item_id, movement_type, qty, unit_price, movement_date, project, source_document_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			uuid.NewString(), *deal.ArticleID, models.StockMovementTypeAPIToDB("EXPENSE"), nextQty, unit, nextDate, deal.Source, deal.ID); err != nil {
			fail(c, err)
			return
		}
	}
	user := authpkg.CurrentUser(c)
	// Демо/сервисные учётки (usr-*) в таблице users не существуют — внешний
	// ключ audit_log.user_id ронял всю смену статуса ошибкой базы (06.09.2026)
	var uid *string
	if user.UserID != "" && !strings.HasPrefix(user.UserID, "usr-") {
		uid = &user.UserID
	}
	role := "system"
	if len(user.Roles) > 0 && user.Roles[0] != "" {
		role = user.Roles[0]
	}
	comment := "Deal status updated"
	if body.Status == "отгружено" {
		comment = "Shipment cascade executed"
	}
	before, _ := json.Marshal(gin.H{"status": deal.Status})
	after, _ := json.Marshal(gin.H{"status": updated.Status, "qtyShipped": updated.QtyShipped, "amountPaid": updated.AmountPaid})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log (id, entity_type, entity_id, action, before, after, user_id, user_role, comment) VALUES ($1,'Deal',$2,'STATUS_UPDATED',$3,$4,$5,$6,$7)`,
		uuid.NewString(), updated.ID, before, after, uid, role, comment); err != nil {
		fail(c, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, dealJSON(updated))
}

func max1(n float64) float64 {
	if n < 1 {
		return 1
	}
	return n
}
