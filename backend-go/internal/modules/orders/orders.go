// Точный перенос orders.controller.ts (базовая часть, без себестоимости
// заказа — order-costing.service.ts зависит от MaterialBatchService/FIFO,
// это отдельный заход вместе с модулем Warehouse, см. memory/go-rewrite-progress.md).
// Портировано: список/карточка (row-scope), инбокс с блокерами, приём в
// производство, объект/БС на позиции, state machine статусов, режим
// отметки этапов, отметка производства по изделиям (с outbox в 1С),
// раскладка часов по позициям, generic PATCH с field-level RBAC,
// GET :id/material-availability (дощла очередь после модуля Warehouse).
package orders

import (
	"context"
	"encoding/json"
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
	"cmk-avrora-erp/backend-go/internal/integration"
	"cmk-avrora-erp/backend-go/internal/models"
	"cmk-avrora-erp/backend-go/internal/orderstate"
	wh "cmk-avrora-erp/backend-go/internal/warehouse"
)

// MaterialAvailability — GET /orders/:id/material-availability — хватает ли
// сырья на заказ (по партиям, с учётом чужих резервов); read-only, до начала работ.
func (h *OrdersHandler) MaterialAvailability(c *gin.Context) {
	id := c.Param("id")
	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM orders WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	avail, err := wh.OrderMaterialAvailability(ctx, h.pool, id)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	c.JSON(http.StatusOK, avail)
}

type OrdersHandler struct {
	pool *pgxpool.Pool
}

func NewOrdersHandler(pool *pgxpool.Pool) *OrdersHandler {
	return &OrdersHandler{pool: pool}
}

// statusTransitionRoles — кто может перевести заказ В этот статус
// (серверная копия матрицы из 04_ROLES_PERMISSIONS.md).
var statusTransitionRoles = map[string][]string{
	"CONFIRMED":     {"sales_manager", "planner", "director", "admin"},
	"DRAFT":         {"sales_manager", "planner", "director", "admin"},
	"IN_PRODUCTION": {"planner", "admin"},
	"READY_TO_SHIP": {"warehouse_fg", "admin"},
	"SHIPPED":       {"warehouse_fg", "admin"},
	"CLOSED":        {"accountant", "admin"},
	"CANCELLED":     {"sales_manager", "director", "admin"},
}

var stageStatusMap = map[string]string{
	"not_started": "NOT_STARTED", "in_progress": "IN_PROGRESS", "done": "DONE",
	"NOT_STARTED": "NOT_STARTED", "IN_PROGRESS": "IN_PROGRESS", "DONE": "DONE",
}

func roleIn(roles []string, list []string) bool {
	for _, r := range roles {
		for _, a := range list {
			if r == a {
				return true
			}
		}
	}
	return false
}

const OrderCols = `id, order_number, customer_id, region, manager_id, order_type, bitrix_deal_id, bitrix_stage,
	status, planned_shipment_date, actual_shipment_date, overdue_days, stage_tracking_mode, accepted_at,
	accepted_by_id, is_archived, request_date, created_at, updated_at, onec_num, onec_status,
	onec_approval_status, onec_total_amount, onec_paid_amount, final_customer, customer_order_num,
	project_group, project_site, division_code, client_agreement, onec_synced_at, production_doc_number,
	production_doc_date, source_sheet, source_row_number, raw_columns`

const orderColsPrefixed = `o.id, o.order_number, o.customer_id, o.region, o.manager_id, o.order_type, o.bitrix_deal_id, o.bitrix_stage,
	o.status, o.planned_shipment_date, o.actual_shipment_date, o.overdue_days, o.stage_tracking_mode, o.accepted_at,
	o.accepted_by_id, o.is_archived, o.request_date, o.created_at, o.updated_at, o.onec_num, o.onec_status,
	o.onec_approval_status, o.onec_total_amount, o.onec_paid_amount, o.final_customer, o.customer_order_num,
	o.project_group, o.project_site, o.division_code, o.client_agreement, o.onec_synced_at, o.production_doc_number,
	o.production_doc_date, o.source_sheet, o.source_row_number, o.raw_columns`

const customerColsPrefixed = `cu.id, cu.name, cu.bin_iin, cu.region, cu.customer_type`

func scanOrderFields(row interface {
	Scan(dest ...interface{}) error
}, o *models.Order) error {
	var orderType string
	err := row.Scan(
		&o.ID, &o.OrderNumber, &o.CustomerID, &o.Region, &o.ManagerID, &orderType, &o.BitrixDealID, &o.BitrixStage,
		&o.Status, &o.PlannedShipmentDate, &o.ActualShipmentDate, &o.OverdueDays, &o.StageTrackingMode, &o.AcceptedAt,
		&o.AcceptedByID, &o.IsArchived, &o.RequestDate, &o.CreatedAt, &o.UpdatedAt, &o.OnecNum, &o.OnecStatus,
		&o.OnecApprovalStatus, &o.OnecTotalAmount, &o.OnecPaidAmount, &o.FinalCustomer, &o.CustomerOrderNum,
		&o.ProjectGroup, &o.ProjectSite, &o.DivisionCode, &o.ClientAgreement, &o.OnecSyncedAt, &o.ProductionDocNumber,
		&o.ProductionDocDate, &o.SourceSheet, &o.SourceRowNumber, &o.RawColumns,
	)
	o.OrderType = models.OrderTypeDBToAPI(orderType)
	return err
}

func ScanOrder(row pgx.Row) (models.Order, error) {
	var o models.Order
	err := scanOrderFields(row, &o)
	return o, err
}

type orderLineOut struct {
	models.OrderLine
	Article *models.Article `json:"article"`
}

const orderLineColsPrefixed = `ol.id, ol.order_id, ol.article_id, ol.qty, ol.unit, ol.unit_price, ol.line_total_vat,
	ol.prepayment, ol.post_payment_1, ol.post_payment_2, ol.penalty, ol.balance_due, ol.reserved_qty,
	ol.shipped_qty, ol.site_code, ol.source_sheet, ol.source_row_number, ol.article_code_raw,
	ol.product_name_raw, ol.raw_columns`

const articleColsPrefixed = `a.id, a.article_code, a.legacy_code, a.name, a.weight_kg, a.series, a.description,
	a.approved_price, a.is_material_resale, a.spec_price, a.price_deviation_pct, a.lead_time_days,
	a.pallet_capacity, a.is_active, a.created_at, a.updated_at`

func scanOrderLineWithArticle(rows pgx.Rows) (orderLineOut, error) {
	var l orderLineOut
	var artID *string
	var a models.Article
	err := rows.Scan(
		&l.ID, &l.OrderID, &l.ArticleID, &l.Qty, &l.Unit, &l.UnitPrice, &l.LineTotalVat,
		&l.Prepayment, &l.PostPayment1, &l.PostPayment2, &l.Penalty, &l.BalanceDue, &l.ReservedQty,
		&l.ShippedQty, &l.SiteCode, &l.SourceSheet, &l.SourceRowNumber, &l.ArticleCodeRaw,
		&l.ProductNameRaw, &l.RawColumns,
		&artID, &a.ArticleCode, &a.LegacyCode, &a.Name, &a.WeightKg, &a.Series, &a.Description,
		&a.ApprovedPrice, &a.IsMaterialResale, &a.SpecPrice, &a.PriceDeviationPct, &a.LeadTimeDays,
		&a.PalletCapacity, &a.IsActive, &a.CreatedAt, &a.UpdatedAt,
	)
	if err != nil {
		return l, err
	}
	if artID != nil {
		a.ID = *artID
		l.Article = &a
	}
	return l, nil
}

// loadOrderLines — состав заказа (позиции + изделие), как include:{orderLines:{include:{article:true}}}.
func loadOrderLines(ctx context.Context, pool *pgxpool.Pool, orderIDs []string) (map[string][]orderLineOut, error) {
	out := map[string][]orderLineOut{}
	if len(orderIDs) == 0 {
		return out, nil
	}
	rows, err := pool.Query(ctx, `
		SELECT `+orderLineColsPrefixed+`, `+articleColsPrefixed+`
		FROM order_lines ol
		LEFT JOIN articles a ON a.id = ol.article_id
		WHERE ol.order_id = ANY($1)`, orderIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		l, serr := scanOrderLineWithArticle(rows)
		if serr != nil {
			return nil, serr
		}
		out[l.OrderID] = append(out[l.OrderID], l)
	}
	return out, rows.Err()
}

// stripKeyDeep — findAll/inbox вырезают rawColumns и на заказе, и на КАЖДОЙ
// его позиции (`({rawColumns,...o}) => ...; orderLines.map(({rawColumns,...l})=>l)`),
// то есть ключ должен физически отсутствовать, а не просто быть null.
// Остальные ручки (findOne, transitionOrder, generic PATCH) rawColumns не
// трогают вовсе — там модель отдаётся с ключом как есть, поэтому эта чистка
// применяется только к ответу findAll/inbox, JSON-роундтрипом по всему дереву.
func stripKeyDeep(v interface{}, key string) interface{} {
	b, err := json.Marshal(v)
	if err != nil {
		return v
	}
	var generic interface{}
	if err := json.Unmarshal(b, &generic); err != nil {
		return v
	}
	stripKeyRecursive(generic, key)
	return generic
}

func stripKeyRecursive(v interface{}, key string) {
	switch t := v.(type) {
	case map[string]interface{}:
		delete(t, key)
		for _, vv := range t {
			stripKeyRecursive(vv, key)
		}
	case []interface{}:
		for _, vv := range t {
			stripKeyRecursive(vv, key)
		}
	}
}

type orderOut struct {
	models.Order
	Customer   *models.Customer `json:"customer,omitempty"`
	OrderLines []orderLineOut   `json:"orderLines"`
}

// rowScopeWhere — ограничение видимости строк (§1.8): подмешивается в
// SQL-условие, а не фильтруется после выборки. Без привязки (viewer без
// linkedCustomerId) — безопасный дефолт «не видит ничего».
func (h *OrdersHandler) rowScopeWhere(ctx context.Context, user authpkg.UserPayload) (field, value string, ok bool) {
	scope := authpkg.RowScopeForRoles(user.Roles, "order")
	if scope == "" {
		return "", "", false
	}
	const none = "00000000-0000-0000-0000-000000000000"
	col := "manager_id"
	if scope == authpkg.RowScopeCustomer {
		col = "customer_id"
	}
	// демо-пользователи (usr-*) не существуют в БД — привязки нет
	if strings.HasPrefix(user.UserID, "usr-") {
		return col, none, true
	}
	var employeeID, linkedCustomerID *string
	if err := h.pool.QueryRow(ctx, "SELECT employee_id, linked_customer_id FROM users WHERE id = $1", user.UserID).
		Scan(&employeeID, &linkedCustomerID); err != nil {
		return col, none, true
	}
	if scope == authpkg.RowScopeCustomer {
		if linkedCustomerID != nil {
			return col, *linkedCustomerID, true
		}
		return col, none, true
	}
	if employeeID != nil {
		return col, *employeeID, true
	}
	return col, none, true
}

// FindAll — GET /orders
func (h *OrdersHandler) FindAll(c *gin.Context) {
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(c.Query("pageSize"))
	if pageSize < 1 {
		pageSize = 50
	}
	offset := (page - 1) * pageSize

	where := "WHERE 1=1"
	args := []interface{}{}
	if status := c.Query("status"); status != "" {
		args = append(args, status)
		where += " AND o.status = $" + strconv.Itoa(len(args))
	}
	if customerID := c.Query("customerId"); customerID != "" {
		args = append(args, customerID)
		where += " AND o.customer_id = $" + strconv.Itoa(len(args))
	}
	if c.Query("overdueOnly") == "true" {
		where += " AND o.overdue_days > 0"
	}
	if c.Query("archived") != "true" {
		where += " AND o.is_archived = false"
	}
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		args = append(args, "%"+search+"%")
		n := strconv.Itoa(len(args))
		// project_site добавлен 03.09.2026: раздел «Объекты» группирует
		// заказы именно по нему (это поле приходит из 1С), а поиск его не
		// знал — карточка площадки показывала «заказов не найдено» при
		// десяти живых заказах. order_lines.site_code оставлен: его
		// заполняют руками, когда в одном заказе несколько БС.
		where += ` AND (o.order_number ILIKE $` + n + ` OR cu.name ILIKE $` + n +
			` OR o.project_site ILIKE $` + n +
			` OR EXISTS (SELECT 1 FROM order_lines ol2 WHERE ol2.order_id = o.id AND ol2.site_code ILIKE $` + n + `))`
	}

	ctx := c.Request.Context()
	user := authpkg.CurrentUser(c)
	if field, value, ok := h.rowScopeWhere(ctx, user); ok {
		args = append(args, value)
		where += " AND o." + field + " = $" + strconv.Itoa(len(args))
	}

	var total int
	countSQL := "SELECT count(*) FROM orders o JOIN customers cu ON cu.id = o.customer_id " + where
	if err := h.pool.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	listArgs := append([]interface{}{}, args...)
	listArgs = append(listArgs, pageSize, offset)
	sql := "SELECT " + orderColsPrefixed + ", " + customerColsPrefixed +
		" FROM orders o JOIN customers cu ON cu.id = o.customer_id " + where +
		" ORDER BY o.created_at DESC LIMIT $" + strconv.Itoa(len(listArgs)-1) + " OFFSET $" + strconv.Itoa(len(listArgs))

	rows, err := h.pool.Query(ctx, sql, listArgs...)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	type pair struct {
		o  models.Order
		cu models.Customer
	}
	pairs := []pair{}
	ids := []string{}
	for rows.Next() {
		var o models.Order
		var cu models.Customer
		var orderType, customerType string
		if serr := rows.Scan(
			&o.ID, &o.OrderNumber, &o.CustomerID, &o.Region, &o.ManagerID, &orderType, &o.BitrixDealID, &o.BitrixStage,
			&o.Status, &o.PlannedShipmentDate, &o.ActualShipmentDate, &o.OverdueDays, &o.StageTrackingMode, &o.AcceptedAt,
			&o.AcceptedByID, &o.IsArchived, &o.RequestDate, &o.CreatedAt, &o.UpdatedAt, &o.OnecNum, &o.OnecStatus,
			&o.OnecApprovalStatus, &o.OnecTotalAmount, &o.OnecPaidAmount, &o.FinalCustomer, &o.CustomerOrderNum,
			&o.ProjectGroup, &o.ProjectSite, &o.DivisionCode, &o.ClientAgreement, &o.OnecSyncedAt, &o.ProductionDocNumber,
			&o.ProductionDocDate, &o.SourceSheet, &o.SourceRowNumber, &o.RawColumns,
			&cu.ID, &cu.Name, &cu.BinIin, &cu.Region, &customerType,
		); serr != nil {
			rows.Close()
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		o.OrderType = models.OrderTypeDBToAPI(orderType)
		cu.CustomerType = models.CustomerTypeDBToAPI(customerType)
		pairs = append(pairs, pair{o: o, cu: cu})
		ids = append(ids, o.ID)
	}
	rows.Close()

	lines, lerr := loadOrderLines(ctx, h.pool, ids)
	if lerr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	data := make([]orderOut, 0, len(pairs))
	for _, p := range pairs {
		ol := lines[p.o.ID]
		if ol == nil {
			ol = []orderLineOut{}
		}
		cu := p.cu
		data = append(data, orderOut{Order: p.o, Customer: &cu, OrderLines: ol})
	}

	// rawColumns — сырые ячейки Excel с ценами; фронт их не читает, а роли
	// без прав на финансы читать их не должны — findAll вырезает КЛЮЧ и на
	// заказе, и на каждой позиции (деструктуризация в оригинале, не null)
	resp := stripKeyDeep(gin.H{"data": data, "meta": gin.H{"page": page, "pageSize": pageSize, "total": total}}, "rawColumns")
	c.JSON(http.StatusOK, resp)
}

// inboxLineArticle — inbox() в оригинале включает артикул с урезанной
// проекцией (`select: { id, articleCode, name }`), не полную запись,
// в отличие от findAll/findOne, которые тянут её целиком.
type inboxLineArticle struct {
	ID          string `json:"id"`
	ArticleCode string `json:"articleCode"`
	Name        string `json:"name"`
}

// Inbox — GET /orders/inbox (planner/sales_manager/director/admin) — заказы
// из 1С, ждущие явного приёма в производство, с блокерами приёма.
func (h *OrdersHandler) Inbox(c *gin.Context) {
	ctx := c.Request.Context()
	sql := "SELECT " + orderColsPrefixed + ", " + customerColsPrefixed +
		" FROM orders o JOIN customers cu ON cu.id = o.customer_id" +
		" WHERE o.status = 'NEW' AND o.is_archived = false ORDER BY o.created_at ASC"
	rows, err := h.pool.Query(ctx, sql)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	type pair struct {
		o  models.Order
		cu models.Customer
	}
	pairs := []pair{}
	ids := []string{}
	for rows.Next() {
		var o models.Order
		var cu models.Customer
		var orderType, customerType string
		if serr := rows.Scan(
			&o.ID, &o.OrderNumber, &o.CustomerID, &o.Region, &o.ManagerID, &orderType, &o.BitrixDealID, &o.BitrixStage,
			&o.Status, &o.PlannedShipmentDate, &o.ActualShipmentDate, &o.OverdueDays, &o.StageTrackingMode, &o.AcceptedAt,
			&o.AcceptedByID, &o.IsArchived, &o.RequestDate, &o.CreatedAt, &o.UpdatedAt, &o.OnecNum, &o.OnecStatus,
			&o.OnecApprovalStatus, &o.OnecTotalAmount, &o.OnecPaidAmount, &o.FinalCustomer, &o.CustomerOrderNum,
			&o.ProjectGroup, &o.ProjectSite, &o.DivisionCode, &o.ClientAgreement, &o.OnecSyncedAt, &o.ProductionDocNumber,
			&o.ProductionDocDate, &o.SourceSheet, &o.SourceRowNumber, &o.RawColumns,
			&cu.ID, &cu.Name, &cu.BinIin, &cu.Region, &customerType,
		); serr != nil {
			rows.Close()
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		o.OrderType = models.OrderTypeDBToAPI(orderType)
		cu.CustomerType = models.CustomerTypeDBToAPI(customerType)
		pairs = append(pairs, pair{o: o, cu: cu})
		ids = append(ids, o.ID)
	}
	rows.Close()

	lines, lerr := loadOrderLines(ctx, h.pool, ids)
	if lerr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	// Позиции с артикулом, но без состава — калькуляция будет пустой
	articleIDs := map[string]bool{}
	for _, ol := range lines {
		for _, l := range ol {
			if l.ArticleID != nil {
				articleIDs[*l.ArticleID] = true
			}
		}
	}
	withBom := map[string]bool{}
	if len(articleIDs) > 0 {
		ids2 := make([]string, 0, len(articleIDs))
		for id := range articleIDs {
			ids2 = append(ids2, id)
		}
		brows, berr := h.pool.Query(ctx, "SELECT DISTINCT article_id FROM bom_items WHERE article_id = ANY($1)", ids2)
		if berr != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
		for brows.Next() {
			var aid string
			if err := brows.Scan(&aid); err != nil {
				brows.Close()
				common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
				return
			}
			withBom[aid] = true
		}
		brows.Close()
	}

	out := make([]gin.H, 0, len(pairs))
	for _, p := range pairs {
		ol := lines[p.o.ID]
		if ol == nil {
			ol = []orderLineOut{}
		}
		blockers := []gin.H{}
		if len(ol) == 0 {
			blockers = append(blockers, gin.H{"code": "EMPTY_ORDER_LINES", "message": "Нет позиций — дождитесь синхронизации строк из 1С"})
		}
		var unresolved []orderLineOut
		for _, l := range ol {
			if l.ArticleID == nil {
				unresolved = append(unresolved, l)
			}
		}
		if len(unresolved) > 0 {
			names := []string{}
			for i, l := range unresolved {
				if i >= 3 {
					break
				}
				name := "—"
				if l.ProductNameRaw != nil && *l.ProductNameRaw != "" {
					name = *l.ProductNameRaw
				} else if l.ArticleCodeRaw != nil && *l.ArticleCodeRaw != "" {
					name = *l.ArticleCodeRaw
				}
				names = append(names, name)
			}
			suffix := ""
			if len(unresolved) > 3 {
				suffix = "…"
			}
			blockers = append(blockers, gin.H{
				"code":    "UNRESOLVED_ORDER_LINES",
				"message": strconv.Itoa(len(unresolved)) + " позиций без сопоставленного артикула: " + strings.Join(names, ", ") + suffix,
			})
		}
		if p.cu.BinIin == "" {
			blockers = append(blockers, gin.H{"code": "MISSING_CUSTOMER_BIN", "message": "У заказчика нет БИН/ИИН"})
		}
		var withArticle []orderLineOut
		for _, l := range ol {
			if l.ArticleID != nil {
				withArticle = append(withArticle, l)
			}
		}
		if len(withArticle) > 0 {
			var noBom int
			for _, l := range withArticle {
				if !withBom[*l.ArticleID] {
					noBom++
				}
			}
			if noBom > 0 {
				blockers = append(blockers, gin.H{"code": "NO_BOM", "message": strconv.Itoa(noBom) + " позиций без состава изделия — калькуляция будет пустой"})
			}
		}
		canAccept := true
		for _, b := range blockers {
			if b["code"] != "NO_BOM" {
				canAccept = false
				break
			}
		}

		// inbox НЕ вырезает rawColumns (ни заказа, ни позиций) — в отличие от
		// findAll, здесь просто {...o, blockers, canAccept} без деструктуризации;
		// и article — урезанная проекция {id, articleCode, name}, не полная запись
		linesOut := make([]gin.H, len(ol))
		for i, l := range ol {
			var article interface{}
			if l.Article != nil {
				article = inboxLineArticle{ID: l.Article.ID, ArticleCode: l.Article.ArticleCode, Name: l.Article.Name}
			}
			linesOut[i] = gin.H{
				"id": l.ID, "orderId": l.OrderID, "articleId": l.ArticleID, "qty": l.Qty, "unit": l.Unit,
				"unitPrice": l.UnitPrice, "lineTotalVat": l.LineTotalVat, "prepayment": l.Prepayment,
				"postPayment1": l.PostPayment1, "postPayment2": l.PostPayment2, "penalty": l.Penalty,
				"balanceDue": l.BalanceDue, "reservedQty": l.ReservedQty, "shippedQty": l.ShippedQty,
				"siteCode": l.SiteCode, "sourceSheet": l.SourceSheet, "sourceRowNumber": l.SourceRowNumber,
				"articleCodeRaw": l.ArticleCodeRaw, "productNameRaw": l.ProductNameRaw, "rawColumns": l.RawColumns,
				"article": article,
			}
		}

		o := p.o
		cu := p.cu
		out = append(out, gin.H{
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
			"customer": cu, "orderLines": linesOut,
			"blockers": blockers, "canAccept": canAccept,
		})
	}

	c.JSON(http.StatusOK, gin.H{"data": out, "meta": gin.H{"total": len(out)}})
}

// apiErr — статус/код/сообщение для прямого ответа клиенту, чтобы не
// городить множественные возвраты ошибок через error+status+message.
type apiErr struct {
	status  int
	code    string
	message string
}

func (e *apiErr) Error() string { return e.message }

func failDB() *apiErr {
	return &apiErr{status: http.StatusInternalServerError, code: "INTERNAL_SERVER_ERROR", message: "Ошибка базы данных"}
}

// transitionOrder — переход статуса через state machine: проверка роли на
// конкретный переход, бизнес-условия, запись в аудит + outbox в 1С.
func (h *OrdersHandler) transitionOrder(ctx context.Context, id, toStatus string, comment *string, user authpkg.UserPayload) (models.Order, orderstate.AuditLogPayload, *apiErr) {
	var o models.Order
	row := h.pool.QueryRow(ctx, "SELECT "+OrderCols+" FROM orders WHERE id = $1", id)
	if err := scanOrderFields(row, &o); err == pgx.ErrNoRows {
		return o, orderstate.AuditLogPayload{}, &apiErr{http.StatusNotFound, "NOT_FOUND", "Order " + id + " not found"}
	} else if err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}

	allowedRoles, known := statusTransitionRoles[toStatus]
	if !known {
		return o, orderstate.AuditLogPayload{}, &apiErr{http.StatusBadRequest, "INVALID_STATUS", "Unknown target status: " + toStatus}
	}
	if !roleIn(user.Roles, allowedRoles) {
		return o, orderstate.AuditLogPayload{}, &apiErr{http.StatusForbidden, "TRANSITION_FORBIDDEN",
			"Роли [" + strings.Join(user.Roles, ", ") + "] не могут перевести заказ в " + toStatus}
	}

	lines, err := h.loadTransitionLines(ctx, id)
	if err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}
	stages, err := h.loadTransitionStages(ctx, id)
	if err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}

	var customerBinIin *string
	if err := h.pool.QueryRow(ctx, "SELECT bin_iin FROM customers WHERE id = $1", o.CustomerID).Scan(&customerBinIin); err != nil && err != pgx.ErrNoRows {
		return o, orderstate.AuditLogPayload{}, failDB()
	}

	var orderedQty, shippedQty float64
	if err := h.pool.QueryRow(ctx, "SELECT COALESCE(SUM(qty),0) FROM order_lines WHERE order_id = $1", id).Scan(&orderedQty); err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}
	if err := h.pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(qty),0) FROM finished_goods_movements
		WHERE order_id = $1 AND movement_type = 'отгрузка'`, id).Scan(&shippedQty); err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}

	// Долг: по ДО, если они есть; иначе по строкам заказа
	var paymentDocsCount int
	var balanceDue float64
	if err := h.pool.QueryRow(ctx, "SELECT count(*), COALESCE(SUM(unpaid_amount),0) FROM payment_documents WHERE order_id = $1", id).
		Scan(&paymentDocsCount, &balanceDue); err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}
	if paymentDocsCount == 0 {
		if err := h.pool.QueryRow(ctx, "SELECT COALESCE(SUM(balance_due),0) FROM order_lines WHERE order_id = $1", id).Scan(&balanceDue); err != nil {
			return o, orderstate.AuditLogPayload{}, failDB()
		}
	}

	var acceptanceActsCount int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM acceptance_acts WHERE order_id = $1", id).Scan(&acceptanceActsCount); err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}

	octx := orderstate.OrderStateContext{
		OrderID:              o.ID,
		CurrentStatus:        o.Status,
		Lines:                lines,
		CustomerBinIin:       customerBinIin,
		ProductionStages:     stages,
		ProductLineIDs:       nil,
		FinishedGoodsShipped: orderedQty > 0 && shippedQty >= orderedQty,
		BalanceDue:           balanceDue,
		HasAcceptanceAct:     acceptanceActsCount > 0,
	}
	userRole := ""
	if len(user.Roles) > 0 {
		userRole = user.Roles[0]
	}
	audit, terr := orderstate.Transition(octx, orderstate.TransitionRequest{
		TargetStatus: toStatus, UserID: user.UserID, UserRole: userRole, Comment: comment,
	})
	if terr != nil {
		if ge, ok := terr.(*orderstate.GuardError); ok {
			return o, orderstate.AuditLogPayload{}, &apiErr{http.StatusConflict, ge.Code, ge.Error()}
		}
		return o, orderstate.AuditLogPayload{}, failDB()
	}

	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, "UPDATE orders SET status = $1 WHERE id = $2", toStatus, id); err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}
	if err := integration.Enqueue(ctx, tx, integration.Message{
		Type: "production-status", EntityType: "Order", EntityID: o.ID,
		Payload: map[string]interface{}{
			"orderNumber": o.OrderNumber, "onecNum": o.OnecNum, "status": toStatus,
			"changedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "comment": commentOrNil(comment),
		},
	}); err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}
	auditUserID := dbUserID(user.UserID)
	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_log (id, entity_type, entity_id, action, before, after, user_id, user_role, comment)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		uuid.NewString(), audit.EntityType, audit.EntityID, audit.Action,
		jsonStatus(audit.BeforeStatus), jsonStatus(audit.AfterStatus), auditUserID, audit.UserRole, comment); err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}
	if err := tx.Commit(ctx); err != nil {
		return o, orderstate.AuditLogPayload{}, failDB()
	}

	o.Status = toStatus
	return o, audit, nil
}

func commentOrNil(c *string) interface{} {
	if c == nil {
		return nil
	}
	return *c
}

func jsonStatus(s string) []byte {
	return []byte(`{"status":"` + s + `"}`)
}

func dbUserID(userID string) *string {
	if userID == "" || strings.HasPrefix(userID, "usr-") {
		return nil
	}
	return &userID
}

func (h *OrdersHandler) loadTransitionLines(ctx context.Context, orderID string) ([]orderstate.OrderLineCtx, error) {
	rows, err := h.pool.Query(ctx, "SELECT qty, reserved_qty, article_id FROM order_lines WHERE order_id = $1", orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []orderstate.OrderLineCtx
	for rows.Next() {
		var qty, reservedQty float64
		var articleID *string
		if err := rows.Scan(&qty, &reservedQty, &articleID); err != nil {
			return nil, err
		}
		code := ""
		if articleID != nil {
			code = *articleID
		}
		out = append(out, orderstate.OrderLineCtx{Qty: qty, ReservedQty: reservedQty, ArticleCode: code})
	}
	return out, rows.Err()
}

func auditOut(a orderstate.AuditLogPayload) gin.H {
	return gin.H{
		"entityType": a.EntityType,
		"entityId":   a.EntityID,
		"action":     a.Action,
		"before":     gin.H{"status": a.BeforeStatus},
		"after":      gin.H{"status": a.AfterStatus},
		"userId":     a.UserID,
		"userRole":   a.UserRole,
		"comment":    commentOrNil(a.Comment),
		"timestamp":  a.Timestamp.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
}

func respondAPIErr(c *gin.Context, err *apiErr) {
	common.Fail(c, err.status, err.code, err.message)
}

type transitionBody struct {
	ToStatus *string `json:"toStatus"`
	Status   *string `json:"status"`
	Comment  *string `json:"comment"`
}

func (b transitionBody) resolveTarget() string {
	if b.ToStatus != nil {
		return *b.ToStatus
	}
	if b.Status != nil {
		return *b.Status
	}
	return ""
}

// TransitionStatus — POST /orders/:id/status.
func (h *OrdersHandler) TransitionStatus(c *gin.Context) {
	id := c.Param("id")
	var body transitionBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	target := body.resolveTarget()
	if target == "" {
		common.BadRequest(c, "MISSING_STATUS", "toStatus is required")
		return
	}
	user := authpkg.CurrentUser(c)
	order, audit, aerr := h.transitionOrder(c.Request.Context(), id, target, body.Comment, user)
	if aerr != nil {
		respondAPIErr(c, aerr)
		return
	}
	c.JSON(http.StatusOK, gin.H{"order": order, "audit": auditOut(audit)})
}

// UpdateStatus — PATCH /orders/:id/status (тот же переход, другой глагол HTTP).
func (h *OrdersHandler) UpdateStatus(c *gin.Context) {
	id := c.Param("id")
	var body transitionBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	target := body.resolveTarget()
	if target == "" {
		common.BadRequest(c, "MISSING_STATUS", "status is required")
		return
	}
	user := authpkg.CurrentUser(c)
	order, audit, aerr := h.transitionOrder(c.Request.Context(), id, target, body.Comment, user)
	if aerr != nil {
		respondAPIErr(c, aerr)
		return
	}
	c.JSON(http.StatusOK, gin.H{"order": order, "audit": auditOut(audit)})
}

type acceptOrderBody struct {
	Comment *string `json:"comment"`
}

// AcceptOrder — POST /orders/:id/accept (planner/sales_manager/director/admin) —
// явный приём из инбокса: NEW → CONFIRMED с записью, кто и когда принял.
func (h *OrdersHandler) AcceptOrder(c *gin.Context) {
	id := c.Param("id")
	var body acceptOrderBody
	_ = c.ShouldBindJSON(&body)
	comment := "Принят в производство из инбокса"
	if body.Comment != nil && *body.Comment != "" {
		comment = *body.Comment
	}
	user := authpkg.CurrentUser(c)
	ctx := c.Request.Context()
	_, audit, aerr := h.transitionOrder(ctx, id, orderstate.StatusConfirmed, &comment, user)
	if aerr != nil {
		respondAPIErr(c, aerr)
		return
	}

	var employeeID *string
	if !strings.HasPrefix(user.UserID, "usr-") {
		_ = h.pool.QueryRow(ctx, "SELECT employee_id FROM users WHERE id = $1", user.UserID).Scan(&employeeID)
	}
	now := time.Now().UTC()
	row := h.pool.QueryRow(ctx, `
		UPDATE orders SET accepted_at = $1, accepted_by_id = $2 WHERE id = $3
		RETURNING `+OrderCols, now, employeeID, id)
	var updated models.Order
	if err := scanOrderFields(row, &updated); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	// {...result, order} в оригинале: спред result ({order, audit}) с
	// перезаписью order на только что обновлённую (с acceptedAt) запись
	c.JSON(http.StatusOK, gin.H{"order": updated, "audit": auditOut(audit)})
}

// FindOne — GET /orders/:id
func (h *OrdersHandler) FindOne(c *gin.Context) {
	id := c.Param("id")
	ctx := c.Request.Context()
	user := authpkg.CurrentUser(c)

	row := h.pool.QueryRow(ctx, "SELECT "+OrderCols+" FROM orders WHERE id = $1", id)
	var o models.Order
	if err := scanOrderFields(row, &o); err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	// Row scope действует и на доступ по прямому ID; чужой заказ = 404, не 403 —
	// не раскрываем сам факт существования (§1.8)
	if field, value, ok := h.rowScopeWhere(ctx, user); ok {
		actual := ""
		switch field {
		case "customer_id":
			actual = o.CustomerID
		case "manager_id":
			if o.ManagerID != nil {
				actual = *o.ManagerID
			}
		}
		if actual != value {
			common.NotFound(c, "Order "+id+" not found")
			return
		}
	}

	var cu models.Customer
	crow := h.pool.QueryRow(ctx, "SELECT "+customerColsPrefixed+" FROM customers cu WHERE cu.id = $1", o.CustomerID)
	if err := func() error {
		var customerType string
		err := crow.Scan(&cu.ID, &cu.Name, &cu.BinIin, &cu.Region, &customerType)
		cu.CustomerType = models.CustomerTypeDBToAPI(customerType)
		return err
	}(); err != nil && err != pgx.ErrNoRows {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	lines, lerr := loadOrderLines(ctx, h.pool, []string{id})
	if lerr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	ol := lines[id]
	if ol == nil {
		ol = []orderLineOut{}
	}
	// findOne (в отличие от findAll) НЕ вырезает rawColumns у вложенных
	// orderLines — ключ должен остаться, даже если значение null (omitempty
	// на models.OrderLine предназначен для findAll, здесь его надо обойти)
	olOut := make([]gin.H, len(ol))
	for i, l := range ol {
		olOut[i] = gin.H{
			"id": l.ID, "orderId": l.OrderID, "articleId": l.ArticleID, "qty": l.Qty, "unit": l.Unit,
			"unitPrice": l.UnitPrice, "lineTotalVat": l.LineTotalVat, "prepayment": l.Prepayment,
			"postPayment1": l.PostPayment1, "postPayment2": l.PostPayment2, "penalty": l.Penalty,
			"balanceDue": l.BalanceDue, "reservedQty": l.ReservedQty, "shippedQty": l.ShippedQty,
			"siteCode": l.SiteCode, "sourceSheet": l.SourceSheet, "sourceRowNumber": l.SourceRowNumber,
			"articleCodeRaw": l.ArticleCodeRaw, "productNameRaw": l.ProductNameRaw, "rawColumns": l.RawColumns,
			"article": l.Article,
		}
	}

	paymentDocs, perr := h.loadPaymentDocuments(ctx, id)
	if perr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	stages, serr := h.loadProductionStagesOut(ctx, id)
	if serr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	perms := authpkg.PermissionsForRoles(user.Roles)
	resp := gin.H{
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
		"customer": cu, "orderLines": olOut, "paymentDocuments": paymentDocs, "productionStages": stages,
	}
	// rawColumns — полный сырой ряд 1С; та же дыра, что и раньше в findAll —
	// роль без прав на финансы не должна получать деньги заказа через detail.
	// Оригинал вырезает КЛЮЧ через деструктуризацию (`const { rawColumns, ...rest }`),
	// не зануляет значение — ключ должен физически отсутствовать в JSON.
	// ВАЖНО: оригинал вырезает rawColumns только на уровне заказа — вложенные
	// orderLines[].rawColumns findOne не трогает вообще (в отличие от findAll,
	// который чистит и там); это asymметрия оригинала, повторяем как есть.
	if !authpkg.HasPermission(perms, "order.commercial:read") {
		delete(resp, "rawColumns")
	}

	c.JSON(http.StatusOK, resp)
}

func (h *OrdersHandler) loadPaymentDocuments(ctx context.Context, orderID string) ([]gin.H, error) {
	rows, err := h.pool.Query(ctx, `
		SELECT id, unpaid_amount, status FROM payment_documents WHERE order_id = $1`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id, status string
		var unpaid float64
		if err := rows.Scan(&id, &unpaid, &status); err != nil {
			return nil, err
		}
		out = append(out, gin.H{"id": id, "unpaidAmount": unpaid, "status": status})
	}
	return out, rows.Err()
}

type productionStageOut struct {
	ID              string   `json:"id"`
	OrderID         string   `json:"orderId"`
	OrderLineID     *string  `json:"orderLineId"`
	StageCode       string   `json:"stageCode"`
	RoutingStage    *string  `json:"routingStage"`
	Status          string   `json:"status"`
	ActualWorkers   *float64 `json:"actualWorkers"`
	ActualHours     *float64 `json:"actualHours"`
	LegacyStageCode *string  `json:"legacyStageCode"`
	CompletedAt     *string  `json:"completedAt"`
	CompletedByID   *string  `json:"completedById"`
	DefectPhotoURL  *string  `json:"defectPhotoUrl"`
}

func (h *OrdersHandler) loadProductionStagesOut(ctx context.Context, orderID string) ([]productionStageOut, error) {
	rows, err := h.pool.Query(ctx, `
		SELECT id, order_id, order_line_id, stage_code, routing_stage, status, actual_workers, actual_hours,
		       legacy_stage_code, completed_at, completed_by_id, defect_photo_url
		FROM production_stages WHERE order_id = $1`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []productionStageOut{}
	for rows.Next() {
		var s productionStageOut
		var stageCode, status string
		var routingStageDB *string
		var completedAt *time.Time
		if err := rows.Scan(&s.ID, &s.OrderID, &s.OrderLineID, &stageCode, &routingStageDB, &status,
			&s.ActualWorkers, &s.ActualHours, &s.LegacyStageCode, &completedAt, &s.CompletedByID, &s.DefectPhotoURL); err != nil {
			return nil, err
		}
		s.StageCode = models.OrderStageCodeDBToAPI(stageCode)
		if routingStageDB != nil {
			v := models.RoutingStageDBToAPI(*routingStageDB)
			s.RoutingStage = &v
		}
		s.Status = models.StageStatusDBToAPI(status)
		if completedAt != nil {
			v := completedAt.UTC().Format("2006-01-02T15:04:05.000Z")
			s.CompletedAt = &v
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

type setLineSiteBody struct {
	SiteCode *string `json:"siteCode"`
}

// SetLineSite — PATCH /orders/:id/lines/:lineId/site (sales_manager/planner/admin).
func (h *OrdersHandler) SetLineSite(c *gin.Context) {
	id := c.Param("id")
	lineID := c.Param("lineId")
	var body setLineSiteBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()

	var lineOrderID string
	if err := h.pool.QueryRow(ctx, "SELECT order_id FROM order_lines WHERE id = $1", lineID).Scan(&lineOrderID); err == pgx.ErrNoRows || (err == nil && lineOrderID != id) {
		common.NotFound(c, "Позиция не найдена в этом заказе")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	var siteCode *string
	if body.SiteCode != nil {
		trimmed := strings.TrimSpace(*body.SiteCode)
		if trimmed != "" {
			siteCode = &trimmed
		}
	}
	if siteCode != nil && len(*siteCode) > 60 {
		common.BadRequest(c, "TOO_LONG", "Код объекта — до 60 символов")
		return
	}

	var updatedID string
	var updatedSite *string
	if err := h.pool.QueryRow(ctx, "UPDATE order_lines SET site_code = $1 WHERE id = $2 RETURNING id, site_code", siteCode, lineID).
		Scan(&updatedID, &updatedSite); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": updatedID, "siteCode": updatedSite})
}

func (h *OrdersHandler) loadTransitionStages(ctx context.Context, orderID string) ([]orderstate.StageRow, error) {
	rows, err := h.pool.Query(ctx, "SELECT stage_code, routing_stage, order_line_id, status FROM production_stages WHERE order_id = $1", orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []orderstate.StageRow
	for rows.Next() {
		var stageCode, status string
		var routingStageDB *string
		var lineID *string
		if err := rows.Scan(&stageCode, &routingStageDB, &lineID, &status); err != nil {
			return nil, err
		}
		var rs *string
		if routingStageDB != nil {
			v := models.RoutingStageDBToAPI(*routingStageDB)
			rs = &v
		}
		out = append(out, orderstate.StageRow{
			StageCode: models.OrderStageCodeDBToAPI(stageCode), RoutingStage: rs, OrderLineID: lineID,
			Status: strings.ToLower(status),
		})
	}
	return out, rows.Err()
}

type stageTrackingModeBody struct {
	Mode string `json:"mode"`
}

// SetStageTrackingMode — PATCH /orders/:id/stage-tracking-mode (planner/shop_foreman/admin).
// Переключение вниз, на отметку заказа целиком, запрещено при уже
// проставленных позициях: иначе построчный факт осиротеет.
func (h *OrdersHandler) SetStageTrackingMode(c *gin.Context) {
	id := c.Param("id")
	var body stageTrackingModeBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	if body.Mode != "ORDER" && body.Mode != "LINE" {
		common.BadRequest(c, "INVALID_TRACKING_MODE", "Режим отметки: ORDER или LINE, получено "+body.Mode)
		return
	}
	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM orders WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	if body.Mode == "ORDER" {
		var lineStages int
		if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM production_stages WHERE order_id = $1 AND order_line_id IS NOT NULL", id).Scan(&lineStages); err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
		if lineStages > 0 {
			common.Conflict(c, "LINE_STAGES_EXIST", "Нельзя вернуть отметку на заказ целиком: по позициям уже отмечено "+strconv.Itoa(lineStages)+" этапов")
			return
		}
	}

	row := h.pool.QueryRow(ctx, "UPDATE orders SET stage_tracking_mode = $1 WHERE id = $2 RETURNING "+OrderCols, body.Mode, id)
	var o models.Order
	if err := scanOrderFields(row, &o); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	c.JSON(http.StatusOK, o)
}

type updateProductionStageBody struct {
	Status         string   `json:"status"`
	RoutingStage   *string  `json:"routingStage"`
	OrderLineID    *string  `json:"orderLineId"`
	ActualWorkers  *float64 `json:"actualWorkers"`
	ActualHours    *float64 `json:"actualHours"`
	DefectPhotoURL *string  `json:"defectPhotoUrl"`
}

type stageOrderLine struct {
	ID               string
	Qty              float64
	Unit             string
	ArticleID        *string
	ArticleCode      string
	ArticleName      string
	IsMaterialResale bool
	HasArticle       bool
	BomCount         int
	NormsCount       int
}

// UpdateProductionStage — PATCH /orders/:id/production-stages/:code
// (shop_foreman/planner/admin) — отметка изделия цехом. Самая тяжёлая
// мутация Orders: пишет outbox в 1С (production-stage, затем при полной
// готовности production-status + production.completed со сверкой BOM и
// внешними GUID, либо production.cancelled + компенсирующее движение при
// снятии отметки после READY_TO_SHIP), создаёт FinishedGoodsMovement.
func (h *OrdersHandler) UpdateProductionStage(c *gin.Context) {
	id := c.Param("id")
	code := c.Param("code")
	var body updateProductionStageBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	if shapeErr := orderstate.StageShapeError(code, body.RoutingStage); shapeErr != "" {
		common.BadRequest(c, "INVALID_STAGE_CODE", shapeErr)
		return
	}
	status, ok := stageStatusMap[body.Status]
	if !ok {
		common.BadRequest(c, "INVALID_STAGE_STATUS", "Недопустимый статус этапа: "+body.Status)
		return
	}

	ctx := c.Request.Context()
	var o models.Order
	row := h.pool.QueryRow(ctx, "SELECT "+OrderCols+" FROM orders WHERE id = $1", id)
	if err := scanOrderFields(row, &o); err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	lines, lerr := h.loadStageOrderLines(ctx, id)
	if lerr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	orderLineID := body.OrderLineID
	if orderLineID == nil || *orderLineID == "" {
		common.BadRequest(c, "ORDER_LINE_REQUIRED", "Укажите изделие (orderLineId): производство отмечается по изделиям")
		return
	}
	var line *stageOrderLine
	for i := range lines {
		if lines[i].ID == *orderLineID {
			line = &lines[i]
			break
		}
	}
	if line == nil {
		common.BadRequest(c, "ORDER_LINE_NOT_IN_ORDER", "Позиция "+*orderLineID+" не принадлежит заказу "+o.OrderNumber)
		return
	}
	if line.HasArticle && line.IsMaterialResale {
		common.BadRequest(c, "NOT_MANUFACTURED", "«"+line.ArticleName+"» — сырьё или ТМЦ, завод его не изготавливает")
		return
	}

	if status == "DONE" && line.HasArticle {
		noBom := line.BomCount == 0
		noNorms := line.NormsCount == 0
		if noBom || noNorms {
			missing := "нормы труда"
			if noBom && noNorms {
				missing = "состав и нормы труда"
			} else if noBom {
				missing = "состав (какое сырьё идёт в изделие)"
			}
			common.FailDetails(c, http.StatusBadRequest, "SPEC_REQUIRED",
				"У «"+line.ArticleName+"» ("+line.ArticleCode+") не заведены "+missing+"."+
					" Пока их нет, изготовление записать нельзя: списывать нечего и себестоимость встанет в ноль."+
					" Заведите спецификацию в «Изделиях» — или отметьте позицию как ТМЦ, если её не изготавливают",
				gin.H{"articleId": *line.ArticleID, "articleCode": line.ArticleCode, "missingBom": noBom, "missingNorms": noNorms})
			return
		}
	}

	user := authpkg.CurrentUser(c)
	var completedByID *string
	if status == "DONE" && !strings.HasPrefix(user.UserID, "usr-") {
		var empID *string
		_ = h.pool.QueryRow(ctx, "SELECT employee_id FROM users WHERE id = $1", user.UserID).Scan(&empID)
		completedByID = empID
	}

	routingStageDB := (*string)(nil)
	if body.RoutingStage != nil && *body.RoutingStage != "" {
		v := models.RoutingStageAPIToDB(*body.RoutingStage)
		routingStageDB = &v
	}
	stageCodeDB := models.OrderStageCodeAPIToDB(code)
	statusDB := models.StageStatusAPIToDB(status)

	var completedAt *time.Time
	if status == "DONE" {
		now := time.Now().UTC()
		completedAt = &now
	}

	tx, err := h.pool.Begin(ctx)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer tx.Rollback(ctx)

	// Составного уникального ключа нет намеренно: NULL-ы в orderLineId и
	// routingStage обычный UNIQUE считает различными; уникальность держат
	// частичные индексы БД, поиск здесь — по тем же полям
	var existingID string
	findErr := tx.QueryRow(ctx, `
		SELECT id FROM production_stages
		WHERE order_id = $1 AND order_line_id = $2 AND stage_code = $3
		  AND ((routing_stage IS NULL AND $4::text IS NULL) OR routing_stage::text = $4)`,
		id, orderLineID, stageCodeDB, routingStageDB).Scan(&existingID)
	if findErr != nil && findErr != pgx.ErrNoRows {
		common.DebugLog(findErr)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	var stageID string
	if findErr == pgx.ErrNoRows {
		stageID = uuid.NewString()
		if _, err := tx.Exec(ctx, `
			INSERT INTO production_stages
				(id, order_id, order_line_id, stage_code, routing_stage, status, actual_workers, actual_hours, completed_at, completed_by_id, defect_photo_url)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			stageID, id, orderLineID, stageCodeDB, routingStageDB, statusDB,
			body.ActualWorkers, body.ActualHours, completedAt, completedByID, body.DefectPhotoURL); err != nil {
			common.DebugLog(err)
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
	} else {
		stageID = existingID
		if _, err := tx.Exec(ctx, `
			UPDATE production_stages SET status = $1, actual_workers = $2, actual_hours = $3,
			       completed_at = $4, completed_by_id = $5, defect_photo_url = $6
			WHERE id = $7`,
			statusDB, body.ActualWorkers, body.ActualHours, completedAt, completedByID, body.DefectPhotoURL, stageID); err != nil {
			common.DebugLog(err)
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
	}

	if err := integration.Enqueue(ctx, tx, integration.Message{
		Type: "production-stage", EntityType: "Order", EntityID: id,
		Payload: map[string]interface{}{
			"orderNumber": o.OrderNumber, "onecNum": o.OnecNum, "stageCode": code,
			"routingStage": strOrNil(body.RoutingStage), "status": status,
			"changedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		},
	}); err != nil {
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	allStages, aerr := h.loadTransitionStagesTx(ctx, tx, id)
	if aerr != nil {
		common.DebugLog(aerr)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	// Заказ готов, когда изготовлены ВСЕ его изделия. Сырьё и ТМЦ в меру не входят
	var productLineIDs []string
	for _, l := range lines {
		if l.HasArticle && !l.IsMaterialResale {
			productLineIDs = append(productLineIDs, l.ID)
		}
	}
	derived := orderstate.DeriveStatusFromStages(o.Status, allStages, productLineIDs)

	respStage := productionStageOut{
		ID: stageID, OrderID: id, OrderLineID: orderLineID, StageCode: code, RoutingStage: body.RoutingStage,
		Status: status, ActualWorkers: body.ActualWorkers, ActualHours: body.ActualHours,
		CompletedByID: completedByID, DefectPhotoURL: body.DefectPhotoURL,
	}
	if completedAt != nil {
		v := completedAt.UTC().Format("2006-01-02T15:04:05.000Z")
		respStage.CompletedAt = &v
	}

	if derived == "" {
		if err := tx.Commit(ctx); err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
		c.JSON(http.StatusOK, mergeStageOut(respStage, o.Status, false))
		return
	}

	// Условие в WHERE: если статус успели сдвинуть между чтением заказа и этой
	// записью, обновление не применится и чужое решение не будет затёрто
	tag, uerr := tx.Exec(ctx, "UPDATE orders SET status = $1 WHERE id = $2 AND status = $3", derived, id, o.Status)
	if uerr != nil {
		common.DebugLog(uerr)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	if tag.RowsAffected() == 0 {
		if err := tx.Commit(ctx); err != nil {
			common.DebugLog(err)
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
		c.JSON(http.StatusOK, mergeStageOut(respStage, o.Status, false))
		return
	}

	routingSuffix := ""
	if body.RoutingStage != nil && *body.RoutingStage != "" {
		routingSuffix = " / " + *body.RoutingStage
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_log (id, entity_type, entity_id, action, before, after, user_id, user_role, comment)
		VALUES ($1,'Order',$2,'status_change',$3,$4,$5,$6,$7)`,
		uuid.NewString(), id, jsonStatus(o.Status), jsonStatus(derived), dbUserID(user.UserID),
		firstOrEmpty(user.Roles), "Автоматически по этапам: "+code+routingSuffix+" → "+status); err != nil {
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	if err := integration.Enqueue(ctx, tx, integration.Message{
		Type: "production-status", EntityType: "Order", EntityID: id,
		Payload: map[string]interface{}{
			"orderNumber": o.OrderNumber, "onecNum": o.OnecNum, "status": derived,
			"changedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "comment": "автоматически по отметкам этапов",
		},
	}); err != nil {
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	if derived == orderstate.StatusReadyToShip {
		if err := h.postProductionCompleted(ctx, tx, o, lines, user); err != nil {
			common.DebugLog(err)
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
	} else if o.Status == orderstate.StatusReadyToShip {
		if err := h.postProductionCancelled(ctx, tx, o, code, routingSuffix, status, user); err != nil {
			common.DebugLog(err)
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	c.JSON(http.StatusOK, mergeStageOut(respStage, derived, true))
}

func mergeStageOut(stage productionStageOut, orderStatus string, changed bool) gin.H {
	return gin.H{
		"id": stage.ID, "orderId": stage.OrderID, "orderLineId": stage.OrderLineID, "stageCode": stage.StageCode,
		"routingStage": stage.RoutingStage, "status": stage.Status, "actualWorkers": stage.ActualWorkers,
		"actualHours": stage.ActualHours, "legacyStageCode": stage.LegacyStageCode, "completedAt": stage.CompletedAt,
		"completedById": stage.CompletedByID, "defectPhotoUrl": stage.DefectPhotoURL,
		"orderStatus": orderStatus, "orderStatusChanged": changed,
	}
}

func strOrNil(s *string) interface{} {
	if s == nil {
		return nil
	}
	return *s
}

func firstOrEmpty(list []string) string {
	if len(list) == 0 {
		return ""
	}
	return list[0]
}

func (h *OrdersHandler) loadTransitionStagesTx(ctx context.Context, tx pgx.Tx, orderID string) ([]orderstate.StageRow, error) {
	rows, err := tx.Query(ctx, "SELECT stage_code, routing_stage, order_line_id, status FROM production_stages WHERE order_id = $1", orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []orderstate.StageRow
	for rows.Next() {
		var stageCode, status string
		var routingStageDB, lineID *string
		if err := rows.Scan(&stageCode, &routingStageDB, &lineID, &status); err != nil {
			return nil, err
		}
		var rs *string
		if routingStageDB != nil {
			v := models.RoutingStageDBToAPI(*routingStageDB)
			rs = &v
		}
		out = append(out, orderstate.StageRow{
			StageCode: models.OrderStageCodeDBToAPI(stageCode), RoutingStage: rs, OrderLineID: lineID,
			Status: strings.ToLower(status),
		})
	}
	return out, rows.Err()
}

func (h *OrdersHandler) loadStageOrderLines(ctx context.Context, orderID string) ([]stageOrderLine, error) {
	rows, err := h.pool.Query(ctx, `
		SELECT ol.id, ol.qty, ol.unit, ol.article_id,
		       a.article_code, a.name, a.is_material_resale,
		       (SELECT count(*) FROM bom_items bi WHERE bi.article_id = a.id),
		       (SELECT count(*) FROM routing_operations ro WHERE ro.article_id = a.id)
		FROM order_lines ol
		LEFT JOIN articles a ON a.id = ol.article_id
		WHERE ol.order_id = $1`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []stageOrderLine
	for rows.Next() {
		var l stageOrderLine
		var articleCode, articleName *string
		var isResale *bool
		var bomCount, normsCount *int
		if err := rows.Scan(&l.ID, &l.Qty, &l.Unit, &l.ArticleID, &articleCode, &articleName, &isResale, &bomCount, &normsCount); err != nil {
			return nil, err
		}
		if l.ArticleID != nil {
			l.HasArticle = true
			if articleCode != nil {
				l.ArticleCode = *articleCode
			}
			if articleName != nil {
				l.ArticleName = *articleName
			}
			if isResale != nil {
				l.IsMaterialResale = *isResale
			}
			if bomCount != nil {
				l.BomCount = *bomCount
			}
			if normsCount != nil {
				l.NormsCount = *normsCount
			}
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// postProductionCompleted — все виды работ закрыты, заказ изготовлен: один
// сигнал в 1С со всеми позициями (production.completed) + приход готовой
// продукции той же транзакцией (FinishedGoodsMovement FROM_PRODUCTION).
func (h *OrdersHandler) postProductionCompleted(ctx context.Context, tx pgx.Tx, o models.Order, lines []stageOrderLine, user authpkg.UserPayload) error {
	var producedLines []stageOrderLine
	var articleIDs []string
	seen := map[string]bool{}
	for _, l := range lines {
		if l.HasArticle && !l.IsMaterialResale {
			producedLines = append(producedLines, l)
			if !seen[*l.ArticleID] {
				seen[*l.ArticleID] = true
				articleIDs = append(articleIDs, *l.ArticleID)
			}
		}
	}

	type bomRow struct {
		ArticleID    string
		MaterialID   string
		MaterialCode string
		MaterialName string
		Unit         string
		QtyPerUnit   float64
	}
	var bomRows []bomRow
	if len(articleIDs) > 0 {
		rows, err := tx.Query(ctx, `
			SELECT bi.article_id, m.id, m.material_code, m.name, m.unit, bi.qty_per_unit
			FROM bom_items bi JOIN materials m ON m.id = bi.material_id
			WHERE bi.article_id = ANY($1)`, articleIDs)
		if err != nil {
			return err
		}
		for rows.Next() {
			var r bomRow
			if err := rows.Scan(&r.ArticleID, &r.MaterialID, &r.MaterialCode, &r.MaterialName, &r.Unit, &r.QtyPerUnit); err != nil {
				rows.Close()
				return err
			}
			bomRows = append(bomRows, r)
		}
		rows.Close()
	}

	type matAgg struct {
		MaterialCode string
		Name         string
		Unit         string
		Qty          float64
	}
	materialQty := map[string]*matAgg{}
	materialOrder := []string{}
	for _, l := range producedLines {
		for _, b := range bomRows {
			if b.ArticleID != *l.ArticleID {
				continue
			}
			cur, ok := materialQty[b.MaterialID]
			if !ok {
				cur = &matAgg{MaterialCode: b.MaterialCode, Name: b.MaterialName, Unit: b.Unit}
				materialQty[b.MaterialID] = cur
				materialOrder = append(materialOrder, b.MaterialID)
			}
			cur.Qty += b.QtyPerUnit * l.Qty
		}
	}

	materialGuids, err := integration.FindExternalIds(ctx, tx, "Material", materialOrder, "1C")
	if err != nil {
		return err
	}
	articleGuids, err := integration.FindExternalIds(ctx, tx, "Article", articleIDs, "1C")
	if err != nil {
		return err
	}

	var rawColumns map[string]interface{}
	if len(o.RawColumns) > 0 {
		_ = json.Unmarshal(o.RawColumns, &rawColumns)
	}
	fromWarehouse, toWarehouse := orderstate.ResolveProductionWarehouses(rawColumns)

	// Использованные обрезки — информация для 1С, не команда: уменьшать ли
	// списание, бизнес ещё не решил (модель OffcutUsage)
	type offcutRow struct {
		MaterialCode string
		MaterialName string
		LengthMm     float64
		WidthMm      *float64
		Qty          float64
	}
	var offcuts []offcutRow
	orows, err := tx.Query(ctx, `SELECT material_code, material_name, length_mm, width_mm, qty FROM offcut_usages WHERE order_id = $1`, o.ID)
	if err != nil {
		return err
	}
	for orows.Next() {
		var r offcutRow
		if err := orows.Scan(&r.MaterialCode, &r.MaterialName, &r.LengthMm, &r.WidthMm, &r.Qty); err != nil {
			orows.Close()
			return err
		}
		offcuts = append(offcuts, r)
	}
	orows.Close()

	releaseDate := time.Now().UTC()
	linesPayload := make([]gin.H, 0, len(producedLines))
	for _, l := range producedLines {
		var guid interface{}
		if g, ok := articleGuids[*l.ArticleID]; ok {
			guid = g
		}
		linesPayload = append(linesPayload, gin.H{
			"orderLineId": l.ID, "articleCode": l.ArticleCode, "articleGuid": guid,
			"articleName": l.ArticleName, "qty": l.Qty, "unit": l.Unit,
		})
	}
	materialsPayload := make([]gin.H, 0, len(materialOrder))
	for _, mid := range materialOrder {
		m := materialQty[mid]
		var guid interface{}
		if g, ok := materialGuids[mid]; ok {
			guid = g
		}
		materialsPayload = append(materialsPayload, gin.H{
			"materialCode": m.MaterialCode, "materialGuid": guid, "name": m.Name,
			"qty": roundThousandths(m.Qty), "unit": m.Unit,
		})
	}
	offcutsPayload := make([]gin.H, 0, len(offcuts))
	for _, u := range offcuts {
		offcutsPayload = append(offcutsPayload, gin.H{
			"materialCode": u.MaterialCode, "name": u.MaterialName, "lengthMm": u.LengthMm,
			"widthMm": widthOrNil(u.WidthMm), "qty": u.Qty,
		})
	}

	reportedBy := firstOrEmpty(user.Roles)
	if user.Email != "" {
		reportedBy = user.Email
	}
	if err := integration.Enqueue(ctx, tx, integration.Message{
		Type: "production.completed", EntityType: "Order", EntityID: o.ID,
		Payload: map[string]interface{}{
			"orderId": o.ID, "orderNumber": o.OrderNumber, "onecNum": strOrNil(o.OnecNum),
			"releaseDate": releaseDate.Format("2006-01-02T15:04:05.000Z"), "reportedBy": reportedBy,
			"documentHint": "Производство без заказа", "fromWarehouse": fromWarehouse, "toWarehouse": toWarehouse,
			"lines": linesPayload, "materials": materialsPayload, "offcutsUsed": offcutsPayload,
		},
	}); err != nil {
		return err
	}

	for _, l := range lines {
		if !l.HasArticle || l.IsMaterialResale {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO finished_goods_movements (id, item_id, order_id, movement_type, qty, movement_date)
			VALUES ($1,$2,$3,'с_производства',$4,$5)`,
			uuid.NewString(), *l.ArticleID, o.ID, l.Qty, releaseDate); err != nil {
			return err
		}
	}
	return nil
}

func roundThousandths(n float64) float64 { return float64(int64(n*1000+0.5)) / 1000 }

func widthOrNil(v *float64) interface{} {
	if v == nil {
		return nil
	}
	return *v
}

// postProductionCancelled — цех снял отметку после того, как
// production.completed уже ушёл: сигнал отмены + компенсирующие движения
// ГП (CORRECTION), иначе остаток врёт в обе стороны.
func (h *OrdersHandler) postProductionCancelled(ctx context.Context, tx pgx.Tx, o models.Order, code, routingSuffix, status string, user authpkg.UserPayload) error {
	cancelledBy := firstOrEmpty(user.Roles)
	if user.Email != "" {
		cancelledBy = user.Email
	}
	if err := integration.Enqueue(ctx, tx, integration.Message{
		Type: "production.cancelled", EntityType: "Order", EntityID: o.ID,
		Payload: map[string]interface{}{
			"orderNumber": o.OrderNumber, "onecNum": strOrNil(o.OnecNum), "productionDocNumber": strOrNil(o.ProductionDocNumber),
			"cancelledBy": cancelledBy, "cancelledAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
			"comment": "Снята отметка изготовления: " + code + routingSuffix,
		},
	}); err != nil {
		return err
	}

	// Откатываем ровно те движения, что реально были созданы при завершении —
	// не текущий состав позиций заказа: он мог измениться между завершением и отменой
	type posted struct {
		ItemID string
		Qty    float64
	}
	var postedRows []posted
	rows, err := tx.Query(ctx, `SELECT item_id, qty FROM finished_goods_movements WHERE order_id = $1 AND movement_type = 'с_производства'`, o.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var p posted
		if err := rows.Scan(&p.ItemID, &p.Qty); err != nil {
			rows.Close()
			return err
		}
		postedRows = append(postedRows, p)
	}
	rows.Close()

	now := time.Now().UTC()
	for _, p := range postedRows {
		if _, err := tx.Exec(ctx, `
			INSERT INTO finished_goods_movements (id, item_id, order_id, movement_type, qty, movement_date, project)
			VALUES ($1,$2,$3,'коррекция',$4,$5,'отмена изготовления')`,
			uuid.NewString(), p.ItemID, o.ID, -p.Qty, now); err != nil {
			return err
		}
	}
	return nil
}

// StageHoursAllocation — GET /orders/:id/production-stages/:code/hours-allocation.
func (h *OrdersHandler) StageHoursAllocation(c *gin.Context) {
	id := c.Param("id")
	code := c.Param("code")
	var routingStage *string
	if v := c.Query("routingStage"); v != "" {
		routingStage = &v
	}
	if shapeErr := orderstate.StageShapeError(code, routingStage); shapeErr != "" {
		common.BadRequest(c, "INVALID_STAGE_CODE", shapeErr)
		return
	}

	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM orders WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	lines, lerr := h.loadStageOrderLines(ctx, id)
	if lerr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	stageCodeDB := models.OrderStageCodeAPIToDB(code)
	var actualHours float64
	if routingStage != nil {
		rsDB := models.RoutingStageAPIToDB(*routingStage)
		_ = h.pool.QueryRow(ctx, `
			SELECT COALESCE(actual_hours,0) FROM production_stages
			WHERE order_id = $1 AND stage_code = $2 AND routing_stage = $3 AND order_line_id IS NULL`,
			id, stageCodeDB, rsDB).Scan(&actualHours)
	}

	normByArticle := map[string]float64{}
	if routingStage != nil {
		var articleIDs []string
		for _, l := range lines {
			if l.HasArticle {
				articleIDs = append(articleIDs, *l.ArticleID)
			}
		}
		if len(articleIDs) > 0 {
			rsDB := models.RoutingStageAPIToDB(*routingStage)
			rows, err := h.pool.Query(ctx, `
				SELECT article_id, workers, hours_per_unit FROM routing_operations
				WHERE article_id = ANY($1) AND stage = $2`, articleIDs, rsDB)
			if err != nil {
				common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
				return
			}
			for rows.Next() {
				var aid string
				var workers, hours float64
				if err := rows.Scan(&aid, &workers, &hours); err != nil {
					rows.Close()
					common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
					return
				}
				normByArticle[aid] = workers * hours
			}
			rows.Close()
		}
	}

	lineNorms := make([]orderstate.LineNorm, len(lines))
	for i, l := range lines {
		norm := 0.0
		if l.HasArticle {
			norm = normByArticle[*l.ArticleID]
		}
		lineNorms[i] = orderstate.LineNorm{OrderLineID: l.ID, NormManHours: norm * l.Qty}
	}
	allocation := orderstate.AllocateActualHours(actualHours, lineNorms)

	basis := "equal_split"
	if len(normByArticle) > 0 {
		basis = "norms"
	}
	linesOut := make([]gin.H, len(allocation))
	for i, a := range allocation {
		var line *stageOrderLine
		for j := range lines {
			if lines[j].ID == a.OrderLineID {
				line = &lines[j]
				break
			}
		}
		articleCode, articleName := "", ""
		qty := 0.0
		if line != nil {
			articleCode = line.ArticleCode
			articleName = line.ArticleName
			qty = line.Qty
		}
		linesOut[i] = gin.H{
			"orderLineId": a.OrderLineID, "sharePct": a.SharePct, "hours": a.Hours,
			"articleCode": articleCode, "articleName": articleName, "qty": qty,
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"stage": gin.H{"code": code, "routingStage": routingStage, "actualHours": actualHours},
		"basis": basis, "lines": linesOut,
	})
}

var orderFieldColumn = map[string]string{
	"region":              "region",
	"managerId":           "manager_id",
	"orderType":           "order_type",
	"status":              "status",
	"requestDate":         "request_date",
	"plannedShipmentDate": "planned_shipment_date",
	"sourceSheet":         "source_sheet",
	"sourceRowNumber":     "source_row_number",
}

// assertOrderFieldWriteAllowed — перенос assertFieldWriteAllowed(body,
// 'order', permissions): поля вне известных групп FIELD_GROUPS.order
// пропускаются молча (как в оригинале — идёт на DTO/Prisma-валидацию),
// расчётная группа cost никогда не проверяется на запись (isCalculated).
func assertOrderFieldWriteAllowed(body map[string]interface{}, perms []string) []string {
	groupOf := func(field string) string {
		for _, g := range authpkg.FieldGroups["order"] {
			for _, f := range g.Fields {
				if f == field {
					return g.Code
				}
			}
		}
		return ""
	}
	var denied []string
	for field := range body {
		group := groupOf(field)
		if group == "" || group == "cost" {
			continue
		}
		if !authpkg.HasPermission(perms, "order."+group+":write") {
			denied = append(denied, field)
		}
	}
	return denied
}

// Update — PATCH /orders/:id (sales_manager/accountant/planner/warehouse_fg/admin).
// Только реальные колонки Order пишутся (см. orderFieldColumn) — прочие
// поля группы (unitPrice, prepayment и т.п. из FIELD_GROUPS.order.commercial)
// на самом деле принадлежат OrderLine, не Order, и в оригинале Prisma на
// них падает валидацией; здесь после прохождения RBAC они молча отбрасываются.
func (h *OrdersHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	user := authpkg.CurrentUser(c)
	perms := authpkg.PermissionsForRoles(user.Roles)
	if denied := assertOrderFieldWriteAllowed(body, perms); len(denied) > 0 {
		common.Fail(c, http.StatusForbidden, "FIELD_WRITE_FORBIDDEN", "Нет прав на изменение полей: "+strings.Join(denied, ", "))
		return
	}

	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM orders WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	setParts := []string{}
	args := []interface{}{}
	for key, val := range body {
		col, ok := orderFieldColumn[key]
		if !ok {
			continue
		}
		if key == "orderType" {
			if s, ok := val.(string); ok {
				val = models.OrderTypeAPIToDB(s)
			}
		}
		args = append(args, val)
		setParts = append(setParts, col+" = $"+strconv.Itoa(len(args)))
	}
	if len(setParts) == 0 {
		row := h.pool.QueryRow(ctx, "SELECT "+OrderCols+" FROM orders WHERE id = $1", id)
		o, _ := ScanOrder(row)
		c.JSON(http.StatusOK, o)
		return
	}
	setParts = append(setParts, "updated_at = now()")
	args = append(args, id)
	sql := "UPDATE orders SET " + strings.Join(setParts, ", ") + " WHERE id = $" + strconv.Itoa(len(args)) + " RETURNING " + OrderCols
	row := h.pool.QueryRow(ctx, sql, args...)
	o, uerr := ScanOrder(row)
	if uerr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Не удалось сохранить изменения")
		return
	}
	c.JSON(http.StatusOK, o)
}
