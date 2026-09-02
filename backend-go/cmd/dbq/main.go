// dbq — служебная утилита: выполнить SQL из аргумента и напечатать строки
// JSON-ом. Нужна для сверки колонок/данных при переносе (psql на машине нет).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

func main() {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, "postgresql://erp_user:erp_password@localhost:5432/erp_production_db")
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
		fmt.Println("--")
	}
}
