package models

import (
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

// Article — перенос Prisma.Article (articles.controller.ts). isMaterialResale
// не JSON-скрыт нигде в оригинале — фронт сам решает, показывать бейдж
// «сырьё, не изделие» или нет.
type Article struct {
	ID                string          `json:"id"`
	ArticleCode       string          `json:"articleCode"`
	LegacyCode        *string         `json:"legacyCode"`
	Name              string          `json:"name"`
	WeightKg          decimal.Decimal `json:"weightKg"`
	Series            *string         `json:"series"`
	Description       *string         `json:"description"`
	ApprovedPrice     decimal.Decimal `json:"approvedPrice"`
	IsMaterialResale  bool            `json:"isMaterialResale"`
	SpecPrice         decimal.Decimal `json:"specPrice"`
	PriceDeviationPct decimal.Decimal `json:"priceDeviationPct"`
	LeadTimeDays      decimal.Decimal `json:"leadTimeDays"`
	PalletCapacity    decimal.Decimal `json:"palletCapacity"`
	IsActive          bool            `json:"isActive"`
	CreatedAt         common.PDate    `json:"createdAt"`
	UpdatedAt         common.PDate    `json:"updatedAt"`
}
