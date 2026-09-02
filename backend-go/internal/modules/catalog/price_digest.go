package catalog

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

// Сводка прайса — GET /articles/price-digest (02.09.2026).
//
// Экран «Прайс» открывался списком из 2 152 строк, и по нему нельзя было
// понять главного: цена утверждена всего у 176 изделий, а сравнить её с
// расчётом не с чем — себестоимость посчитана у двух. Раньше это можно
// было узнать, только пролистав список глазами.
//
// Одним запросом: сколько в прайсе, сколько без цены, у скольких есть
// расчёт, и десятка изделий, где утверждённая цена ближе всего к
// себестоимости (или ниже неё) — именно там завод теряет деньги.
const priceDigestSQL = `
SELECT COUNT(*)                                                                    AS total,
       COUNT(*) FILTER (WHERE approved_price > 0)                                  AS priced,
       COUNT(*) FILTER (WHERE spec_price > 0)                                      AS with_spec,
       COUNT(*) FILTER (WHERE approved_price > 0 AND spec_price > 0)               AS comparable,
       COUNT(*) FILTER (WHERE approved_price > 0 AND spec_price > 0
                          AND approved_price < spec_price)                         AS below_cost
  FROM articles
 WHERE is_material_resale = false`

const priceThinSQL = `
SELECT id, article_code, name, approved_price, spec_price,
       COALESCE(price_deviation_pct, 0) AS dev
  FROM articles
 WHERE is_material_resale = false
   AND approved_price > 0 AND spec_price > 0
 ORDER BY (approved_price - spec_price) / NULLIF(spec_price, 0) ASC
 LIMIT 6`

// PriceDigest — GET /articles/price-digest
func (h *ArticlesHandler) PriceDigest(c *gin.Context) {
	ctx := c.Request.Context()

	var total, priced, withSpec, comparable, belowCost int
	if err := h.pool.QueryRow(ctx, priceDigestSQL).
		Scan(&total, &priced, &withSpec, &comparable, &belowCost); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	rows, err := h.pool.Query(ctx, priceThinSQL)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer rows.Close()

	thin := []gin.H{}
	for rows.Next() {
		var (
			id, code, name      string
			approved, spec, dev decimal.Decimal
		)
		if err := rows.Scan(&id, &code, &name, &approved, &spec, &dev); err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
		thin = append(thin, gin.H{
			"id": id, "articleCode": code, "name": name,
			"approvedPrice": approved, "specPrice": spec, "deviationPct": dev,
		})
	}
	if err := rows.Err(); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"total":      total,
		"priced":     priced,
		"withSpec":   withSpec,
		"comparable": comparable,
		"belowCost":  belowCost,
		"thinnest":   thin,
	})
}
