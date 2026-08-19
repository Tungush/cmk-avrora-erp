-- 09_COSTING_AND_STAGES.md, шаг 3: партии материалов и карантин цен.
-- Аддитивно: справочные цены продолжают работать как фолбэк.

CREATE TYPE "BatchOrigin" AS ENUM ('LOCAL', 'ONEC');
CREATE TYPE "PriceSource" AS ENUM (
  'FIFO_STOCK', 'SPECIFIC_BATCH', 'WEIGHTED_AVG', 'LAST_PURCHASE', 'PRICE_LIST', 'MANUAL'
);

CREATE TABLE "material_batches" (
  "id"                    UUID          NOT NULL DEFAULT gen_random_uuid(),
  "material_id"           UUID          NOT NULL,
  "receipt_date"          DATE          NOT NULL,
  "unit_price"            DECIMAL(14,2) NOT NULL,
  "qty_received"          DECIMAL(14,3) NOT NULL,
  "qty_remaining"         DECIMAL(14,3) NOT NULL,
  "supplier_name"         VARCHAR(200),
  "document_number"       VARCHAR(50),
  "source_movement_id"    UUID,
  "origin"                "BatchOrigin" NOT NULL DEFAULT 'LOCAL',
  "external_id"           VARCHAR(64),
  "price_anomaly"         BOOLEAN       NOT NULL DEFAULT false,
  "anomaly_factor"        DECIMAL(10,2),
  "anomaly_cleared_at"    TIMESTAMP(3),
  "anomaly_cleared_by_id" UUID,
  "created_at"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "material_batches_pkey" PRIMARY KEY ("id")
);

-- Идемпотентность приёма из 1С: повторная обработка того же документа
-- не создаёт вторую партию
CREATE UNIQUE INDEX "material_batches_source_movement_id_key"
  ON "material_batches" ("source_movement_id");
CREATE INDEX "material_batches_material_id_receipt_date_idx"
  ON "material_batches" ("material_id", "receipt_date");
CREATE INDEX "material_batches_material_id_price_anomaly_idx"
  ON "material_batches" ("material_id", "price_anomaly");

ALTER TABLE "material_batches"
  ADD CONSTRAINT "material_batches_material_id_fkey"
  FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- Наполнение из истории приходов делает сервис (POST /material-batches/backfill):
-- детектор аномалий должен идти по возрастанию даты и сравнивать цену только
-- с уже проверенными партиями, а это последовательная логика, не одна UPDATE.
