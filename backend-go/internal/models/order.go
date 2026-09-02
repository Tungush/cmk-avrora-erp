package models

import (
	"encoding/json"

	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

// Order — перенос Prisma.Order (orders.controller.ts). Полный набор полей,
// потому что GET /orders/:id отдаёт всю запись целиком (кроме rawColumns,
// который вырезается по правам отдельно, не структурой ответа).
type Order struct {
	ID                  string           `json:"id"`
	OrderNumber         string           `json:"orderNumber"`
	CustomerID          string           `json:"customerId"`
	Region              *string          `json:"region"`
	ManagerID           *string          `json:"managerId"`
	OrderType           string           `json:"orderType"` // FZ/VZ (см. OrderTypeDBToAPI)
	BitrixDealID        *string          `json:"bitrixDealId"`
	BitrixStage         *string          `json:"bitrixStage"`
	Status              string           `json:"status"` // без перевода — enum без @map
	PlannedShipmentDate common.PDate     `json:"plannedShipmentDate"`
	ActualShipmentDate  common.PDate     `json:"actualShipmentDate"`
	OverdueDays         int              `json:"overdueDays"`
	StageTrackingMode   string           `json:"stageTrackingMode"` // ORDER/LINE — без @map
	AcceptedAt          common.PDate     `json:"acceptedAt"`
	AcceptedByID        *string          `json:"acceptedById"`
	IsArchived          bool             `json:"isArchived"`
	RequestDate         common.PDate     `json:"requestDate"`
	CreatedAt           common.PDate     `json:"createdAt"`
	UpdatedAt           common.PDate     `json:"updatedAt"`
	OnecNum             *string          `json:"onecNum"`
	OnecStatus          *string          `json:"onecStatus"`
	OnecApprovalStatus  *string          `json:"onecApprovalStatus"`
	OnecTotalAmount     *decimal.Decimal `json:"onecTotalAmount"`
	OnecPaidAmount      *decimal.Decimal `json:"onecPaidAmount"`
	FinalCustomer       *string          `json:"finalCustomer"`
	CustomerOrderNum    *string          `json:"customerOrderNum"`
	ProjectGroup        *string          `json:"projectGroup"`
	ProjectSite         *string          `json:"projectSite"`
	DivisionCode        *string          `json:"divisionCode"`
	ClientAgreement     *string          `json:"clientAgreement"`
	OnecSyncedAt        common.PDate     `json:"onecSyncedAt"`
	ProductionDocNumber *string          `json:"productionDocNumber"`
	ProductionDocDate   common.PDate     `json:"productionDocDate"`
	SourceSheet         *string          `json:"sourceSheet"`
	SourceRowNumber     *int             `json:"sourceRowNumber"`
	RawColumns          json.RawMessage  `json:"rawColumns"`
}

// OrderLine — перенос Prisma.OrderLine.
type OrderLine struct {
	ID              string          `json:"id"`
	OrderID         string          `json:"orderId"`
	ArticleID       *string         `json:"articleId"`
	Qty             decimal.Decimal `json:"qty"`
	Unit            string          `json:"unit"`
	UnitPrice       decimal.Decimal `json:"unitPrice"`
	LineTotalVat    decimal.Decimal `json:"lineTotalVat"`
	Prepayment      decimal.Decimal `json:"prepayment"`
	PostPayment1    decimal.Decimal `json:"postPayment1"`
	PostPayment2    decimal.Decimal `json:"postPayment2"`
	Penalty         decimal.Decimal `json:"penalty"`
	BalanceDue      decimal.Decimal `json:"balanceDue"`
	ReservedQty     decimal.Decimal `json:"reservedQty"`
	ShippedQty      decimal.Decimal `json:"shippedQty"`
	SiteCode        *string         `json:"siteCode"`
	SourceSheet     *string         `json:"sourceSheet"`
	SourceRowNumber *int            `json:"sourceRowNumber"`
	ArticleCodeRaw  *string         `json:"articleCodeRaw"`
	ProductNameRaw  *string         `json:"productNameRaw"`
	RawColumns      json.RawMessage `json:"rawColumns"`
}

var orderTypeDBToAPI = map[string]string{"ФЗ": "FZ", "ВЗ": "VZ"}
var orderTypeAPIToDB = map[string]string{"FZ": "ФЗ", "VZ": "ВЗ"}

func OrderTypeDBToAPI(db string) string {
	if v, ok := orderTypeDBToAPI[db]; ok {
		return v
	}
	return db
}
func OrderTypeAPIToDB(api string) string {
	if v, ok := orderTypeAPIToDB[api]; ok {
		return v
	}
	return api
}

var orderStageCodeDBToAPI = map[string]string{"КД": "DESIGN", "Снабжение": "SUPPLY", "Производство": "PRODUCTION"}
var orderStageCodeAPIToDB = map[string]string{"DESIGN": "КД", "SUPPLY": "Снабжение", "PRODUCTION": "Производство"}

func OrderStageCodeDBToAPI(db string) string {
	if v, ok := orderStageCodeDBToAPI[db]; ok {
		return v
	}
	return db
}
func OrderStageCodeAPIToDB(api string) string {
	if v, ok := orderStageCodeAPIToDB[api]; ok {
		return v
	}
	return api
}

var stageStatusDBToAPI = map[string]string{"not_started": "NOT_STARTED", "in_progress": "IN_PROGRESS", "done": "DONE"}
var stageStatusAPIToDB = map[string]string{"NOT_STARTED": "not_started", "IN_PROGRESS": "in_progress", "DONE": "done"}

func StageStatusDBToAPI(db string) string {
	if v, ok := stageStatusDBToAPI[db]; ok {
		return v
	}
	return db
}
func StageStatusAPIToDB(api string) string {
	if v, ok := stageStatusAPIToDB[api]; ok {
		return v
	}
	return api
}

var stockMovementTypeAPIToDB = map[string]string{
	"RECEIPT": "приход", "EXPENSE": "расход", "TO_PRODUCTION": "в_производство",
	"FROM_PRODUCTION": "с_производства", "RETURN": "возврат", "CORRECTION": "коррекция", "SHIPMENT": "отгрузка",
}

func StockMovementTypeAPIToDB(api string) string {
	if v, ok := stockMovementTypeAPIToDB[api]; ok {
		return v
	}
	return api
}

var stockMovementTypeDBToAPI = map[string]string{
	"приход": "RECEIPT", "расход": "EXPENSE", "в_производство": "TO_PRODUCTION",
	"с_производства": "FROM_PRODUCTION", "возврат": "RETURN", "коррекция": "CORRECTION", "отгрузка": "SHIPMENT",
}

func StockMovementTypeDBToAPI(db string) string {
	if v, ok := stockMovementTypeDBToAPI[db]; ok {
		return v
	}
	return db
}
