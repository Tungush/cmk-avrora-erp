package finance

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
)

// Перенос customer-payments.controller.ts — оплаты от заказчиков по заказу.
type CustomerPaymentsHandler struct{ pool *pgxpool.Pool }

func NewCustomerPaymentsHandler(pool *pgxpool.Pool) *CustomerPaymentsHandler {
	return &CustomerPaymentsHandler{pool: pool}
}

const customerPaymentCols = "id, order_id, amount, paid_at, source, reference, note, created_by_id, created_at"

func scanCustomerPayment(row pgx.Row) (models.CustomerPayment, error) {
	var p models.CustomerPayment
	err := row.Scan(&p.ID, &p.OrderID, &p.Amount, &p.PaidAt, &p.Source, &p.Reference, &p.Note, &p.CreatedByID, &p.CreatedAt)
	return p, err
}

// recalcOrderPaid — onecPaidAmount = Σ платежей заказа, единственная точка пересчёта.
func (h *CustomerPaymentsHandler) recalcOrderPaid(c *gin.Context, orderID string) (float64, error) {
	ctx := c.Request.Context()
	var sum *float64
	if err := h.pool.QueryRow(ctx, "SELECT sum(amount) FROM customer_payments WHERE order_id = $1", orderID).Scan(&sum); err != nil {
		return 0, err
	}
	total := 0.0
	if sum != nil {
		total = *sum
	}
	if _, err := h.pool.Exec(ctx, "UPDATE orders SET onec_paid_amount = $1, updated_at = now() WHERE id = $2", total, orderID); err != nil {
		return 0, err
	}
	return total, nil
}

// List — GET /orders/:orderId/customer-payments.
func (h *CustomerPaymentsHandler) List(c *gin.Context) {
	orderID := c.Param("id")
	ctx := c.Request.Context()
	var orderNumber string
	var total *float64
	err := h.pool.QueryRow(ctx, "SELECT order_number, onec_total_amount FROM orders WHERE id = $1", orderID).Scan(&orderNumber, &total)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+orderID+" not found")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	rows, err := h.pool.Query(ctx, "SELECT "+customerPaymentCols+" FROM customer_payments WHERE order_id = $1 ORDER BY paid_at DESC", orderID)
	if err != nil {
		respondErr(c, err)
		return
	}
	defer rows.Close()
	data := []models.CustomerPayment{}
	paid := 0.0
	for rows.Next() {
		p, err := scanCustomerPayment(rows)
		if err != nil {
			respondErr(c, err)
			return
		}
		data = append(data, p)
		paid += p.Amount
	}
	var balance interface{}
	if total != nil {
		balance = round2(*total - paid)
	}
	c.JSON(http.StatusOK, gin.H{"orderNumber": orderNumber, "totalAmount": total, "paidAmount": round2(paid), "balanceDue": balance, "data": data})
}

type customerPaymentBody struct {
	Amount    float64 `json:"amount"`
	PaidAt    *string `json:"paidAt"`
	Reference *string `json:"reference"`
	Note      *string `json:"note"`
}

// Create — POST /orders/:orderId/customer-payments (accountant/sales_manager/admin).
func (h *CustomerPaymentsHandler) Create(c *gin.Context) {
	orderID := c.Param("id")
	var body customerPaymentBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	var x string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM orders WHERE id = $1", orderID).Scan(&x); err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+orderID+" not found")
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
	user := authpkg.CurrentUser(c)
	p, err := scanCustomerPayment(h.pool.QueryRow(ctx, `INSERT INTO customer_payments (id, order_id, amount, paid_at, source, reference, note, created_by_id)
		VALUES ($1,$2,$3,$4,'MANUAL',$5,$6,$7) RETURNING `+customerPaymentCols,
		uuid.NewString(), orderID, body.Amount, paidAt, trimPtr(body.Reference), trimPtr(body.Note), dbUserID(user.UserID)))
	if err != nil {
		respondErr(c, err)
		return
	}
	paidTotal, err := h.recalcOrderPaid(c, orderID)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": p.ID, "orderId": p.OrderID, "amount": p.Amount, "paidAt": p.PaidAt, "source": p.Source,
		"reference": p.Reference, "note": p.Note, "createdById": p.CreatedByID, "createdAt": p.CreatedAt, "orderPaidTotal": paidTotal})
}

// Remove — DELETE /customer-payments/:id (accountant/admin) — только занесённые вручную.
func (h *CustomerPaymentsHandler) Remove(c *gin.Context) {
	id := c.Param("id")
	ctx := c.Request.Context()
	var orderID, source string
	err := h.pool.QueryRow(ctx, "SELECT order_id, source FROM customer_payments WHERE id = $1", id).Scan(&orderID, &source)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Платёж "+id+" не найден")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	if source != "MANUAL" {
		common.Conflict(c, "ONEC_PAYMENT", "Этот платёж пришёл из 1С — удалять его здесь нельзя, поправьте в 1С и перезалейте выгрузку")
		return
	}
	if _, err := h.pool.Exec(ctx, "DELETE FROM customer_payments WHERE id = $1", id); err != nil {
		respondErr(c, err)
		return
	}
	paidTotal, err := h.recalcOrderPaid(c, orderID)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true, "orderPaidTotal": paidTotal})
}
