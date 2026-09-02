package models

import (
	"encoding/json"

	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

// OrderCosting — перенос Prisma.OrderCosting. Использовано в местах, где
// оригинал отдаёт СЫРУЮ запись Prisma (build/approve) — decimal-поля
// сериализуются строками. list()/getOne() в контроллере оборачивают
// каждое поле Number(...) явно — там своя, отдельная float64-проекция
// (см. internal/modules/orders/order_costings.go).
type OrderCosting struct {
	ID             string          `json:"id"`
	OrderID        string          `json:"orderId"`
	OrderLineID    string          `json:"orderLineId"`
	ArticleID      *string         `json:"articleId"`
	Qty            decimal.Decimal `json:"qty"`
	Version        int             `json:"version"`
	Status         string          `json:"status"`
	CalculatedAt   common.PDate    `json:"calculatedAt"`
	ApprovedAt     common.PDate    `json:"approvedAt"`
	ApprovedByID   *string         `json:"approvedById"`
	CreatedByID    *string         `json:"createdById"`
	BaseCostingID  *string         `json:"baseCostingId"`
	HourlyRate     decimal.Decimal `json:"hourlyRate"`
	LogisticsPct   decimal.Decimal `json:"logisticsPct"`
	LogisticsMode  string          `json:"logisticsMode"`
	LogisticsFixed decimal.Decimal `json:"logisticsFixed"`
	LogisticsPerKg decimal.Decimal `json:"logisticsPerKg"`
	UtilitiesPct   decimal.Decimal `json:"utilitiesPct"`
	MarginPct      decimal.Decimal `json:"marginPct"`
	MarginMode     string          `json:"marginMode"`
	VatPct         decimal.Decimal `json:"vatPct"`
	RatesSource    string          `json:"ratesSource"`
	RatesReason    *string         `json:"ratesReason"`
	MaterialCost   decimal.Decimal `json:"materialCost"`
	LaborCost      decimal.Decimal `json:"laborCost"`
	ContractorCost decimal.Decimal `json:"contractorCost"`
	LogisticsCost  decimal.Decimal `json:"logisticsCost"`
	UtilitiesCost  decimal.Decimal `json:"utilitiesCost"`
	TotalCost      decimal.Decimal `json:"totalCost"`
	Margin         decimal.Decimal `json:"margin"`
	Price          decimal.Decimal `json:"price"`
	TotalManHours  decimal.Decimal `json:"totalManHours"`
	HasShortage    bool            `json:"hasShortage"`
	HasMissingNorm bool            `json:"hasMissingNorm"`
	HasMissingBom  bool            `json:"hasMissingBom"`
	Note           *string         `json:"note"`
}

type OrderCostingMaterial struct {
	ID                   string          `json:"id"`
	CostingID            string          `json:"costingId"`
	MaterialID           *string         `json:"materialId"`
	MaterialCodeSnapshot *string         `json:"materialCodeSnapshot"`
	MaterialNameSnapshot string          `json:"materialNameSnapshot"`
	QtyPerUnit           decimal.Decimal `json:"qtyPerUnit"`
	QtyTotal             decimal.Decimal `json:"qtyTotal"`
	UnitPrice            decimal.Decimal `json:"unitPrice"`
	LineCost             decimal.Decimal `json:"lineCost"`
	PriceSource          string          `json:"priceSource"`
	BatchID              *string         `json:"batchId"`
	SourceDocumentID     *string         `json:"sourceDocumentId"`
	PriceDate            common.PDate    `json:"priceDate"`
	Allocations          json.RawMessage `json:"allocations"`
	PriceState           string          `json:"priceState"`
	SupplierOrderNumber  *string         `json:"supplierOrderNumber"`
	PriceStateChangedAt  common.PDate    `json:"priceStateChangedAt"`
	IsShortage           bool            `json:"isShortage"`
	ShortageQty          decimal.Decimal `json:"shortageQty"`
	ShortageUnitPrice    decimal.Decimal `json:"shortageUnitPrice"`
}

type OrderCostingLabor struct {
	ID               string          `json:"id"`
	CostingID        string          `json:"costingId"`
	Stage            string          `json:"stage"` // API-код (RoutingStageDBToAPI)
	LaborKind        string          `json:"laborKind"`
	WorkCenterID     *string         `json:"workCenterId"`
	ContractorID     *string         `json:"contractorId"`
	Share            decimal.Decimal `json:"share"`
	RateType         string          `json:"rateType"`
	Rate             decimal.Decimal `json:"rate"`
	CountInShopHours bool            `json:"countInShopHours"`
	Workers          decimal.Decimal `json:"workers"`
	HoursPerUnit     decimal.Decimal `json:"hoursPerUnit"`
	ManHours         decimal.Decimal `json:"manHours"`
	LineCost         decimal.Decimal `json:"lineCost"`
}
