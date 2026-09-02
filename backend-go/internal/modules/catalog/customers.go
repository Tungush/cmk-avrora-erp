// Точный перенос customers.controller.ts. Самый простой каталожный модуль:
// нет field-level RBAC (assertFieldWriteAllowed не вызывается в оригинале
// вообще) — запись защищена только ролью на весь эндпоинт, и Prisma
// принимает body как есть без allow-list полей.
package catalog

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
)

type CustomersHandler struct {
	pool *pgxpool.Pool
}

func NewCustomersHandler(pool *pgxpool.Pool) *CustomersHandler {
	return &CustomersHandler{pool: pool}
}

const CustomerCols = `id, name, bin_iin, region, customer_type`

func ScanCustomer(row pgx.Row) (models.Customer, error) {
	var cust models.Customer
	var customerType string
	err := row.Scan(&cust.ID, &cust.Name, &cust.BinIin, &cust.Region, &customerType)
	cust.CustomerType = models.CustomerTypeDBToAPI(customerType)
	return cust, err
}

// FindAll — GET /customers?search=&page=&pageSize=
func (h *CustomersHandler) FindAll(c *gin.Context) {
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
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		args = append(args, "%"+search+"%")
		where += " AND (name ILIKE $" + strconv.Itoa(len(args)) + " OR bin_iin ILIKE $" + strconv.Itoa(len(args)) + ")"
	}

	ctx := c.Request.Context()

	var total int
	countArgs := append([]interface{}{}, args...)
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM customers "+where, countArgs...).Scan(&total); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	listArgs := append([]interface{}{}, args...)
	listArgs = append(listArgs, pageSize, offset)
	sql := "SELECT " + CustomerCols + " FROM customers " + where +
		" ORDER BY name ASC LIMIT $" + strconv.Itoa(len(listArgs)-1) + " OFFSET $" + strconv.Itoa(len(listArgs))

	rows, err := h.pool.Query(ctx, sql, listArgs...)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer rows.Close()

	data := []models.Customer{}
	for rows.Next() {
		cust, serr := ScanCustomer(rows)
		if serr != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка чтения данных")
			return
		}
		data = append(data, cust)
	}

	c.JSON(http.StatusOK, gin.H{
		"data": data,
		"meta": gin.H{"page": page, "pageSize": pageSize, "total": total},
	})
}

// FindOne — GET /customers/:id
func (h *CustomersHandler) FindOne(c *gin.Context) {
	id := c.Param("id")
	row := h.pool.QueryRow(c.Request.Context(), "SELECT "+CustomerCols+" FROM customers WHERE id = $1", id)
	cust, err := ScanCustomer(row)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Customer "+id+" not found")
		return
	}
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	c.JSON(http.StatusOK, cust)
}

type createCustomerBody struct {
	Name         string  `json:"name" binding:"required"`
	BinIin       string  `json:"binIin" binding:"required"`
	Region       *string `json:"region"`
	CustomerType *string `json:"customerType"`
}

// Create — POST /customers (@Roles sales_manager, admin)
func (h *CustomersHandler) Create(c *gin.Context) {
	var body createCustomerBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()

	var existingID string
	err := h.pool.QueryRow(ctx, "SELECT id FROM customers WHERE bin_iin = $1", body.BinIin).Scan(&existingID)
	if err == nil {
		common.Conflict(c, "DUPLICATE_ENTITY", "Customer BIN "+body.BinIin+" already exists")
		return
	}
	if err != pgx.ErrNoRows {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	// customerType не задан клиентом — берётся дефолт схемы (@default(OUTSIDE)),
	// поэтому здесь передаём NULL и полагаемся на DEFAULT колонки, а не на
	// захардкоженное значение в Go
	var customerTypeDB *string
	if body.CustomerType != nil {
		v := models.CustomerTypeAPIToDB(*body.CustomerType)
		customerTypeDB = &v
	}

	var row pgx.Row
	if customerTypeDB != nil {
		row = h.pool.QueryRow(ctx,
			`INSERT INTO customers (id, name, bin_iin, region, customer_type) VALUES ($1,$2,$3,$4,$5) RETURNING `+CustomerCols,
			uuid.NewString(), body.Name, body.BinIin, body.Region, *customerTypeDB)
	} else {
		row = h.pool.QueryRow(ctx,
			`INSERT INTO customers (id, name, bin_iin, region) VALUES ($1,$2,$3,$4) RETURNING `+CustomerCols,
			uuid.NewString(), body.Name, body.BinIin, body.Region)
	}
	cust, ierr := ScanCustomer(row)
	if ierr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Не удалось создать контрагента")
		return
	}
	c.JSON(http.StatusCreated, cust)
}

var customerFieldColumn = map[string]string{
	"name":         "name",
	"binIin":       "bin_iin",
	"region":       "region",
	"customerType": "customer_type",
}

// Update — PATCH /customers/:id (@Roles sales_manager, admin). Без
// field-level RBAC (оригинал не вызывает assertFieldWriteAllowed для
// customer) — любой с ролью sales_manager/admin правит любое поле.
func (h *CustomersHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}

	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM customers WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Customer "+id+" not found")
		return
	} else if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	setParts := []string{}
	args := []interface{}{}
	for key, val := range body {
		col, ok := customerFieldColumn[key]
		if !ok {
			continue
		}
		if key == "customerType" {
			if s, ok := val.(string); ok {
				val = models.CustomerTypeAPIToDB(s)
			}
		}
		args = append(args, val)
		setParts = append(setParts, col+" = $"+strconv.Itoa(len(args)))
	}
	if len(setParts) == 0 {
		row := h.pool.QueryRow(ctx, "SELECT "+CustomerCols+" FROM customers WHERE id = $1", id)
		cust, _ := ScanCustomer(row)
		c.JSON(http.StatusOK, cust)
		return
	}
	args = append(args, id)
	sql := "UPDATE customers SET " + strings.Join(setParts, ", ") + " WHERE id = $" + strconv.Itoa(len(args)) + " RETURNING " + CustomerCols
	row := h.pool.QueryRow(ctx, sql, args...)
	cust, uerr := ScanCustomer(row)
	if uerr != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Не удалось сохранить изменения")
		return
	}
	c.JSON(http.StatusOK, cust)
}
