package models

import (
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

// Material — тот же набор полей, что Prisma.Material (materials.controller.ts),
// JSON-теги совпадают с тем, что сегодня отдаёт Nest, чтобы фронтенд не
// заметил разницы между бэкендами.
type Material struct {
	ID                     string          `json:"id"`
	MaterialCode           string          `json:"materialCode"`
	Category               string          `json:"category"` // API-код: METAL/HARDWARE/... (см. CategoryDBToAPI)
	Name                   string          `json:"name"`
	Unit                   string          `json:"unit"`
	UnitWeightKg           decimal.Decimal `json:"unitWeightKg"`
	PurchasePrice          decimal.Decimal `json:"purchasePrice"`
	PurchasePriceUpdatedAt common.PDate    `json:"purchasePriceUpdatedAt"`
	LastPurchasePrice      decimal.Decimal `json:"lastPurchasePrice"`
	LastPurchaseDate       common.PDate    `json:"lastPurchaseDate"`
	PriceListPrice         decimal.Decimal `json:"priceListPrice"`
	StockQty               decimal.Decimal `json:"stockQty"`
}

// Postgres хранит категорию русской меткой (@map в schema.prisma), Prisma
// на границе API переводит в английский код enum — тот же перевод нужен
// и здесь, иначе фронтенд получит "Металл" вместо "METAL" и фильтры сломаются.
var categoryDBToAPI = map[string]string{
	"Инструменты":   "INSTRUMENTS",
	"Металл":        "METAL",
	"Метизы":        "HARDWARE",
	"Комплектующие": "COMPONENTS",
	"Расходники":    "CONSUMABLES",
}

var categoryAPIToDB = map[string]string{
	"INSTRUMENTS": "Инструменты",
	"METAL":       "Металл",
	"HARDWARE":    "Метизы",
	"COMPONENTS":  "Комплектующие",
	"CONSUMABLES": "Расходники",
}

func CategoryDBToAPI(db string) string {
	if v, ok := categoryDBToAPI[db]; ok {
		return v
	}
	return db
}

func CategoryAPIToDB(api string) string {
	if v, ok := categoryAPIToDB[api]; ok {
		return v
	}
	return api
}

// OperationType — та же логика перевода, что у категории материала:
// Postgres хранит русскую метку (@map в schema.prisma), Prisma отдаёт
// английское имя enum-значения.
var operationTypeDBToAPI = map[string]string{
	"резка":         "CUTTING",
	"сборка/сварка": "WELDING_ASSEMBLY",
	"обшивка":       "CLADDING",
	"покраска":      "PAINTING",
}

var operationTypeAPIToDB = map[string]string{
	"CUTTING":          "резка",
	"WELDING_ASSEMBLY": "сборка/сварка",
	"CLADDING":         "обшивка",
	"PAINTING":         "покраска",
}

func OperationTypeDBToAPI(db string) string {
	if v, ok := operationTypeDBToAPI[db]; ok {
		return v
	}
	return db
}

func OperationTypeAPIToDB(api string) string {
	if v, ok := operationTypeAPIToDB[api]; ok {
		return v
	}
	return api
}
