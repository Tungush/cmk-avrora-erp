// Точный перенос materials.controller.ts. Мок-фоллбэк на недоступность БД
// не портирован осознанно: Go-сервер не стартует без подключения к базе
// (main.go: db.Connect фатален), поэтому ветка «БД нет вовсе» структурно
// недостижима здесь — в отличие от Nest, который мог подняться без Docker.
package catalog

import (
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
	"cmk-avrora-erp/backend-go/internal/models"
)

type MaterialsHandler struct {
	pool *pgxpool.Pool
}

func NewMaterialsHandler(pool *pgxpool.Pool) *MaterialsHandler {
	return &MaterialsHandler{pool: pool}
}

func ScanMaterial(row pgx.Row) (models.Material, error) {
	var m models.Material
	var category string
	err := row.Scan(
		&m.ID, &m.MaterialCode, &category, &m.Name, &m.Unit,
		&m.UnitWeightKg, &m.PurchasePrice, &m.PurchasePriceUpdatedAt,
		&m.LastPurchasePrice, &m.LastPurchaseDate, &m.PriceListPrice, &m.StockQty,
	)
	m.Category = models.CategoryDBToAPI(category)
	return m, err
}

const MaterialCols = `id, material_code, category, name, unit, unit_weight_kg,
	purchase_price, purchase_price_updated_at, last_purchase_price,
	last_purchase_date, price_list_price, stock_qty`

// FindAll — GET /materials?category=&categories=&search=&page=&pageSize=
func (h *MaterialsHandler) FindAll(c *gin.Context) {
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

	if cat := c.Query("category"); cat != "" {
		args = append(args, models.CategoryAPIToDB(cat))
		where += " AND category = $" + strconv.Itoa(len(args))
	} else if cats := c.Query("categories"); cats != "" {
		// Несколько категорий разом: «Склад сырья» = металл+метизы+комплектующие,
		// «Кладовая» = расходники+инструменты (26.08.2026, materials.controller.ts:29)
		var list []string
		for _, part := range strings.Split(cats, ",") {
			p := strings.TrimSpace(part)
			if p != "" {
				list = append(list, models.CategoryAPIToDB(p))
			}
		}
		if len(list) > 0 {
			args = append(args, list)
			where += " AND category = ANY($" + strconv.Itoa(len(args)) + ")"
		}
	}
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		args = append(args, "%"+search+"%")
		where += " AND (material_code ILIKE $" + strconv.Itoa(len(args)) +
			" OR name ILIKE $" + strconv.Itoa(len(args)) + ")"
	}

	ctx := c.Request.Context()

	var total int
	countArgs := append([]interface{}{}, args...)
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM materials "+where, countArgs...).Scan(&total); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	listArgs := append([]interface{}{}, args...)
	listArgs = append(listArgs, pageSize, offset)
	sql := "SELECT " + MaterialCols + " FROM materials " + where +
		" ORDER BY name ASC LIMIT $" + strconv.Itoa(len(listArgs)-1) + " OFFSET $" + strconv.Itoa(len(listArgs))

	rows, err := h.pool.Query(ctx, sql, listArgs...)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer rows.Close()

	data := []models.Material{}
	for rows.Next() {
		m, serr := ScanMaterial(rows)
		if serr != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		data = append(data, m)
	}

	c.JSON(http.StatusOK, gin.H{
		"data": data,
		"meta": gin.H{"page": page, "pageSize": pageSize, "total": total},
	})
}

// FindOne — GET /materials/:id (с составом BomItem, как include: { bomItems: true } в оригинале)
func (h *MaterialsHandler) FindOne(c *gin.Context) {
	id := c.Param("id")
	ctx := c.Request.Context()

	row := h.pool.QueryRow(ctx, "SELECT "+MaterialCols+" FROM materials WHERE id = $1", id)
	m, err := ScanMaterial(row)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Material "+id+" not found")
		return
	}
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	bomRows, berr := h.pool.Query(ctx,
		`SELECT id, article_id, material_id, qty_per_unit, operation_type, labor_hours, line_cost
		 FROM bom_items WHERE material_id = $1`, id)
	if berr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer bomRows.Close()
	type bomItem struct {
		ID            string          `json:"id"`
		ArticleID     string          `json:"articleId"`
		MaterialID    string          `json:"materialId"`
		QtyPerUnit    decimal.Decimal `json:"qtyPerUnit"`
		OperationType string          `json:"operationType"`
		LaborHours    decimal.Decimal `json:"laborHours"`
		LineCost      decimal.Decimal `json:"lineCost"`
	}
	bomItems := []bomItem{}
	for bomRows.Next() {
		var b bomItem
		var opType string
		if err := bomRows.Scan(&b.ID, &b.ArticleID, &b.MaterialID, &b.QtyPerUnit, &opType, &b.LaborHours, &b.LineCost); err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		b.OperationType = models.OperationTypeDBToAPI(opType)
		bomItems = append(bomItems, b)
	}

	c.JSON(http.StatusOK, gin.H{
		"id": m.ID, "materialCode": m.MaterialCode, "category": m.Category, "name": m.Name,
		"unit": m.Unit, "unitWeightKg": m.UnitWeightKg, "purchasePrice": m.PurchasePrice,
		"purchasePriceUpdatedAt": m.PurchasePriceUpdatedAt, "lastPurchasePrice": m.LastPurchasePrice,
		"lastPurchaseDate": m.LastPurchaseDate, "priceListPrice": m.PriceListPrice, "stockQty": m.StockQty,
		"bomItems": bomItems,
	})
}

type createMaterialBody struct {
	MaterialCode  string  `json:"materialCode" binding:"required"`
	Category      string  `json:"category" binding:"required"`
	Name          string  `json:"name" binding:"required"`
	Unit          string  `json:"unit" binding:"required"`
	UnitWeightKg  float64 `json:"unitWeightKg"`
	PurchasePrice float64 `json:"purchasePrice"`
}

// Create — POST /materials (@Roles procurement, warehouse_material, admin)
func (h *MaterialsHandler) Create(c *gin.Context) {
	var body createMaterialBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()

	var existingID string
	err := h.pool.QueryRow(ctx, "SELECT id FROM materials WHERE material_code = $1", body.MaterialCode).Scan(&existingID)
	if err == nil {
		common.Conflict(c, "DUPLICATE_ENTITY", "Material code "+body.MaterialCode+" already exists")
		return
	}
	if err != pgx.ErrNoRows {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	// id без серверного дефолта (Prisma генерирует UUID на своей стороне,
	// не dbgenerated) — Go делает то же самое явно, иначе NOT NULL падает
	row := h.pool.QueryRow(ctx,
		`INSERT INTO materials (id, material_code, category, name, unit, unit_weight_kg, purchase_price)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING `+MaterialCols,
		uuid.NewString(), body.MaterialCode, models.CategoryAPIToDB(body.Category), body.Name, body.Unit, body.UnitWeightKg, body.PurchasePrice,
	)
	m, ierr := ScanMaterial(row)
	if ierr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Не удалось создать материал")
		return
	}
	c.JSON(http.StatusCreated, m)
}

// writableMaterialFields — какие JSON-ключи разрешено писать в PATCH и в какую
// колонку; поле "purchasePrice"/"purchasePriceUpdatedAt"/"lastPurchasePrice"/
// "lastPurchaseDate" принадлежат группе material.price (field-access.ts) —
// та же проверка assertFieldWriteAllowed, что и в оригинале.
var materialFieldColumn = map[string]string{
	"materialCode":           "material_code",
	"category":               "category",
	"name":                   "name",
	"unit":                   "unit",
	"unitWeightKg":           "unit_weight_kg",
	"isActive":               "is_active",
	"purchasePrice":          "purchase_price",
	"purchasePriceUpdatedAt": "purchase_price_updated_at",
	"lastPurchasePrice":      "last_purchase_price",
	"lastPurchaseDate":       "last_purchase_date",
}

// Update — PATCH /materials/:id, field-level RBAC как в оригинале:
// warehouse_material правит material.core, но не purchasePrice (material.price — только procurement)
func (h *MaterialsHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}

	user := authpkg.CurrentUser(c)
	perms := authpkg.PermissionsForRoles(user.Roles)
	if denied := assertMaterialFieldWriteAllowed(body, perms); len(denied) > 0 {
		// Оригинал бросает {code, message, fields}, но фильтр читает только
		// res.details (которого там нет) — fields до клиента не долетает,
		// details всегда null. Не «чинить», а повторить как есть.
		common.Fail(c, http.StatusForbidden, "FIELD_WRITE_FORBIDDEN",
			"Нет прав на изменение полей: "+strings.Join(denied, ", "))
		return
	}

	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM materials WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Material "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	setParts := []string{}
	args := []interface{}{}
	for key, val := range body {
		col, ok := materialFieldColumn[key]
		if !ok {
			continue // поле вне известных групп — молча отсекается, как в assertFieldWriteAllowed
		}
		if key == "category" {
			if s, ok := val.(string); ok {
				val = models.CategoryAPIToDB(s)
			}
		}
		args = append(args, val)
		setParts = append(setParts, col+" = $"+strconv.Itoa(len(args)))
	}
	if len(setParts) == 0 {
		row := h.pool.QueryRow(ctx, "SELECT "+MaterialCols+" FROM materials WHERE id = $1", id)
		m, _ := ScanMaterial(row)
		c.JSON(http.StatusOK, m)
		return
	}
	args = append(args, id)
	sql := "UPDATE materials SET " + strings.Join(setParts, ", ") + " WHERE id = $" + strconv.Itoa(len(args)) + " RETURNING " + MaterialCols
	row := h.pool.QueryRow(ctx, sql, args...)
	m, uerr := ScanMaterial(row)
	if uerr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Не удалось сохранить изменения")
		return
	}
	c.JSON(http.StatusOK, m)
}

// assertMaterialFieldWriteAllowed — перенос assertFieldWriteAllowed(body, 'material', permissions)
// именно для этой сущности: core-поля нужен material.core:write, ценовые —
// material.price:write. Возвращает список отклонённых полей (пусто — всё разрешено).
func assertMaterialFieldWriteAllowed(body map[string]interface{}, perms []string) []string {
	coreFields := map[string]bool{"materialCode": true, "category": true, "name": true, "unit": true, "unitWeightKg": true, "isActive": true}
	priceFields := map[string]bool{"purchasePrice": true, "purchasePriceUpdatedAt": true, "lastPurchasePrice": true, "lastPurchaseDate": true}

	var denied []string
	for field := range body {
		switch {
		case coreFields[field]:
			if !authpkg.HasPermission(perms, "material.core:write") {
				denied = append(denied, field)
			}
		case priceFields[field]:
			if !authpkg.HasPermission(perms, "material.price:write") {
				denied = append(denied, field)
			}
		}
		// поля вне групп (id и т.п.) пропускаются молча, как в оригинале
	}
	return denied
}
