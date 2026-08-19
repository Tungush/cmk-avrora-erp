# 03. API Specification — REST API v1

> Формат: OpenAPI-подобное описание в Markdown. Базовый путь: `/api/v1`.
> Аутентификация: Bearer JWT для всех эндпоинтов, кроме `/auth/*` и `/webhooks/*` (webhook-подпись отдельно).
> Формат ошибок: `{ "error": { "code": string, "message": string, "details": object|null } }`, HTTP-статусы стандартные (400/401/403/404/409/422/500).
> Пагинация: `?page=1&pageSize=50`, ответ-обёртка `{ "data": [...], "meta": { "page","pageSize","total" } }`.
> Все поля, помеченные в `01_DATA_MODEL.md` как **Calculated**, отсутствуют в теле запроса (игнорируются, если присланы) и всегда возвращаются в ответе.

---

## 1. Справочники (Catalog)

### `GET /articles`
Список номенклатуры ГП. Query: `?search=&category=&isActive=&page=&pageSize=`
Response `200`: `{ data: Article[], meta }`

### `POST /articles`
Body: `{ articleCode, name, weightKg, series?, description?, approvedPrice, palletCapacity? }`
Response `201`: `Article`
Ошибки: `409` если `articleCode` уже существует.

### `GET /articles/{id}`
Response `200`: `Article` (включая calculated: `specPrice`, `priceDeviationPct`, `leadTimeDays`)

### `PATCH /articles/{id}`
Body: любые Input-поля частично. Response `200`: `Article`.

### `GET /articles/{id}/price-history`
Response `200`: `PriceHistory[]`

### `POST /articles/{id}/price-history`
Body: `{ price, validFrom }` → создаёт новую версию цены, не трогает старые.
Response `201`: `PriceHistory`

### `GET /articles/{id}/bom`
Response `200`: `BomItem[]`

### `PUT /articles/{id}/bom`
Body: `{ items: [{ materialId, qtyPerUnit, operationType, laborHours }] }` — полная замена BOM.
Response `200`: `BomItem[]` (пересчитывает `spec_price`, `lead_time_days` — см. `02_BUSINESS_LOGIC.md` п.2.1, 2.3)

### `GET /materials`
Query: `?category=&search=&page=&pageSize=`
Response `200`: `{ data: Material[], meta }`

### `POST /materials`
Body: `{ materialCode, category, name, unit, unitWeightKg?, purchasePrice? }`
Response `201`: `Material`

### `PATCH /materials/{id}`
Response `200`: `Material`

### `GET /customers`
Query: `?search=&region=&customerType=`
Response `200`: `{ data: Customer[], meta }`

### `POST /customers`
Body: `{ name, binIin, region, customerType }`
Response `201`: `Customer`. Ошибка `409` при дубликате `binIin`.

---

## 2. Заказы и планирование (Orders / Production Plan)

### `GET /orders`
Query: `?status=&customerId=&managerId=&orderType=&overdueOnly=&dateFrom=&dateTo=&page=&pageSize=`
Response `200`: `{ data: Order[], meta }`

### `POST /orders`
Body:
```json
{
  "customerId": "uuid",
  "region": "string",
  "orderType": "ФЗ|ВЗ",
  "requestDate": "date",
  "plannedShipmentDate": "date",
  "lines": [ { "articleId": "uuid", "qty": 10, "unit": "шт" } ]
}
```
Response `201`: `Order` (со статусом `Draft`, `orderNumber` сгенерирован).
Валидация: `qty > 0` для каждой строки; `customer.binIin` обязателен и валиден.

### `GET /orders/{id}`
Response `200`: `Order` (включая `lines[]`, `balanceDue`, `overdueDays`, `status`)

### `PATCH /orders/{id}`
Body: изменяемые Input-поля (region, plannedShipmentDate, lines[] добавление/правка).
Response `200`: `Order`

### `POST /orders/{id}/status`
Body: `{ "toStatus": "Confirmed|InProduction|ReadyToShip|Shipped|Closed|Cancelled", "comment"?: "string" }`
Response `200`: `Order`
Ошибки: `409 INVALID_TRANSITION` если переход запрещён state machine (см. `02_BUSINESS_LOGIC.md` раздел 3).
Обязателен `comment` при `toStatus = Cancelled`.

### `GET /orders/{id}/production-stages`
Response `200`: `ProductionStage[]`

### `PATCH /orders/{id}/production-stages/{stageCode}`
Body: `{ "status": "in_progress|done", "defectPhotoUrl"?: "string" }`
Response `200`: `ProductionStage`

### `GET /production-plan`
Query: `?period=week|month|quarter&from=&to=&articleId=`
Response `200`:
```json
{
  "data": [
    { "articleId": "uuid", "periodKey": "2026-W33",
      "qtyFromOrders": 32, "qtyMinStock": 5, "qtyReserved": 0,
      "qtyInStock": 12, "qtyToProduce": 25 }
  ]
}
```

### `POST /production-plan/recalc`
Body: `{ "articleId"?: "uuid", "periodFrom"?: "date", "periodTo"?: "date" }` (без параметров — полный пересчёт, использовать осторожно, async job).
Response `202`: `{ "jobId": "uuid" }`

### `GET /production-plan/jobs/{jobId}`
Response `200`: `{ "status": "queued|running|done|failed", "result"?: {...} }`

### `GET /min-stock-levels`
Query: `?articleId=&deficitOnly=true`
Response `200`: `MinStockLevel[]`

### `PATCH /min-stock-levels/{articleId}`
Body: `{ "periodMonths"?, "targetQty"? }` (только Input-поля; `actualQty`, `deficitQty` — только чтение)
Response `200`: `MinStockLevel`

---

## 3. Склад (Warehouse)

### `POST /warehouse/materials/movements`
Body: `{ materialId, movementType, qty, unitPrice?, movementDate, project? }`
Response `201`: `MaterialStockMovement` (триггерит пересчёт `materials.stockQty`, `minStockLevels`, `purchaseRequests` — см. `02_BUSINESS_LOGIC.md`)

### `GET /warehouse/materials/balance`
Query: `?category=&materialId=`
Response `200`: `[{ materialId, materialCode, stockQty, unit, sumAmount }]`

### `POST /warehouse/finished-goods/movements`
Body: `{ articleId, movementType: "приход|отгрузка|резерв|возврат", qty, orderId?, movementDate }`
Response `201`: `FinishedGoodsMovement`

### `GET /purchase-requests`
Query: `?status=&materialGroup=&page=&pageSize=`
Response `200`: `{ data: PurchaseRequest[], meta }`

### `POST /purchase-requests/{id}/approve`
Response `200`: `PurchaseRequest` (status → approved), доступно ролям Закупщик+/Директор.

---

## 4. Финансы (Finance)

### `GET /payment-documents`
Query: `?status=&contractorId=&orderId=&page=&pageSize=`
Response `200`: `{ data: PaymentDocument[], meta }`

### `POST /payment-documents`
Body: `{ doNumber, doDate, contractorId, currency, totalAmount, category, orderId? }`
Response `201`: `PaymentDocument`

### `POST /payment-documents/{id}/payments`
Body: `{ amount, paidAt }`
Response `201`: `Payment` (пересчитывает `paidAmount`, `unpaidAmount`, `status`)

### `GET /orders/{id}/payments`
Response `200`: `{ prepayment, postPayment1, postPayment2, penalty, balanceDue }`

### `GET /receivables`
Query: `?customerId=&overdueOnly=`
Response `200`: сводная дебиторка (замена листов «Долги по отгрузкам», «Долги ЦМК»)

### `POST /acceptance-acts`
Body: `{ orderId, appNumber, actDate, amount }`
Response `201`: `AcceptanceAct`

---

## 5. Интеграционные вебхуки

### `POST /webhooks/bitrix/deal-updated`
Заголовок: `X-Bitrix-Signature`. Body — payload Bitrix24.
Действие: upsert `orders.bitrixDealId`, `orders.bitrixStage`.
Response `200`: `{ "received": true }`

### `POST /webhooks/1c/payment-posted`
Body: `{ doNumber, amount, paidAt }` → создаёт `Payment`.
Response `200`: `{ "received": true }`

### `POST /webhooks/1c/stock-updated`
Body: `{ materialCode, qty, movementType, movementDate }` → создаёт `MaterialStockMovement`.
Response `200`: `{ "received": true }`

### `POST /webhooks/telegram/stage-confirmed`
Body: `{ orderId, stageCode, employeeTelegramId, photoUrl? }` → `PATCH production-stages`.
Response `200`: `{ "received": true }`

---

## 6. Отчёты / дашборды (read-only агрегаты)

### `GET /dashboards/production-summary`
Замена «Сводка», «Сводная». Response: KPI-карточки (план/факт, загрузка, дебиторка).

### `GET /dashboards/finished-goods-summary`
Замена «Сводная по ГП», «Сводная по ГП2». Query: `?year=`
Response: остатки/отгрузки ГП по годам и артикулам.

### `GET /audit-log`
Query: `?entityType=&entityId=&userId=&dateFrom=&dateTo=`
Response `200`: `{ data: AuditLogEntry[], meta }` — см. `04_ROLES_PERMISSIONS.md`.

---

## 7. Общие требования к реализации

- Все `Calculated`-поля из `01_DATA_MODEL.md` — read-only на уровне DTO (отдельные Input-DTO и Response-DTO, не одна модель).
- Идемпотентность вебхуков — обязательна проверка по внешнему ID (`bitrixDealId`, `doNumber`) во избежание дублей при повторной доставке.
- Долгие операции (`production-plan/recalc`, массовый импорт остатков) — только через async job + polling, не синхронный ответ.
- Версионирование API через префикс `/api/v1` — при breaking change создавать `/api/v2`, не менять v1 «на месте».
