package models

import (
	"encoding/json"

	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

// PaymentDocStatus — enum с @map (русские метки в БД).
var paymentDocStatusDBToAPI = map[string]string{
	"Не оплачен": "UNPAID", "Частично оплачен": "PARTIALLY_PAID", "Оплачено": "PAID", "Исполнен": "EXECUTED",
}
var paymentDocStatusAPIToDB = map[string]string{
	"UNPAID": "Не оплачен", "PARTIALLY_PAID": "Частично оплачен", "PAID": "Оплачено", "EXECUTED": "Исполнен",
}

func PaymentDocStatusDBToAPI(db string) string {
	if v, ok := paymentDocStatusDBToAPI[db]; ok {
		return v
	}
	return db
}
func PaymentDocStatusAPIToDB(api string) string {
	if v, ok := paymentDocStatusAPIToDB[api]; ok {
		return v
	}
	return api
}

type PaymentDocument struct {
	ID                string          `json:"id"`
	DoNumber          string          `json:"doNumber"`
	DoDate            common.PDate    `json:"doDate"`
	ContractorID      string          `json:"contractorId"`
	Currency          string          `json:"currency"`
	TotalAmount       decimal.Decimal `json:"totalAmount"`
	PaidAmount        decimal.Decimal `json:"paidAmount"`
	UnpaidAmount      decimal.Decimal `json:"unpaidAmount"`
	Category          *string         `json:"category"`
	Status            string          `json:"status"`
	OrderID           *string         `json:"orderId"`
	RawColumns        json.RawMessage `json:"rawColumns"`
	BusinessDirection *string         `json:"businessDirection"`
	ProjectName       *string         `json:"projectName"`
	Division          *string         `json:"division"`
	WarehouseName     *string         `json:"warehouseName"`
	CostCategory      *string         `json:"costCategory"`
	Author            *string         `json:"author"`
	ManagerName       *string         `json:"managerName"`
	ApprovedAt        common.PDate    `json:"approvedAt"`
	Approver          *string         `json:"approver"`
	SupplierDocNumber *string         `json:"supplierDocNumber"`
	SupplierDocDate   common.PDate    `json:"supplierDocDate"`
	SalesOrderNumber  *string         `json:"salesOrderNumber"`
}

type PaymentDocumentLine struct {
	ID                string           `json:"id"`
	PaymentDocumentID string           `json:"paymentDocumentId"`
	LineNo            int              `json:"lineNo"`
	ItemName          string           `json:"itemName"`
	Qty               *decimal.Decimal `json:"qty"`
	UnitPrice         *decimal.Decimal `json:"unitPrice"`
	Amount            *decimal.Decimal `json:"amount"`
	VatRate           *string          `json:"vatRate"`
	Packaging         *string          `json:"packaging"`
	ExpenseItem       *string          `json:"expenseItem"`
	Purpose           *string          `json:"purpose"`
	CustomerOrderNum  *string          `json:"customerOrderNum"`
	MaterialID        *string          `json:"materialId"`
	AmountMismatch    bool             `json:"amountMismatch"`
	RawColumns        json.RawMessage  `json:"rawColumns"`
}

type Payment struct {
	ID                string          `json:"id"`
	PaymentDocumentID string          `json:"paymentDocumentId"`
	Amount            decimal.Decimal `json:"amount"`
	PaymentDate       common.PDate    `json:"paymentDate"`
	PaymentType       *string         `json:"paymentType"`
	Reference         *string         `json:"reference"`
	CreatedAt         common.PDate    `json:"createdAt"`
}

type CustomerPayment struct {
	ID          string       `json:"id"`
	OrderID     string       `json:"orderId"`
	Amount      float64      `json:"amount"` // всегда Number(...) в оригинале
	PaidAt      common.PDate `json:"paidAt"`
	Source      string       `json:"source"`
	Reference   *string      `json:"reference"`
	Note        *string      `json:"note"`
	CreatedByID *string      `json:"createdById"`
	CreatedAt   common.PDate `json:"createdAt"`
}
