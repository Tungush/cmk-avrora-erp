// Перенос articles.controller.ts, включая BOM-мутации (addBomItem/replaceBom),
// которые зовут ArticleCostingService.recalculate — портированы после того,
// как модуль себестоимости (internal/costing) прошёл свою отдельную сверку.
package catalog

import (
	"context"
	"net/http"
	"strconv"
	"strings"

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

type ArticlesHandler struct {
	pool *pgxpool.Pool
}

func NewArticlesHandler(pool *pgxpool.Pool) *ArticlesHandler {
	return &ArticlesHandler{pool: pool}
}

const ArticleCols = `id, article_code, legacy_code, name, weight_kg, series, description,
	approved_price, is_material_resale, spec_price, price_deviation_pct, lead_time_days,
	pallet_capacity, is_active, created_at, updated_at`

func ScanArticle(row pgx.Row) (models.Article, error) {
	var a models.Article
	err := row.Scan(
		&a.ID, &a.ArticleCode, &a.LegacyCode, &a.Name, &a.WeightKg, &a.Series, &a.Description,
		&a.ApprovedPrice, &a.IsMaterialResale, &a.SpecPrice, &a.PriceDeviationPct, &a.LeadTimeDays,
		&a.PalletCapacity, &a.IsActive, &a.CreatedAt, &a.UpdatedAt,
	)
	return a, err
}

type bomItemOut struct {
	ID            string          `json:"id"`
	ArticleID     string          `json:"articleId"`
	MaterialID    string          `json:"materialId"`
	QtyPerUnit    decimal.Decimal `json:"qtyPerUnit"`
	OperationType string          `json:"operationType"`
	LaborHours    decimal.Decimal `json:"laborHours"`
	LineCost      decimal.Decimal `json:"lineCost"`
	Material      models.Material `json:"material"`
}

// loadBomItems — состав изделия с материалом внутри каждой строки, как
// include: { bomItems: { include: { material: true } } } в оригинале.
func loadBomItems(ctx context.Context, pool *pgxpool.Pool, articleID string, orderByLineCostDesc bool) ([]bomItemOut, error) {
	sql := `SELECT b.id, b.article_id, b.material_id, b.qty_per_unit, b.operation_type, b.labor_hours, b.line_cost,
		m.id, m.material_code, m.category, m.name, m.unit, m.unit_weight_kg,
		m.purchase_price, m.purchase_price_updated_at, m.last_purchase_price,
		m.last_purchase_date, m.price_list_price, m.stock_qty
		FROM bom_items b JOIN materials m ON m.id = b.material_id
		WHERE b.article_id = $1`
	if orderByLineCostDesc {
		sql += " ORDER BY b.line_cost DESC"
	}
	rows, err := pool.Query(ctx, sql, articleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []bomItemOut{}
	for rows.Next() {
		var b bomItemOut
		var opType, matCategory string
		if err := rows.Scan(
			&b.ID, &b.ArticleID, &b.MaterialID, &b.QtyPerUnit, &opType, &b.LaborHours, &b.LineCost,
			&b.Material.ID, &b.Material.MaterialCode, &matCategory, &b.Material.Name, &b.Material.Unit,
			&b.Material.UnitWeightKg, &b.Material.PurchasePrice, &b.Material.PurchasePriceUpdatedAt,
			&b.Material.LastPurchasePrice, &b.Material.LastPurchaseDate, &b.Material.PriceListPrice, &b.Material.StockQty,
		); err != nil {
			return nil, err
		}
		b.OperationType = models.OperationTypeDBToAPI(opType)
		b.Material.Category = models.CategoryDBToAPI(matCategory)
		items = append(items, b)
	}
	return items, rows.Err()
}

type articleOut struct {
	models.Article
	BomItems     []bomItemOut  `json:"bomItems"`
	PriceHistory []interface{} `json:"priceHistory,omitempty"`
}

// FindAll — GET /articles?search=&page=&pageSize=&includeResale=&onlyPriced=
func (h *ArticlesHandler) FindAll(c *gin.Context) {
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(c.Query("pageSize"))
	if pageSize < 1 {
		pageSize = 50
	}
	offset := (page - 1) * pageSize

	where := "WHERE 1=1"
	args := []interface{}{}
	if c.Query("includeResale") != "true" {
		where += " AND is_material_resale = false"
	}
	if c.Query("onlyPriced") == "true" {
		where += " AND approved_price > 0"
	}
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		args = append(args, "%"+search+"%")
		n := strconv.Itoa(len(args))
		where += " AND (article_code ILIKE $" + n + " OR name ILIKE $" + n + " OR legacy_code ILIKE $" + n + ")"
	}

	ctx := c.Request.Context()
	var total int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM articles "+where, args...).Scan(&total); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	listArgs := append([]interface{}{}, args...)
	listArgs = append(listArgs, pageSize, offset)
	sql := "SELECT " + ArticleCols + " FROM articles " + where +
		" ORDER BY name ASC LIMIT $" + strconv.Itoa(len(listArgs)-1) + " OFFSET $" + strconv.Itoa(len(listArgs))
	rows, err := h.pool.Query(ctx, sql, listArgs...)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	articles := []models.Article{}
	for rows.Next() {
		a, serr := ScanArticle(rows)
		if serr != nil {
			rows.Close()
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		articles = append(articles, a)
	}
	rows.Close()

	data := make([]articleOut, len(articles))
	for i, a := range articles {
		bom, berr := loadBomItems(ctx, h.pool, a.ID, false)
		if berr != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения состава")
			return
		}
		data[i] = articleOut{Article: a, BomItems: bom}
	}

	c.JSON(http.StatusOK, gin.H{
		"data": data,
		"meta": gin.H{"page": page, "pageSize": pageSize, "total": total},
	})
}

type priceHistoryRow struct {
	ID        string          `json:"id"`
	ArticleID string          `json:"articleId"`
	Price     decimal.Decimal `json:"price"`
	ValidFrom common.PDate    `json:"validFrom"`
	ChangedBy string          `json:"changedBy"`
}

// FindOne — GET /articles/:id (+bomItems, +priceHistory)
func (h *ArticlesHandler) FindOne(c *gin.Context) {
	id := c.Param("id")
	ctx := c.Request.Context()

	row := h.pool.QueryRow(ctx, "SELECT "+ArticleCols+" FROM articles WHERE id = $1", id)
	a, err := ScanArticle(row)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Article "+id+" not found")
		return
	}
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	bom, berr := loadBomItems(ctx, h.pool, id, false)
	if berr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения состава")
		return
	}

	phRows, perr := h.pool.Query(ctx,
		`SELECT id, article_id, price, valid_from, changed_by FROM price_history WHERE article_id = $1`, id)
	if perr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer phRows.Close()
	priceHistory := []priceHistoryRow{}
	for phRows.Next() {
		var ph priceHistoryRow
		if err := phRows.Scan(&ph.ID, &ph.ArticleID, &ph.Price, &ph.ValidFrom, &ph.ChangedBy); err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		priceHistory = append(priceHistory, ph)
	}

	c.JSON(http.StatusOK, gin.H{
		"id": a.ID, "articleCode": a.ArticleCode, "legacyCode": a.LegacyCode, "name": a.Name,
		"weightKg": a.WeightKg, "series": a.Series, "description": a.Description,
		"approvedPrice": a.ApprovedPrice, "isMaterialResale": a.IsMaterialResale,
		"specPrice": a.SpecPrice, "priceDeviationPct": a.PriceDeviationPct, "leadTimeDays": a.LeadTimeDays,
		"palletCapacity": a.PalletCapacity, "isActive": a.IsActive,
		"createdAt": a.CreatedAt, "updatedAt": a.UpdatedAt,
		"bomItems": bom, "priceHistory": priceHistory,
	})
}

type createArticleBody struct {
	ArticleCode string  `json:"articleCode" binding:"required"`
	LegacyCode  *string `json:"legacyCode"`
	Name        string  `json:"name" binding:"required"`
	WeightKg    float64 `json:"weightKg"`
	Series      *string `json:"series"`
	Description *string `json:"description"`
}

// Create — POST /articles (@Roles engineer, admin)
func (h *ArticlesHandler) Create(c *gin.Context) {
	var body createArticleBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()

	var existingID string
	err := h.pool.QueryRow(ctx, "SELECT id FROM articles WHERE article_code = $1", body.ArticleCode).Scan(&existingID)
	if err == nil {
		common.Conflict(c, "DUPLICATE_ENTITY", "Article code "+body.ArticleCode+" already exists")
		return
	}
	if err != pgx.ErrNoRows {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	// id и updated_at без серверных дефолтов: Prisma генерирует UUID и
	// проставляет @updatedAt на своей стороне при КАЖДОЙ записи (create и
	// update), не триггером БД — created_at единственный с DEFAULT
	// CURRENT_TIMESTAMP в самой таблице.
	row := h.pool.QueryRow(ctx,
		`INSERT INTO articles (id, article_code, legacy_code, name, weight_kg, series, description, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, now())
		 RETURNING `+ArticleCols,
		uuid.NewString(), body.ArticleCode, body.LegacyCode, body.Name, body.WeightKg, body.Series, body.Description,
	)
	a, ierr := ScanArticle(row)
	if ierr != nil {
		common.DebugLog(ierr)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Не удалось создать изделие")
		return
	}
	c.JSON(http.StatusCreated, a)
}

var articleFieldColumn = map[string]string{
	"articleCode":    "article_code",
	"legacyCode":     "legacy_code",
	"name":           "name",
	"weightKg":       "weight_kg",
	"series":         "series",
	"description":    "description",
	"palletCapacity": "pallet_capacity",
	"isActive":       "is_active",
	"approvedPrice":  "approved_price",
}

// Update — PATCH /articles/:id (@Roles engineer, planner, admin), field-level
// RBAC: article.core доступен engineer/planner, article.price (approvedPrice)
// — только тем, у кого есть :write на неё (в матрице никто, кроме admin —
// у остальных на цену только Approve через отдельный маршрут пересмотра).
func (h *ArticlesHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}

	user := authpkg.CurrentUser(c)
	perms := authpkg.PermissionsForRoles(user.Roles)
	if denied := assertArticleFieldWriteAllowed(body, perms); len(denied) > 0 {
		// Оригинал бросает {code, message, fields}, но фильтр читает только
		// res.details (которого там нет) — fields до клиента не долетает,
		// details всегда null. Не «чинить», а повторить как есть.
		common.Fail(c, http.StatusForbidden, "FIELD_WRITE_FORBIDDEN",
			"Нет прав на изменение полей: "+strings.Join(denied, ", "))
		return
	}

	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM articles WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Article "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	setParts := []string{}
	args := []interface{}{}
	for key, val := range body {
		col, ok := articleFieldColumn[key]
		if !ok {
			continue
		}
		args = append(args, val)
		setParts = append(setParts, col+" = $"+strconv.Itoa(len(args)))
	}
	if len(setParts) == 0 {
		row := h.pool.QueryRow(ctx, "SELECT "+ArticleCols+" FROM articles WHERE id = $1", id)
		a, _ := ScanArticle(row)
		c.JSON(http.StatusOK, a)
		return
	}
	// @updatedAt в Prisma обновляется на КАЖДЫЙ write, не только когда клиент
	// прислал это поле сам — иначе updated_at тихо расходится с Nest-версией
	setParts = append(setParts, "updated_at = now()")
	args = append(args, id)
	sql := "UPDATE articles SET " + strings.Join(setParts, ", ") + " WHERE id = $" + strconv.Itoa(len(args)) + " RETURNING " + ArticleCols
	row := h.pool.QueryRow(ctx, sql, args...)
	a, uerr := ScanArticle(row)
	if uerr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Не удалось сохранить изменения")
		return
	}
	c.JSON(http.StatusOK, a)
}

func assertArticleFieldWriteAllowed(body map[string]interface{}, perms []string) []string {
	coreFields := map[string]bool{
		"articleCode": true, "legacyCode": true, "name": true, "weightKg": true,
		"series": true, "description": true, "palletCapacity": true, "isActive": true,
	}
	priceFields := map[string]bool{"approvedPrice": true}

	var denied []string
	for field := range body {
		switch {
		case coreFields[field]:
			if !authpkg.HasPermission(perms, "article.core:write") {
				denied = append(denied, field)
			}
		case priceFields[field]:
			if !authpkg.HasPermission(perms, "article.price:write") {
				denied = append(denied, field)
			}
		}
	}
	return denied
}

// GetBom — GET /articles/:id/bom
func (h *ArticlesHandler) GetBom(c *gin.Context) {
	id := c.Param("id")
	ctx := c.Request.Context()

	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM articles WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Article "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	bom, berr := loadBomItems(ctx, h.pool, id, true)
	if berr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения состава")
		return
	}
	c.JSON(http.StatusOK, bom)
}

type addBomItemBody struct {
	MaterialID    string   `json:"materialId"`
	QtyPerUnit    float64  `json:"qtyPerUnit"`
	OperationType *string  `json:"operationType"`
	LaborHours    *float64 `json:"laborHours"`
}

func bomItemOpType(v *string) (api, db string) {
	api = "WELDING_ASSEMBLY"
	if v != nil && *v != "" {
		api = *v
	}
	return api, models.OperationTypeAPIToDB(api)
}

func loadOneBomItem(ctx context.Context, pool *pgxpool.Pool, articleID, materialID, opTypeDB string) (bomItemOut, error) {
	row := pool.QueryRow(ctx, `
		SELECT b.id, b.article_id, b.material_id, b.qty_per_unit, b.operation_type, b.labor_hours, b.line_cost,
		       m.id, m.material_code, m.category, m.name, m.unit, m.unit_weight_kg,
		       m.purchase_price, m.purchase_price_updated_at, m.last_purchase_price,
		       m.last_purchase_date, m.price_list_price, m.stock_qty
		FROM bom_items b JOIN materials m ON m.id = b.material_id
		WHERE b.article_id = $1 AND b.material_id = $2 AND b.operation_type = $3`, articleID, materialID, opTypeDB)
	var item bomItemOut
	var opTypeOut, matCategory string
	err := row.Scan(
		&item.ID, &item.ArticleID, &item.MaterialID, &item.QtyPerUnit, &opTypeOut, &item.LaborHours, &item.LineCost,
		&item.Material.ID, &item.Material.MaterialCode, &matCategory, &item.Material.Name, &item.Material.Unit,
		&item.Material.UnitWeightKg, &item.Material.PurchasePrice, &item.Material.PurchasePriceUpdatedAt,
		&item.Material.LastPurchasePrice, &item.Material.LastPurchaseDate, &item.Material.PriceListPrice, &item.Material.StockQty,
	)
	if err != nil {
		return bomItemOut{}, err
	}
	item.OperationType = models.OperationTypeDBToAPI(opTypeOut)
	item.Material.Category = models.CategoryDBToAPI(matCategory)
	return item, nil
}

// AddBomItem — POST /articles/:id/bom (engineer/admin) — добавить позицию состава
// (расход материала на единицу); повторное добавление того же материала на ту
// же операцию — обновление расхода (upsert по [articleId, materialId, operationType]).
func (h *ArticlesHandler) AddBomItem(c *gin.Context) {
	id := c.Param("id")
	var body addBomItemBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	if body.MaterialID == "" || !(body.QtyPerUnit > 0) {
		common.BadRequest(c, "INVALID_BOM_ITEM", "Нужны materialId и qtyPerUnit > 0")
		return
	}

	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM articles WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Article "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	var purchasePrice float64
	err := h.pool.QueryRow(ctx, "SELECT purchase_price FROM materials WHERE id = $1", body.MaterialID).Scan(&purchasePrice)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Material "+body.MaterialID+" not found")
		return
	}
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	_, opTypeDB := bomItemOpType(body.OperationType)
	laborHours := 0.0
	if body.LaborHours != nil {
		laborHours = *body.LaborHours
	}
	lineCost := round2(body.QtyPerUnit * purchasePrice)

	_, err = h.pool.Exec(ctx, `
		INSERT INTO bom_items (id, article_id, material_id, operation_type, qty_per_unit, labor_hours, line_cost)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (article_id, material_id, operation_type) DO UPDATE SET
			qty_per_unit = EXCLUDED.qty_per_unit,
			labor_hours = EXCLUDED.labor_hours,
			line_cost = EXCLUDED.line_cost`,
		uuid.NewString(), id, body.MaterialID, opTypeDB, body.QtyPerUnit, laborHours, lineCost)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	item, ierr := loadOneBomItem(ctx, h.pool, id, body.MaterialID, opTypeDB)
	if ierr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	user := authpkg.CurrentUser(c)
	result, cerr := costing.Recalculate(ctx, h.pool, id, "bom_change", user.UserID)
	if cerr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"item": item, "costing": result})
}

type bomItemInput struct {
	MaterialID    string   `json:"materialId"`
	QtyPerUnit    float64  `json:"qtyPerUnit"`
	OperationType *string  `json:"operationType"`
	LaborHours    *float64 `json:"laborHours"`
}

type replaceBomBody struct {
	Items []bomItemInput `json:"items"`
}

// ReplaceBom — PUT /articles/:id/bom (engineer/admin) — заменить состав целиком
// («собрать ГП»: полный список расхода). Удаляет старый состав и пересоздаёт
// новый одной транзакцией — частичный список никогда не виден снаружи.
func (h *ArticlesHandler) ReplaceBom(c *gin.Context) {
	id := c.Param("id")
	var body replaceBomBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}

	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM articles WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Article "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	items := make([]bomItemInput, 0, len(body.Items))
	for _, i := range body.Items {
		if i.MaterialID != "" && i.QtyPerUnit > 0 {
			items = append(items, i)
		}
	}

	priceByID := map[string]float64{}
	if len(items) > 0 {
		ids := make([]string, len(items))
		for i, it := range items {
			ids[i] = it.MaterialID
		}
		rows, err := h.pool.Query(ctx, "SELECT id, purchase_price FROM materials WHERE id = ANY($1)", ids)
		if err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
		for rows.Next() {
			var mid string
			var price float64
			if serr := rows.Scan(&mid, &price); serr != nil {
				rows.Close()
				common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
				return
			}
			priceByID[mid] = price
		}
		rows.Close()
	}

	tx, err := h.pool.Begin(ctx)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, "DELETE FROM bom_items WHERE article_id = $1", id); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	// skipDuplicates оригинала: уникальность по [articleId, materialId, operationType] —
	// дубли внутри присланного списка молча схлопываются, а не 409
	for _, it := range items {
		_, opTypeDB := bomItemOpType(it.OperationType)
		laborHours := 0.0
		if it.LaborHours != nil {
			laborHours = *it.LaborHours
		}
		lineCost := round2(it.QtyPerUnit * priceByID[it.MaterialID])
		if _, err := tx.Exec(ctx, `
			INSERT INTO bom_items (id, article_id, material_id, operation_type, qty_per_unit, labor_hours, line_cost)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (article_id, material_id, operation_type) DO NOTHING`,
			uuid.NewString(), id, it.MaterialID, opTypeDB, it.QtyPerUnit, laborHours, lineCost); err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	user := authpkg.CurrentUser(c)
	result, cerr := costing.Recalculate(ctx, h.pool, id, "bom_change", user.UserID)
	if cerr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	bomItems, berr := loadBomItems(ctx, h.pool, id, false)
	if berr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения состава")
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": bomItems, "costing": result})
}
