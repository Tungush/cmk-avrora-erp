// Package integration — часть integration.service.ts, нужная модулю Orders:
// запись в outbox (в той же транзакции, что и само изменение) и чтение
// внешних GUID для payload. Отправка (flushOutbox/send), приём вебхуков
// (receive/verifySignature) и HTTP-поверхность — отдельный будущий модуль
// Integration, здесь не нужны: Orders только ПИШЕТ в очередь, не отправляет.
package integration

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Execer — общий интерфейс *pgxpool.Pool и pgx.Tx: Enqueue вызывается
// ВНУТРИ транзакции статуса заказа/отметки этапа, как и в оригинале
// (`prisma.$transaction(async (tx) => { ...; await integration.enqueue(tx, ...) })`).
type Execer interface {
	Exec(ctx context.Context, sql string, args ...interface{}) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...interface{}) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...interface{}) pgx.Row
}

type Message struct {
	Type       string
	EntityType string
	EntityID   string
	Payload    map[string]interface{}
	System     string // "" -> "1C"
}

// Enqueue — перенос IntegrationService.enqueue: пишет строку в
// outbox_messages, статус PENDING по умолчанию колонки.
func Enqueue(ctx context.Context, tx Execer, msg Message) error {
	system := msg.System
	if system == "" {
		system = "1C"
	}
	payload, err := json.Marshal(msg.Payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO outbox_messages (id, system, type, entity_type, entity_id, payload)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		uuid.NewString(), system, msg.Type, msg.EntityType, msg.EntityID, payload)
	return err
}

// FindExternalIds — перенос IntegrationService.findExternalIds: GUID
// внешней системы по нашим id, пачкой.
func FindExternalIds(ctx context.Context, tx Execer, entityType string, localIDs []string, system string) (map[string]string, error) {
	out := map[string]string{}
	if len(localIDs) == 0 {
		return out, nil
	}
	if system == "" {
		system = "1C"
	}
	rows, err := tx.Query(ctx, `
		SELECT local_id, external_id FROM external_refs
		WHERE system = $1 AND entity_type = $2 AND local_id = ANY($3)`,
		system, entityType, localIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var localID, externalID string
		if err := rows.Scan(&localID, &externalID); err != nil {
			return nil, err
		}
		out[localID] = externalID
	}
	return out, rows.Err()
}
