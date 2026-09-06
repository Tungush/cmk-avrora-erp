# НКТ: фактический контракт API

Снят с боевой спецификации 05.09.2026. Полный OpenAPI — [openapi.json](openapi.json)
(качается заново: `curl -o docs/nkt/openapi.json https://nationalcatalog.kz/gwp/portal/v3/api-docs/portal`).

Этот файл закрывает открытый вопрос 5 «Точные URL, тела запросов и коды статусов
обоих API — Этап 1» из [ТЗ](НКТ%20ТЗ.docx). Читать вместе с ним: логика процесса
в ТЗ верна, а имена методов и полей в приложении
[НКТ поля.xlsx](НКТ%20поля.xlsx) писались по смыслу и с фактическими расходятся.

## База и авторизация

| | |
|---|---|
| Прод | `https://nationalcatalog.kz/gwp` + путь из спецификации |
| Ключ | заголовок `X-API-KEY`, из личного кабинета НКТ → «Ключи API» |
| Тест | `stg.nct.kz` (в спецификации не объявлен, проверить при получении ключа) |

Без ключа все методы отдают 401. `https://nationalcatalog.kz/portal/api/...`
(без `/gwp`) перехватывает SPA портала и отдаёт HTML со статусом 200 — при отладке
это выглядит как «сервер вернул мусор», хотя дело в префиксе.

## Методы

### Поиск готовой карточки

| Метод | Назначение |
|---|---|
| `GET /portal/api/v2/products/{tin}` | Карточки по **NTIN или GTIN** — один и тот же путь |
| `GET /portal/api/v1/products/{tin}` | То же, версия 1 |

Отдельного «API поиска» по Postman-коллекции из ТЗ не существует: поиск и заявки —
один сервис с одним ключом.

### Заявки

| Метод | Назначение |
|---|---|
| `POST /portal/api/v1/products/requests` | Создать черновик → `{id}` |
| `PUT /portal/api/v1/products/requests/{id}` | Обновить (цикл доработки) |
| `PUT /portal/api/v1/products/requests/{id}/moderation` | Отправить на модерацию |
| `PUT /portal/api/v1/products/requests/{id}/publish` | Опубликовать |
| `PUT /portal/api/v1/products/requests/{id}/cancel` | Отозвать |
| `DELETE /portal/api/v1/products/requests/{id}` | Удалить черновик |
| `GET /portal/api/v1/products/requests/{id}/status` | Статус, замечания, NTIN |
| `GET /portal/api/v1/products/requests/{id}/details` | Полное тело заявки |
| `GET /portal/api/v1/products/requests` | Список своих заявок |
| `POST /portal/api/v1/products/requests/{ntin}/edit-product` | Заявка на правку чужой карточки |

### Схема полей и справочники

| Метод | Назначение |
|---|---|
| `GET /portal/api/v1/products/requests/attributes` | Базовые атрибуты: код, тип, обязательность, `dictionaryCode`, `pattern` |
| `GET /portal/api/v1/products/requests/categories/{oktru}/gov-attributes` | Расширенные: `mainAttributes` + `additionalAttributes` |
| `GET /portal/api/v1/dictionaries` | Список справочников |
| `GET /portal/api/v1/dictionaries/{code}/items` | Значения, постранично |
| `GET /portal/api/v1/dictionaries/{code}/roots` · `/children/{parentId}` | Иерархические справочники |

Это и есть замена скрипту `nkt_fields_dump.py` из ТЗ — выгрузка делается штатными
методами.

### Файлы

| Метод | Назначение |
|---|---|
| `POST /portal/api/v1/storage/upload` | Фото → `fileName` для `imageFiles[]` |
| `POST /portal/api/v1/storage/upload/document` | PDF → `fileName` для `documents[]` |

## Тело заявки

Плоских полей `name` / `brand` / `gtin` / `tnvedCode`, как в приложении xlsx, **нет**.
Всё содержимое карточки — пары «код атрибута → значение», разложенные по четырём
массивам:

```jsonc
{
  "oktru": "…",                        // обязательно
  "autoPublication": false,            // обязательно
  "ntin": "…",                         // есть → заявка на редактирование, нет → на новый товар
  "isGov": false,                      // расширенная карточка
  "attributes": [                      // базовые: name_ru, name_kk, brand, tnved,
    { "code": "name_ru", "value": "…" }//   szpt_category, is_domestic и прочие
  ],
  "mainExtendedAttributes": [ … ],     // enstrus, gross_weight, net_weight, volume,
                                       //   standards, package_dimensions, product_dimensions
  "additionalExtendedAttributes": [ … ],// категорийные, из gov-attributes
  "customExtendedAttributes": [ … ],   // свои: без code, обязательны nameRu + nameKk
  "imageFiles": [ { "fileName": "…", "imageType": "front|back|left|right|top|bottom" } ],
  "documents": [ { "fileName": "…" } ]
}
```

Правила, которые ломают заявку, если их не знать:

- Атрибут в чужой группе → ошибка валидации с его кодом. Расширенный атрибут
  (`isGov`) в `attributes` — ошибка. Исключение: `szpt_category` и `is_domestic`
  расширенными не считаются и идут в `attributes`.
- `mainExtendedAttributes` обязательны для отправки на модерацию — без них
  черновик создастся, а `moderation` не пройдёт.
- Для расширенной карточки обязательны `brand`, а из фото — `front` и `back`.
- `multiDictionary`: несколько значений в одном `value` через `@` —
  `"2105009100@6403919600"`.
- При создании — только базовая проверка. Полная валидация на `moderation`, поэтому
  локальная проверка тела по схеме до отправки (ТЗ §12.3) экономит реальные циклы.
- При редактировании нельзя менять `name_ru`, `name_kk`, `ntin`, `tnved` — их проще
  не передавать; переданное отличающееся значение вернёт ошибку.
- Расширенные карточки (с КЗТИН) через внешний API не редактируются.

## Статусы заявки

`GET /{id}/status` → `code`:

| Код | Значение | Статус в нашей модели |
|---|---|---|
| `new` | Новая | `REQUEST_CREATED` |
| `onModeration` | Отправлена на модерацию | `MODERATION` |
| `accepted` | Принято в работу | `MODERATION` |
| `underRevision` | На доработке | `REWORK` (или `MATCH_REVIEW`, см. ниже) |
| `rejected` | Отклонено | `REJECTED` |
| `cancelled` | Отозвано | `REJECTED` |
| `readyToPublish` | Готов к публикации | `READY_TO_PUBLISH` |
| `existingProductSelected` | Выбран существующий товар | `HAS_NTIN`, источник `MANUAL` |
| `completed` | Выполнено | `HAS_NTIN`, источник `REQUEST` |

Ответ также несёт `ntinCode` и `productUrl` (при `completed` и
`existingProductSelected`), `comment` — общий комментарий модератора, `revisionDetails[]` —
замечания к конкретным атрибутам, `photoModeration` — оценка изображений ИИ,
`nextAction` — подсказка, какой метод звать дальше, `gzStatus` — состояние
расширенной части (живёт своей жизнью и после `completed` базовой).

## Совпадения ищет НКТ, а не мы

Ветка BPMN «найден схожий товар → менеджер подтверждает» закрывается штатными
методами, свой нечёткий поиск по наименованию не нужен:

1. `POST /requests` → НКТ сам проверяет на дубли.
2. Нашёл похожие → заявка уходит в `underRevision`, в ответе `reason` и `nextAction`.
3. `GET /{id}/duplicates` → список: `orderNumber`, `name`, `brand`, `gtin`, `ntin`,
   `similarity` (процент совпадения).
4. Решение менеджера → `POST /{id}/duplicate-decision`:
   `{"decision":"CONTINUE"}` — делать свою карточку, либо
   `{"decision":"USE_EXISTING","ntin":"…"}` — взять чужую.
5. При `USE_EXISTING` заявка становится `existingProductSelected`, в статусе приходит
   NTIN выбранной карточки.

Если карточка уже существует один в один — выбирать нечего, заявка сразу `rejected`.

Запрет из ТЗ §10.4 в силе: решение по `similarity` принимает человек, автоматического
присвоения по проценту совпадения нет.

## Что расходится с ТЗ и приложением

| В документах | Фактически |
|---|---|
| Два API: поиск (Postman) и заявки (`/gwp/`) | Один сервис, один ключ, поиск — `GET /products/{tin}` по GTIN |
| Токен из ЛК с сроком действия | Ключ в заголовке `X-API-KEY` |
| Плоские поля `name`, `brand`, `gtin`, `tnvedCode`, `netWeight`… | Пары код-значение в четырёх массивах атрибутов |
| Свой нечёткий поиск, свои `MATCH_CANDIDATES` | Дубли ищет НКТ: `/duplicates` + `/duplicate-decision` |
| `nkt_fields_dump.py` для выгрузки схемы | Штатные `/attributes`, `/gov-attributes`, `/dictionaries` |
| Автопубликация — наша настройка | Поле заявки `autoPublication`, обязательное |
| Отзыв заявки не предусмотрен | `PUT /{id}/cancel`, `DELETE /{id}` |
| Вес, объём, габариты — обычные поля | Расширенные (`mainExtendedAttributes`), без них не пройти модерацию |
