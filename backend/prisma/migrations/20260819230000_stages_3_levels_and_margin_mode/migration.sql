-- 09_COSTING_AND_STAGES.md, шаги 1 и 2.
-- Шаг 1: этапы 8 → 3 с сохранением истории. Шаг 2: режимы маржи и логистики.

-- ============================================================
-- Шаг 2. Режимы маржи и логистики (аддитивно, ничего не ломает)
-- ============================================================

CREATE TYPE "MarginMode"    AS ENUM ('MARGIN', 'MARKUP');
CREATE TYPE "LogisticsMode" AS ENUM ('PERCENT_OF_MATERIAL', 'FIXED_AMOUNT', 'PER_KG');

ALTER TABLE "costing_configs"
  ADD COLUMN "margin_mode"              "MarginMode"    NOT NULL DEFAULT 'MARGIN',
  ADD COLUMN "logistics_mode"           "LogisticsMode" NOT NULL DEFAULT 'PERCENT_OF_MATERIAL',
  ADD COLUMN "logistics_fixed"          DECIMAL(14,2)   NOT NULL DEFAULT 0,
  ADD COLUMN "logistics_per_kg"         DECIMAL(14,2)   NOT NULL DEFAULT 0,
  ADD COLUMN "stage_tracking_threshold" INTEGER         NOT NULL DEFAULT 5;

-- Старые снимки считались наценкой 10 % — они и остаются MARKUP,
-- иначе объяснение прошлых цифр разъедется с самими цифрами.
ALTER TABLE "article_costings"
  ADD COLUMN "margin_mode"   "MarginMode"  NOT NULL DEFAULT 'MARKUP',
  ADD COLUMN "margin_pct"    DECIMAL(6,4)  NOT NULL DEFAULT 0,
  ADD COLUMN "logistics_pct" DECIMAL(6,4)  NOT NULL DEFAULT 0;

-- Восстанавливаем проценты из самих сумм: снимок становится самоописываемым
UPDATE "article_costings"
   SET "margin_pct" = ROUND("margin" / "total_cost", 4)
 WHERE "total_cost" > 0;
UPDATE "article_costings"
   SET "logistics_pct" = ROUND("logistics_cost" / "material_cost", 4)
 WHERE "material_cost" > 0;

-- Переход на маржу 35 % от цены — не правкой действующей записи, а новой
-- версией: расчёты, сделанные до сегодня, должны объясняться прежним конфигом.
UPDATE "costing_configs"
   SET "valid_to" = CURRENT_DATE
 WHERE "valid_to" IS NULL;

INSERT INTO "costing_configs" (
  "id", "valid_from", "valid_to", "hourly_rate", "logistics_pct", "utilities_pct",
  "vat_pct", "margin_pct", "payment_term_days", "welding_factor",
  "margin_mode", "logistics_mode", "logistics_fixed", "logistics_per_kg",
  "stage_tracking_threshold"
)
SELECT gen_random_uuid(), CURRENT_DATE, NULL, "hourly_rate", "logistics_pct", "utilities_pct",
       "vat_pct", 0.35, "payment_term_days", "welding_factor",
       'MARGIN', 'PERCENT_OF_MATERIAL', 0, 0, 5
  FROM "costing_configs"
 ORDER BY "valid_from" DESC
 LIMIT 1;

-- ============================================================
-- Шаг 1. Этапы: КД → Снабжение → Производство (три передела)
-- ============================================================

CREATE TYPE "OrderStageCode"    AS ENUM ('КД', 'Снабжение', 'Производство');
CREATE TYPE "StageTrackingMode" AS ENUM ('ORDER', 'LINE');

-- Полный снимок до преобразования: миграция обратима без восстановления из бэкапа
CREATE TABLE "production_stages_archive" AS
  SELECT *, now() AS "archived_at" FROM "production_stages";

ALTER TABLE "orders"
  ADD COLUMN "stage_tracking_mode" "StageTrackingMode" NOT NULL DEFAULT 'ORDER';

ALTER TABLE "production_stages"
  ADD COLUMN "order_line_id"     UUID,
  ADD COLUMN "routing_stage"     "RoutingStage",
  ADD COLUMN "actual_workers"    DECIMAL(6,2),
  ADD COLUMN "actual_hours"      DECIMAL(8,3),
  ADD COLUMN "legacy_stage_code" VARCHAR(30),
  ADD COLUMN "stage_code_new"    "OrderStageCode";

UPDATE "production_stages" SET "legacy_stage_code" = "stage_code"::text;

-- Продажные стадии уходят из этапов производства (09 §2.4).
-- Данные не теряются: они целиком лежат в production_stages_archive.
DELETE FROM "production_stages"
 WHERE "stage_code" IN ('ОС_с_заказчиком', 'Общий_вид');

UPDATE "production_stages" SET
  "stage_code_new" = CASE "stage_code"::text
    WHEN 'Чертежи' THEN 'КД'
    WHEN 'Закуп'   THEN 'Снабжение'
    ELSE 'Производство'
  END::"OrderStageCode",
  "routing_stage" = CASE "stage_code"::text
    WHEN 'Резка'         THEN 'резка'
    WHEN 'Сборка_сварка' THEN 'сборка/сварка/обшивка'
    WHEN 'Обшивка'       THEN 'сборка/сварка/обшивка'
    WHEN 'Покраска'      THEN 'зачистка/покраска'
    ELSE NULL
  END::"RoutingStage";

-- «Сборка_сварка» и «Обшивка» сливаются в один передел, как в «Спецификациях 2022».
-- Объединённый этап считается завершённым, только если завершены оба:
-- сборка done + обшивка not_started — это работа в процессе, а не готово.
WITH grp AS (
  SELECT "order_id", "stage_code_new", "routing_stage",
         MIN("id"::text) AS keep_id,
         CASE
           WHEN bool_and("status" = 'done')                          THEN 'done'
           WHEN bool_or("status" IN ('done', 'in_progress'))         THEN 'in_progress'
           ELSE 'not_started'
         END::"StageStatus" AS merged_status,
         MAX("completed_at") AS merged_completed_at,
         string_agg(DISTINCT "legacy_stage_code", '+' ORDER BY "legacy_stage_code") AS merged_legacy
    FROM "production_stages"
   GROUP BY "order_id", "stage_code_new", "routing_stage"
  HAVING count(*) > 1
)
UPDATE "production_stages" ps
   SET "status" = grp.merged_status,
       "completed_at" = CASE WHEN grp.merged_status = 'done' THEN grp.merged_completed_at END,
       "legacy_stage_code" = grp.merged_legacy
  FROM grp
 WHERE ps."id"::text = grp.keep_id;

DELETE FROM "production_stages" ps
 USING (
   SELECT "order_id", "stage_code_new", "routing_stage", MIN("id"::text) AS keep_id
     FROM "production_stages"
    GROUP BY "order_id", "stage_code_new", "routing_stage"
   HAVING count(*) > 1
 ) dup
 WHERE ps."order_id" = dup."order_id"
   AND ps."stage_code_new" IS NOT DISTINCT FROM dup."stage_code_new"
   AND ps."routing_stage" IS NOT DISTINCT FROM dup."routing_stage"
   AND ps."id"::text <> dup.keep_id;

ALTER TABLE "production_stages" DROP CONSTRAINT "production_stages_order_id_stage_code_key";
ALTER TABLE "production_stages" DROP COLUMN "stage_code";
ALTER TABLE "production_stages" RENAME COLUMN "stage_code_new" TO "stage_code";
ALTER TABLE "production_stages" ALTER COLUMN "stage_code" SET NOT NULL;

DROP TYPE "StageCode";

ALTER TABLE "production_stages"
  ADD CONSTRAINT "production_stages_order_line_id_fkey"
  FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- Обычный UNIQUE считает NULL-ы различными и пропустил бы два «Производство/Резка»
-- на одном заказе. Поэтому уникальность задана двумя частичными индексами.
CREATE UNIQUE INDEX "production_stages_order_scope_key"
  ON "production_stages" ("order_id", "stage_code", COALESCE("routing_stage"::text, ''))
  WHERE "order_line_id" IS NULL;

CREATE UNIQUE INDEX "production_stages_line_scope_key"
  ON "production_stages" ("order_id", "order_line_id", "stage_code", COALESCE("routing_stage"::text, ''))
  WHERE "order_line_id" IS NOT NULL;

CREATE INDEX "production_stages_order_id_stage_code_idx" ON "production_stages" ("order_id", "stage_code");
CREATE INDEX "production_stages_order_line_id_idx" ON "production_stages" ("order_line_id");

-- Режим отметки подставляется по числу позиций (порог 5 из CostingConfig)
UPDATE "orders" o
   SET "stage_tracking_mode" = 'LINE'
 WHERE (SELECT count(*) FROM "order_lines" ol WHERE ol."order_id" = o."id") > 5;
