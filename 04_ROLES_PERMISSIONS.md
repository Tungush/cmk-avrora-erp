# 04. Roles & Permissions — RBAC и правила ввода

## 1. Роли

| Код роли | Название | Основание в исходном файле |
|---|---|---|
| `sales_manager` | Менеджер по продажам / ПМ | Telecom, Для фиксации: «Руководитель», «ПМ» |
| `planner` | Плановик / ПЭО | План, Минимальные остатки, Рабочее время |
| `engineer` | Конструктор / технолог | Отчет по проектам проект, Спецификации 2022 |
| `procurement` | Закупщик / снабженец | 19.20-7п: «Ответственный закупщик», лист «На закуп» |
| `warehouse_material` | Кладовщик (сырьё) | Склад ТМЦ (импорт) |
| `warehouse_fg` | Кладовщик (ГП) | Склад ГП, Приход ГП |
| `shop_foreman` | Мастер цеха | Отчет по проектам проект: этапы резки/сборки/покраски |
| `accountant` | Бухгалтер / финансист | 19.20-7п, реестр АПП по заказчикам, Остатки по бух. |
| `director` | Директор / руководство | Сводка, Сводная, Сводная по ГП |
| `admin` | Администратор системы | Permissions, Log, LogErrors |

Пользователь может иметь несколько ролей одновременно. Права — объединение прав всех ролей.

---

## 2. Матрица прав по сущностям

Обозначения: `R` — просмотр, `C` — создание, `U` — редактирование, `D` — удаление (soft-delete),
`A` — согласование/утверждение (approve), `-` — нет доступа.

| Сущность | sales_manager | planner | engineer | procurement | warehouse_material | warehouse_fg | shop_foreman | accountant | director | admin |
|---|---|---|---|---|---|---|---|---|---|---|
| `Order` | CRUD | R | R | R | R | R | R | R | R | R |
| `Order.status` (переходы) | Confirmed, Cancelled | InProduction | — | — | — | ReadyToShip, Shipped | — | Closed | Cancelled (любой) | — |
| `ProductionPlanItem` | R | CRUD | R | R | R | R | R | R | R | R |
| `BomItem` | R | R | CRUD | R | R | R | R | - | R | R |
| `Article` / `PriceHistory` | R | R | CU | R | R | R | R | R | A (approve цену) | R |
| `Material` | - | R | R | CRUD | CRU | R | R | R | R | R |
| `PurchaseRequest` | R | R | R | CRU + A | R | - | - | R | R | R |
| `MaterialStockMovement` | - | R | - | R | CRUD | R | R | R | R | R |
| `FinishedGoodsMovement` | R | R | - | - | R | CRUD | R | R | R | R |
| `ProductionStage` | R | R | R | - | - | - | CRUD | - | R | R |
| `PaymentDocument` / `Payment` | R | - | - | CR | - | - | - | CRU + A | R | R |
| `AcceptanceAct` | CR | - | - | - | - | - | - | R | R | R |
| `Customer` | CRU | R | R | R | R | R | R | R | A | R |
| Дашборды/отчёты | R | R | R | R | R | R | R | R | R | R |
| `User` / `Role` | - | - | - | - | - | - | - | - | R | CRUD |
| `AuditLogEntry` | - | - | - | - | - | - | - | - | R | R |

Правило: любое действие `A` (approve) должно требовать отдельного эндпоинта
(`POST /.../approve`), а не быть побочным эффектом `PATCH` — чтобы явно логироваться в audit log
с указанием, кто именно утвердил.

---

## 3. Правила ввода / валидации (перенос текстовых предупреждений Excel в системные правила)

| Было в Excel (текстовая пометка) | Стало в системе |
|---|---|
| «БИН/ИИН — Обязательно заполнять!» | `NOT NULL` + формат-валидация на уровне API (`422` при некорректном БИН/ИИН) |
| «Штраф — НЕ МЕНЯТЬ ДАННЫЕ!» | Поле `penalty` редактируемо только ролью `accountant`, с `A`-подтверждением при изменении > 0 |
| Столбцы «(формула)» в заголовке | Поле помечено `readOnly: true` в DTO, попытка записи через API → `422 FIELD_IS_CALCULATED` |
| Скрытые (hidden) листы без защиты (ЗП сотр., Permissions) | Отдельные таблицы с доступом только по роли, не «скрытие» — а `403 FORBIDDEN` при попытке чтения без роли |
| Dropdown-список заказчиков захардкожен в Data Validation | Полноценный CRUD-справочник `Customer` с правом создания у `sales_manager` |

---

## 4. Аудит (Audit Log)

Замена «Log»/«LogErrors» (которые в Excel фиксировали только факт *открытия документа*,
а не изменения данных).

**Обязательные события для логирования:**
- Любой `POST`/`PATCH`/`DELETE` по сущностям из раздела 2 — с `entityType`, `entityId`, `userId`, `before`, `after`, `timestamp`.
- Все переходы `Order.status`.
- Все `approve`-действия.
- Login/logout, смена ролей пользователя (`admin`-действия).

**Формат записи:**
```json
{
  "id": "uuid",
  "entityType": "Order",
  "entityId": "uuid",
  "action": "status_change",
  "before": { "status": "Confirmed" },
  "after": { "status": "InProduction" },
  "userId": "uuid",
  "userRole": "planner",
  "timestamp": "2026-08-11T10:00:00Z",
  "comment": "string|null"
}
```

Хранить не менее 3 лет (соответствие требованиям бухгалтерского учёта в РК — уточнить у заказчика точный срок).

---

## 5. Аутентификация и сессии

- JWT-токен с ролями в claims, срок жизни access-токена ≤ 1 час, refresh-токен — отдельный эндпоинт.
- Для Telegram-бота (мастер цеха) — отдельная авторизация по `employee.telegramId`, привязанному администратором заранее (не самостоятельная регистрация).
- Для вебхуков (Bitrix/1С) — HMAC-подпись запроса, не JWT.
