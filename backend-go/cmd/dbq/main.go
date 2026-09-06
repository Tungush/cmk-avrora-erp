// dbq — служебная утилита: выполнить SQL из аргумента и напечатать строки
// JSON-ом. Нужна для сверки колонок/данных при переносе (psql на машине нет).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
)

// База — из DATABASE_URL (как у сервера; `?schema=public` Prisma отрезается,
// pgx его не понимает). Без переменной — боевая база по умолчанию, как и
// раньше. Раньше переменная игнорировалась молча, и запрос, адресованный
// копии (erp_pilot_test), уходил в бой — 06.09.2026.
func dsn() string {
	u := os.Getenv("DATABASE_URL")
	if u == "" {
		return "postgresql://erp_user:erp_password@localhost:5432/erp_production_db"
	}
	if i := strings.Index(u, "?"); i >= 0 {
		u = u[:i]
	}
	return u
}

func main() {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer conn.Close(ctx)
	for _, q := range os.Args[1:] {
		rows, err := conn.Query(ctx, q)
		if err != nil {
			fmt.Fprintln(os.Stderr, "ERR:", err)
			continue
		}
		fds := rows.FieldDescriptions()
		for rows.Next() {
			vals, _ := rows.Values()
			m := map[string]interface{}{}
			for i, f := range fds {
				m[string(f.Name)] = vals[i]
			}
			b, _ := json.Marshal(m)
			fmt.Println(string(b))
		}
		rows.Close()
		// Ошибка выполнения (не подготовки) всплывает только здесь: без этой
		// проверки упавший ALTER/UPDATE выглядел как успех
		if err := rows.Err(); err != nil {
			fmt.Fprintln(os.Stderr, "ERR:", err)
		}
		fmt.Println("--")
	}
}
