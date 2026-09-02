package warehouse

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/bitrix"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
	"cmk-avrora-erp/backend-go/internal/modules/catalog"
	wh "cmk-avrora-erp/backend-go/internal/warehouse"
)

// Перенос purchase-requests.controller.ts — заявки на закуп недостающего сырья.
type PurchaseRequestsHandler struct{ pool *pgxpool.Pool }

func NewPurchaseRequestsHandler(pool *pgxpool.Pool) *PurchaseRequestsHandler {
	return &PurchaseRequestsHandler{pool: pool}
}

const prCols = "p.id, p.material_id, p.requested_qty, p.unit, p.estimated_price, p.order_id, p.note, p.requested_by_id, p.status, p.bitrix_deal_id, p.bitrix_sent_at, p.created_at, p.updated_at"

func scanPR(row pgx.Row) (models.PurchaseRequest, error) {
	var r models.PurchaseRequest
	err := row.Scan(&r.ID, &r.MaterialID, &r.RequestedQty, &r.Unit, &r.EstimatedPrice, &r.OrderID, &r.Note, &r.RequestedByID, &r.Status, &r.BitrixDealID, &r.BitrixSentAt, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}

func prJSON(r models.PurchaseRequest) gin.H {
	return gin.H{"id": r.ID, "materialId": r.MaterialID, "requestedQty": r.RequestedQty, "unit": r.Unit, "estimatedPrice": r.EstimatedPrice, "orderId": r.OrderID,
		"note": r.Note, "requestedById": r.RequestedByID, "status": r.Status, "bitrixDealId": r.BitrixDealID, "bitrixSentAt": r.BitrixSentAt, "createdAt": r.CreatedAt, "updatedAt": r.UpdatedAt}
}

// FindAll — GET /purchase-requests?status=&page=&pageSize=
func (h *PurchaseRequestsHandler) FindAll(c *gin.Context) {
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(c.Query("pageSize"))
	if size < 1 {
		size = 100
	}
	where, args := "WHERE 1=1", []interface{}{}
	if v := c.Query("status"); v != "" {
		args = append(args, v)
		where += " AND p.status = $1"
	}
	ctx := c.Request.Context()
	var total int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM purchase_requests p "+where, args...).Scan(&total); err != nil {
		respondErr(c, err)
		return
	}
	largs := append(append([]interface{}{}, args...), size, (page-1)*size)
	rows, err := h.pool.Query(ctx, "SELECT "+prCols+", m.material_code, m.name, m.unit, m.purchase_price, o.id, o.order_number, o.planned_shipment_date, cu.name FROM purchase_requests p JOIN materials m ON m.id = p.material_id LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN customers cu ON cu.id = o.customer_id "+
		where+" ORDER BY p.created_at DESC LIMIT $"+strconv.Itoa(len(largs)-1)+" OFFSET $"+strconv.Itoa(len(largs)), largs...)
	if err != nil {
		respondErr(c, err)
		return
	}
	defer rows.Close()
	data := []gin.H{}
	for rows.Next() {
		var r models.PurchaseRequest
		var mCode, mName, mUnit string
		var mPrice decimal.Decimal
		var oid, onum, cname *string
		var planned common.PDate
		if err := rows.Scan(&r.ID, &r.MaterialID, &r.RequestedQty, &r.Unit, &r.EstimatedPrice, &r.OrderID, &r.Note, &r.RequestedByID, &r.Status, &r.BitrixDealID, &r.BitrixSentAt, &r.CreatedAt, &r.UpdatedAt,
			&mCode, &mName, &mUnit, &mPrice, &oid, &onum, &planned, &cname); err != nil {
			respondErr(c, err)
			return
		}
		m := prJSON(r)
		m["material"] = gin.H{"materialCode": mCode, "name": mName, "unit": mUnit, "purchasePrice": mPrice}
		if oid != nil {
			m["order"] = gin.H{"id": *oid, "orderNumber": *onum, "plannedShipmentDate": planned, "customer": gin.H{"name": *cname}}
		} else {
			m["order"] = nil
		}
		data = append(data, m)
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "meta": gin.H{"page": page, "pageSize": size, "total": total}})
}

// Create — POST /purchase-requests
func (h *PurchaseRequestsHandler) Create(c *gin.Context) {
	var body struct {
		MaterialID   string  `json:"materialId"`
		RequestedQty float64 `json:"requestedQty"`
		Note         *string `json:"note"`
		OrderID      *string `json:"orderId"`
	}
	_ = c.ShouldBindJSON(&body)
	if body.MaterialID == "" || !(body.RequestedQty > 0) {
		common.BadRequest(c, "INVALID_REQUEST", "Нужны materialId и requestedQty > 0")
		return
	}
	ctx := c.Request.Context()
	mat, err := catalog.ScanMaterial(h.pool.QueryRow(ctx, "SELECT "+catalog.MaterialCols+" FROM materials WHERE id = $1", body.MaterialID))
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Material "+body.MaterialID+" not found")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	// validatePurchaseRequestMaterialGuard((material as any).isActive ?? true, ...):
	// у Material в Prisma нет поля isActive → всегда true, гард не срабатывает никогда.
	user := authpkg.CurrentUser(c)
	r, err := scanPR(h.pool.QueryRow(ctx, "INSERT INTO purchase_requests AS p (id, material_id, requested_qty, unit, estimated_price, note, order_id, requested_by_id, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING "+prCols,
		uuid.NewString(), body.MaterialID, body.RequestedQty, mat.Unit, mat.LastPurchasePrice, body.Note, body.OrderID, dbUserIDLocal(user.UserID)))
	if err != nil {
		respondErr(c, err)
		return
	}
	m := prJSON(r)
	m["material"] = mat
	c.JSON(http.StatusCreated, m)
}

// FromOrder — POST /purchase-requests/from-order/:orderId
func (h *PurchaseRequestsHandler) FromOrder(c *gin.Context) {
	orderID := c.Param("orderId")
	ctx := c.Request.Context()
	var orderNumber string
	if err := h.pool.QueryRow(ctx, "SELECT order_number FROM orders WHERE id = $1", orderID).Scan(&orderNumber); err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+orderID+" not found")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	av, err := wh.OrderMaterialAvailability(ctx, h.pool, orderID)
	if err != nil {
		respondErr(c, err)
		return
	}
	if len(av.Shortages) == 0 {
		c.JSON(http.StatusCreated, gin.H{"created": 0, "updated": 0, "message": "Дефицита нет — сырья хватает"})
		return
	}
	user := authpkg.CurrentUser(c)
	created, updated := 0, 0
	for _, s := range av.Shortages {
		var est interface{} = s.EstimatedPrice
		if s.EstimatedPrice == 0 {
			est = nil
		}
		var existing string
		err := h.pool.QueryRow(ctx, "SELECT id FROM purchase_requests WHERE material_id = $1 AND order_id = $2 AND status = 'DRAFT' LIMIT 1", s.MaterialID, orderID).Scan(&existing)
		if err == nil {
			if _, err := h.pool.Exec(ctx, "UPDATE purchase_requests SET requested_qty = $1, estimated_price = $2, updated_at = now() WHERE id = $3", s.Shortage, est, existing); err != nil {
				respondErr(c, err)
				return
			}
			updated++
		} else if err == pgx.ErrNoRows {
			if _, err := h.pool.Exec(ctx, "INSERT INTO purchase_requests (id, material_id, requested_qty, unit, estimated_price, order_id, note, requested_by_id, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())",
				uuid.NewString(), s.MaterialID, s.Shortage, s.Unit, est, orderID, "Дефицит по заказу "+orderNumber, dbUserIDLocal(user.UserID)); err != nil {
				respondErr(c, err)
				return
			}
			created++
		} else {
			respondErr(c, err)
			return
		}
	}
	c.JSON(http.StatusCreated, gin.H{"created": created, "updated": updated, "shortages": len(av.Shortages)})
}

// SendToBitrix — POST /purchase-requests/send-to-bitrix (procurement/admin)
func (h *PurchaseRequestsHandler) SendToBitrix(c *gin.Context) {
	var body struct {
		IDs []string `json:"ids"`
	}
	_ = c.ShouldBindJSON(&body)
	if len(body.IDs) == 0 {
		common.BadRequest(c, "EMPTY_SELECTION", "Не выбрано ни одной заявки")
		return
	}
	ctx := c.Request.Context()
	rows, err := h.pool.Query(ctx, "SELECT p.id, p.requested_qty, p.estimated_price, p.unit, m.material_code, m.name, m.unit FROM purchase_requests p JOIN materials m ON m.id = p.material_id WHERE p.id = ANY($1) AND p.status = 'DRAFT'", body.IDs)
	if err != nil {
		respondErr(c, err)
		return
	}
	type line struct {
		Code, Name, Unit string
		Qty, Est         float64
	}
	byMat := map[string]*line{}
	var order, ids []string
	for rows.Next() {
		var id, code, name, munit string
		var unit *string
		var qty float64
		var est *float64
		if err := rows.Scan(&id, &qty, &est, &unit, &code, &name, &munit); err != nil {
			rows.Close()
			respondErr(c, err)
			return
		}
		ids = append(ids, id)
		e := 0.0
		if est != nil {
			e = *est
		}
		if cur, ok := byMat[code]; ok {
			cur.Qty += qty
			if cur.Est == 0 {
				cur.Est = e
			}
		} else {
			u := munit
			if unit != nil {
				u = *unit
			}
			byMat[code] = &line{Code: code, Name: name, Unit: u, Qty: qty, Est: e}
			order = append(order, code)
		}
	}
	rows.Close()
	if len(ids) == 0 {
		common.BadRequest(c, "NOTHING_TO_SEND", "Среди выбранных нет заявок в статусе «накоплено»")
		return
	}
	var lines []bitrix.SupplyLine
	total := 0.0
	for _, code := range order {
		l := byMat[code]
		lines = append(lines, bitrix.SupplyLine{Code: l.Code, Name: l.Name, Unit: l.Unit, Qty: l.Qty, EstPrice: l.Est})
		total += l.Qty * l.Est
	}
	user := authpkg.CurrentUser(c)
	reqBy := user.Email
	if reqBy == "" && len(user.Roles) > 0 {
		reqBy = user.Roles[0]
	}
	title := "Заявка на закуп: " + strconv.Itoa(len(lines)) + " позиций на " + common.FmtRu(common.JsRound(total)) + " ₸"
	dealID, err := bitrix.CreateSupplyDeal(ctx, title, lines, total, reqBy)
	if err != nil {
		common.BadRequest(c, "BITRIX_SEND_FAILED", err.Error())
		return
	}
	if _, err := h.pool.Exec(ctx, "UPDATE purchase_requests SET status = 'APPROVED', bitrix_deal_id = $1, bitrix_sent_at = now(), updated_at = now() WHERE id = ANY($2)", dealID, ids); err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"sent": len(ids), "dealId": dealID, "totalEstimate": common.JsRound(total)})
}

func (h *PurchaseRequestsHandler) setStatus(c *gin.Context, status string) {
	id := c.Param("id")
	ctx := c.Request.Context()
	var x string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM purchase_requests WHERE id = $1", id).Scan(&x); err == pgx.ErrNoRows {
		common.NotFound(c, "Purchase request "+id+" not found")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	r, err := scanPR(h.pool.QueryRow(ctx, "UPDATE purchase_requests AS p SET status = $1, updated_at = now() WHERE id = $2 RETURNING "+prCols, status, id))
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, prJSON(r))
}

// Reject — POST /purchase-requests/:id/reject
func (h *PurchaseRequestsHandler) Reject(c *gin.Context) { h.setStatus(c, "REJECTED") }

// MarkOrdered — POST /purchase-requests/:id/ordered
func (h *PurchaseRequestsHandler) MarkOrdered(c *gin.Context) { h.setStatus(c, "ORDERED") }
