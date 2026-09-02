package models

import (
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

// MaterialStockMovement — перенос Prisma.MaterialStockMovement. movementType
// в БД — русская метка (StockMovementType @map), в API — английское имя.
type MaterialStockMovement struct {
	ID               string          `json:"id"`
	ItemID           string          `json:"itemId"`
	WarehouseID      *string         `json:"warehouseId"`
	MovementType     string          `json:"movementType"`
	Qty              decimal.Decimal `json:"qty"`
	UnitPrice        decimal.Decimal `json:"unitPrice"`
	MovementDate     common.PDate    `json:"movementDate"`
	Project          *string         `json:"project"`
	SourceDocumentID *string         `json:"sourceDocumentId"`
	SupplierName     *string         `json:"supplierName"`
	DocumentNumber   *string         `json:"documentNumber"`
	Comment          *string         `json:"comment"`
	CreatedAt        common.PDate    `json:"createdAt"`
}

type FinishedGoodsMovement struct {
	ID               string          `json:"id"`
	ItemID           string          `json:"itemId"`
	OrderID          *string         `json:"orderId"`
	MovementType     string          `json:"movementType"`
	Qty              decimal.Decimal `json:"qty"`
	UnitPrice        decimal.Decimal `json:"unitPrice"`
	MovementDate     common.PDate    `json:"movementDate"`
	Project          *string         `json:"project"`
	SourceDocumentID *string         `json:"sourceDocumentId"`
}
