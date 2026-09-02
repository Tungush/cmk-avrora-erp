// Package db держит единственный пул соединений к той же Postgres-базе,
// что и NestJS-бэкенд (erp_production_db). Схема не трогается — Go
// работает поверх таблиц, которые завела Prisma (snake_case имена колонок
// через @map, см. backend/prisma/schema.prisma).
package db

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Connect(ctx context.Context) (*pgxpool.Pool, error) {
	raw := os.Getenv("DATABASE_URL")
	if raw == "" {
		return nil, fmt.Errorf("DATABASE_URL не задан")
	}
	// Prisma пишет в URL ?schema=public — для Postgres/pgx это неизвестный
	// параметр («unrecognized configuration parameter "schema"»). Убираем
	// только его, остальное (sslmode, connect_timeout …) остаётся.
	if u, perr := url.Parse(raw); perr == nil {
		q := u.Query()
		if q.Has("schema") {
			q.Del("schema")
			u.RawQuery = q.Encode()
			raw = u.String()
		}
	}
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		return nil, fmt.Errorf("некорректный DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 20
	cfg.MaxConnLifetime = time.Hour

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("не удалось создать пул: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("база недоступна: %w", err)
	}
	return pool, nil
}
