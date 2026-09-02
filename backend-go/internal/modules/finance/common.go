// Перенос backend/src/modules/finance/*. Пять контроллеров без сервисов —
// прямой Prisma, поэтому здесь прямой pgx. Помощники общие на пакет.
package finance

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
	"cmk-avrora-erp/backend-go/internal/modules/catalog"
	"cmk-avrora-erp/backend-go/internal/modules/orders"
)

func round2(n float64) float64 { return math.Round(n*100) / 100 }

func respondErr(c *gin.Context, err error) {
	switch e := err.(type) {
	case *common.APIError404:
		common.Fail(c, http.StatusNotFound, e.Code, e.Message)
	case *common.APIError400:
		common.Fail(c, http.StatusBadRequest, e.Code, e.Message)
	case *common.APIError409:
		common.Fail(c, http.StatusConflict, e.Code, e.Message)
	default:
		common.DebugLog(err)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
	}
}

func pageParams(c *gin.Context, defaultSize int) (int, int) {
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(c.Query("pageSize"))
	if pageSize < 1 {
		pageSize = defaultSize
	}
	return page, pageSize
}

func dbUserID(userID string) *string {
	if userID == "" || strings.HasPrefix(userID, "usr-") {
		return nil
	}
	return &userID
}

func trimPtr(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		return nil
	}
	return &t
}

// parseJSDate — new Date(str): RFC3339/ISO или YYYY-MM-DD; ok=false — NaN.
func parseJSDate(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

const paymentDocCols = `id, do_number, do_date, contractor_id, currency, total_amount, paid_amount, unpaid_amount, category, status,
	order_id, raw_columns, business_direction, project_name, division, warehouse_name, cost_category, author, manager_name,
	approved_at, approver, supplier_doc_number, supplier_doc_date, sales_order_number`

func scanPaymentDoc(row pgx.Row) (models.PaymentDocument, error) {
	var d models.PaymentDocument
	var status string
	err := row.Scan(&d.ID, &d.DoNumber, &d.DoDate, &d.ContractorID, &d.Currency, &d.TotalAmount, &d.PaidAmount, &d.UnpaidAmount,
		&d.Category, &status, &d.OrderID, &d.RawColumns, &d.BusinessDirection, &d.ProjectName, &d.Division, &d.WarehouseName,
		&d.CostCategory, &d.Author, &d.ManagerName, &d.ApprovedAt, &d.Approver, &d.SupplierDocNumber, &d.SupplierDocDate, &d.SalesOrderNumber)
	d.Status = models.PaymentDocStatusDBToAPI(status)
	return d, err
}

func customersByID(ctx context.Context, pool *pgxpool.Pool, ids []string) (map[string]models.Customer, error) {
	out := map[string]models.Customer{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := pool.Query(ctx, "SELECT "+catalog.CustomerCols+" FROM customers WHERE id = ANY($1)", ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		cu, err := catalog.ScanCustomer(rows)
		if err != nil {
			return nil, err
		}
		out[cu.ID] = cu
	}
	return out, rows.Err()
}

func ordersByID(ctx context.Context, pool *pgxpool.Pool, ids []string) (map[string]models.Order, error) {
	out := map[string]models.Order{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := pool.Query(ctx, "SELECT "+orders.OrderCols+" FROM orders WHERE id = ANY($1)", ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		o, err := orders.ScanOrder(rows)
		if err != nil {
			return nil, err
		}
		out[o.ID] = o
	}
	return out, rows.Err()
}

func dedupe(ids []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, id := range ids {
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func jsonRaw(b []byte) json.RawMessage { return json.RawMessage(b) }
