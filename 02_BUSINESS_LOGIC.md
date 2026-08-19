# 02. Business Logic — Формулы и алгоритмы пересчёта

> Формализация Excel-формул из «2025_План Производства.xlsx» в виде псевдокода/SQL для
> реализации в backend-слое (service layer, не в БД-триггерах, кроме явно отмеченных мест).

## 1. Общий принцип пересчёта

В Excel всё пересчитывалось каскадно при любом изменении ячейки. В целевой системе это
**событийный пересчёт** (event-driven), не полный recalculation всей книги:

| Событие | Что пересчитывается |
|---|---|
| Создана/изменена `OrderLine` | `order.balance_due`, `production_plan_items` (период заказа), `min_stock_levels.deficit_qty` |
| Проведено движение склада (`material_stock_movements` / `finished_goods_movements`) | `materials.stock_qty` / остаток ГП, `min_stock_levels.actual_qty`, `production_plan_items.qty_in_stock`, `purchase_requests` (пересчёт дефицита) |
| Изменена цена артикула (`price_history`) | `articles.price_deviation_pct`, пересчёт `order_lines.unit_price` для новых (не для уже созданных) заказов |
| Изменён `bom_items` | `articles.spec_price`, `articles.lead_time_days` |
| Наступила полночь / новый день | `orders.overdue_days` (batch job), `work_calendar_days` не пересчитывается (статичный справочник на год) |

Рекомендация: реализовать как очередь доменных событий (напр. `OrderLineCreated`,
`StockMovementPosted`) → обработчики пересчёта → запись в таблицы-агрегаты. Не считать
агрегаты «на лету» при каждом GET, если объём данных большой (Excel уже страдал от
таймаутов на десятках тысяч строк — см. `LogErrors`).

---

## 2. Формулы (детально)

### 2.1 Себестоимость по спецификации (`articles.spec_price`)

Исходная формула (лист «Прайс», VLOOKUP в «Спецификации 2022»):

```
spec_price = SUM(bom_items.line_cost) FOR article_id
line_cost  = qty_per_unit * material.purchase_price
```

```sql
UPDATE articles a
SET spec_price = (
  SELECT COALESCE(SUM(bi.qty_per_unit * m.purchase_price), 0)
  FROM bom_items bi JOIN materials m ON m.id = bi.material_id
  WHERE bi.article_id = a.id
)
WHERE a.id = :article_id;
```

### 2.2 Отклонение утверждённой цены от расчётной (`price_deviation_pct`)

```
price_deviation_pct = approved_price / spec_price - 1   (если approved_price > 0, иначе NULL)
```

Бизнес-смысл: контроль маржинальности. Если < 0 → артикул продаётся ниже себестоимости —
кандидат для алерта/дашборда.

### 2.3 Срок изготовления (`lead_time_days`)

Исходная формула: `ROUNDUP(SUM(нормо-часы резка+сборка+обшивка) / 8, 1)`.

```
lead_time_days = CEIL( SUM(bom_items.labor_hours WHERE operation_type IN ('резка','сборка/сварка','обшивка')) / 8 )
```

8 — длина рабочей смены в часах (вынести в конфиг `WORK_SHIFT_HOURS`, не хардкодить).

### 2.4 Себестоимость человеко-часа (лист «Рабочее время»)

```
hour_cost = payroll_fund_total / (employee_count * working_hours_per_month)
```

Используется как множитель для расчёта стоимости трудоёмкости плана:

```
plan_labor_cost = plan_labor_hours_total * hour_cost
```

### 2.5 Рабочий календарь (`work_calendar_days`)

```
is_working_day(date) = NOT (weekday(date) IN (SATURDAY, SUNDAY) OR is_public_holiday(date))
cumulative_working_day_no(date) = COUNT(is_working_day = true) WHERE date' <= date AND date' >= year_start
```

`is_public_holiday` — справочник праздников (по стране, настраиваемый на год), в Excel
задавался вручную в столбце «праздник».

### 2.6 Минимальный остаток и дефицит (лист «Минимальные остатки»)

```
target_qty (F) = base_norm * (1 + correction_pct)          # "Корректировки на мес."
actual_qty (G) = SUM(finished_goods_movements) balance for article
readiness_pct (H) = MIN(actual_qty / target_qty, 1)          # capped на 1, если target=0 -> NULL
deficit_qty (I) = MAX(target_qty - actual_qty, 0)
```

### 2.7 Потребность из заявок (замена `SUMIFS(Telecom...)`)

Исходная формула (упрощённо):

```
demand_from_orders(article, period) =
    SUM(order_lines.qty WHERE article_id = article AND order.period = period)
  - SUM(shipped_qty WHERE ...)
  - SUM(reserved_qty WHERE ...)
```

```sql
SELECT ol.article_id, o.period_key, 
       SUM(ol.qty) - SUM(ol.shipped_qty) - SUM(ol.reserved_qty) AS demand
FROM order_lines ol JOIN orders o ON o.id = ol.order_id
WHERE o.status NOT IN ('cancelled')
GROUP BY ol.article_id, o.period_key;
```

### 2.8 Итоговая производственная потребность (лист «План», столбец P «Изготовить план+Мин ост»)

```
qty_to_produce = demand_from_orders(article, period)
               + qty_min_stock(article)
               - qty_reserved(article)
               - qty_in_stock(article)
# отрицательный результат -> 0 (излишек, ничего не изготавливаем)
qty_to_produce = MAX(qty_to_produce, 0)
```

### 2.9 Агрегация План: неделя → месяц → квартал

Исходно — 53 колонки недель, агрегируемые вручную формулами SUM/SUBTOTAL в колонки месяца
и квартала. В целевой системе — **не хранить агрегаты**, вычислять на чтении:

```sql
-- Месяц
SELECT article_id, date_trunc('month', period_start) AS month, SUM(qty_to_produce)
FROM production_plan_items GROUP BY article_id, month;

-- Квартал
SELECT article_id, date_trunc('quarter', period_start) AS quarter, SUM(qty_to_produce)
FROM production_plan_items GROUP BY article_id, quarter;
```

ISO week: `EXTRACT(week FROM date)` (PostgreSQL) — эквивалент Excel `WEEKNUM(date, 2)`.

### 2.10 Заявка на закупку сырья (лист «На закуп»)

```
purchase_qty(material) = MAX( demand_for_material(material) - stock_qty(material), 0 )
demand_for_material(material) = SUM(bom_items.qty_per_unit * production_plan_items.qty_to_produce)
                                 FOR material used in article's bom
purchase_amount(material) = purchase_qty(material) * material.purchase_price
```

### 2.11 Остаток к оплате по заказу (`order_lines.balance_due`)

```
line_total_vat = qty * unit_price * (1 + vat_rate)
balance_due    = line_total_vat - prepayment - post_payment_1 - post_payment_2 - penalty
```

### 2.12 Просрочка отгрузки (`orders.overdue_days`)

```
IF actual_shipment_date IS NULL AND today() > planned_shipment_date:
    overdue_days = today() - planned_shipment_date
ELSE:
    overdue_days = 0
```

Реализовать как **scheduled job** (ежедневно, ночью), не как computed-column на каждый read —
иначе при большом числе заказов это дорого. Job также генерирует уведомления (см. `05_DEV_ROADMAP.md`, MVP quick win).

---

## 3. Жизненный цикл заказа (state machine)

```
Draft
  └──> Confirmed/Planned        (заявка подтверждена, попадает в production_plan_items)
         └──> InProduction      (составной статус: под-статусы = production_stages)
                └──> ReadyToShip   (все stage.status = done, товар на складе ГП)
                       └──> Shipped   (actual_shipment_date заполнена)
                              └──> Closed  (balance_due = 0 AND acceptance_act существует)
  └──> Cancelled                (из любого состояния, флаг "Отмена")
```

Правила переходов (валидировать в service-слое, не только в UI):

| Переход | Условие |
|---|---|
| Draft → Confirmed | все обязательные поля order_line заполнены, customer.bin_iin валиден |
| Confirmed → InProduction | создана хотя бы одна `production_stage` со статусом in_progress |
| InProduction → ReadyToShip | все `production_stages` данного заказа = done |
| ReadyToShip → Shipped | `finished_goods_movements` (тип "отгрузка") создано на полное кол-во |
| Shipped → Closed | `balance_due = 0` и существует связанный `acceptance_act` |
| любой → Cancelled | ручное действие с ролью не ниже "Менеджер", обязателен комментарий причины |

Каждый переход обязан писаться в `audit_log` (см. `04_ROLES_PERMISSIONS.md`).

---

## 4. Валидация на уровне бизнес-правил (не только типов данных)

- `order_lines.qty > 0`, запрет отрицательного количества.
- Нельзя перевести заказ в `Shipped`, если `reserved_qty < qty` (не всё зарезервировано на складе).
- Нельзя удалить `Material`, если есть ссылки в `bom_items` (soft-delete через `is_active`).
- `purchase_requests` не создаются автоматически на материалы с `is_active = false`.
- Изменение `approved_price` в `articles` не должно ретроактивно менять `unit_price` уже созданных `order_lines` — только `price_history` на будущее (частая ошибка при миграции с Excel, где формула VLOOKUP всегда тянет текущую цену).
