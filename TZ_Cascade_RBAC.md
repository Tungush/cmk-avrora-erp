# ТЗ: каскадный пересчёт, Prisma-связи, RBAC/UI по ролям
### Дополнение к `TZ_ERP_Production_Planning.md` — роли: Акерке (финансист), ЦМК (снабжение), Технолог, Производство, Руководитель

---

## 1. Взаимосвязь данных и автоматический каскад

### 1.1 ЦМК → Технолог: цена материала → себестоимость BOM

```
База сырья (металл)!Цена (ЦМК) ──► Material.purchasePrice (+ PriceHistory запись)
        │
        ▼ recompute
BomItem.lineCost = qtyPerUnit × Material.purchasePrice   (для каждой строки BOM с этим материалом)
        │
        ▼ SUM по articleId
Article.specPrice = Σ(BomItem.lineCost) + трудозатраты (Резка/Сборка-сварка/Покраска)
                     + логистика + вода/газ/электр. + НДС
```
Пересчёт **точечный**: меняется цена одного материала (напр. "Труба проф. 120х120х4мм") → находим все `BomItem` с этим `materialId` → пересчитываем только их `lineCost` → пересчитываем только те `Article`, где эти `BomItem` встречаются в BOM. Полный пересчёт всех 27662 строк `Спецификации 2022` при каждом изменении цены не нужен и не должен запускаться.

### 1.2 Себестоимость → маржа у Руководителя

```
Article.specPrice (пересчитано)  ──►  Article.priceDeviationPct = (specPrice - approvedPrice) / approvedPrice
                                  ──►  Маржа = Article.approvedPrice - Article.specPrice
```
`approvedPrice` (УТВ цена) **не меняется автоматически** — правит только Руководитель (Approve). Если после пересчёта `priceDeviationPct` превышает порог (например ±5%), строка в `Прайс` подсвечивается ("Дешевле/Дороже" — уже есть как поля в исходнике) и уходит в очередь на пересмотр цены, но старая `approvedPrice` продолжает действовать до явного Approve.

### 1.3 План + Спецификации → потребность в материалах (для ЦМК)

```
ProductionPlanItem.qtyToProduce (по Article, по периоду)
        × BomItem.qtyPerUnit (по каждому Material в BOM этого Article)
        ── GROUP BY materialId, periodKey ──►
Требуемое кол-во материала на период
        − Material.stockQty (текущий остаток)
        ──►  PurchaseRequest (draft, автосоздание/обновление), видно ЦМК как лист "На закуп"
```
Пересчёт запускается при: (а) сохранении строки `План` Производством, (б) изменении нормы расхода (`BomItem.qtyPerUnit`) Технологом. `PurchaseRequest` в статусе `DRAFT` **перезаписывается** пересчётом; после перехода в `APPROVED`/`ORDERED` — заморожен, не трогается автопересчётом (та же логика, что и с закрытыми заказами из первого ТЗ).

### 1.4 Продажи (Акерке: Telecom / Др проекты) → списание Склад ГП → свод Акерке

```
Telecom / Др проекты: статус заказа → "Отгружено" (+ дата отгрузки, № доверенности)
        ──► создаётся FinishedGoodsMovement (EXPENSE, articleId, qty, sourceDocumentId = dealId)
        ──► Склад ГП: qtyInStock -= qty  (агрегат "Отгружено" за период)

"приходы др проектам": Общая стоимость ДО − SUMIFS(Оплаченная сумма, по № ДО) = Неоплаченная сумма
        ──► кредиторская задолженность перед поставщиками (отдельный контур от дебиторки)

свод Акерке = VIEW, агрегирующий:
  Deal(Telecom) + Deal(Др проекты)  GROUP BY Заказчик/Проект
  ──► Сумма по заказу, Долги по АПП-Телеком (= Сумма заказа − Сумма оплат − Сумма отгруженного)
```
Разделяй два независимых потока, которые в Excel визуально смешаны на соседних листах: **дебиторка** (заказчик должен нам — из `Telecom`/`Др проекты`) и **кредиторка** (мы должны поставщику — из `приходы др проектам`). В БД — разные таблицы/views, не путать в одном своде.

---

## 2. Техническая реализация (Prisma / PostgreSQL / API)

### 2.1 Foreign Keys (дополнение к ранее присланной схеме)

```prisma
model Deal {
  id             String    @id @default(uuid()) @db.Uuid
  source         String    @db.VarChar(20)  // "Telecom" | "ДругиеПроекты"
  customerId     String    @db.Uuid @map("customer_id")
  articleId      String?   @db.Uuid @map("article_id")
  managerId      String?   @db.Uuid @map("manager_id")   // Акерке / др. финансист
  qtyOrdered     Decimal   @db.Decimal(12,2) @map("qty_ordered")
  qtyShipped     Decimal   @default(0) @db.Decimal(12,2) @map("qty_shipped")
  amountOrdered  Decimal   @db.Decimal(14,2) @map("amount_ordered")
  amountPaid     Decimal   @default(0) @db.Decimal(14,2) @map("amount_paid")
  status         String    @db.VarChar(30)   // "в работе"|"отгружено"|"закрыт"
  periodKey      String?   @db.VarChar(10) @map("period_key")
  shipmentDate   DateTime? @db.Date @map("shipment_date")

  customer Customer  @relation(fields: [customerId], references: [id])
  article  Article?  @relation(fields: [articleId], references: [id])
  manager  Employee? @relation(fields: [managerId], references: [id])
  @@map("deals")
}

model SupplierDocument { // "приходы др проектам"
  id             String   @id @default(uuid()) @db.Uuid
  docNumber      String   @db.VarChar(30) @map("doc_number")   // № ДО
  supplierName   String   @db.Text @map("supplier_name")
  buyerId        String?  @db.Uuid @map("buyer_id")            // Ответственный закупщик (ЦМК)
  totalAmount    Decimal  @db.Decimal(14,2) @map("total_amount")
  paidAmount     Decimal  @default(0) @db.Decimal(14,2) @map("paid_amount")
  currency       String   @db.VarChar(5) @default("KZT")
  category       String?  @db.VarChar(30)  // "ТМЦ" и т.п.

  buyer Employee? @relation(fields: [buyerId], references: [id])
  @@map("supplier_documents")
}
```

`Material`, `BomItem`, `Article`, `ProductionPlanItem`, `PurchaseRequest`, `FinishedGoodsMovement` — связи уже заданы в первом ТЗ (`BomItem.materialId → Material`, `BomItem.articleId → Article`, `ProductionPlanItem.articleId → Article`, `PurchaseRequest.materialId → Material`, `FinishedGoodsMovement.itemId → Article`). Новое: `Deal.articleId → Article`, `Deal.customerId → Customer` — замыкает цепочку "продажа списывает готовую продукцию".

### 2.2 Таблицы vs SQL View

| Физическая таблица | SQL View (не хранить, считать на лету) |
|---|---|
| `Article`, `Material`, `BomItem`, `Order/OrderLine`, `Deal`, `SupplierDocument`, `ProductionPlanItem`, `MaterialStockMovement`, `FinishedGoodsMovement`, `PurchaseRequest`, `PriceHistory` | `v_procurement_needed` ("На закуп" — plan×BOM минус stock) |
| | `v_customer_debts` ("Долги по отгрузкам"/"свод Акерке" — SUM(Deal.amountOrdered-amountPaid) GROUP BY customer) |
| | `v_supplier_debts` (кредиторка из `SupplierDocument`) |
| | `v_stock_summary` ("Склад ГП"/"Сводная по ГП" — движения FinishedGoodsMovement по периодам) |
| | `v_min_stock_readiness` ("Минимальные остатки" — target vs actual) |

Правило: если поле = агрегат (`SUM`/`SUBTOTAL`/разница остатков) и не требует независимого журнала аудита — View. Если это факт, который вводит человек и который должен иметь свою историю изменений (аудит, откат) — физическая таблица.

### 2.3 Пошаговая инструкция для Cursor

1. **Миграция:** добавить `Deal`, `SupplierDocument` в `schema.prisma`, создать SQL views миграцией `prisma migrate dev --create-only` + ручной SQL в файле миграции (`CREATE VIEW v_procurement_needed AS ...`).
2. **API — точечные PATCH-эндпоинты**, а не "сохранить весь лист":
   - `PATCH /materials/:id` (ЦМК) → в транзакции: `update Material` → `insert PriceHistory` → **enqueue** job `recalcBomCostsByMaterial(materialId)`.
   - `PATCH /bom-items/:id` (Технолог) → `update BomItem` → enqueue `recalcArticleCost(articleId)`.
   - `PATCH /production-plan-items/:id` (Производство) → `update ProductionPlanItem` → enqueue `recalcProcurementNeed(periodKey)`.
   - `PATCH /deals/:id` status→"отгружено" (Акерке) → в транзакции: `insert FinishedGoodsMovement(EXPENSE)` + `update Deal.qtyShipped/amountPaid`.
   - `POST /prices/:articleId/approve` (Руководитель) → `update Article.approvedPrice` (только эта роль).
3. **Фоновые джобы (BullMQ/pg-boss):**
   - `recalcBomCostsByMaterial(materialId)` → находит затронутые `BomItem` → пересчитывает `lineCost` → триггерит `recalcArticleCost` для каждого уникального `articleId`.
   - `recalcArticleCost(articleId)` → пересчитывает `Article.specPrice`, `priceDeviationPct` → пушит WebSocket-событие `article:cost_updated` подписчикам экрана "Прайс".
   - `recalcProcurementNeed(periodKey)` → пересчитывает `v_procurement_needed` (materialized, `REFRESH MATERIALIZED VIEW CONCURRENTLY`) → пушит событие в UI ЦМК.
   - Синхронно (без очереди) — только пересчёт одного `Article` при точечной правке BOM; полный пересчёт периода плана — только фоново, т.к. затрагивает тысячи строк (как `Спецификации 2022` на 27 тыс. строк).
4. **WebSocket-канал по ролям:** `article:cost_updated` → подписаны Руководитель/Технолог; `procurement:updated` → ЦМК; `deal:shipped` → Акерке+Производство (обновление остатка ГП).
5. **Идемпотентность:** каждый recalculation-джоб принимает `entityId` + `triggeredBy`, пишет в `AuditLogEntry` (`before`/`after`), чтобы не потерять причину пересчёта (сейчас в Excel невозможно понять, кто и почему изменил цену, что привело к каскаду).

---

## 3. Права доступа и интерфейс

### 3.1 Grid-конфигурация по ролям (AG Grid / TanStack Table)

| Роль | Видимые листы/таблицы | editable колонки | read-only колонки |
|---|---|---|---|
| **ЦМК** | `Material`, `MaterialStockMovement`, `SupplierDocument`, `v_procurement_needed` (На закуп) | `purchasePrice`, `stockQty`-движения (приход), `SupplierDocument.paidAmount` | `lineCost` в BOM (видит, но не правит), `stockQty` (расчётный остаток) |
| **Акерке (финансист проектов)** | `Deal` (Telecom + Др проекты), `SupplierDocument`, `v_customer_debts`, `v_supplier_debts` | статус сделки, суммы оплат, комментарии | `Article.specPrice`/себестоимость (не её зона) |
| **Технолог** | `Article` (только тех.поля: вес, серия), `BomItem` | `qtyPerUnit`, `operationType`, `laborHours`, состав материалов | `Material.purchasePrice`, `Article.approvedPrice`, `specPrice` (расчётное) |
| **Производство** | `ProductionPlanItem`, `ProductionStage`, `FinishedGoodsMovement` (RECEIPT) | план по периодам, статус этапов | нормы BOM, цены |
| **Руководитель/Финансы** | `Article` (полный), `PriceHistory`, все агрегаты/дашборды | `approvedPrice` (Approve-экшн) | `specPrice` (только просмотр, это расчёт) |

Реализация row/column scoping — **на бэкенде**, не на фронте: API отдаёт только те поля, на которые есть право чтения (иначе себестоимость утечёт в devtools даже при скрытой колонке в UI). Пример: эндпоинт `GET /articles/:id` для роли `TECHNOLOGIST` не включает в ответ `approvedPrice`/`specPrice`/`margin` вовсе — не просто `hidden: true` в grid.

```ts
// пример column def — editable как функция от роли, из серверного permission-набора
{
  field: 'purchasePrice',
  editable: (params) => params.context.permissions.includes('material:write'),
  cellStyle: (params) => params.context.permissions.includes('material:write')
    ? {} : { backgroundColor: '#f4f4f5', color: '#888' }, // визуальный "замок"
}
```

### 3.2 Блокировка вычисляемых полей

Правило одно на всю систему: **ни одно поле, помеченное в Prisma-схеме комментарием `// Calculated`, никогда не приходит в API как editable=true**, независимо от роли — эти поля не имеют PATCH-эндпоинта вообще (только GET). Единственный способ их изменить — изменить первичные данные (цену материала, норму расхода), которые запускают пересчёт из раздела 2.3. Это устраняет главный класс ошибок исходного Excel-файла, где пользователь физически мог вписать число поверх формулы `=VLOOKUP(...)` и молча сломать всю цепочку до конца листа.
