package models

import (
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

type Employee struct {
	ID         string       `json:"id"`
	Name       string       `json:"name"`
	Role       *string      `json:"role"`
	Department *string      `json:"department"`
	TelegramID *string      `json:"telegramId"`
	CreatedAt  common.PDate `json:"createdAt"`
}

type Deal struct {
	ID                   string          `json:"id"`
	Source               string          `json:"source"`
	CustomerID           string          `json:"customerId"`
	ArticleID            *string         `json:"articleId"`
	ManagerID            *string         `json:"managerId"`
	QtyOrdered           decimal.Decimal `json:"qtyOrdered"`
	QtyShipped           decimal.Decimal `json:"qtyShipped"`
	AmountOrdered        decimal.Decimal `json:"amountOrdered"`
	AmountPaid           decimal.Decimal `json:"amountPaid"`
	Status               string          `json:"status"`
	PeriodKey            *string         `json:"periodKey"`
	ShipmentDate         common.PDate    `json:"shipmentDate"`
	SiteCode             *string         `json:"siteCode"`
	Region               *string         `json:"region"`
	ManagerName          *string         `json:"managerName"`
	PlannedDispatchMonth *string         `json:"plannedDispatchMonth"`
	HasFormalRequest     bool            `json:"hasFormalRequest"`
}

type PurchaseRequest struct {
	ID             string           `json:"id"`
	MaterialID     string           `json:"materialId"`
	RequestedQty   decimal.Decimal  `json:"requestedQty"`
	Unit           *string          `json:"unit"`
	EstimatedPrice *decimal.Decimal `json:"estimatedPrice"`
	OrderID        *string          `json:"orderId"`
	Note           *string          `json:"note"`
	RequestedByID  *string          `json:"requestedById"`
	Status         string           `json:"status"`
	BitrixDealID   *string          `json:"bitrixDealId"`
	BitrixSentAt   common.PDate     `json:"bitrixSentAt"`
	CreatedAt      common.PDate     `json:"createdAt"`
	UpdatedAt      common.PDate     `json:"updatedAt"`
}
