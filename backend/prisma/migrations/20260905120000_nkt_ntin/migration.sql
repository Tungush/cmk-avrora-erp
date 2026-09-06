-- Присвоение кодов NTIN изделиям ЦМК через Национальный каталог товаров
-- (05.09.2026). ТЗ и разбор фактического API — docs/nkt/.
--
-- Периметр. Только собственное производство: изделия ЦМК (articles, у
-- которых is_material_resale = false). Покупная номенклатура не входит —
-- ей NTIN ищется по чужому GTIN, а штрихкодов у нас нет: они живут в 1С и
-- ни в один обмен пока не приходят. Отсюда и укороченная статусная
-- модель: READY_TO_SEARCH и MATCHED из ТЗ не заводятся, потому что шаг
-- поиска для собственного производства пропускается (ТЗ §10.3) — карточки
-- в НКТ заведомо нет, объект сразу идёт в заявку.
--
-- Паспорт заводит инженер у нас. В 1С этих данных тоже нет: габариты,
-- ГОСТы и вес упаковки изделия знает конструктор, а не бухгалтерия.
-- Поэтому справочника соответствия «атрибут НКТ → реквизит 1С» из ТЗ
-- здесь нет вовсе — инженер заполняет атрибуты НКТ напрямую, а форма
-- рисуется по схеме, выгруженной из самого НКТ (nkt_attributes).

-- ---------------------------------------------------------------------------
-- Перечисления
-- ---------------------------------------------------------------------------

CREATE TYPE "NktStatus" AS ENUM (
  'NEW',               -- объект попал в обработку
  'DATA_INCOMPLETE',   -- не хватает обязательных данных паспорта
  'NEED_REGISTRATION', -- данные валидны, ждём подачи заявки
  'REQUEST_CREATED',   -- черновик заявки создан в НКТ
  'MODERATION',        -- отправлена на модерацию (new/onModeration/accepted)
  'MATCH_REVIEW',      -- НКТ нашёл похожие карточки, решает менеджер
  'REWORK',            -- вернули с замечаниями
  'REJECTED',          -- отклонена или отозвана
  'READY_TO_PUBLISH',  -- модерация пройдена, ждёт публикации
  'HAS_NTIN',          -- целевое состояние
  'ERROR'              -- техническая ошибка обмена
);

-- Как получен NTIN. Варианта GTIN (точное совпадение при поиске) нет по
-- той же причине, что и статуса MATCHED: поиска в периметре нет.
CREATE TYPE "NktNtinSource" AS ENUM (
  'REQUEST', -- опубликована наша заявка
  'MANUAL'   -- менеджер выбрал существующую карточку при разборе дублей
);

-- Операция в очереди. Фактический шаг воркер всё равно выводит из статуса
-- карточки; операция нужна, чтобы менеджер мог поставить конкретное
-- действие («отправить повторно») и чтобы очередь читалась глазами.
CREATE TYPE "NktQueueOp" AS ENUM ('VALIDATE', 'SUBMIT', 'POLL', 'PUBLISH');

-- Группа атрибута в теле заявки. НКТ роняет валидацию, если атрибут
-- передан не в своей группе, поэтому группа хранится вместе со схемой.
CREATE TYPE "NktAttrGroup" AS ENUM ('BASE', 'MAIN_EXT', 'ADDITIONAL_EXT');

CREATE TYPE "NktLogDirection" AS ENUM ('OUT', 'IN');

-- ---------------------------------------------------------------------------
-- Карточка НКТ: паспорт изделия и состояние заявки
-- ---------------------------------------------------------------------------
--
-- Одна строка на изделие. ТЗ проектировало три измерения (номенклатура ×
-- характеристика × упаковка), потому что NTIN присваивается потребительской
-- упаковке. У изделий ЦМК упаковка одна — лоток или шкаф отгружается как
-- есть, — поэтому измерение здесь одно, article_id, и оно уникально.
-- Появятся изделия с разной фасовкой — добавится packaging_code в ключ.
CREATE TABLE "nkt_cards" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "article_id" UUID NOT NULL,

  -- ---- Паспорт: заполняет инженер --------------------------------------
  -- Код категории ОКТРУ. Умолчание берётся из nkt_category_map по виду
  -- изделия, здесь лежит фактическое значение — вид грубее ОКТРУ, и
  -- инженер вправе уточнить категорию у конкретного изделия.
  "oktru"       VARCHAR(30),
  "tnved"       VARCHAR(20),
  -- Штрихкод изделия. У продукции собственного производства его, как
  -- правило, нет: получение GTIN в GS1 Kazakhstan — отдельный процесс вне
  -- периметра (ТЗ §10.3). Пустой GTIN подаче заявки не мешает.
  "gtin"        VARCHAR(14),
  "gtin_valid"  BOOLEAN NOT NULL DEFAULT false,
  -- Наименование по регламенту НКТ: тип + бренд + модель + характеристики.
  -- Наименование из справочника напрямую не подходит (ТЗ, открытый вопрос 6),
  -- поэтому это отдельное поле, а не articles.name.
  "name_ru"     TEXT,
  "name_kk"     TEXT,
  "brand"       TEXT,
  -- Остальные атрибуты — парами «код НКТ → значение», ровно как их принимает
  -- API: {"net_weight":"12500","standards":"ГОСТ 52868-2007",…}. Колонками
  -- они не разложены намеренно: состав атрибутов задаёт НКТ и меняет его без
  -- нас, а колонка под каждый означала бы миграцию на каждое их изменение.
  "attributes"  JSONB NOT NULL DEFAULT '{}',
  -- Загруженные в НКТ изображения: [{"fileName":"…","imageType":"front"}]
  "images"      JSONB NOT NULL DEFAULT '[]',

  -- ---- Состояние: пишет автомат ----------------------------------------
  "status"              "NktStatus" NOT NULL DEFAULT 'NEW',
  "request_id"          VARCHAR(40),
  -- Сырой код статуса от НКТ, как пришёл. Для диагностики: наш статус —
  -- это уже интерпретация, а разбираться с модератором приходится по их коду.
  "request_status_raw"  VARCHAR(40),
  "moderator_comment"   TEXT,
  -- Замечания к конкретным атрибутам (revisionDetails ответа НКТ)
  "revision_details"    JSONB,
  -- Найденные НКТ дубли: ntin, name, brand, gtin, similarity
  "duplicates"          JSONB,
  "ntin"                VARCHAR(13),
  "ntin_source"         "NktNtinSource",
  "product_url"         TEXT,
  -- SHA-256 тела заявки: если тело не изменилось, повторная отправка не
  -- выполняется — иначе цикл доработки крутит модератору одно и то же
  "payload_hash"        VARCHAR(64),
  "attempts"            INTEGER NOT NULL DEFAULT 0,
  "last_sync_at"        TIMESTAMP(3),
  "next_retry_at"       TIMESTAMP(3),
  "published_at"        TIMESTAMP(3),
  "last_error"          TEXT,
  -- Автопубликация — поле самой заявки в API НКТ, а не наша настройка
  "auto_publication"    BOOLEAN NOT NULL DEFAULT false,

  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "nkt_cards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "nkt_cards_article_id_key" ON "nkt_cards" ("article_id");
CREATE INDEX "nkt_cards_status_updated_at_idx" ON "nkt_cards" ("status", "updated_at");
-- Заполненный request_id при любых обстоятельствах запрещает создание
-- второй заявки по объекту (ТЗ §13). Уникальность — последний рубеж на
-- случай, если две горутины всё же дошли до создания одновременно.
CREATE UNIQUE INDEX "nkt_cards_request_id_key" ON "nkt_cards" ("request_id") WHERE "request_id" IS NOT NULL;

ALTER TABLE "nkt_cards"
  ADD CONSTRAINT "nkt_cards_article_id_fkey"
    FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Очередь обмена
-- ---------------------------------------------------------------------------
--
-- Уникальность по card_id — это и есть блокировка из ТЗ §7.5: пока по
-- изделию есть незакрытое задание, второе не поставится, и два фоновых
-- задания не возьмут один объект.
CREATE TABLE "nkt_queue" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "card_id"     UUID NOT NULL,
  "operation"   "NktQueueOp" NOT NULL,
  -- Меньше — раньше. Ручная постановка менеджером идёт с 0, фоновое
  -- заполнение очереди — с 100
  "priority"    INTEGER NOT NULL DEFAULT 100,
  "enqueued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Задержка ретрая: задание не берётся раньше этого момента
  "not_before"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Взято в работу. Ставится с таймаутом: воркер, умерший с задачей в
  -- руках, не должен запереть изделие навсегда
  "locked_at"   TIMESTAMP(3),

  CONSTRAINT "nkt_queue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "nkt_queue_card_id_key" ON "nkt_queue" ("card_id");
CREATE INDEX "nkt_queue_pick_idx" ON "nkt_queue" ("not_before", "priority", "enqueued_at");

ALTER TABLE "nkt_queue"
  ADD CONSTRAINT "nkt_queue_card_id_fkey"
    FOREIGN KEY ("card_id") REFERENCES "nkt_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Соответствие «вид изделия → ОКТРУ», ведёт аналитик
-- ---------------------------------------------------------------------------
--
-- Ключ — префикс артикула до дефиса (n, z, d, t, k, a, b, m…): это
-- единственная работающая классификация изделий. Колонка articles.series
-- для этого не годится — на 05.09.2026 она пуста у всех 2 152 изделий,
-- хотя тот же префикс исправно присваивается заявкой на номенклатуру.
--
-- Вид грубее ОКТРУ, поэтому это только умолчание: фактическая категория
-- лежит в nkt_cards.oktru и уточняется инженером по изделию.
CREATE TABLE "nkt_category_map" (
  "code_prefix"   VARCHAR(10) NOT NULL,
  "oktru"         VARCHAR(30) NOT NULL,
  -- Наименование категории — для контроля глазами, что код не перепутан
  "oktru_name"    TEXT,
  "tnved_default" VARCHAR(20),
  "is_active"     BOOLEAN NOT NULL DEFAULT true,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "nkt_category_map_pkey" PRIMARY KEY ("code_prefix")
);

-- ---------------------------------------------------------------------------
-- Кэш схемы атрибутов НКТ
-- ---------------------------------------------------------------------------
--
-- Обновляется ежесуточной синхронизацией из /products/requests/attributes
-- (базовые, общие для всех категорий — хранятся с oktru = '') и
-- /categories/{oktru}/gov-attributes (расширенные). По этой же таблице
-- рисуется форма паспорта и выполняется локальная валидация тела заявки
-- до отправки — заведомо невалидная заявка в НКТ не уходит (ТЗ §12.3).
CREATE TABLE "nkt_attributes" (
  -- '' — базовые атрибуты, общие для всех категорий
  "oktru"           VARCHAR(30) NOT NULL,
  "code"            VARCHAR(80) NOT NULL,
  "attr_group"      "NktAttrGroup" NOT NULL,
  "name_ru"         TEXT NOT NULL,
  "name_kk"         TEXT,
  "description_ru"  TEXT,
  -- string | text | number | boolean | dictionary | multiDictionary | date
  "data_type"       VARCHAR(20) NOT NULL,
  "is_required"     BOOLEAN NOT NULL DEFAULT false,
  "dictionary_code" VARCHAR(80),
  "pattern"         TEXT,
  "max_length"      INTEGER,
  "min_value"       VARCHAR(40),
  "max_value"       VARCHAR(40),
  "attribute_order" INTEGER NOT NULL DEFAULT 0,
  "synced_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "nkt_attributes_pkey" PRIMARY KEY ("oktru", "code")
);

-- ---------------------------------------------------------------------------
-- Кэш значений справочников НКТ
-- ---------------------------------------------------------------------------
--
-- Списки единиц измерения, стран, типов упаковки и категорийных справочников.
-- Значения не выписываются руками и не хардкодятся в коде (ТЗ §12.3): они
-- приходят из /dictionaries/{code}/items и обновляются синхронизацией.
CREATE TABLE "nkt_dictionary_values" (
  "dictionary_code" VARCHAR(80) NOT NULL,
  "value_id"        VARCHAR(80) NOT NULL,
  "name_ru"         TEXT NOT NULL,
  "name_kk"         TEXT,
  "parent_id"       VARCHAR(80),
  "synced_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "nkt_dictionary_values_pkey" PRIMARY KEY ("dictionary_code", "value_id")
);

CREATE INDEX "nkt_dictionary_values_parent_idx"
  ON "nkt_dictionary_values" ("dictionary_code", "parent_id");

-- ---------------------------------------------------------------------------
-- Журнал обмена
-- ---------------------------------------------------------------------------
--
-- Хранится 6 месяцев, чистится фоновым заданием. Ключ API в журнал не
-- попадает: заголовки не пишутся вовсе, а тела чистятся перед записью.
CREATE TABLE "nkt_log" (
  "id"            BIGSERIAL NOT NULL,
  -- NULL — обмен не по конкретному изделию (синхронизация схемы, справочники)
  "card_id"       UUID,
  "direction"     "NktLogDirection" NOT NULL,
  -- HTTP-метод и логическое имя операции: «POST createRequest»
  "method"        VARCHAR(60) NOT NULL,
  "url"           TEXT NOT NULL,
  "http_code"     INTEGER,
  "request_body"  TEXT,
  "response_body" TEXT,
  "attempt"       INTEGER NOT NULL DEFAULT 1,
  "duration_ms"   INTEGER,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "nkt_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "nkt_log_card_id_created_at_idx" ON "nkt_log" ("card_id", "created_at" DESC);
CREATE INDEX "nkt_log_created_at_idx" ON "nkt_log" ("created_at");

ALTER TABLE "nkt_log"
  ADD CONSTRAINT "nkt_log_card_id_fkey"
    FOREIGN KEY ("card_id") REFERENCES "nkt_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
