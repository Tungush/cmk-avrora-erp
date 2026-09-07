// Пересчёт себестоимости изделий той же математикой, что и сервис
// (internal/costing) — после загрузки состава и норм из таблицы инженера.
//
// Зачем отдельная команда: импортёр пишет состав и нормы, но цену изделия
// (spec_price) и снимок калькуляции считает только эта математика. Без
// пересчёта маржа у директора и себестоимость в карточке остаются пустыми.
//
//	npm run recalc:costing                 # все изделия с составом или нормами
//	npm run recalc:costing -- --active     # только те, что в активных заказах
//	npm run recalc:costing -- --article n-059
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/costing"
	"cmk-avrora-erp/backend-go/internal/db"
)

func main() {
	onlyActive := flag.Bool("active", false, "только изделия из активных заказов")
	article := flag.String("article", "", "один артикул (код изделия)")
	flag.Parse()

	// В контейнере переменные приходят из compose, на машине разработки — из backend/.env
	common.LoadDotEnv("../backend/.env")
	common.LoadDotEnv("backend/.env")

	ctx := context.Background()
	pool, err := db.Connect(ctx)
	if err != nil {
		log.Fatalf("не удалось подключиться к базе: %v", err)
	}
	defer pool.Close()

	query := `
		SELECT DISTINCT a.id, a.article_code
		FROM articles a
		WHERE (EXISTS (SELECT 1 FROM bom_items b WHERE b.article_id = a.id)
		    OR EXISTS (SELECT 1 FROM routing_operations r WHERE r.article_id = a.id))`
	var args []interface{}
	switch {
	case *article != "":
		query = `SELECT id, article_code FROM articles WHERE lower(article_code) = lower($1)`
		args = append(args, *article)
	case *onlyActive:
		query += ` AND EXISTS (
			SELECT 1 FROM order_lines ol JOIN orders o ON o.id = ol.order_id
			WHERE ol.article_id = a.id AND o.status NOT IN ('CLOSED','CANCELLED'))`
	}
	query += ` ORDER BY 2`

	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		log.Fatalf("выборка изделий: %v", err)
	}
	type item struct{ id, code string }
	var items []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.id, &it.code); err != nil {
			log.Fatalf("чтение изделия: %v", err)
		}
		items = append(items, it)
	}
	rows.Close()

	if len(items) == 0 {
		fmt.Println("Нечего пересчитывать: у изделий нет ни состава, ни норм")
		return
	}
	fmt.Printf("Пересчёт себестоимости: %d изделий\n", len(items))

	start := time.Now()
	var done, failed int
	for i, it := range items {
		if _, err := costing.Recalculate(ctx, pool, it.id, "bom_change", ""); err != nil {
			failed++
			fmt.Printf("  %s — не пересчиталось: %v\n", it.code, err)
			continue
		}
		done++
		if (i+1)%200 == 0 {
			fmt.Printf("  … %d из %d\n", i+1, len(items))
		}
	}
	fmt.Printf("Пересчитано: %d, с ошибкой: %d, заняло %s\n", done, failed, time.Since(start).Round(time.Second))
	if failed > 0 {
		os.Exit(1)
	}
}
