// Точный перенос routing.controller.ts (RoutingController + WorkCentersController
// + CostingConfigController) — модуль трудочасов и себестоимости, самая
// проверенная и самая рискованная арифметика в системе. Норму пишет
// engineer, факт — shop_foreman.
package catalog

import (
	"context"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/costing"
	"cmk-avrora-erp/backend-go/internal/models"
)

type RoutingHandler struct {
	pool *pgxpool.Pool
}

func NewRoutingHandler(pool *pgxpool.Pool) *RoutingHandler {
	return &RoutingHandler{pool: pool}
}

// ACTIVE_ORDER_STATUSES — заказ считается затронутым правкой нормы, пока не отгружен и не закрыт
var activeOrderStatuses = []string{"DRAFT", "CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP"}

var stages = []costing.Stage{costing.StageCutting, costing.StageAssembly, costing.StagePainting}

var stageLabelsRu = map[costing.Stage]string{
	costing.StageCutting:  "Резка",
	costing.StageAssembly: "Сборка / сварка / обшивка",
	costing.StagePainting: "Зачистка / покраска",
}

func round2(n float64) float64 { return math.Round(n*100) / 100 }
func round3(n float64) float64 { return math.Round(n*1000) / 1000 }

func assertStage(stage string) bool {
	for _, s := range stages {
		if string(s) == stage {
			return true
		}
	}
	return false
}

func allStagesJoined() string {
	out := make([]string, len(stages))
	for i, s := range stages {
		out[i] = string(s)
	}
	return strings.Join(out, ", ")
}

func fmtPDate(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format("2006-01-02T15:04:05.000Z")
	return &s
}

func dbUserID(userID string) *string {
	if userID == "" || strings.HasPrefix(userID, "usr-") {
		return nil
	}
	return &userID
}

type workCenterOut struct {
	ID         string  `json:"id"`
	Code       string  `json:"code"`
	Name       string  `json:"name"`
	HourlyRate float64 `json:"hourlyRate"`
}

type routingOp struct {
	id            string
	workers       float64
	hoursPerUnit  float64
	actualWorkers *float64
	actualHours   *float64
	workCenterID  *string
	notes         *string
	updatedAt     *time.Time
	wcCode        *string
	wcName        *string
	wcHourlyRate  *float64
}

func (h *RoutingHandler) loadOps(ctx context.Context, articleID string) (map[costing.Stage]routingOp, error) {
	rows, err := h.pool.Query(ctx, `
		SELECT ro.stage, ro.id, ro.workers, ro.hours_per_unit, ro.actual_workers, ro.actual_hours,
		       ro.work_center_id, ro.notes, ro.updated_at, wc.code, wc.name, wc.hourly_rate
		FROM routing_operations ro
		LEFT JOIN work_centers wc ON wc.id = ro.work_center_id
		WHERE ro.article_id = $1
		ORDER BY ro.sort_order ASC`, articleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byStage := map[costing.Stage]routingOp{}
	for rows.Next() {
		var stageDB string
		var op routingOp
		if err := rows.Scan(&stageDB, &op.id, &op.workers, &op.hoursPerUnit, &op.actualWorkers, &op.actualHours,
			&op.workCenterID, &op.notes, &op.updatedAt, &op.wcCode, &op.wcName, &op.wcHourlyRate); err != nil {
			return nil, err
		}
		byStage[costing.Stage(models.RoutingStageDBToAPI(stageDB))] = op
	}
	return byStage, rows.Err()
}

func ratesOut(r costing.CostingRates) gin.H {
	return gin.H{
		"hourlyRate": r.HourlyRate,
		"stageRates": gin.H{
			"CUTTING":  r.StageRates.Cutting,
			"ASSEMBLY": r.StageRates.Assembly,
			"PAINTING": r.StageRates.Painting,
		},
		"logisticsPct":   r.LogisticsPct,
		"utilitiesPct":   r.UtilitiesPct,
		"marginPct":      r.MarginPct,
		"marginMode":     r.MarginMode,
		"logisticsMode":  r.LogisticsMode,
		"logisticsFixed": r.LogisticsFixed,
		"logisticsPerKg": r.LogisticsPerKg,
	}
}

// GetRouting — GET /articles/:articleId/routing — нормы и факт по переделам + отклонения.
// Все три передела всегда присутствуют в ответе — незаполненные с нулями,
// чтобы UI показывал «норма не задана», а не прятал передел.
func (h *RoutingHandler) GetRouting(c *gin.Context) {
	articleID := c.Param("id")
	ctx := c.Request.Context()
	rates, err := costing.ActiveRates(ctx, h.pool)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	byStage, err := h.loadOps(ctx, articleID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	type stageOut struct {
		Stage              costing.Stage  `json:"stage"`
		Label              string         `json:"label"`
		Exists             bool           `json:"exists"`
		Workers            float64        `json:"workers"`
		HoursPerUnit       float64        `json:"hoursPerUnit"`
		WorkCenter         *workCenterOut `json:"workCenter"`
		HourlyRate         float64        `json:"hourlyRate"`
		ManHours           float64        `json:"manHours"`
		StageCost          float64        `json:"stageCost"`
		ActualWorkers      *float64       `json:"actualWorkers"`
		ActualHours        *float64       `json:"actualHours"`
		ActualDeviationPct *float64       `json:"actualDeviationPct"`
		Notes              *string        `json:"notes"`
		UpdatedAt          *string        `json:"updatedAt"`
	}

	out := make([]stageOut, 0, len(stages))
	for _, stage := range stages {
		op, exists := byStage[stage]
		workers, hours := 0.0, 0.0
		var wcRatePtr *float64
		var wc *workCenterOut
		if exists {
			workers, hours = op.workers, op.hoursPerUnit
			if op.workCenterID != nil {
				wcRatePtr = op.wcHourlyRate
				wc = &workCenterOut{ID: *op.workCenterID}
				if op.wcCode != nil {
					wc.Code = *op.wcCode
				}
				if op.wcName != nil {
					wc.Name = *op.wcName
				}
			}
		}
		rate := costing.RateForStage(stage, rates, wcRatePtr)
		manHours := workers * hours
		if wc != nil {
			wc.HourlyRate = rate
		}
		var actualWorkers, actualHours, deviation *float64
		var notes *string
		var updatedAt *string
		if exists {
			actualWorkers, actualHours = op.actualWorkers, op.actualHours
			deviation = costing.ActualDeviationPct(manHours, op.actualWorkers, op.actualHours)
			notes = op.notes
			updatedAt = fmtPDate(op.updatedAt)
		}
		out = append(out, stageOut{
			Stage: stage, Label: stageLabelsRu[stage], Exists: exists,
			Workers: workers, HoursPerUnit: hours, WorkCenter: wc, HourlyRate: rate,
			ManHours: round3(manHours), StageCost: round2(manHours * rate),
			ActualWorkers: actualWorkers, ActualHours: actualHours,
			ActualDeviationPct: deviation, Notes: notes, UpdatedAt: updatedAt,
		})
	}

	c.JSON(http.StatusOK, gin.H{"articleId": articleID, "rates": ratesOut(rates), "stages": out})
}

type putNormBody struct {
	Workers      float64 `json:"workers"`
	HoursPerUnit float64 `json:"hoursPerUnit"`
	WorkCenterID *string `json:"workCenterId"`
	Notes        *string `json:"notes"`
	Reason       *string `json:"reason"`
}

type routingOperationOut struct {
	ID            string              `json:"id"`
	ArticleID     string              `json:"articleId"`
	Stage         string              `json:"stage"`
	SortOrder     int                 `json:"sortOrder"`
	Workers       decimal.Decimal     `json:"workers"`
	HoursPerUnit  decimal.Decimal     `json:"hoursPerUnit"`
	ActualWorkers decimal.NullDecimal `json:"actualWorkers"`
	ActualHours   decimal.NullDecimal `json:"actualHours"`
	WorkCenterID  *string             `json:"workCenterId"`
	Notes         *string             `json:"notes"`
	UpdatedAt     string              `json:"updatedAt"`
	UpdatedByID   *string             `json:"updatedById"`
}

// upsertNorm — INSERT ... ON CONFLICT (article_id, stage) DO UPDATE + запись
// в историю, в одной транзакции — перенос tx.routingOperation.upsert +
// tx.routingOperationHistory.create оригинала. Оригинал асимметричен:
// create() ничего не пишет в updatedById (остаётся NULL по умолчанию схемы),
// update() явно проставляет текущего пользователя — тот же баг/поведение
// нужно повторить, а не «улучшить» до единообразия.
func (h *RoutingHandler) upsertNorm(ctx context.Context, articleID, stageParam string, body putNormBody, actorID *string) (routingOperationOut, error) {
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return routingOperationOut{}, err
	}
	defer tx.Rollback(ctx)

	sortOrder := 0
	for i, s := range stages {
		if string(s) == stageParam {
			sortOrder = i
		}
	}
	stageDB := models.RoutingStageAPIToDB(stageParam)

	row := tx.QueryRow(ctx, `
		INSERT INTO routing_operations
			(id, article_id, stage, sort_order, workers, hours_per_unit, work_center_id, notes, updated_at, updated_by_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), NULL)
		ON CONFLICT (article_id, stage) DO UPDATE SET
			workers = EXCLUDED.workers,
			hours_per_unit = EXCLUDED.hours_per_unit,
			work_center_id = EXCLUDED.work_center_id,
			notes = EXCLUDED.notes,
			updated_at = now(),
			updated_by_id = $9
		RETURNING id, article_id, stage, sort_order, workers, hours_per_unit, actual_workers, actual_hours, work_center_id, notes, updated_at, updated_by_id`,
		uuid.NewString(), articleID, stageDB, sortOrder, body.Workers, body.HoursPerUnit, body.WorkCenterID, body.Notes, actorID)

	var out routingOperationOut
	var stageDBOut string
	var updatedAt time.Time
	if err := row.Scan(&out.ID, &out.ArticleID, &stageDBOut, &out.SortOrder, &out.Workers, &out.HoursPerUnit,
		&out.ActualWorkers, &out.ActualHours, &out.WorkCenterID, &out.Notes, &updatedAt, &out.UpdatedByID); err != nil {
		return routingOperationOut{}, err
	}
	out.Stage = models.RoutingStageDBToAPI(stageDBOut)
	out.UpdatedAt = updatedAt.UTC().Format("2006-01-02T15:04:05.000Z")

	if _, err := tx.Exec(ctx, `
		INSERT INTO routing_operation_history (id, operation_id, workers, hours_per_unit, changed_by_id, reason)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		uuid.NewString(), out.ID, body.Workers, body.HoursPerUnit, actorID, body.Reason); err != nil {
		return routingOperationOut{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return routingOperationOut{}, err
	}
	return out, nil
}

// PutNorm — PUT /articles/:articleId/routing/:stage (engineer/admin) — задать норму передела.
func (h *RoutingHandler) PutNorm(c *gin.Context) {
	articleID := c.Param("id")
	stageParam := c.Param("stage")
	if !assertStage(stageParam) {
		common.BadRequest(c, "INVALID_STAGE", "Неизвестный передел: "+stageParam+". Допустимо: "+allStagesJoined())
		return
	}
	var body putNormBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	if !(body.Workers > 0) || !(body.HoursPerUnit >= 0) {
		common.BadRequest(c, "INVALID_NORM", "workers должен быть > 0, hoursPerUnit ≥ 0")
		return
	}

	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM articles WHERE id = $1", articleID).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Article "+articleID+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	user := authpkg.CurrentUser(c)
	op, err := h.upsertNorm(ctx, articleID, stageParam, body, dbUserID(user.UserID))
	if err != nil {
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	result, err := costing.Recalculate(ctx, h.pool, articleID, "routing_change", user.UserID)
	if err != nil {
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	c.JSON(http.StatusOK, gin.H{"operation": op, "costing": result})
}

type postActualBody struct {
	ActualWorkers float64 `json:"actualWorkers"`
	ActualHours   float64 `json:"actualHours"`
}

// PostActual — POST /articles/:articleId/routing/:stage/actual (shop_foreman/admin) — факт из цеха.
func (h *RoutingHandler) PostActual(c *gin.Context) {
	articleID := c.Param("id")
	stageParam := c.Param("stage")
	if !assertStage(stageParam) {
		common.BadRequest(c, "INVALID_STAGE", "Неизвестный передел: "+stageParam+". Допустимо: "+allStagesJoined())
		return
	}
	var body postActualBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}

	ctx := c.Request.Context()
	stageDB := models.RoutingStageAPIToDB(stageParam)
	var opID string
	err := h.pool.QueryRow(ctx, "SELECT id FROM routing_operations WHERE article_id = $1 AND stage = $2", articleID, stageDB).Scan(&opID)
	if err == pgx.ErrNoRows {
		common.Fail(c, http.StatusNotFound, "NORM_NOT_SET", "Норма для передела не задана — сначала инженер задаёт норму")
		return
	}
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	row := h.pool.QueryRow(ctx, `
		UPDATE routing_operations SET actual_workers = $1, actual_hours = $2, updated_at = now()
		WHERE id = $3
		RETURNING id, article_id, stage, sort_order, workers, hours_per_unit, actual_workers, actual_hours, work_center_id, notes, updated_at, updated_by_id`,
		body.ActualWorkers, body.ActualHours, opID)
	var out routingOperationOut
	var stageDBOut string
	var updatedAt time.Time
	if err := row.Scan(&out.ID, &out.ArticleID, &stageDBOut, &out.SortOrder, &out.Workers, &out.HoursPerUnit,
		&out.ActualWorkers, &out.ActualHours, &out.WorkCenterID, &out.Notes, &updatedAt, &out.UpdatedByID); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	out.Stage = models.RoutingStageDBToAPI(stageDBOut)
	out.UpdatedAt = updatedAt.UTC().Format("2006-01-02T15:04:05.000Z")
	c.JSON(http.StatusCreated, out)
}

// Promote — POST /articles/:articleId/routing/:stage/promote (engineer/admin) —
// «принять факт как норму», переиспользует upsertNorm+recalculate ровно как putNorm в оригинале.
func (h *RoutingHandler) Promote(c *gin.Context) {
	articleID := c.Param("id")
	stageParam := c.Param("stage")
	if !assertStage(stageParam) {
		common.BadRequest(c, "INVALID_STAGE", "Неизвестный передел: "+stageParam+". Допустимо: "+allStagesJoined())
		return
	}

	ctx := c.Request.Context()
	stageDB := models.RoutingStageAPIToDB(stageParam)
	var actualWorkers, actualHours *float64
	var workCenterID *string
	err := h.pool.QueryRow(ctx, "SELECT actual_workers, actual_hours, work_center_id FROM routing_operations WHERE article_id = $1 AND stage = $2", articleID, stageDB).
		Scan(&actualWorkers, &actualHours, &workCenterID)
	if err == pgx.ErrNoRows {
		common.Fail(c, http.StatusNotFound, "NORM_NOT_SET", "Норма не задана")
		return
	}
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	if actualWorkers == nil || actualHours == nil {
		common.BadRequest(c, "NO_ACTUALS", "Факт из цеха ещё не зафиксирован")
		return
	}

	user := authpkg.CurrentUser(c)
	reason := "Факт из цеха принят как норму"
	body := putNormBody{Workers: *actualWorkers, HoursPerUnit: *actualHours, WorkCenterID: workCenterID, Reason: &reason}
	op, err := h.upsertNorm(ctx, articleID, stageParam, body, dbUserID(user.UserID))
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	result, err := costing.Recalculate(ctx, h.pool, articleID, "routing_change", user.UserID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"operation": op, "costing": result})
}

// History — GET /articles/:articleId/routing/history — история изменения норм (последние 100).
func (h *RoutingHandler) History(c *gin.Context) {
	articleID := c.Param("id")
	rows, err := h.pool.Query(c.Request.Context(), `
		SELECT h.id, h.operation_id, h.workers, h.hours_per_unit, h.changed_at, h.changed_by_id, h.reason, ro.stage
		FROM routing_operation_history h
		JOIN routing_operations ro ON ro.id = h.operation_id
		WHERE ro.article_id = $1
		ORDER BY h.changed_at DESC
		LIMIT 100`, articleID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer rows.Close()

	// Как и снимки себестоимости, история читается напрямую из Decimal-колонок —
	// сериализуется строкой, не числом (в отличие от Number()-converted полей GetRouting)
	type histOut struct {
		ID           string          `json:"id"`
		OperationID  string          `json:"operationId"`
		Workers      decimal.Decimal `json:"workers"`
		HoursPerUnit decimal.Decimal `json:"hoursPerUnit"`
		ChangedAt    string          `json:"changedAt"`
		ChangedByID  *string         `json:"changedById"`
		Reason       *string         `json:"reason"`
		Operation    gin.H           `json:"operation"`
	}
	out := []histOut{}
	for rows.Next() {
		var r histOut
		var changedAt time.Time
		var stageDB string
		if err := rows.Scan(&r.ID, &r.OperationID, &r.Workers, &r.HoursPerUnit, &changedAt, &r.ChangedByID, &r.Reason, &stageDB); err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		r.ChangedAt = changedAt.UTC().Format("2006-01-02T15:04:05.000Z")
		r.Operation = gin.H{"stage": models.RoutingStageDBToAPI(stageDB)}
		out = append(out, r)
	}
	c.JSON(http.StatusOK, out)
}

// Recalculate — POST /articles/:articleId/routing/recalculate (engineer/admin).
func (h *RoutingHandler) Recalculate(c *gin.Context) {
	articleID := c.Param("id")
	user := authpkg.CurrentUser(c)
	result, err := costing.Recalculate(c.Request.Context(), h.pool, articleID, "manual", user.UserID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	c.JSON(http.StatusCreated, result)
}

type orderLineAgg struct {
	OrderID             string  `json:"orderId"`
	OrderNumber         string  `json:"orderNumber"`
	Customer            *string `json:"customer"`
	Status              string  `json:"status"`
	Qty                 float64 `json:"qty"`
	UnitPrice           float64 `json:"unitPrice"`
	PlannedShipmentDate *string `json:"plannedShipmentDate"`
}

// activeOrderLines — позиции этого артикула в незакрытых заказах, агрегированные
// по заказу (Σ qty, max unitPrice) — тот же orderMap оригинала.
func (h *RoutingHandler) activeOrderLines(ctx context.Context, articleID string) ([]orderLineAgg, int, error) {
	rows, err := h.pool.Query(ctx, `
		SELECT o.id, o.order_number, c.name, o.status, ol.qty, ol.unit_price, o.planned_shipment_date
		FROM order_lines ol
		JOIN orders o ON o.id = ol.order_id
		JOIN customers c ON c.id = o.customer_id
		WHERE ol.article_id = $1 AND o.status = ANY($2)`, articleID, activeOrderStatuses)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	byOrder := map[string]*orderLineAgg{}
	order := []string{}
	linesCount := 0
	for rows.Next() {
		var orderID, orderNumber, status string
		var customer *string
		var qty, unitPrice float64
		var planned *time.Time
		if err := rows.Scan(&orderID, &orderNumber, &customer, &status, &qty, &unitPrice, &planned); err != nil {
			return nil, 0, err
		}
		linesCount++
		var plannedStr *string
		if planned != nil {
			s := planned.UTC().Format("2006-01-02T00:00:00.000Z")
			plannedStr = &s
		}
		if existing, ok := byOrder[orderID]; ok {
			existing.Qty += qty
			if unitPrice > existing.UnitPrice {
				existing.UnitPrice = unitPrice
			}
		} else {
			byOrder[orderID] = &orderLineAgg{
				OrderID: orderID, OrderNumber: orderNumber, Customer: customer, Status: status,
				Qty: qty, UnitPrice: unitPrice, PlannedShipmentDate: plannedStr,
			}
			order = append(order, orderID)
		}
	}
	out := make([]orderLineAgg, 0, len(order))
	for _, id := range order {
		out = append(out, *byOrder[id])
	}
	return out, linesCount, rows.Err()
}

type previewCostingBody struct {
	Stage        string  `json:"stage"`
	Workers      float64 `json:"workers"`
	HoursPerUnit float64 `json:"hoursPerUnit"`
	WorkCenterID *string `json:"workCenterId"`
}

// PreviewCosting — POST /articles/:articleId/routing/costing/preview (engineer/admin) —
// предпросмотр влияния правки нормы до сохранения: что изменится и какие
// заказы уйдут в отрицательную маржу при новой себестоимости.
func (h *RoutingHandler) PreviewCosting(c *gin.Context) {
	articleID := c.Param("id")
	var body previewCostingBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	if !assertStage(body.Stage) {
		common.BadRequest(c, "INVALID_STAGE", "Неизвестный передел: "+body.Stage+". Допустимо: "+allStagesJoined())
		return
	}

	ctx := c.Request.Context()
	rates, err := costing.ActiveRates(ctx, h.pool)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	materialCost, err := costing.MaterialCostOf(ctx, h.pool, articleID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	currentNorms, err := costing.NormsOf(ctx, h.pool, articleID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	var approvedPrice *float64
	err = h.pool.QueryRow(ctx, "SELECT approved_price FROM articles WHERE id = $1", articleID).Scan(&approvedPrice)
	if err != nil && err != pgx.ErrNoRows {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	lines, linesCount, err := h.activeOrderLines(ctx, articleID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	var proposedRate *float64
	if body.WorkCenterID != nil {
		var rate float64
		err := h.pool.QueryRow(ctx, "SELECT hourly_rate FROM work_centers WHERE id = $1", *body.WorkCenterID).Scan(&rate)
		if err != nil && err != pgx.ErrNoRows {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
		if err == nil {
			proposedRate = &rate
		}
	}
	proposedNorm := costing.StageNorm{Stage: costing.Stage(body.Stage), Workers: body.Workers, HoursPerUnit: body.HoursPerUnit, HourlyRate: proposedRate}
	proposedNorms := make([]costing.StageNorm, 0, len(currentNorms)+1)
	for _, n := range currentNorms {
		if string(n.Stage) != body.Stage {
			proposedNorms = append(proposedNorms, n)
		}
	}
	proposedNorms = append(proposedNorms, proposedNorm)

	current, err := costing.CalculateArticleCosting(materialCost, currentNorms, rates, nil)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	proposed, err := costing.CalculateArticleCosting(materialCost, proposedNorms, rates, nil)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	impact := costing.CostingImpact(current, proposed)

	totalQty := 0.0
	negative := []gin.H{}
	negativeCount := 0
	for _, o := range lines {
		totalQty += o.Qty
		if o.UnitPrice > 0 && o.UnitPrice < proposed.TotalCost {
			negativeCount++
			if len(negative) < 10 {
				negative = append(negative, gin.H{
					"orderNumber": o.OrderNumber, "customer": o.Customer, "unitPrice": o.UnitPrice, "newCost": proposed.TotalCost,
				})
			}
		}
	}

	c.JSON(http.StatusCreated, gin.H{
		"articleId": articleID,
		"current":   current,
		"proposed":  proposed,
		"impact":    impact,
		"affected": gin.H{
			"ordersCount":          len(lines),
			"linesCount":           linesCount,
			"totalQty":             totalQty,
			"negativeMarginCount":  negativeCount,
			"negativeMarginOrders": negative,
		},
		// Утверждённая цена прайса не меняется — только через согласование директора (§3.4)
		"approvedPrice":          approvedPrice,
		"approvedPriceUnchanged": true,
	})
}

// Usage — GET /articles/:articleId/routing/usage — «где применяется»: позиции в активных заказах.
func (h *RoutingHandler) Usage(c *gin.Context) {
	articleID := c.Param("id")
	ctx := c.Request.Context()
	lines, linesCount, err := h.activeOrderLines(ctx, articleID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	// Сортировка: без даты отгрузки — в конец, иначе по возрастанию даты
	sorted := make([]orderLineAgg, len(lines))
	copy(sorted, lines)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0; j-- {
			a, b := sorted[j-1], sorted[j]
			swap := false
			if a.PlannedShipmentDate == nil && b.PlannedShipmentDate != nil {
				swap = true
			} else if a.PlannedShipmentDate != nil && b.PlannedShipmentDate != nil && *b.PlannedShipmentDate < *a.PlannedShipmentDate {
				swap = true
			}
			if swap {
				sorted[j-1], sorted[j] = sorted[j], sorted[j-1]
			} else {
				break
			}
		}
	}

	var nearest gin.H
	totalQty := 0.0
	for _, o := range sorted {
		totalQty += o.Qty
	}
	for _, o := range sorted {
		if o.PlannedShipmentDate != nil {
			nearest = gin.H{"orderNumber": o.OrderNumber, "date": *o.PlannedShipmentDate}
			break
		}
	}

	limit := len(sorted)
	if limit > 20 {
		limit = 20
	}
	// usage() в оригинале держит собственный orderMap БЕЗ unitPrice (только
	// previewCosting его добавляет) — раздельные анонимные типы TS; здесь
	// оба используют один activeOrderLines, поэтому unitPrice надо снять
	// перед отдачей, иначе он тихо просочится туда, где Nest его не отдаёт
	type usageOrderOut struct {
		OrderID             string  `json:"orderId"`
		OrderNumber         string  `json:"orderNumber"`
		Customer            *string `json:"customer"`
		Status              string  `json:"status"`
		Qty                 float64 `json:"qty"`
		PlannedShipmentDate *string `json:"plannedShipmentDate"`
	}
	orders := make([]usageOrderOut, 0, limit)
	for _, o := range sorted[:limit] {
		orders = append(orders, usageOrderOut{
			OrderID: o.OrderID, OrderNumber: o.OrderNumber, Customer: o.Customer,
			Status: o.Status, Qty: o.Qty, PlannedShipmentDate: o.PlannedShipmentDate,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"articleId":       articleID,
		"ordersCount":     len(sorted),
		"linesCount":      linesCount,
		"totalQty":        totalQty,
		"nearestShipment": nearest,
		"orders":          orders,
	})
}

// CostingHistory — GET /articles/:articleId/routing/costing/history — снимки калькуляции во времени (последние 50).
func (h *RoutingHandler) CostingHistory(c *gin.Context) {
	articleID := c.Param("id")
	rows, err := h.pool.Query(c.Request.Context(), `
		SELECT id, article_id, calculated_at, material_cost, labor_cost, total_man_hours, logistics_cost,
		       utilities_cost, total_cost, margin, price, margin_mode, margin_pct, logistics_pct, trigger, triggered_by_id
		FROM article_costings
		WHERE article_id = $1
		ORDER BY calculated_at DESC
		LIMIT 50`, articleID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer rows.Close()

	// Снимок читается напрямую из Decimal-колонок (не пересчитывается) — как
	// и в остальных модулях, Prisma сериализует Decimal как JSON-строку, не число
	type snapshotOut struct {
		ID            string          `json:"id"`
		ArticleID     string          `json:"articleId"`
		CalculatedAt  string          `json:"calculatedAt"`
		MaterialCost  decimal.Decimal `json:"materialCost"`
		LaborCost     decimal.Decimal `json:"laborCost"`
		TotalManHours decimal.Decimal `json:"totalManHours"`
		LogisticsCost decimal.Decimal `json:"logisticsCost"`
		UtilitiesCost decimal.Decimal `json:"utilitiesCost"`
		TotalCost     decimal.Decimal `json:"totalCost"`
		Margin        decimal.Decimal `json:"margin"`
		Price         decimal.Decimal `json:"price"`
		MarginMode    string          `json:"marginMode"`
		MarginPct     decimal.Decimal `json:"marginPct"`
		LogisticsPct  decimal.Decimal `json:"logisticsPct"`
		Trigger       *string         `json:"trigger"`
		TriggeredByID *string         `json:"triggeredById"`
	}
	out := []snapshotOut{}
	for rows.Next() {
		var s snapshotOut
		var calculatedAt time.Time
		if err := rows.Scan(&s.ID, &s.ArticleID, &calculatedAt, &s.MaterialCost, &s.LaborCost, &s.TotalManHours,
			&s.LogisticsCost, &s.UtilitiesCost, &s.TotalCost, &s.Margin, &s.Price, &s.MarginMode, &s.MarginPct,
			&s.LogisticsPct, &s.Trigger, &s.TriggeredByID); err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		s.CalculatedAt = calculatedAt.UTC().Format("2006-01-02T15:04:05.000Z")
		out = append(out, s)
	}
	c.JSON(http.StatusOK, out)
}

// Costing — GET /articles/:articleId/routing/costing — калькуляция + разбор формулы для UI.
func (h *RoutingHandler) Costing(c *gin.Context) {
	articleID := c.Param("id")
	ctx := c.Request.Context()
	rates, err := costing.ActiveRates(ctx, h.pool)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	materialCost, err := costing.MaterialCostOf(ctx, h.pool, articleID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	norms, err := costing.NormsOf(ctx, h.pool, articleID)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	var approvedPrice *float64
	err = h.pool.QueryRow(ctx, "SELECT approved_price FROM articles WHERE id = $1", articleID).Scan(&approvedPrice)
	if err != nil && err != pgx.ErrNoRows {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	result, err := costing.CalculateArticleCosting(materialCost, norms, rates, nil)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	explain := costing.ExplainCosting(result, approvedPrice, nil)

	c.JSON(http.StatusOK, gin.H{"articleId": articleID, "result": result, "explain": explain})
}

// --- WorkCentersController ---

type WorkCentersHandler struct {
	pool *pgxpool.Pool
}

func NewWorkCentersHandler(pool *pgxpool.Pool) *WorkCentersHandler {
	return &WorkCentersHandler{pool: pool}
}

// FindAll — GET /work-centers — участки со ставками (активные, по коду).
func (h *WorkCentersHandler) FindAll(c *gin.Context) {
	rows, err := h.pool.Query(c.Request.Context(), `
		SELECT id, code, name, stage, hourly_rate, capacity_per_day, is_active
		FROM work_centers WHERE is_active = true ORDER BY code ASC`)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer rows.Close()

	type wcOut struct {
		ID             string          `json:"id"`
		Code           string          `json:"code"`
		Name           string          `json:"name"`
		Stage          string          `json:"stage"`
		HourlyRate     decimal.Decimal `json:"hourlyRate"`
		CapacityPerDay decimal.Decimal `json:"capacityPerDay"`
		IsActive       bool            `json:"isActive"`
	}
	out := []wcOut{}
	for rows.Next() {
		var w wcOut
		var stageDB string
		if err := rows.Scan(&w.ID, &w.Code, &w.Name, &stageDB, &w.HourlyRate, &w.CapacityPerDay, &w.IsActive); err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		w.Stage = models.RoutingStageDBToAPI(stageDB)
		out = append(out, w)
	}
	c.JSON(http.StatusOK, out)
}

// --- CostingConfigController ---

type CostingConfigHandler struct {
	pool *pgxpool.Pool
}

func NewCostingConfigHandler(pool *pgxpool.Pool) *CostingConfigHandler {
	return &CostingConfigHandler{pool: pool}
}

// costingConfigOut — форма реальной строки costing_configs: поля читаются
// напрямую из Decimal-колонок через Prisma в оригинале, поэтому сериализуются
// JSON-строками ("0.03"), не числами.
type costingConfigOut struct {
	ID                     *string             `json:"id"`
	ValidFrom              *string             `json:"validFrom"`
	ValidTo                *string             `json:"validTo"`
	HourlyRate             decimal.Decimal     `json:"hourlyRate"`
	RateCutting            decimal.NullDecimal `json:"rateCutting"`
	RateAssembly           decimal.NullDecimal `json:"rateAssembly"`
	RatePainting           decimal.NullDecimal `json:"ratePainting"`
	LogisticsPct           decimal.Decimal     `json:"logisticsPct"`
	UtilitiesPct           decimal.Decimal     `json:"utilitiesPct"`
	VatPct                 decimal.Decimal     `json:"vatPct"`
	MarginPct              decimal.Decimal     `json:"marginPct"`
	PaymentTermDays        int                 `json:"paymentTermDays"`
	WeldingFactor          decimal.Decimal     `json:"weldingFactor"`
	CreatedByID            *string             `json:"createdById"`
	MarginMode             string              `json:"marginMode"`
	LogisticsMode          string              `json:"logisticsMode"`
	LogisticsFixed         decimal.Decimal     `json:"logisticsFixed"`
	LogisticsPerKg         decimal.Decimal     `json:"logisticsPerKg"`
	StageTrackingThreshold int                 `json:"stageTrackingThreshold"`
}

// defaultCostingConfigOut — фолбэк ...DEFAULT_RATES оригинала: плейн JS-объект,
// НЕ строка из Prisma, поэтому здесь числа остаются числами, а не строками —
// та же асимметрия, что уже документирована для ArticleCostingService.DEFAULT_RATES.
func defaultCostingConfigOut() gin.H {
	return gin.H{
		"hourlyRate": 2040, "logisticsPct": 0.03, "utilitiesPct": 0.01, "vatPct": 0.12, "marginPct": 0.35,
		"marginMode": "MARGIN", "logisticsMode": "PERCENT_OF_MATERIAL", "paymentTermDays": 30, "source": "default",
	}
}

// Active — GET /costing-config — активные коэффициенты калькуляции.
func (h *CostingConfigHandler) Active(c *gin.Context) {
	row := h.pool.QueryRow(c.Request.Context(), `
		SELECT id, valid_from, valid_to, hourly_rate, rate_cutting, rate_assembly, rate_painting,
		       logistics_pct, utilities_pct, vat_pct, margin_pct, payment_term_days, welding_factor,
		       created_by_id, margin_mode, logistics_mode, logistics_fixed, logistics_per_kg, stage_tracking_threshold
		FROM costing_configs WHERE valid_to IS NULL ORDER BY valid_from DESC LIMIT 1`)

	var cfg costingConfigOut
	var validFrom time.Time
	var validTo *time.Time
	err := row.Scan(&cfg.ID, &validFrom, &validTo, &cfg.HourlyRate, &cfg.RateCutting, &cfg.RateAssembly, &cfg.RatePainting,
		&cfg.LogisticsPct, &cfg.UtilitiesPct, &cfg.VatPct, &cfg.MarginPct, &cfg.PaymentTermDays, &cfg.WeldingFactor,
		&cfg.CreatedByID, &cfg.MarginMode, &cfg.LogisticsMode, &cfg.LogisticsFixed, &cfg.LogisticsPerKg, &cfg.StageTrackingThreshold)
	if err == pgx.ErrNoRows {
		c.JSON(http.StatusOK, defaultCostingConfigOut())
		return
	}
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	vf := validFrom.UTC().Format("2006-01-02T00:00:00.000Z")
	cfg.ValidFrom = &vf
	if validTo != nil {
		vt := validTo.UTC().Format("2006-01-02T00:00:00.000Z")
		cfg.ValidTo = &vt
	}
	c.JSON(http.StatusOK, cfg)
}

type updateCostingConfigBody struct {
	HourlyRate      float64  `json:"hourlyRate"`
	LogisticsPct    float64  `json:"logisticsPct"`
	UtilitiesPct    float64  `json:"utilitiesPct"`
	VatPct          float64  `json:"vatPct"`
	MarginPct       float64  `json:"marginPct"`
	PaymentTermDays *int     `json:"paymentTermDays"`
	RateCutting     *float64 `json:"rateCutting"`
	RateAssembly    *float64 `json:"rateAssembly"`
	RatePainting    *float64 `json:"ratePainting"`
}

// Update — PUT /costing-config (admin/director) — новая версия коэффициентов,
// версионируется: старая закрывается validTo, новая открывается. Поля,
// которых нет в форме (режим маржи, режим логистики, коэффициент сварки,
// порог построчной отметки), переносятся из действующей версии — иначе
// сохранение ставки молча сбрасывало бы режим логистики к умолчанию схемы.
func (h *CostingConfigHandler) Update(c *gin.Context) {
	var body updateCostingConfigBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	user := authpkg.CurrentUser(c)

	ctx := c.Request.Context()
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer tx.Rollback(ctx)

	var prevRateCutting, prevRateAssembly, prevRatePainting decimal.NullDecimal
	var prevLogisticsFixed, prevLogisticsPerKg, prevWeldingFactor decimal.Decimal
	var prevMarginMode, prevLogisticsMode string
	var prevStageTrackingThreshold int
	err = tx.QueryRow(ctx, `
		SELECT rate_cutting, rate_assembly, rate_painting, margin_mode, logistics_mode,
		       logistics_fixed, logistics_per_kg, welding_factor, stage_tracking_threshold
		FROM costing_configs WHERE valid_to IS NULL ORDER BY valid_from DESC LIMIT 1`).
		Scan(&prevRateCutting, &prevRateAssembly, &prevRatePainting, &prevMarginMode, &prevLogisticsMode,
			&prevLogisticsFixed, &prevLogisticsPerKg, &prevWeldingFactor, &prevStageTrackingThreshold)
	hadPrev := err == nil
	if err != nil && err != pgx.ErrNoRows {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	if _, err := tx.Exec(ctx, `UPDATE costing_configs SET valid_to = now() WHERE valid_to IS NULL`); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	orPrevRate := func(v *float64, fallback decimal.NullDecimal) decimal.NullDecimal {
		if v != nil {
			return decimal.NewNullDecimal(decimal.NewFromFloat(*v))
		}
		return fallback
	}
	rateCutting := orPrevRate(body.RateCutting, prevRateCutting)
	rateAssembly := orPrevRate(body.RateAssembly, prevRateAssembly)
	ratePainting := orPrevRate(body.RatePainting, prevRatePainting)

	paymentTermDays := 30
	if body.PaymentTermDays != nil {
		paymentTermDays = *body.PaymentTermDays
	}
	marginMode := "MARGIN"
	logisticsMode := "PERCENT_OF_MATERIAL"
	logisticsFixed := decimal.Zero
	logisticsPerKg := decimal.Zero
	weldingFactor := decimal.NewFromFloat(0.02)
	stageTrackingThreshold := 5
	if hadPrev {
		marginMode = prevMarginMode
		logisticsMode = prevLogisticsMode
		logisticsFixed = prevLogisticsFixed
		logisticsPerKg = prevLogisticsPerKg
		weldingFactor = prevWeldingFactor
		stageTrackingThreshold = prevStageTrackingThreshold
	}

	createdBy := dbUserID(user.UserID)
	row := tx.QueryRow(ctx, `
		INSERT INTO costing_configs
			(id, valid_from, hourly_rate, rate_cutting, rate_assembly, rate_painting,
			 logistics_pct, utilities_pct, vat_pct, margin_pct, payment_term_days,
			 margin_mode, logistics_mode, logistics_fixed, logistics_per_kg, welding_factor,
			 stage_tracking_threshold, created_by_id)
		VALUES (
			$1, now(), $2, $3, $4, $5,
			$6, $7, $8, $9, $10,
			$11, $12, $13, $14, $15,
			$16, $17)
		RETURNING id, valid_from, valid_to, hourly_rate, rate_cutting, rate_assembly, rate_painting,
		          logistics_pct, utilities_pct, vat_pct, margin_pct, payment_term_days, welding_factor,
		          created_by_id, margin_mode, logistics_mode, logistics_fixed, logistics_per_kg, stage_tracking_threshold`,
		uuid.NewString(), body.HourlyRate, rateCutting, rateAssembly, ratePainting,
		body.LogisticsPct, body.UtilitiesPct, body.VatPct, body.MarginPct, paymentTermDays,
		marginMode, logisticsMode, logisticsFixed, logisticsPerKg, weldingFactor,
		stageTrackingThreshold, createdBy)

	var cfg costingConfigOut
	var validFrom time.Time
	var validTo *time.Time
	if err := row.Scan(&cfg.ID, &validFrom, &validTo, &cfg.HourlyRate, &cfg.RateCutting, &cfg.RateAssembly, &cfg.RatePainting,
		&cfg.LogisticsPct, &cfg.UtilitiesPct, &cfg.VatPct, &cfg.MarginPct, &cfg.PaymentTermDays, &cfg.WeldingFactor,
		&cfg.CreatedByID, &cfg.MarginMode, &cfg.LogisticsMode, &cfg.LogisticsFixed, &cfg.LogisticsPerKg, &cfg.StageTrackingThreshold); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Не удалось сохранить изменения")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	vf := validFrom.UTC().Format("2006-01-02T00:00:00.000Z")
	cfg.ValidFrom = &vf
	if validTo != nil {
		vt := validTo.UTC().Format("2006-01-02T00:00:00.000Z")
		cfg.ValidTo = &vt
	}
	c.JSON(http.StatusOK, cfg)
}
