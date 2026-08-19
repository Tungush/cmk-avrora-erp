-- 09_COSTING_AND_STAGES.md, шаги 6, 4 и 7: подряд, калькуляция заказа
-- как версионируемый документ и факторный разбор разницы.
-- Аддитивно: ArticleCosting остаётся как есть.

CREATE TYPE "LaborKind"     AS ENUM ('STAFF', 'CONTRACTOR');
CREATE TYPE "RateType"      AS ENUM ('PER_HOUR', 'PER_UNIT', 'PER_KG', 'PER_TON', 'FIXED');
CREATE TYPE "WorkLocation"  AS ENUM ('OUR_SHOP', 'CONTRACTOR_SITE');
CREATE TYPE "CostingStatus" AS ENUM ('DRAFT', 'APPROVED', 'ARCHIVED');

-- ============================================================
-- Шаг 6. Подряд
-- ============================================================

CREATE TABLE "contractors" (
  "id"                    UUID           NOT NULL DEFAULT gen_random_uuid(),
  "name"                  TEXT           NOT NULL,
  "bin_iin"               VARCHAR(20),
  -- Дефолт «за штуку»: вес заполнен у 70 артикулов из 2 161, весовые ставки
  -- по умолчанию давали бы ноль на 97 % изделий
  "default_rate_type"     "RateType"     NOT NULL DEFAULT 'PER_UNIT',
  "default_rate"          DECIMAL(14,2)  NOT NULL DEFAULT 0,
  "default_work_location" "WorkLocation" NOT NULL DEFAULT 'CONTRACTOR_SITE',
  "is_active"             BOOLEAN        NOT NULL DEFAULT true,
  "notes"                 TEXT,
  "created_at"            TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contractors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "contractors_bin_iin_key" ON "contractors" ("bin_iin");

CREATE TABLE "order_labor_assignments" (
  "id"                  UUID           NOT NULL DEFAULT gen_random_uuid(),
  "order_id"            UUID           NOT NULL,
  "order_line_id"       UUID,
  "article_id"          UUID,
  "stage"               "RoutingStage" NOT NULL,
  "labor_kind"          "LaborKind"    NOT NULL,
  "work_center_id"      UUID,
  "contractor_id"       UUID,
  "share"               DECIMAL(6,4)   NOT NULL DEFAULT 1,
  "rate_type"           "RateType"     NOT NULL DEFAULT 'PER_UNIT',
  "rate"                DECIMAL(14,2)  NOT NULL DEFAULT 0,
  "count_in_shop_hours" BOOLEAN        NOT NULL DEFAULT true,
  "planned_hours"       DECIMAL(10,3),
  "actual_hours"        DECIMAL(10,3),
  "contract_doc_id"     UUID,
  "note"                TEXT,
  "created_at"          TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3)   NOT NULL,
  CONSTRAINT "order_labor_assignments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "order_labor_assignments_order_id_stage_idx" ON "order_labor_assignments" ("order_id", "stage");
CREATE INDEX "order_labor_assignments_order_line_id_idx" ON "order_labor_assignments" ("order_line_id");

ALTER TABLE "order_labor_assignments"
  ADD CONSTRAINT "order_labor_assignments_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "order_labor_assignments_order_line_id_fkey"
    FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "order_labor_assignments_work_center_id_fkey"
    FOREIGN KEY ("work_center_id") REFERENCES "work_centers"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  ADD CONSTRAINT "order_labor_assignments_contractor_id_fkey"
    FOREIGN KEY ("contractor_id") REFERENCES "contractors"("id") ON UPDATE CASCADE ON DELETE SET NULL;

-- ============================================================
-- Шаг 4. Калькуляция заказа как документ
-- ============================================================

CREATE TABLE "order_costings" (
  "id"              UUID            NOT NULL DEFAULT gen_random_uuid(),
  "order_id"        UUID            NOT NULL,
  "order_line_id"   UUID            NOT NULL,
  "article_id"      UUID,
  "qty"             DECIMAL(12,3)   NOT NULL,
  "version"         INTEGER         NOT NULL,
  "status"          "CostingStatus" NOT NULL DEFAULT 'DRAFT',
  "calculated_at"   TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_at"     TIMESTAMP(3),
  "approved_by_id"  UUID,
  "created_by_id"   UUID,
  "base_costing_id" UUID,

  -- замороженные коэффициенты: справочник потом может меняться сколько угодно
  "hourly_rate"     DECIMAL(12,2)   NOT NULL,
  "logistics_pct"   DECIMAL(6,4)    NOT NULL,
  "logistics_mode"  "LogisticsMode" NOT NULL DEFAULT 'PERCENT_OF_MATERIAL',
  "logistics_fixed" DECIMAL(14,2)   NOT NULL DEFAULT 0,
  "logistics_per_kg" DECIMAL(14,2)  NOT NULL DEFAULT 0,
  "utilities_pct"   DECIMAL(6,4)    NOT NULL,
  "margin_pct"      DECIMAL(6,4)    NOT NULL,
  "margin_mode"     "MarginMode"    NOT NULL DEFAULT 'MARGIN',
  "vat_pct"         DECIMAL(6,4)    NOT NULL DEFAULT 0.12,
  "rates_source"    VARCHAR(10)     NOT NULL DEFAULT 'config',
  "rates_reason"    TEXT,

  "material_cost"   DECIMAL(14,2)   NOT NULL,
  "labor_cost"      DECIMAL(14,2)   NOT NULL,
  "contractor_cost" DECIMAL(14,2)   NOT NULL DEFAULT 0,
  "logistics_cost"  DECIMAL(14,2)   NOT NULL,
  "utilities_cost"  DECIMAL(14,2)   NOT NULL,
  "total_cost"      DECIMAL(14,2)   NOT NULL,
  "margin"          DECIMAL(14,2)   NOT NULL,
  "price"           DECIMAL(14,2)   NOT NULL,
  "total_man_hours" DECIMAL(10,3)   NOT NULL DEFAULT 0,
  "has_shortage"    BOOLEAN         NOT NULL DEFAULT false,
  "note"            TEXT,
  CONSTRAINT "order_costings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_costings_order_line_id_version_key" ON "order_costings" ("order_line_id", "version");
CREATE INDEX "order_costings_order_id_status_idx" ON "order_costings" ("order_id", "status");

ALTER TABLE "order_costings"
  ADD CONSTRAINT "order_costings_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "order_costings_order_line_id_fkey"
    FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON UPDATE CASCADE ON DELETE CASCADE;

CREATE TABLE "order_costing_materials" (
  "id"                     UUID          NOT NULL DEFAULT gen_random_uuid(),
  "costing_id"             UUID          NOT NULL,
  "material_id"            UUID,
  -- Имя копируется: переименование в 1С не должно менять согласованную калькуляцию
  "material_code_snapshot" VARCHAR(20),
  "material_name_snapshot" TEXT          NOT NULL,
  "qty_per_unit"           DECIMAL(12,4) NOT NULL,
  "qty_total"              DECIMAL(14,3) NOT NULL,
  "unit_price"             DECIMAL(14,2) NOT NULL,
  "line_cost"              DECIMAL(14,2) NOT NULL,
  "price_source"           "PriceSource" NOT NULL DEFAULT 'FIFO_STOCK',
  -- Ссылка на партию и приход: без них через месяц не ответить «почему дороже»
  "batch_id"               UUID,
  "source_document_id"     UUID,
  "price_date"             DATE,
  "allocations"            JSONB,
  "is_shortage"            BOOLEAN       NOT NULL DEFAULT false,
  "shortage_qty"           DECIMAL(14,3) NOT NULL DEFAULT 0,
  "shortage_unit_price"    DECIMAL(14,2) NOT NULL DEFAULT 0,
  CONSTRAINT "order_costing_materials_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "order_costing_materials_costing_id_idx" ON "order_costing_materials" ("costing_id");
ALTER TABLE "order_costing_materials"
  ADD CONSTRAINT "order_costing_materials_costing_id_fkey"
  FOREIGN KEY ("costing_id") REFERENCES "order_costings"("id") ON UPDATE CASCADE ON DELETE CASCADE;

CREATE TABLE "order_costing_labor" (
  "id"                  UUID           NOT NULL DEFAULT gen_random_uuid(),
  "costing_id"          UUID           NOT NULL,
  "stage"               "RoutingStage" NOT NULL,
  "labor_kind"          "LaborKind"    NOT NULL,
  "work_center_id"      UUID,
  "contractor_id"       UUID,
  "share"               DECIMAL(6,4)   NOT NULL DEFAULT 1,
  "rate_type"           "RateType"     NOT NULL DEFAULT 'PER_HOUR',
  "rate"                DECIMAL(14,2)  NOT NULL,
  "count_in_shop_hours" BOOLEAN        NOT NULL DEFAULT true,
  "workers"             DECIMAL(6,2)   NOT NULL DEFAULT 0,
  "hours_per_unit"      DECIMAL(8,3)   NOT NULL DEFAULT 0,
  "man_hours"           DECIMAL(10,3)  NOT NULL DEFAULT 0,
  "line_cost"           DECIMAL(14,2)  NOT NULL,
  CONSTRAINT "order_costing_labor_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "order_costing_labor_costing_id_idx" ON "order_costing_labor" ("costing_id");
ALTER TABLE "order_costing_labor"
  ADD CONSTRAINT "order_costing_labor_costing_id_fkey"
    FOREIGN KEY ("costing_id") REFERENCES "order_costings"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "order_costing_labor_contractor_id_fkey"
    FOREIGN KEY ("contractor_id") REFERENCES "contractors"("id") ON UPDATE CASCADE ON DELETE SET NULL;
