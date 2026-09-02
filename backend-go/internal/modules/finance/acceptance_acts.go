package finance

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/common"
)

// Перенос acceptance-acts.controller.ts — акты приёмки-передачи.
type AcceptanceActsHandler struct{ pool *pgxpool.Pool }

func NewAcceptanceActsHandler(pool *pgxpool.Pool) *AcceptanceActsHandler {
	return &AcceptanceActsHandler{pool: pool}
}

type actLineOut struct {
	ID          string   `json:"id"`
	ActID       string   `json:"actId"`
	LineNo      int      `json:"lineNo"`
	ItemName    string   `json:"itemName"`
	ArticleID   *string  `json:"articleId"`
	Qty         *float64 `json:"qty"`
	UnitPrice   *float64 `json:"unitPrice"`
	Amount      *float64 `json:"amount"`
	VatRate     *string  `json:"vatRate"`
	OrderNumber *string  `json:"orderNumber"`
}

func (h *AcceptanceActsHandler) linesFor(c *gin.Context, actIDs []string) (map[string][]actLineOut, error) {
	out := map[string][]actLineOut{}
	if len(actIDs) == 0 {
		return out, nil
	}
	rows, err := h.pool.Query(c.Request.Context(), `SELECT id, act_id, line_no, item_name, article_id, qty, unit_price, amount, vat_rate, order_number
		FROM acceptance_act_lines WHERE act_id = ANY($1) ORDER BY line_no ASC`, actIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var l actLineOut
		if err := rows.Scan(&l.ID, &l.ActID, &l.LineNo, &l.ItemName, &l.ArticleID, &l.Qty, &l.UnitPrice, &l.Amount, &l.VatRate, &l.OrderNumber); err != nil {
			return nil, err
		}
		out[l.ActID] = append(out[l.ActID], l)
	}
	return out, rows.Err()
}

const actCols = `a.id, a.app_number, a.customer_id, a.order_id, a.act_date, a.total_amount, a.warehouse, a.division, a.business_direction,
	a.manager_name, a.manager_id, a.status, a.is_posted, a.raw_columns, a.created_at`

type actRow struct {
	ID, AppNumber, CustomerID              string
	OrderID                                *string
	ActDate                                common.PDate
	TotalAmount                            float64
	Warehouse, Division, BusinessDirection *string
	ManagerName, ManagerID, Status         *string
	IsPosted                               bool
	RawColumns                             []byte
	CreatedAt                              common.PDate
}

func scanAct(row pgx.Row) (actRow, error) {
	var a actRow
	err := row.Scan(&a.ID, &a.AppNumber, &a.CustomerID, &a.OrderID, &a.ActDate, &a.TotalAmount, &a.Warehouse, &a.Division, &a.BusinessDirection,
		&a.ManagerName, &a.ManagerID, &a.Status, &a.IsPosted, &a.RawColumns, &a.CreatedAt)
	return a, err
}

func actBase(a actRow) gin.H {
	var raw interface{}
	if a.RawColumns != nil {
		raw = jsonRaw(a.RawColumns)
	}
	return gin.H{"id": a.ID, "appNumber": a.AppNumber, "customerId": a.CustomerID, "orderId": a.OrderID, "actDate": a.ActDate,
		"totalAmount": a.TotalAmount, "warehouse": a.Warehouse, "division": a.Division, "businessDirection": a.BusinessDirection,
		"managerName": a.ManagerName, "managerId": a.ManagerID, "status": a.Status, "isPosted": a.IsPosted, "rawColumns": raw, "createdAt": a.CreatedAt}
}

// FindAll — GET /acceptance-acts?orderId=&customerId=&page=&pageSize=.
func (h *AcceptanceActsHandler) FindAll(c *gin.Context) {
	page, pageSize := pageParams(c, 50)
	where, args := "WHERE 1=1", []interface{}{}
	if v := c.Query("orderId"); v != "" {
		args = append(args, v)
		where += " AND a.order_id = $" + strconv.Itoa(len(args))
	}
	if v := c.Query("customerId"); v != "" {
		args = append(args, v)
		where += " AND a.customer_id = $" + strconv.Itoa(len(args))
	}
	ctx := c.Request.Context()
	var total int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM acceptance_acts a "+where, args...).Scan(&total); err != nil {
		respondErr(c, err)
		return
	}
	largs := append(append([]interface{}{}, args...), pageSize, (page-1)*pageSize)
	rows, err := h.pool.Query(ctx, "SELECT "+actCols+", cu.id, cu.name, cu.bin_iin, o.id, o.order_number FROM acceptance_acts a JOIN customers cu ON cu.id = a.customer_id LEFT JOIN orders o ON o.id = a.order_id "+
		where+" ORDER BY a.act_date DESC LIMIT $"+strconv.Itoa(len(largs)-1)+" OFFSET $"+strconv.Itoa(len(largs)), largs...)
	if err != nil {
		respondErr(c, err)
		return
	}
	type rec struct {
		A                   actRow
		CuID, CuName, CuBin string
		OID, ONum           *string
	}
	var recs []rec
	var ids []string
	for rows.Next() {
		var a actRow
		var r rec
		if err := rows.Scan(&a.ID, &a.AppNumber, &a.CustomerID, &a.OrderID, &a.ActDate, &a.TotalAmount, &a.Warehouse, &a.Division, &a.BusinessDirection,
			&a.ManagerName, &a.ManagerID, &a.Status, &a.IsPosted, &a.RawColumns, &a.CreatedAt, &r.CuID, &r.CuName, &r.CuBin, &r.OID, &r.ONum); err != nil {
			rows.Close()
			respondErr(c, err)
			return
		}
		r.A = a
		recs = append(recs, r)
		ids = append(ids, a.ID)
	}
	rows.Close()
	lines, err := h.linesFor(c, ids)
	if err != nil {
		respondErr(c, err)
		return
	}
	data := make([]gin.H, 0, len(recs))
	for _, r := range recs {
		hh := actBase(r.A)
		hh["customer"] = gin.H{"id": r.CuID, "name": r.CuName, "binIin": r.CuBin}
		if r.OID != nil {
			hh["order"] = gin.H{"id": *r.OID, "orderNumber": *r.ONum}
		} else {
			hh["order"] = nil
		}
		ls := lines[r.A.ID]
		if ls == nil {
			ls = []actLineOut{}
		}
		hh["lines"] = ls
		data = append(data, hh)
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "meta": gin.H{"page": page, "pageSize": pageSize, "total": total}})
}

func (h *AcceptanceActsHandler) nextNumber(c *gin.Context) (string, error) {
	rows, err := h.pool.Query(c.Request.Context(), "SELECT app_number FROM acceptance_acts WHERE app_number LIKE 'АПП-%' ORDER BY app_number DESC LIMIT 200")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	max := 0
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return "", err
		}
		if n, err := strconv.Atoi(strings.TrimPrefix(s, "АПП-")); err == nil && n > max {
			max = n
		}
	}
	return fmt.Sprintf("АПП-%03d", max+1), nil
}

type actBody struct {
	OrderID   string  `json:"orderId"`
	ActDate   *string `json:"actDate"`
	AppNumber *string `json:"appNumber"`
	Lines     []struct {
		OrderLineID *string `json:"orderLineId"`
		ItemName    *string `json:"itemName"`
		Qty         float64 `json:"qty"`
		UnitPrice   float64 `json:"unitPrice"`
	} `json:"lines"`
}

// Create — POST /acceptance-acts (accountant/sales_manager/warehouse_fg/admin).
func (h *AcceptanceActsHandler) Create(c *gin.Context) {
	var body actBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	var orderNumber, customerID string
	var managerID, managerName *string
	err := h.pool.QueryRow(ctx, "SELECT o.order_number, o.customer_id, o.manager_id, e.name FROM orders o LEFT JOIN employees e ON e.id = o.manager_id WHERE o.id = $1", body.OrderID).
		Scan(&orderNumber, &customerID, &managerID, &managerName)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+body.OrderID+" not found")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	if len(body.Lines) == 0 {
		common.BadRequest(c, "EMPTY_ACT", "В акте нет ни одной позиции")
		return
	}
	type srcLine struct {
		ArticleID   *string
		ArticleName *string
	}
	src := map[string]srcLine{}
	lrows, err := h.pool.Query(ctx, "SELECT ol.id, a.id, a.name FROM order_lines ol LEFT JOIN articles a ON a.id = ol.article_id WHERE ol.order_id = $1", body.OrderID)
	if err != nil {
		respondErr(c, err)
		return
	}
	for lrows.Next() {
		var id string
		var s srcLine
		if err := lrows.Scan(&id, &s.ArticleID, &s.ArticleName); err != nil {
			lrows.Close()
			respondErr(c, err)
			return
		}
		src[id] = s
	}
	lrows.Close()

	type prep struct {
		LineNo                 int
		ItemName               string
		ArticleID              *string
		Qty, UnitPrice, Amount float64
	}
	var prepared []prep
	total := 0.0
	for idx, l := range body.Lines {
		var s *srcLine
		if l.OrderLineID != nil && *l.OrderLineID != "" {
			ss, ok := src[*l.OrderLineID]
			if !ok {
				common.BadRequest(c, "LINE_MISMATCH", "Позиция "+*l.OrderLineID+" не из заказа "+orderNumber)
				return
			}
			s = &ss
		}
		if !(l.Qty > 0) {
			common.BadRequest(c, "INVALID_QTY", "Количество в строке "+strconv.Itoa(idx+1)+" должно быть больше нуля")
			return
		}
		if !(l.UnitPrice >= 0) {
			common.BadRequest(c, "INVALID_PRICE", "Цена в строке "+strconv.Itoa(idx+1)+" не может быть отрицательной")
			return
		}
		name := "—"
		if l.ItemName != nil && strings.TrimSpace(*l.ItemName) != "" {
			name = strings.TrimSpace(*l.ItemName)
		} else if s != nil && s.ArticleName != nil {
			name = *s.ArticleName
		}
		var articleID *string
		if s != nil {
			articleID = s.ArticleID
		}
		amount := round2(l.Qty * l.UnitPrice)
		total += amount
		prepared = append(prepared, prep{idx + 1, name, articleID, l.Qty, l.UnitPrice, amount})
	}
	total = round2(total)

	appNumber := ""
	if body.AppNumber != nil {
		appNumber = strings.TrimSpace(*body.AppNumber)
	}
	if appNumber == "" {
		appNumber, err = h.nextNumber(c)
		if err != nil {
			respondErr(c, err)
			return
		}
	}
	var dup string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM acceptance_acts WHERE app_number = $1", appNumber).Scan(&dup); err == nil {
		common.Conflict(c, "NUMBER_TAKEN", "Акт с номером "+appNumber+" уже существует")
		return
	} else if err != pgx.ErrNoRows {
		respondErr(c, err)
		return
	}
	actDate := time.Now().UTC()
	if body.ActDate != nil && *body.ActDate != "" {
		t, ok := parseJSDate(*body.ActDate)
		if !ok {
			common.BadRequest(c, "INVALID_DATE", "Дата акта не распознана")
			return
		}
		actDate = t
	}

	tx, err := h.pool.Begin(ctx)
	if err != nil {
		respondErr(c, err)
		return
	}
	defer tx.Rollback(ctx)
	actID := uuid.NewString()
	a, err := scanAct(tx.QueryRow(ctx, `INSERT INTO acceptance_acts (id, app_number, customer_id, order_id, act_date, total_amount, manager_name, manager_id, status, is_posted)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Оформлен в сервисе',true) RETURNING `+strings.ReplaceAll(actCols, "a.", ""),
		actID, appNumber, customerID, body.OrderID, actDate, total, managerName, managerID))
	if err != nil {
		respondErr(c, err)
		return
	}
	lines := make([]actLineOut, 0, len(prepared))
	for _, p := range prepared {
		var l actLineOut
		if err := tx.QueryRow(ctx, `INSERT INTO acceptance_act_lines (id, act_id, line_no, item_name, article_id, qty, unit_price, amount, order_number)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, act_id, line_no, item_name, article_id, qty, unit_price, amount, vat_rate, order_number`,
			uuid.NewString(), actID, p.LineNo, p.ItemName, p.ArticleID, p.Qty, p.UnitPrice, p.Amount, orderNumber).
			Scan(&l.ID, &l.ActID, &l.LineNo, &l.ItemName, &l.ArticleID, &l.Qty, &l.UnitPrice, &l.Amount, &l.VatRate, &l.OrderNumber); err != nil {
			respondErr(c, err)
			return
		}
		lines = append(lines, l)
	}
	if err := tx.Commit(ctx); err != nil {
		respondErr(c, err)
		return
	}
	// Акт — это ещё и отгрузка: двигаем shippedQty позиций (вне транзакции, как в оригинале)
	for _, l := range body.Lines {
		if l.OrderLineID == nil || *l.OrderLineID == "" {
			continue
		}
		if _, err := h.pool.Exec(ctx, "UPDATE order_lines SET shipped_qty = shipped_qty + $1 WHERE id = $2", l.Qty, *l.OrderLineID); err != nil {
			respondErr(c, err)
			return
		}
	}
	var custName string
	_ = h.pool.QueryRow(ctx, "SELECT name FROM customers WHERE id = $1", customerID).Scan(&custName)
	out := actBase(a)
	out["lines"] = lines
	out["customer"] = gin.H{"name": custName}
	c.JSON(http.StatusCreated, out)
}
