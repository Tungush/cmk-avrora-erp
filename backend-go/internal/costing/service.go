// DB-обёртка над pure.go — перенос article-costing.service.ts. Живое
// событие article:cost_updated уходит в шину internal/events (SSE-поток
// GET /events/stream), как events.emit(...) оригинала.
package costing

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/events"
	"cmk-avrora-erp/backend-go/internal/models"
)

// DefaultRates — фолбэк без БД (backend/src/services/article-costing.service.ts):
// ставка и проценты логистики/энергии из исходника «Спецификации 2022»,
// маржа — 35% от цены (09 §3.2), не прежние 10% наценки.
var DefaultRates = CostingRates{
	HourlyRate:    2040,
	LogisticsPct:  0.03,
	UtilitiesPct:  0.01,
	MarginPct:     0.35,
	MarginMode:    MarginModeMargin,
	LogisticsMode: LogisticsPercentOfMaterial,
}

// ActiveRates — действующая версия CostingConfig (validTo IS NULL,
// последняя по validFrom); нет строки — DefaultRates.
func ActiveRates(ctx context.Context, pool *pgxpool.Pool) (CostingRates, error) {
	row := pool.QueryRow(ctx, `
		SELECT hourly_rate, rate_cutting, rate_assembly, rate_painting,
		       logistics_pct, utilities_pct, margin_pct, margin_mode,
		       logistics_mode, logistics_fixed, logistics_per_kg
		FROM costing_configs
		WHERE valid_to IS NULL
		ORDER BY valid_from DESC
		LIMIT 1`)

	var hourlyRate, logisticsPct, utilitiesPct, marginPct, logisticsFixed, logisticsPerKg float64
	var rateCutting, rateAssembly, ratePainting *float64
	var marginMode, logisticsMode string
	err := row.Scan(&hourlyRate, &rateCutting, &rateAssembly, &ratePainting,
		&logisticsPct, &utilitiesPct, &marginPct, &marginMode,
		&logisticsMode, &logisticsFixed, &logisticsPerKg)
	if err == pgx.ErrNoRows {
		return DefaultRates, nil
	}
	if err != nil {
		return CostingRates{}, err
	}

	return CostingRates{
		HourlyRate: hourlyRate,
		StageRates: StageRates{
			Cutting:  rateCutting,
			Assembly: rateAssembly,
			Painting: ratePainting,
		},
		LogisticsPct:   logisticsPct,
		UtilitiesPct:   utilitiesPct,
		MarginPct:      marginPct,
		MarginMode:     MarginMode(marginMode),
		LogisticsMode:  LogisticsMode(logisticsMode),
		LogisticsFixed: logisticsFixed,
		LogisticsPerKg: logisticsPerKg,
	}, nil
}

// MaterialCostOf — материальная часть = Σ (расход × закупочная цена) по составу.
func MaterialCostOf(ctx context.Context, pool *pgxpool.Pool, articleID string) (float64, error) {
	rows, err := pool.Query(ctx, `
		SELECT bi.qty_per_unit, m.purchase_price
		FROM bom_items bi
		JOIN materials m ON m.id = bi.material_id
		WHERE bi.article_id = $1`, articleID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	sum := 0.0
	for rows.Next() {
		var qty, price float64
		if err := rows.Scan(&qty, &price); err != nil {
			return 0, err
		}
		sum += qty * price
	}
	return sum, rows.Err()
}

// NormsOf — нормы труда по переделам изделия, со ставкой участка, если операция к нему привязана.
func NormsOf(ctx context.Context, pool *pgxpool.Pool, articleID string) ([]StageNorm, error) {
	rows, err := pool.Query(ctx, `
		SELECT ro.stage, ro.workers, ro.hours_per_unit, wc.hourly_rate
		FROM routing_operations ro
		LEFT JOIN work_centers wc ON wc.id = ro.work_center_id
		WHERE ro.article_id = $1
		ORDER BY ro.sort_order ASC`, articleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var norms []StageNorm
	for rows.Next() {
		var stageDB string
		var workers, hoursPerUnit float64
		var workCenterRate *float64
		if err := rows.Scan(&stageDB, &workers, &hoursPerUnit, &workCenterRate); err != nil {
			return nil, err
		}
		norms = append(norms, StageNorm{
			Stage:        Stage(models.RoutingStageDBToAPI(stageDB)),
			Workers:      workers,
			HoursPerUnit: hoursPerUnit,
			HourlyRate:   workCenterRate,
		})
	}
	return norms, rows.Err()
}

// dbUserID — usr-* — синтетический id демо-режима, не реальный uuid в БД;
// писать его в FK нельзя (та же проверка, что userId.startsWith('usr-') в оригинале).
func dbUserID(userID string) *string {
	if userID == "" || strings.HasPrefix(userID, "usr-") {
		return nil
	}
	return &userID
}

// Recalculate — точечный пересчёт одного артикула: снимок ArticleCosting +
// specPrice/priceDeviationPct на самом Article + автозаявка директору при
// отклонении > 5%. Полный пересчёт всех артикулов разом не запускается
// никогда (TZ_Cascade_RBAC) — только этот один articleID.
func Recalculate(ctx context.Context, pool *pgxpool.Pool, articleID, trigger, userID string) (CostingResult, error) {
	rates, err := ActiveRates(ctx, pool)
	if err != nil {
		return CostingResult{}, err
	}
	materialCost, err := MaterialCostOf(ctx, pool, articleID)
	if err != nil {
		return CostingResult{}, err
	}
	norms, err := NormsOf(ctx, pool, articleID)
	if err != nil {
		return CostingResult{}, err
	}

	result, err := CalculateArticleCosting(materialCost, norms, rates, nil)
	if err != nil {
		return CostingResult{}, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return CostingResult{}, err
	}
	defer tx.Rollback(ctx)

	triggeredBy := dbUserID(userID)
	_, err = tx.Exec(ctx, `
		INSERT INTO article_costings
			(id, article_id, material_cost, labor_cost, total_man_hours, logistics_cost,
			 utilities_cost, total_cost, margin, price, margin_mode, margin_pct,
			 logistics_pct, trigger, triggered_by_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		uuid.NewString(), articleID, result.MaterialCost, result.LaborCost, result.TotalManHours,
		result.LogisticsCost, result.UtilitiesCost, result.TotalCost, result.Margin, result.Price,
		string(result.MarginMode), result.MarginPct, rates.LogisticsPct, trigger, triggeredBy)
	if err != nil {
		return CostingResult{}, err
	}

	var approvedPrice float64
	err = tx.QueryRow(ctx, "SELECT approved_price FROM articles WHERE id = $1", articleID).Scan(&approvedPrice)
	if err != nil && err != pgx.ErrNoRows {
		return CostingResult{}, err
	}

	deviationPct := 0.0
	if approvedPrice > 0 && result.Price > 0 {
		deviationPct = round2(((approvedPrice - result.Price) / result.Price) * 100)
	}
	// updated_at не имеет дефолта в Postgres (@updatedAt — клиентское поведение
	// Prisma) — обязателен на каждом UPDATE, как в остальных модулях
	_, err = tx.Exec(ctx, `UPDATE articles SET spec_price = $1, price_deviation_pct = $2, updated_at = now() WHERE id = $3`,
		result.Price, deviationPct, articleID)
	if err != nil {
		return CostingResult{}, err
	}

	// |отклонение| > порога → задача директору на пересмотр цены (§3.4, ±5%)
	if approvedPrice > 0 && (deviationPct > 5 || deviationPct < -5) {
		var pendingID string
		err = tx.QueryRow(ctx, `SELECT id FROM price_review_requests WHERE article_id = $1 AND status = 'PENDING' LIMIT 1`, articleID).Scan(&pendingID)
		if err != nil && err != pgx.ErrNoRows {
			return CostingResult{}, err
		}
		if err == pgx.ErrNoRows {
			sign := ""
			if deviationPct > 0 {
				sign = "+"
			}
			reason := "Автоматически: отклонение прайса от расчёта " + sign + trimFloat(deviationPct) + "% при пересчёте (" + trigger + ")"
			_, err = tx.Exec(ctx, `
				INSERT INTO price_review_requests
					(id, article_id, calculated_price, approved_price, deviation_pct, reason, requested_by_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				uuid.NewString(), articleID, result.Price, approvedPrice, deviationPct, reason, triggeredBy)
			if err != nil {
				return CostingResult{}, err
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return CostingResult{}, err
	}

	// Живое оповещение подписчиков «Спецификаций» и «Прайса» (§3.4)
	events.Emit("article:cost_updated", map[string]interface{}{"articleId": articleID, "trigger": trigger})

	return result, nil
}
