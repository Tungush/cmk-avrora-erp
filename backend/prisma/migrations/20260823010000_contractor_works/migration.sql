-- Отметка работ: «норматив молчит, подряд говорит» (решение 23.08.2026).
--
-- Три модели описывали одно событие «кто-то поработал на переделе»:
--   order_labor_assignments — план исполнения (включая штат), без API и UI
--   contractor_work_logs    — поденный факт подряда
--   production_stages.actual_hours — часы, которые экран цеха не заполнял
--
-- Теперь штат не хранится вовсе: норма изделия (routing_operations) — это
-- и есть план штата, а остаток объёма (1 − Σ доля подряда) достаётся ему
-- автоматически. Руками заводится только исключение — подряд.

CREATE TABLE "contractor_works" (
  "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
  "order_id"        UUID           NOT NULL,
  -- NULL — передел заказа целиком (режим ORDER)
  "order_line_id"   UUID,
  "routing_stage"   "RoutingStage" NOT NULL,
  "contractor_id"   UUID           NOT NULL,
  -- 1 — весь передел; 0.6 — вместе со штатом
  "share"           DECIMAL(6,4)   NOT NULL DEFAULT 1,
  "rate_type"       "RateType"     NOT NULL,
  "rate"            DECIMAL(14,2)  NOT NULL,
  -- Факт в единицах СВОЕЙ ставки; NULL — работа ещё не принята
  "actual_qty"      DECIMAL(12,3),
  "actual_workers"  INTEGER,
  -- Заморожена при приёмке: ставка потом может смениться
  "actual_amount"   DECIMAL(14,2),
  "work_location"   "WorkLocation" NOT NULL DEFAULT 'CONTRACTOR_SITE',
  "planned_hours"   DECIMAL(10,3),
  "decided_by_id"   UUID,
  "decided_at"      TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason"          TEXT,
  "accepted_by_id"  UUID,
  "accepted_at"     TIMESTAMP(3),
  "contract_doc_id" UUID,
  "note"            TEXT,
  CONSTRAINT "contractor_works_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contractor_works_order_id_routing_stage_idx"  ON "contractor_works" ("order_id", "routing_stage");
CREATE INDEX "contractor_works_contractor_id_decided_at_idx" ON "contractor_works" ("contractor_id", "decided_at");

ALTER TABLE "contractor_works"
  ADD CONSTRAINT "contractor_works_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "contractor_works_order_line_id_fkey"
    FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "contractor_works_contractor_id_fkey"
    FOREIGN KEY ("contractor_id") REFERENCES "contractors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Переливка. Порядок важен: план задаёт долю передела, факт её не переопределяет.
-- ---------------------------------------------------------------------------

-- 1. План исполнения. Штатные строки НЕ переносятся: штат теперь и есть
--    умолчание, хранить его строкой больше не нужно.
INSERT INTO "contractor_works" (
  "order_id", "order_line_id", "routing_stage", "contractor_id",
  "share", "rate_type", "rate", "work_location", "planned_hours",
  "decided_at", "contract_doc_id", "note"
)
SELECT
  a."order_id", a."order_line_id", a."stage", a."contractor_id",
  a."share", a."rate_type", a."rate",
  -- булев countInShopHours → енум workLocation
  CASE WHEN a."count_in_shop_hours" THEN 'OUR_SHOP'::"WorkLocation"
       ELSE 'CONTRACTOR_SITE'::"WorkLocation" END,
  a."planned_hours", a."created_at", a."contract_doc_id", a."note"
FROM "order_labor_assignments" a
WHERE a."laborKind" = 'CONTRACTOR' AND a."contractor_id" IS NOT NULL;

-- 2. Поденный журнал СХЛОПЫВАЕТСЯ в факт одной строки: три записи по
--    40/40/32 ч — это не три подрядчика на переделе, а один, отработавший 112 ч.
--    Доля из журнала не берётся: там она всегда «весь объём за этот день».
WITH agg AS (
  SELECT
    l."order_id", l."stage", l."contractor_id",
    SUM(l."quantity")  AS qty,
    SUM(l."amount")    AS amount,
    MAX(l."workers")   AS workers,
    MAX(l."work_date") AS last_day,
    MIN(l."created_at") AS first_entry,
    MIN(l."rate_type"::text) AS rate_type,
    MAX(l."rate")      AS rate
  FROM "contractor_work_logs" l
  GROUP BY l."order_id", l."stage", l."contractor_id"
)
-- 2a. Факт ложится на существующую строку плана
UPDATE "contractor_works" w
SET "actual_qty"     = agg.qty,
    "actual_amount"  = agg.amount,
    "actual_workers" = NULLIF(agg.workers, 0),
    "accepted_at"    = agg.last_day
FROM agg
WHERE w."order_id" = agg."order_id"
  AND w."routing_stage" = agg."stage"
  AND w."contractor_id" = agg."contractor_id"
  AND w."order_line_id" IS NULL;

-- 2b. Факт без плана — новая строка на весь передел
INSERT INTO "contractor_works" (
  "order_id", "routing_stage", "contractor_id", "share",
  "rate_type", "rate", "actual_qty", "actual_amount", "actual_workers",
  "work_location", "decided_at", "accepted_at"
)
SELECT
  agg."order_id", agg."stage", agg."contractor_id", 1,
  agg.rate_type::"RateType", agg.rate, agg.qty, agg.amount, NULLIF(agg.workers, 0),
  COALESCE(c."default_work_location", 'CONTRACTOR_SITE'::"WorkLocation"),
  agg.first_entry, agg.last_day
FROM (
  SELECT
    l."order_id", l."stage", l."contractor_id",
    SUM(l."quantity") AS qty, SUM(l."amount") AS amount, MAX(l."workers") AS workers,
    MAX(l."work_date") AS last_day, MIN(l."created_at") AS first_entry,
    MIN(l."rate_type"::text) AS rate_type, MAX(l."rate") AS rate
  FROM "contractor_work_logs" l
  GROUP BY l."order_id", l."stage", l."contractor_id"
) agg
LEFT JOIN "contractors" c ON c."id" = agg."contractor_id"
WHERE NOT EXISTS (
  SELECT 1 FROM "contractor_works" w
  WHERE w."order_id" = agg."order_id"
    AND w."routing_stage" = agg."stage"
    AND w."contractor_id" = agg."contractor_id"
    AND w."order_line_id" IS NULL
);

DROP TABLE "order_labor_assignments";
DROP TABLE "contractor_work_logs";

-- Нормы труда есть не у всех изделий (485 артикулов из 2 160). Раньше такой
-- заказ тихо считался бесплатным по труду — теперь калькуляция это признаёт.
ALTER TABLE "order_costings"
  ADD COLUMN "has_missing_norm" BOOLEAN NOT NULL DEFAULT false;
