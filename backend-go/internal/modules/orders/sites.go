package orders

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

// Объекты (базовые станции) — GET /orders/sites (02.09.2026).
//
// Телеком живёт объектами, а не заказами: на одну площадку идут разные
// заказы и разные изделия, а вопрос всегда один — «мачта на Dudar готова?».
// Раньше ответа не было нигде: в реестре заказов площадка лежала строкой
// в карточке, и собрать её пришлось бы глазами по 384 заказам.
//
// Площадка берётся из orders.project_site — это поле приходит из 1С
// (KZ-ALM_Dudar, KZ-EKB_Hill и т.п.), заполнено у 136 заказов из 384.
// Заказы без площадки в срез не попадают вовсе: показывать «объект —
// пусто» честнее нечем, чем не показывать его совсем.
const sitesSQL = `
SELECT o.project_site                                          AS site,
       COALESCE(MAX(o.project_group), '')                      AS project_group,
       COUNT(DISTINCT o.id)                                    AS orders_count,
       COUNT(DISTINCT o.id) FILTER (WHERE o.overdue_days > 0)  AS overdue_orders,
       COUNT(ol.id)                                            AS lines_count,
       COUNT(ol.id) FILTER (
         WHERE d.line_id IS NOT NULL OR sh.shipped > 0
       )                                                       AS done_lines,
       COALESCE(SUM(ol.qty * ol.unit_price), 0)                AS amount,
       MIN(o.planned_shipment_date) FILTER (
         WHERE o.status NOT IN ('CLOSED', 'CANCELLED')
       )                                                       AS nearest_date,
       COALESCE(MAX(o.overdue_days), 0)                        AS max_overdue,
       COALESCE(MAX(c.name), '')                               AS customer_name
  FROM orders o
  LEFT JOIN order_lines ol ON ol.order_id = o.id
  LEFT JOIN customers   c  ON c.id = o.customer_id
  LEFT JOIN (
        SELECT DISTINCT order_line_id AS line_id
          FROM production_stages
         WHERE status = 'done' AND order_line_id IS NOT NULL
  ) d ON d.line_id = ol.id
  -- Отгруженное изделие изготовлено по определению (04.09.2026).
  --
  -- Раньше «сделано» считалось ТОЛЬКО по отметкам цеха, а их в базе 17
  -- на весь завод: кнопку «Изготовлено» почти не жмут. Из-за этого на
  -- каждой площадке стояло «0 / 25 изделий» даже там, где всё давно
  -- вывезено и подписан акт. Акт — документ приёмки: если заказчик
  -- принял изделие, спорить с тем, что оно сделано, бессмысленно.
  LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(al.qty), 0) AS shipped
          FROM acceptance_act_lines al
          JOIN orders ao ON ao.order_number = al.order_number
         WHERE ao.id = ol.order_id AND al.article_id = ol.article_id
  ) sh ON TRUE
 WHERE o.project_site IS NOT NULL AND o.project_site <> ''
   AND o.is_archived = false
 GROUP BY o.project_site
 ORDER BY MAX(o.overdue_days) DESC NULLS LAST, o.project_site`

// Sites — GET /orders/sites
func (h *OrdersHandler) Sites(c *gin.Context) {
	ctx := c.Request.Context()
	rows, err := h.pool.Query(ctx, sitesSQL)
	if err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}
	defer rows.Close()

	out := []gin.H{}
	var totalOrders, totalLines, doneLines int
	for rows.Next() {
		var (
			site, group, customer      string
			ordersCount, overdueOrders int
			linesCount, done           int
			maxOverdue                 int
			amount                     decimal.Decimal
			nearest                    common.PDate
		)
		if err := rows.Scan(&site, &group, &ordersCount, &overdueOrders, &linesCount,
			&done, &amount, &nearest, &maxOverdue, &customer); err != nil {
			common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
			return
		}
		totalOrders += ordersCount
		totalLines += linesCount
		doneLines += done
		out = append(out, gin.H{
			"site":           site,
			"projectGroup":   group,
			"customerName":   customer,
			"ordersCount":    ordersCount,
			"overdueOrders":  overdueOrders,
			"linesCount":     linesCount,
			"doneLines":      done,
			"amount":         amount,
			"nearestDate":    nearest,
			"maxOverdueDays": maxOverdue,
		})
	}
	if err := rows.Err(); err != nil {
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"data": out,
		"meta": gin.H{
			"sites":     len(out),
			"orders":    totalOrders,
			"lines":     totalLines,
			"doneLines": doneLines,
		},
	})
}
