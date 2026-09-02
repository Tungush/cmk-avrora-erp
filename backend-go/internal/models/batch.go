package models

import (
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

// MaterialBatch — перенос Prisma.MaterialBatch. Ни один из его enum'ов
// (BatchType, BatchOrigin) не имеет @map в schema.prisma — Postgres хранит
// английские значения как есть, перевод не нужен (в отличие от category/
// operationType/routingStage/customerType).
type MaterialBatch struct {
	ID                 string           `json:"id"`
	MaterialID         string           `json:"materialId"`
	WarehouseID        *string          `json:"warehouseId"`
	ReceiptDate        common.PDate     `json:"receiptDate"`
	UnitPrice          decimal.Decimal  `json:"unitPrice"`
	QtyReceived        decimal.Decimal  `json:"qtyReceived"`
	QtyRemaining       decimal.Decimal  `json:"qtyRemaining"`
	SupplierName       *string          `json:"supplierName"`
	DocumentNumber     *string          `json:"documentNumber"`
	SourceMovementID   *string          `json:"sourceMovementId"`
	PaymentDocumentID  *string          `json:"paymentDocumentId"`
	Origin             string           `json:"origin"`
	ExternalID         *string          `json:"externalId"`
	BatchType          string           `json:"batchType"`
	OwnerOrderID       *string          `json:"ownerOrderId"`
	PriceAnomaly       bool             `json:"priceAnomaly"`
	AnomalyFactor      *decimal.Decimal `json:"anomalyFactor"`
	AnomalyClearedAt   common.PDate     `json:"anomalyClearedAt"`
	AnomalyClearedByID *string          `json:"anomalyClearedById"`
	CreatedAt          common.PDate     `json:"createdAt"`
}
