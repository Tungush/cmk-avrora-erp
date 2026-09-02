package models

import (
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

// BatchReservation/BatchOverrideRequest — ни один enum здесь (ReservationStatus,
// OverrideStatus) не имеет @map — английские значения хранятся как есть.
type BatchReservation struct {
	ID             string          `json:"id"`
	BatchID        string          `json:"batchId"`
	OrderID        string          `json:"orderId"`
	OrderCostingID *string         `json:"orderCostingId"`
	Qty            decimal.Decimal `json:"qty"`
	Status         string          `json:"status"`
	ExpiresAt      common.PDate    `json:"expiresAt"`
	CreatedAt      common.PDate    `json:"createdAt"`
	CreatedByID    *string         `json:"createdById"`
	ReleasedAt     common.PDate    `json:"releasedAt"`
	ReleasedByID   *string         `json:"releasedById"`
	ReleaseReason  *string         `json:"releaseReason"`
}

type BatchOverrideRequest struct {
	ID                 string          `json:"id"`
	ReservationID      string          `json:"reservationId"`
	RequestedByOrderID string          `json:"requestedByOrderId"`
	QtyRequested       decimal.Decimal `json:"qtyRequested"`
	Reason             string          `json:"reason"`
	Status             string          `json:"status"`
	RequestedByID      *string         `json:"requestedById"`
	CreatedAt          common.PDate    `json:"createdAt"`
	DecidedByID        *string         `json:"decidedById"`
	DecidedAt          common.PDate    `json:"decidedAt"`
	DecisionComment    *string         `json:"decisionComment"`
}
