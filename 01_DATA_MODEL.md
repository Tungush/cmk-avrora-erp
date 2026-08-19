# 01. Data Model — Сущности, типы, связи

> Источник: анализ «2025_План Производства.xlsx» (44 листа, Google Sheets export).
> Назначение документа: описать целевую нормализованную модель данных для веб-сервиса,
> заменяющего Excel-книгу. Использовать как основу для ORM-схемы (Prisma/SQLAlchemy/TypeORM).

## 1. Обзор доменов

Текущий файл объединяет 5 доменов в одной книге. В целевой системе — это 5 логических
модулей с общей БД (или отдельными схемами):

| Домен | Исходные листы Excel | Целевой модуль |
|---|---|---|
| Номенклатура и ценообразование | Прайс, Прайс 2024, Артикулы, Спецификации 2022, Тех-лист | `catalog` |
| Заказы / CRM | Telecom, Др проекты, Инфо3, Инфо4-да, Планируемое (без заявок), 7.28, Для фиксации | `orders` |
| Финансы / ДО | 19.20-7п (+копии), приходы др проектам, реестр АПП по заказчикам, Долги по отгрузкам | `finance` |
| Склад / снабжение | База сырья (+металл), Склад ТМЦ (импорт), Минимальные остатки, Остатки по бух., На закуп, Склад ГП, Приход ГП, Сводная по ГП(2) | `warehouse` |
| Планирование производства | План, Рабочее время, Годовое время, Сделка, ЗП сотр., Отчет по проектам проект | `production` |

Служебные листы (Permissions, Log, LogErrors, Импорт, Сводка, Сводная) в целевой системе
заменяются штатными механизмами платформы (RBAC, audit log, dashboards) и не переносятся как данные.

---

## 2. Каталог сущностей

| Сущность | Ключ | Модуль |
|---|---|---|
| `Article` (Изделие/ГП) | `article_code` (a-001, m-008…) | catalog |
| `Material` (Сырьё) | `material_code` (И0001, Р0308…) | catalog |
| `BomItem` (строка спецификации) | `article_id + material_id` | catalog |
| `PriceHistory` (версия цены) | `article_id + valid_from` | catalog |
| `Customer` (Контрагент) | `bin_iin` | orders/finance |
| `Order` (Заказ/Заявка) | `order_number` (П-XXXXXX-ГГ) | orders |
| `OrderLine` (позиция заказа) | `order_id + article_id` | orders |
| `PaymentDocument` (ДО) | `do_number` | finance |
| `Payment` (аванс/постоплата) | `payment_id` | finance |
| `AcceptanceAct` (АПП) | `app_number` | finance |
| `MaterialStockMovement` (движение сырья) | `movement_id` | warehouse |
| `FinishedGoodsMovement` (движение ГП) | `movement_id` | warehouse |
| `MinStockLevel` (норматив мин. остатка) | `article_id` | warehouse |
| `PurchaseRequest` (заявка на закупку) | `request_id` | warehouse |
| `ProductionPlanItem` (позиция плана) | `article_id + period_id` | production |
| `ProductionStage` (этап заказа) | `order_id + stage_code` | production |
| `WorkCalendarDay` (рабочий календарь) | `date` | production |
| `Employee` (сотрудник) | `employee_id` | production |
| `User` / `Role` | `user_id` / `role_id` | platform |
| `AuditLogEntry` | `id` | platform |

---

## 3. Структура таблиц (DDL-уровень описания)

### 3.1 `articles` (замена листов «Прайс», «Артикулы»)

| Поле | Тип | Input/Calculated | Правила |
|---|---|---|---|
| `id` | UUID | system | PK |
| `article_code` | varchar(20) | Input | UNIQUE, обязательное |
| `legacy_code` | varchar(20) | Input | старый код (миграция один раз, далее не используется) |
| `name` | text | Input | обязательное |
| `weight_kg` | decimal(10,3) | Input | ≥ 0 |
| `series` | varchar(10) | Input | справочник серий |
| `description` | text | Input | — |
| `approved_price` | decimal(14,2) | Input | текущая утверждённая цена (замена «УТВ цена») |
| `spec_price` | decimal(14,2) | **Calculated** | = агрегат по `bom_items` данного артикула (замена VLOOKUP в «Спецификации 2022») |
| `price_deviation_pct` | decimal(6,4) | **Calculated** | = `approved_price / spec_price - 1` |
| `lead_time_days` | decimal(6,2) | **Calculated** | = ROUNDUP(SUM(нормо-часы BOM) / 8, 1) |
| `pallet_capacity` | decimal(8,2) | Input | кол-во паллетомест под ГП |
| `is_active` | boolean | Input | soft-delete флаг |
| `created_at`, `updated_at` | timestamp | system | — |

### 3.2 `price_history` (замена «Прайс 2024»)

| Поле | Тип | Комментарий |
|---|---|---|
| `id` | UUID | PK |
| `article_id` | FK → articles | — |
| `price` | decimal(14,2) | — |
| `valid_from` | date | версионирование цены |
| `changed_by` | FK → users | обязательное — для аудита (в Excel этого не было) |

### 3.3 `materials` (замена «База сырья», «База сырья (металл)»)

| Поле | Тип | Input/Calculated | Правила |
|---|---|---|---|
| `id` | UUID | system | PK |
| `material_code` | varchar(20) | Input | UNIQUE |
| `category` | varchar(50) | Input | enum: Инструменты, Металл, Метизы, Комплектующие, Расходники |
| `name` | text | Input | обязательное |
| `unit` | varchar(10) | Input | ОБЯЗАТЕЛЬНАЯ нормализация (кг/шт/тн — единая ед. изм. на материал, замена смешения единиц из Excel) |
| `unit_weight_kg` | decimal(10,4) | Input | для конвертации между ед. изм. |
| `purchase_price` | decimal(14,2) | Input | цена из последней закупки |
| `purchase_price_updated_at` | date | system | — |
| `price_list_price` | decimal(14,2) | Input | цена из прайс-листа поставщика |
| `stock_qty` | decimal(14,3) | **Calculated** | агрегат по `material_stock_movements` |

### 3.4 `bom_items` (замена «Спецификации 2022»)

| Поле | Тип | Input/Calculated | Правила |
|---|---|---|---|
| `id` | UUID | system | PK |
| `article_id` | FK → articles | Input | — |
| `material_id` | FK → materials | Input | — |
| `qty_per_unit` | decimal(12,4) | Input | норма расхода на 1 ед. ГП |
| `operation_type` | varchar(30) | Input | enum: резка, сборка/сварка, обшивка, покраска |
| `labor_hours` | decimal(8,2) | Input | нормо-часы на операцию |
| `line_cost` | decimal(14,2) | **Calculated** | = `qty_per_unit * material.purchase_price` (замена `=(Z*Y)*X`) |

### 3.5 `customers` (справочник контрагентов)

| Поле | Тип | Правила |
|---|---|---|
| `id` | UUID | PK |
| `name` | text | обязательное |
| `bin_iin` | varchar(20) | обязательное, UNIQUE (в Excel — текстовая пометка «Обязательно заполнять!») |
| `region` | varchar(50) | справочник регионов |
| `customer_type` | varchar(20) | Внешний / Внутренний (замена «Тип клиента») |

### 3.6 `orders` + `order_lines` (замена Telecom, Др проекты)

**orders**

| Поле | Тип | Input/Calculated | Правила |
|---|---|---|---|
| `id` | UUID | system | PK |
| `order_number` | varchar(30) | Input/system | формат П-XXXXXX-ГГ, генерируется системой |
| `customer_id` | FK → customers | Input | обязательное |
| `region` | varchar(50) | Input | — |
| `manager_id` | FK → employees | **Calculated** | подстановка по региону/заказчику (замена «Руководитель (формула)») |
| `order_type` | varchar(5) | Input | enum: ФЗ (фиксированный), ВЗ (внеплановый) |
| `bitrix_deal_id` | varchar(50) | Input/system | интеграция CRM |
| `bitrix_stage` | varchar(50) | **Calculated** (из вебхука) | — |
| `status` | varchar(30) | **system (state machine)** | см. `05_DEV_ROADMAP.md` / состояния в разделе 4 |
| `planned_shipment_date` | date | Input | «План вывоза» |
| `actual_shipment_date` | date | Input | факт |
| `overdue_days` | integer | **Calculated** | = today − planned_shipment_date, если actual is null и today > planned |
| `request_date` | date | Input | Дата заявки |
| `created_at`, `updated_at` | timestamp | system | — |

**order_lines**

| Поле | Тип | Input/Calculated | Правила |
|---|---|---|---|
| `id` | UUID | system | PK |
| `order_id` | FK → orders | — | — |
| `article_id` | FK → articles | Input | — |
| `qty` | decimal(12,3) | Input | > 0 |
| `unit` | varchar(10) | Input | — |
| `unit_price` | decimal(14,2) | **Calculated** | из `articles.approved_price` на дату заявки |
| `line_total_vat` | decimal(14,2) | **Calculated** | = qty × unit_price × (1+НДС) |
| `prepayment` | decimal(14,2) | Input | — |
| `post_payment_1`, `post_payment_2` | decimal(14,2) | Input | — |
| `penalty` | decimal(14,2) | Input | «Штраф» |
| `balance_due` | decimal(14,2) | **Calculated** | = line_total_vat − (prepayment+post_payment_1+post_payment_2) − penalty |
| `reserved_qty` | decimal(12,3) | **Calculated** | резерв под заказ из склада ГП |
| `shipped_qty` | decimal(12,3) | **Calculated** | сумма движений отгрузки |

### 3.7 `payment_documents` (замена 19.20-7п / 19_20-ручной)

| Поле | Тип | Input/Calculated | Правила |
|---|---|---|---|
| `id` | UUID | system | PK |
| `do_number` | varchar(30) | Input | UNIQUE |
| `do_date` | date | Input | — |
| `contractor_id` | FK → customers | Input | — |
| `currency` | varchar(3) | Input | default KZT |
| `total_amount` | decimal(14,2) | Input | — |
| `paid_amount` | decimal(14,2) | **Calculated** | сумма `payments` |
| `unpaid_amount` | decimal(14,2) | **Calculated** | = total − paid |
| `category` | varchar(30) | Input | ТМЦ / Услуги / … |
| `status` | varchar(20) | **system** | Не оплачен → Частично оплачен → Оплачено → Исполнен |
| `order_id` | FK → orders (nullable) | Input | связка с заказом на продажу |

### 3.8 `material_stock_movements` / `finished_goods_movements` (замена Склад ТМЦ (импорт), Склад ГП, Приход ГП)

| Поле | Тип | Правила |
|---|---|---|
| `id` | UUID | PK |
| `item_id` | FK → materials / articles | — |
| `movement_type` | enum | приход, расход, в_производство, с_производства, возврат, коррекция |
| `qty` | decimal(14,3) | signed (+/-) |
| `unit_price` | decimal(14,2) | на момент движения |
| `movement_date` | date | обязательное |
| `project` | varchar(50) | nullable |
| `source_document_id` | UUID | ссылка на заказ/ДО, если применимо |

### 3.9 `min_stock_levels` (замена «Минимальные остатки»)

| Поле | Тип | Input/Calculated |
|---|---|---|
| `article_id` | FK → articles | — |
| `period_months` | decimal(6,3) | Input — «Период изготовления мин. остатков», сейчас константа (0.517 мес.) |
| `target_qty` | decimal(12,2) | Input/Calculated (корректировки на мес.) |
| `actual_qty` | decimal(12,2) | **Calculated** — из `finished_goods_movements` остаток |
| `deficit_qty` | decimal(12,2) | **Calculated** | = MAX(target_qty − actual_qty, 0) |
| `readiness_pct` | decimal(5,2) | **Calculated** | = actual_qty / target_qty |

### 3.10 `production_plan_items` (замена «План»)

> Критично: НЕ переносить широкую таблицу 110 колонок «неделя1..неделя53». Хранить как узкую
> таблицу факт-измерений (`article × period`), агрегировать в квартал/месяц на лету (SQL/BI-слой).

| Поле | Тип | Input/Calculated |
|---|---|---|
| `id` | UUID | system |
| `article_id` | FK → articles | — |
| `period_type` | enum(week/month/quarter) | — |
| `period_key` | varchar(10) | напр. `2026-W33` |
| `qty_from_orders` | decimal(12,2) | **Calculated** — SUM(order_lines.qty) по периоду |
| `qty_min_stock` | decimal(12,2) | **Calculated** — из min_stock_levels |
| `qty_reserved` | decimal(12,2) | **Calculated** | — |
| `qty_in_stock` | decimal(12,2) | **Calculated** | — |
| `qty_to_produce` | decimal(12,2) | **Calculated** | = qty_from_orders + qty_min_stock − qty_reserved − qty_in_stock |

### 3.11 `production_stages` (замена «Отчет по проектам проект»)

| Поле | Тип | Правила |
|---|---|---|
| `order_id` | FK → orders | — |
| `stage_code` | enum | ОС_с_заказчиком, Общий_вид, Чертежи, Закуп, Резка, Сборка_сварка, Покраска, Обшивка |
| `status` | enum | not_started / in_progress / done |
| `completed_at` | timestamp | — |
| `completed_by` | FK → employees | — |
| `defect_photo_url` | text (nullable) | MVP quick-win, п. 5 старого ТЗ |

### 3.12 `work_calendar_days` (замена «Годовое время»)

| Поле | Тип | Calculated |
|---|---|---|
| `date` | date PK | — |
| `week_number` | integer | ISO WEEKNUM |
| `is_working_day` | boolean | = NOT (суббота/воскресенье/праздник) |
| `cumulative_working_day_no` | integer | накопительный счётчик с начала года |

---

## 4. ER-диаграмма (текстовое представление связей)

```
Customer 1---* Order 1---* OrderLine *---1 Article 1---* BomItem *---1 Material
Order 1---1 [state machine status]
Order 1---* ProductionStage
Order 1---* PaymentDocument 1---* Payment
Article 1---* PriceHistory
Article 1---1 MinStockLevel
Article 1---* ProductionPlanItem
Material 1---* MaterialStockMovement
Article  1---* FinishedGoodsMovement
Employee 1---* Order (manager_id) ; Employee 1---* ProductionStage (completed_by)
WorkCalendarDay (справочник, используется production_plan_items.period_key)
```

---

## 5. Правила валидации (сводно)

- Все денежные поля — `decimal`, не `float`.
- `article_code` / `material_code` — единственный источник истины, без слоя legacy-перекодировки после миграции.
- `unit` на материале — фиксируется один раз, конвертация между ед. изм. — через явный коэффициент, не через ручной ввод в разных строках.
- Любое поле с меткой «Calculated» — **read-only на уровне API и UI**, не принимает значение из тела запроса.
- Обязательные поля (`bin_iin`, `article_code`, `order_number`, `qty`) — валидация на уровне БД (`NOT NULL`) и API (400 при отсутствии), а не текстовой подписью в интерфейсе.
