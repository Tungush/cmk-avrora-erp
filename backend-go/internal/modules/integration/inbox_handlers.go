// Package integrationapi — модуль Integration (integration.controller.ts +
// inbox-handlers.service.ts + onec-sync). Имя пакета отличается от каталога:
// "integration" уже занято internal/integration (outbox/inbox/external_refs).
//
// Этот файл — перенос inbox-handlers.service.ts: разбор накопленных входящих
// сообщений 1С. Принцип оригинала сохранён: обработчик применяет только то,
// чем 1С владеет; расхождение уходит в аудит, а не в молчаливую правку.
package integrationapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"time"

	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/integration"
	"cmk-avrora-erp/backend-go/internal/warehouse"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ProcessResult — ответ processPending: { processed, failed, ignored, total }.
type ProcessResult struct {
	Processed int `json:"processed"`
	Failed    int `json:"failed"`
	Ignored   int `json:"ignored"`
	Total     int `json:"total"`
}

// ProcessPending — перенос InboxHandlersService.processPending: берёт
// PENDING/FAILED по времени приёма, применяет обработчик по типу.
// Как в оригинале, в try-блок попадает и сама отметка PROCESSED/IGNORED —
// её сбой тоже уходит в markFailed, а не роняет весь разбор.
func ProcessPending(ctx context.Context, pool *pgxpool.Pool, limit int) (ProcessResult, error) {
	rows, err := pool.Query(ctx, `SELECT `+integration.InboxCols+` FROM inbox_messages
		WHERE status IN ('PENDING','FAILED') ORDER BY received_at ASC LIMIT $1`, limit)
	if err != nil {
		return ProcessResult{}, err
	}
	var messages []integration.InboxMessage
	for rows.Next() {
		m, err := integration.ScanInbox(rows)
		if err != nil {
			rows.Close()
			return ProcessResult{}, err
		}
		messages = append(messages, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return ProcessResult{}, err
	}

	res := ProcessResult{Total: len(messages)}
	for _, m := range messages {
		ignored, herr := dispatch(ctx, pool, m.Type, m.Payload)
		if herr == nil {
			if ignored {
				_, herr = pool.Exec(ctx, `UPDATE inbox_messages SET status = 'IGNORED', processed_at = $1 WHERE id = $2`,
					time.Now().UTC(), m.ID)
				if herr == nil {
					res.Ignored++
					continue
				}
			} else {
				herr = integration.MarkProcessed(ctx, pool, m.ID)
				if herr == nil {
					res.Processed++
					continue
				}
			}
		}
		if err := integration.MarkFailed(ctx, pool, m.ID, herr.Error(), m.Attempts+1); err != nil {
			return res, err
		}
		res.Failed++
	}
	return res, nil
}

// dispatch — второе значение true = 'IGNORED'.
func dispatch(ctx context.Context, pool *pgxpool.Pool, typ string, payload json.RawMessage) (bool, error) {
	var raw interface{}
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &raw); err != nil {
			return false, err
		}
	}
	switch typ {
	case "nomenclature.created":
		p, err := payloadObject(raw, "Cannot destructure property 'requestId' of 'p' as it is null.")
		if err != nil {
			return false, err
		}
		return false, onNomenclatureCreated(ctx, pool, p)
	case "receipt.posted":
		p, err := payloadObject(raw, nullRead("lines"))
		if err != nil {
			return false, err
		}
		return false, onReceiptPosted(ctx, pool, p)
	case "stock.snapshot":
		p, err := payloadObject(raw, nullRead("lines"))
		if err != nil {
			return false, err
		}
		return false, onStockSnapshot(ctx, pool, p)
	case "purchase_order.posted":
		p, err := payloadObject(raw, nullRead("items"))
		if err != nil {
			return false, err
		}
		return onPurchaseOrderPosted(ctx, pool, p)
	case "production.posted":
		p, err := payloadObject(raw, nullRead("orderNumber"))
		if err != nil {
			return false, err
		}
		return false, onProductionPosted(ctx, pool, p)
	case "production.rejected":
		p, err := payloadObject(raw, nullRead("orderNumber"))
		if err != nil {
			return false, err
		}
		return false, onProductionRejected(ctx, pool, p)
	case "production.costed":
		p, err := payloadObject(raw, nullRead("documents"))
		if err != nil {
			return false, err
		}
		return false, onProductionCosted(ctx, pool, p)
	default:
		log.Printf("[warn] Неизвестный тип входящего сообщения: %s", typ)
		return true, nil
	}
}

// onPurchaseOrderPosted — 1С провела заказ поставщику: заявки на закуп по
// совпавшим материалам APPROVED → ORDERED (best-effort, свой id 1С не проносит).
func onPurchaseOrderPosted(ctx context.Context, pool *pgxpool.Pool, p map[string]interface{}) (bool, error) {
	items := jsArray(p["items"])
	if len(items) == 0 {
		return true, nil
	}
	codes := make([]string, 0, len(items))
	for _, it := range items {
		v, err := jsProp(it, "item_code")
		if err != nil {
			return false, err
		}
		if jsTruthy(v) {
			codes = append(codes, jsString(v))
		}
	}
	if len(codes) == 0 {
		return true, nil
	}
	rows, err := pool.Query(ctx, `SELECT id FROM materials WHERE material_code = ANY($1)`, codes)
	if err != nil {
		return false, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return false, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return false, err
	}
	if len(ids) == 0 {
		return true, nil
	}
	// PurchaseRequest.updatedAt — @updatedAt: updateMany Prisma бампает его сам
	tag, err := pool.Exec(ctx, `UPDATE purchase_requests SET status = 'ORDERED', updated_at = now()
		WHERE material_id = ANY($1) AND status = 'APPROVED'`, ids)
	if err != nil {
		return false, err
	}
	log.Printf("purchase_order.posted: заявок переведено в ORDERED — %d", tag.RowsAffected())
	return false, nil
}

// onProductionPosted — 1С провела «Перемещение» + «Производство без заказа»
// по нашему production.completed: списываем сырьё ФАКТОМ 1С, не оценкой по BOM.
func onProductionPosted(ctx context.Context, pool *pgxpool.Pool, p map[string]interface{}) error {
	order, err := findOrderByRef(ctx, pool, p["orderNumber"], p["onecNum"])
	if err != nil {
		return err
	}
	if order == nil {
		return fmt.Errorf("production.posted: заказ не найден (%s)", refText(p))
	}

	movementRaw := jsCoalesce(p["movement"], map[string]interface{}{})
	productionRaw := jsCoalesce(p["production"], map[string]interface{}{})
	movement, _ := movementRaw.(map[string]interface{})
	production, _ := productionRaw.(map[string]interface{})

	warehouseCode := ""
	if v := movement["warehouseFrom"]; v != nil {
		warehouseCode = jsString(v)
	}
	var warehouseID *string
	if warehouseCode != "" {
		var id string
		err := pool.QueryRow(ctx, `SELECT id FROM warehouses WHERE code = $1`, warehouseCode).Scan(&id)
		if err == nil {
			warehouseID = &id
		} else if err != pgx.ErrNoRows {
			return err
		}
	}

	materials := jsArray(p["materials"])
	// new Date(String(documentDate)) — невалидная дата роняет первый же
	// Prisma-write (create движения или update заказа), до побочных эффектов
	movementDate := time.Now().UTC()
	var docDate *time.Time
	dateInvalid := false
	if v := production["documentDate"]; jsTruthy(v) {
		t, ok := jsDate(jsString(v))
		if ok {
			movementDate = t
			docDate = &t
		} else {
			dateInvalid = true
		}
	}
	var docNumber *string
	if v := production["documentNumber"]; jsTruthy(v) {
		s := jsString(v)
		docNumber = &s
	}

	posted := 0
	for _, m := range materials {
		mc, err := jsProp(m, "materialCode")
		if err != nil {
			return err
		}
		materialID, err := resolveMaterial(ctx, pool, map[string]interface{}{"materialCode": mc})
		if err != nil {
			return err
		}
		if materialID == nil {
			continue // не найден — предупреждение уже пришло отдельной строкой в warnings
		}
		qa, _ := jsProp(m, "qtyActual")
		q, _ := jsProp(m, "qty")
		qty := jsNumber(jsCoalesce(qa, q, float64(0)))
		if !(qty > 0) {
			continue
		}
		if dateInvalid {
			return fmt.Errorf("Invalid value for argument `movementDate`: Provided Date object is invalid. Expected Date.")
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO material_stock_movements (id, item_id, warehouse_id, movement_type, qty, movement_date, document_number, source_document_id, comment)
			VALUES ($1,$2,$3,'в_производство',$4,$5,$6,$7,$8)`,
			uuid.NewString(), *materialID, warehouseID, qty, movementDate, docNumber, order.ID,
			"production.posted: "+order.OrderNumber); err != nil {
			return err
		}
		posted++
	}

	if dateInvalid {
		return fmt.Errorf("Invalid value for argument `productionDocDate`: Provided Date object is invalid. Expected Date.")
	}
	if _, err := pool.Exec(ctx, `UPDATE orders SET production_doc_number = $1, production_doc_date = $2, updated_at = now() WHERE id = $3`,
		docNumber, docDate, order.ID); err != nil {
		return err
	}

	warnings := jsArray(p["warnings"])
	for _, w := range warnings {
		// 1С нашла материал по артикулу и вернула GUID — сохраняем, чтобы
		// следующий пакет по этому материалу ушёл уже с GUID, не артикулом
		code, err := jsProp(w, "code")
		if err != nil {
			return err
		}
		mc, _ := jsProp(w, "materialCode")
		guid, _ := jsProp(w, "resolvedGuid")
		if codeStr, ok := code.(string); ok && codeStr == "RESOLVED_BY_ARTICLE" && jsTruthy(mc) && jsTruthy(guid) {
			materialID, err := resolveMaterial(ctx, pool, map[string]interface{}{"materialCode": mc})
			if err != nil {
				return err
			}
			if materialID != nil {
				extCode := jsString(mc)
				if err := integration.LinkExternal(ctx, pool, integration.LinkInput{
					EntityType: "Material", LocalID: *materialID, ExternalID: jsString(guid), ExternalCode: &extCode,
				}); err != nil {
					return err
				}
			}
		}
	}

	docText := "—"
	if v := production["documentNumber"]; v != nil {
		docText = jsString(v)
	}
	comment := fmt.Sprintf("Производство без заказа проведено: %s, списано материалов: %d", docText, posted)
	if len(warnings) > 0 {
		comment += fmt.Sprintf(", предупреждений: %d", len(warnings))
	}
	after, err := json.Marshal(map[string]interface{}{
		"movement": movementRaw, "production": productionRaw, "materialsCount": posted, "warnings": warnings,
	})
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `INSERT INTO audit_log (id, entity_type, entity_id, action, after, user_role, comment)
		VALUES ($1,'Order',$2,'production_posted',$3,'1С',$4)`, uuid.NewString(), order.ID, after, comment)
	return err
}

// onProductionRejected — 1С отклонила пакет целиком: только аудит, статус
// заказа не откатывается (решение за человеком).
func onProductionRejected(ctx context.Context, pool *pgxpool.Pool, p map[string]interface{}) error {
	order, err := findOrderByRef(ctx, pool, p["orderNumber"], p["onecNum"])
	if err != nil {
		return err
	}
	if order == nil {
		return fmt.Errorf("production.rejected: заказ не найден (%s)", refText(p))
	}
	errRaw := jsCoalesce(p["error"], map[string]interface{}{})
	errObj, _ := errRaw.(map[string]interface{})
	code := "ERROR"
	if v := errObj["code"]; v != nil {
		code = jsString(v)
	}
	message := ""
	if v := errObj["message"]; v != nil {
		message = jsString(v)
	}
	after, err := json.Marshal(map[string]interface{}{"error": errRaw})
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `INSERT INTO audit_log (id, entity_type, entity_id, action, after, user_role, comment)
		VALUES ($1,'Order',$2,'production_rejected',$3,'1С',$4)`,
		uuid.NewString(), order.ID, after,
		fmt.Sprintf("1С отклонила «Производство без заказа»: %s — %s", code, message))
	return err
}

// onProductionCosted — финальная себестоимость после закрытия месяца в 1С:
// матчится по номеру документа из production.posted, не по заказу.
func onProductionCosted(ctx context.Context, pool *pgxpool.Pool, p map[string]interface{}) error {
	documents := jsArray(p["documents"])
	matched := 0
	for _, d := range documents {
		dn, err := jsProp(d, "documentNumber")
		if err != nil {
			return err
		}
		if !jsTruthy(dn) {
			continue
		}
		docNumber := jsString(dn)
		var orderID string
		err = pool.QueryRow(ctx, `SELECT id FROM orders WHERE production_doc_number = $1 ORDER BY id ASC LIMIT 1`, docNumber).Scan(&orderID)
		if err == pgx.ErrNoRows {
			continue // документ мог относиться к заказу, которого у нас нет — не ошибка
		}
		if err != nil {
			return err
		}
		// JSON.stringify выбрасывает ключи со значением undefined — отсутствующий
		// finalAmount/period не пишем вовсе, null — пишем как null
		afterObj := map[string]interface{}{"documentNumber": docNumber}
		if v, ok := jsKey(d, "finalAmount"); ok {
			afterObj["finalAmount"] = v
		}
		if v, ok := p["period"]; ok {
			afterObj["period"] = v
		}
		finalText := "—"
		if v, _ := jsProp(d, "finalAmount"); v != nil {
			finalText = jsString(v)
		}
		after, err := json.Marshal(afterObj)
		if err != nil {
			return err
		}
		if _, err := pool.Exec(ctx, `INSERT INTO audit_log (id, entity_type, entity_id, action, after, user_role, comment)
			VALUES ($1,'Order',$2,'production_costed',$3,'1С',$4)`,
			uuid.NewString(), orderID, after,
			fmt.Sprintf("Финальная себестоимость по «%s»: %s", docNumber, finalText)); err != nil {
			return err
		}
		matched++
	}
	log.Printf("production.costed: сматчено документов %d из %d", matched, len(documents))
	return nil
}

type orderRef struct {
	ID          string
	OrderNumber string
}

// findOrderByRef — сначала по нашему номеру, затем по номеру 1С. findFirst
// без orderBy = take 1 → неявный ORDER BY id (см. паттерн Prisma в памяти).
func findOrderByRef(ctx context.Context, pool *pgxpool.Pool, orderNumber, onecNum interface{}) (*orderRef, error) {
	if jsTruthy(orderNumber) {
		var o orderRef
		err := pool.QueryRow(ctx, `SELECT id, order_number FROM orders WHERE order_number = $1 ORDER BY id ASC LIMIT 1`,
			jsString(orderNumber)).Scan(&o.ID, &o.OrderNumber)
		if err == nil {
			return &o, nil
		}
		if err != pgx.ErrNoRows {
			return nil, err
		}
	}
	if jsTruthy(onecNum) {
		var o orderRef
		err := pool.QueryRow(ctx, `SELECT id, order_number FROM orders WHERE onec_num = $1 ORDER BY id ASC LIMIT 1`,
			jsString(onecNum)).Scan(&o.ID, &o.OrderNumber)
		if err == nil {
			return &o, nil
		}
		if err != pgx.ErrNoRows {
			return nil, err
		}
	}
	return nil, nil
}

// refText — `${p.orderNumber ?? p.onecNum}` для текста ошибки: null → "null",
// отсутствие обоих → "undefined", как в шаблонной строке JS.
func refText(p map[string]interface{}) string {
	if v := p["orderNumber"]; v != nil {
		return jsString(v)
	}
	v, ok := p["onecNum"]
	if v != nil {
		return jsString(v)
	}
	if ok {
		return "null"
	}
	return "undefined"
}

// onNomenclatureCreated — 1С создала номенклатуру по нашей заявке и вернула код.
func onNomenclatureCreated(ctx context.Context, pool *pgxpool.Pool, p map[string]interface{}) error {
	requestID, articleCode, externalID, name := p["requestId"], p["articleCode"], p["externalId"], p["name"]
	if !jsTruthy(articleCode) {
		return fmt.Errorf("nomenclature.created: нет articleCode")
	}

	type nreq struct {
		ID           string
		Status       string
		ProposedName string
		Series       *string
		Description  *string
	}
	var request *nreq
	if jsTruthy(requestID) {
		var r nreq
		err := pool.QueryRow(ctx, `SELECT id, status, proposed_name, series, description FROM nomenclature_requests WHERE id = $1`,
			jsString(requestID)).Scan(&r.ID, &r.Status, &r.ProposedName, &r.Series, &r.Description)
		if err == nil {
			request = &r
		} else if err != pgx.ErrNoRows {
			return err
		}
	}

	codeStr := jsString(articleCode)
	var articleID string
	err := pool.QueryRow(ctx, `SELECT id FROM articles WHERE article_code = $1`, codeStr).Scan(&articleID)
	if err == pgx.ErrNoRows {
		// name ?? request?.proposedName ?? articleCode
		nameStr := codeStr
		if name != nil {
			nameStr = jsString(name)
		} else if request != nil {
			nameStr = request.ProposedName
		}
		var series, description *string
		if request != nil {
			series, description = request.Series, request.Description
		}
		err = pool.QueryRow(ctx, `INSERT INTO articles (id, article_code, name, series, description, updated_at)
			VALUES ($1,$2,$3,$4,$5,now()) RETURNING id`,
			uuid.NewString(), codeStr, nameStr, series, description).Scan(&articleID)
	}
	if err != nil {
		return err
	}

	if jsTruthy(externalID) {
		if err := integration.LinkExternal(ctx, pool, integration.LinkInput{
			EntityType: "Article", LocalID: articleID, ExternalID: jsString(externalID), ExternalCode: &codeStr,
		}); err != nil {
			return err
		}
	}

	if request != nil && request.Status == "PENDING" {
		if _, err := pool.Exec(ctx, `UPDATE nomenclature_requests
			SET status = 'APPROVED', article_id = $1, decided_by = '1С', decided_at = $2, decision_comment = $3
			WHERE id = $4`,
			articleID, time.Now().UTC(), "Артикул присвоен в 1С: "+codeStr, request.ID); err != nil {
			return err
		}
	}
	return nil
}

// onReceiptPosted — проведено «Поступление товаров»: материал по коду или
// маппингу ExternalRef; неизвестный — ошибка, не молчаливое создание.
func onReceiptPosted(ctx context.Context, pool *pgxpool.Pool, p map[string]interface{}) error {
	var lines []interface{}
	if arr, ok := p["lines"].([]interface{}); ok {
		lines = arr
	} else {
		lines = []interface{}{p}
	}
	var docNumber, supplier *string
	if v := p["documentNumber"]; jsTruthy(v) {
		s := jsString(v)
		docNumber = &s
	}
	if v := p["supplierName"]; jsTruthy(v) {
		s := jsString(v)
		supplier = &s
	}
	date := time.Now().UTC()
	dateValid := true
	if v := p["date"]; jsTruthy(v) {
		date, dateValid = jsDate(jsString(v))
	}

	for _, line := range lines {
		materialID, err := resolveMaterial(ctx, pool, line)
		if err != nil {
			return err
		}
		if materialID == nil {
			mc, _ := jsProp(line, "materialCode")
			ext, _ := jsProp(line, "externalId")
			codeText := "—"
			if v := jsCoalesce(mc, ext); v != nil {
				codeText = jsString(v)
			}
			return fmt.Errorf("Материал не найден: код «%s». Заведите номенклатуру или сверьте справочники.", codeText)
		}
		qty := math.NaN() // Number(undefined)
		if v, ok := jsKey(line, "qty"); ok {
			qty = jsNumber(v)
		}
		price, _ := jsProp(line, "price")
		unitPrice, _ := jsProp(line, "unitPrice")
		var comment *string
		if v, _ := jsProp(line, "comment"); v != nil {
			s := jsString(v)
			comment = &s
		}
		in := warehouse.ReceiptInput{
			MaterialID:     *materialID,
			Qty:            qty,
			UnitPrice:      jsNumber(jsCoalesce(price, unitPrice, float64(0))),
			MovementDate:   &date,
			SupplierName:   supplier,
			DocumentNumber: docNumber,
			Comment:        comment,
		}
		if !dateValid {
			// Invalid Date доживает до Prisma-write в receive(): валидации
			// количества/цены и поиск материала в оригинале идут раньше
			if !(in.Qty > 0) {
				return &common.APIError400{Code: "INVALID_QTY", Message: "Количество должно быть > 0"}
			}
			if !(in.UnitPrice >= 0) {
				return &common.APIError400{Code: "INVALID_PRICE", Message: "Цена не может быть отрицательной"}
			}
			return fmt.Errorf("Invalid value for argument `movementDate`: Provided Date object is invalid. Expected Date.")
		}
		if _, err := warehouse.Receive(ctx, pool, in, ""); err != nil {
			return err
		}
	}
	return nil
}

// onStockSnapshot — снимок остатков: не перезаписываем, фиксируем расхождение.
func onStockSnapshot(ctx context.Context, pool *pgxpool.Pool, p map[string]interface{}) error {
	lines := jsArray(p["lines"])
	type divergence struct {
		MaterialCode string  `json:"materialCode"`
		Ours         float64 `json:"ours"`
		Theirs       float64 `json:"theirs"`
	}
	divergences := []divergence{}

	for _, line := range lines {
		materialID, err := resolveMaterial(ctx, pool, line)
		if err != nil {
			return err
		}
		if materialID == nil {
			continue
		}
		var materialCode string
		var stockQty float64
		err = pool.QueryRow(ctx, `SELECT material_code, stock_qty FROM materials WHERE id = $1`, *materialID).Scan(&materialCode, &stockQty)
		if err == pgx.ErrNoRows {
			continue
		}
		if err != nil {
			return err
		}
		q, _ := jsProp(line, "qty")
		ours := stockQty
		theirs := jsNumber(jsCoalesce(q, float64(0)))
		if math.Abs(ours-theirs) > 0.001 {
			divergences = append(divergences, divergence{MaterialCode: materialCode, Ours: ours, Theirs: theirs})
		}
	}

	if len(divergences) > 0 {
		// Расхождение — задача человеку: пишем в аудит, остатки не трогаем
		head := divergences
		if len(head) > 100 {
			head = head[:100]
		}
		after, err := json.Marshal(map[string]interface{}{"divergences": head, "count": len(divergences)})
		if err != nil {
			return err
		}
		if _, err := pool.Exec(ctx, `INSERT INTO audit_log (id, entity_type, entity_id, action, after, user_role, comment)
			VALUES ($1,'Material','00000000-0000-0000-0000-000000000000','stock_divergence',$2,'1С',$3)`,
			uuid.NewString(), after,
			fmt.Sprintf("Расхождение остатков с 1С по %d позициям", len(divergences))); err != nil {
			return err
		}
	}
	return nil
}

// resolveMaterial — материал по маппингу 1С, коду или наименованию.
func resolveMaterial(ctx context.Context, pool *pgxpool.Pool, line interface{}) (*string, error) {
	ext, err := jsProp(line, "externalId")
	if err != nil {
		return nil, err
	}
	if jsTruthy(ext) {
		local, err := integration.FindLocalID(ctx, pool, "Material", jsString(ext), "")
		if err != nil {
			return nil, err
		}
		if local != nil {
			return local, nil
		}
	}
	if mc, _ := jsProp(line, "materialCode"); jsTruthy(mc) {
		var id string
		err := pool.QueryRow(ctx, `SELECT id FROM materials WHERE material_code = $1`, jsString(mc)).Scan(&id)
		if err == nil {
			return &id, nil
		}
		if err != pgx.ErrNoRows {
			return nil, err
		}
	}
	if name, _ := jsProp(line, "name"); jsTruthy(name) {
		var id string
		err := pool.QueryRow(ctx, `SELECT id FROM materials WHERE lower(name) = lower($1) ORDER BY id ASC LIMIT 1`, jsString(name)).Scan(&id)
		if err == nil {
			return &id, nil
		}
		if err != pgx.ErrNoRows {
			return nil, err
		}
	}
	return nil, nil
}

// ---- JS-семантика над разобранным JSON (payload — Record<string, any>) ----

// payloadObject — `m.payload as Record<string, any>`: объект как есть,
// примитив → доступ к свойствам даёт undefined (пустая map), null → TypeError.
func payloadObject(raw interface{}, nullMessage string) (map[string]interface{}, error) {
	switch v := raw.(type) {
	case nil:
		return nil, fmt.Errorf("%s", nullMessage)
	case map[string]interface{}:
		return v, nil
	default:
		return map[string]interface{}{}, nil
	}
}

func nullRead(key string) string {
	return fmt.Sprintf("Cannot read properties of null (reading '%s')", key)
}

// jsProp — `v.key`: у объекта — значение (или nil), у примитива/массива —
// undefined (nil), у null — TypeError, как в V8.
func jsProp(v interface{}, key string) (interface{}, error) {
	switch t := v.(type) {
	case nil:
		return nil, fmt.Errorf("%s", nullRead(key))
	case map[string]interface{}:
		return t[key], nil
	default:
		return nil, nil
	}
}

// jsKey — как jsProp, но различает отсутствующий ключ (undefined) и null;
// нужно там, где JSON.stringify выбрасывает undefined-поля.
func jsKey(v interface{}, key string) (interface{}, bool) {
	if m, ok := v.(map[string]interface{}); ok {
		val, present := m[key]
		return val, present
	}
	return nil, false
}

// jsArray — `Array.isArray(v) ? v : []` (всегда не-nil, чтобы в JSON был []).
func jsArray(v interface{}) []interface{} {
	if arr, ok := v.([]interface{}); ok {
		return arr
	}
	return []interface{}{}
}

// jsCoalesce — оператор `??`: первое не-null/undefined значение.
func jsCoalesce(vals ...interface{}) interface{} {
	for _, v := range vals {
		if v != nil {
			return v
		}
	}
	return nil
}

// jsTruthy — правила истинности JS для значений из JSON.
func jsTruthy(v interface{}) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case string:
		return t != ""
	default:
		return true // объекты и массивы (даже пустые) истинны
	}
}

// jsString — String(v) / `${v}`.
func jsString(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return jsNumberString(t)
	case string:
		return t
	case map[string]interface{}:
		return "[object Object]"
	case []interface{}:
		parts := make([]string, len(t))
		for i, el := range t {
			if el == nil {
				continue // Array.prototype.join: null/undefined → ""
			}
			parts[i] = jsString(el)
		}
		return strings.Join(parts, ",")
	default:
		return fmt.Sprint(v)
	}
}

// jsNumberString — Number.prototype.toString(): кратчайшее представление,
// экспонента только вне [1e-6, 1e21), без ведущих нулей в показателе.
func jsNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	abs := math.Abs(f)
	if abs >= 1e21 || abs < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64) // "1.5e-07"
		mant, exp, _ := strings.Cut(s, "e")
		sign := exp[:1]
		digits := strings.TrimLeft(exp[1:], "0")
		if digits == "" {
			digits = "0"
		}
		return mant + "e" + sign + digits
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// jsNumber — Number(v) для значения из JSON (undefined обрабатывает вызывающий:
// отсутствующий ключ → NaN, здесь nil = null → 0).
func jsNumber(v interface{}) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case bool:
		if t {
			return 1
		}
		return 0
	case float64:
		return t
	case string:
		return jsParseNumber(t)
	case []interface{}:
		// Number([]) → 0, Number([x]) → Number(String(x)), иначе NaN
		return jsParseNumber(jsString(t))
	default:
		return math.NaN()
	}
}

// jsParseNumber — StringToNumber: пробелы по краям, "" → 0, 0x/0o/0b,
// только точные "Infinity"; всё остальное — через десятичную грамматику.
func jsParseNumber(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			n, err := strconv.ParseUint(s[2:], base, 64)
			if err != nil {
				return math.NaN()
			}
			return float64(n)
		}
	}
	if strings.ContainsAny(s, "_xXpPnN") { // подчёркивания, hex-float, inf/nan — не JS
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
			return f // ±Inf / 0 при переполнении, как в JS
		}
		return math.NaN()
	}
	return f
}

// jsDate — new Date(String(x)) для ISO-форм: только дата → UTC, дата-время
// без смещения → локальное время сервера, со смещением — как указано.
// Возвращает мгновение в UTC; false — Invalid Date.
func jsDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04Z07:00", "2006-01-02T15:04:05-0700"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	for _, layout := range []string{"2006-01-02", "2006-01", "2006"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}
