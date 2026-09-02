package models

import (
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

type Offcut struct {
	ID         string           `json:"id"`
	MaterialID string           `json:"materialId"`
	LengthMm   decimal.Decimal  `json:"lengthMm"`
	WidthMm    *decimal.Decimal `json:"widthMm"`
	Qty        decimal.Decimal  `json:"qty"`
	Note       *string          `json:"note"`
	CreatedAt  common.PDate     `json:"createdAt"`
	UpdatedAt  common.PDate     `json:"updatedAt"`
}

type OffcutUsage struct {
	ID           string           `json:"id"`
	OrderID      string           `json:"orderId"`
	MaterialID   string           `json:"materialId"`
	MaterialCode string           `json:"materialCode"`
	MaterialName string           `json:"materialName"`
	LengthMm     decimal.Decimal  `json:"lengthMm"`
	WidthMm      *decimal.Decimal `json:"widthMm"`
	Qty          decimal.Decimal  `json:"qty"`
	UsedAt       common.PDate     `json:"usedAt"`
}

type WarehouseRef struct {
	ID       string  `json:"id"`
	Code     string  `json:"code"`
	Name     string  `json:"name"`
	Division *string `json:"division"`
}
