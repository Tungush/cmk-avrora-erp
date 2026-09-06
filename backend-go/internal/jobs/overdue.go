// Package jobs — фоновые пересчёты, которые не привязаны к запросу.
package jobs

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// RecomputeOverdueDays пересчитывает orders.overdue_days по формуле 2.12
// (formulas.service.ts в прежнем NestJS): если заказ не отгружен
// (actual_shipment_date пуст), не закрыт и не отменён, а плановая дата вывоза
// уже прошла — число дней просрочки, иначе 0. Отгруженные тоже не считаются:
// «срок вывоза прошёл» — про то, что ещё лежит в цеху.
//
// В NestJS был класс ScheduledOverdueBatchJob, но его никто не вызывал, и
// счётчик оставался нулём с момента импорта — цех показывал «Просрочено 0»
// при сроках месячной давности. Дата — местная (TZ контейнера Asia/Almaty),
// как и границы месяцев в дашбордах.
func RecomputeOverdueDays(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	today := time.Now().In(time.Local).Format("2006-01-02")
	tag, err := pool.Exec(ctx, `
		UPDATE orders o
		SET overdue_days = v.days
		FROM (
			SELECT id,
			       CASE
			         WHEN actual_shipment_date IS NULL
			          AND status NOT IN ('CANCELLED', 'CLOSED', 'SHIPPED')
			          AND planned_shipment_date IS NOT NULL
			          AND planned_shipment_date < $1::date
			         THEN ($1::date - planned_shipment_date)
			         ELSE 0
			       END AS days
			FROM orders
		) v
		WHERE v.id = o.id AND o.overdue_days IS DISTINCT FROM v.days`, today)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// StartOverdueDays — пересчёт сразу при старте и затем каждый час: дата
// меняется раз в сутки, но час — дешёвая страховка от пропущенной полуночи.
func StartOverdueDays(ctx context.Context, pool *pgxpool.Pool) {
	run := func() {
		n, err := RecomputeOverdueDays(ctx, pool)
		if err != nil {
			log.Printf("Пересчёт просрочки заказов упал: %v", err)
			return
		}
		if n > 0 {
			log.Printf("Пересчёт просрочки заказов: обновлено %d", n)
		}
	}
	go func() {
		run()
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				run()
			}
		}
	}()
}
