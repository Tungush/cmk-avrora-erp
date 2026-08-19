-- 09_COSTING_AND_STAGES.md, шаг 8: три контура контроля имён номенклатуры.
-- Опорный факт: 82 группы дублей в справочнике при двух заявках на
-- номенклатуру за всё время.

CREATE TYPE "AliasSource" AS ENUM ('REQUEST', 'ONEC', 'EXCEL', 'SUPPLIER', 'SEARCH_MISS', 'MANUAL');

-- Заявка не закрывается сама и не теряется молча
ALTER TYPE "NomenclatureRequestStatus" ADD VALUE IF NOT EXISTS 'WAITING_1C';
ALTER TYPE "NomenclatureRequestStatus" ADD VALUE IF NOT EXISTS 'SYNCED';

ALTER TABLE "nomenclature_requests"
  ADD COLUMN "onec_code"          VARCHAR(50),
  ADD COLUMN "onec_name"          TEXT,
  ADD COLUMN "onec_guid"          VARCHAR(64),
  ADD COLUMN "onec_unit"          VARCHAR(10),
  ADD COLUMN "linked_material_id" UUID,
  ADD COLUMN "synced_at"          TIMESTAMP(3),
  ADD COLUMN "sla_due_at"         TIMESTAMP(3);

-- Все имена, под которыми материал известен людям.
-- Формулировка автора заявки живёт здесь вечно: помнить имя из 1С не нужно.
CREATE TABLE "material_aliases" (
  "id"            UUID          NOT NULL DEFAULT gen_random_uuid(),
  "material_id"   UUID          NOT NULL,
  "alias"         TEXT          NOT NULL,
  -- Нормализация обрабатывает числа отдельно от текста: наивная склеила бы
  -- «5х2,5» с «5х25» и предложила слить два разных кабеля
  "normalized"    TEXT          NOT NULL,
  "source"        "AliasSource" NOT NULL DEFAULT 'MANUAL',
  "valid_from"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "valid_to"      TIMESTAMP(3),
  "created_by_id" UUID,
  "created_at"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "material_aliases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "material_aliases_material_id_normalized_key"
  ON "material_aliases" ("material_id", "normalized");
CREATE INDEX "material_aliases_normalized_idx" ON "material_aliases" ("normalized");

ALTER TABLE "material_aliases"
  ADD CONSTRAINT "material_aliases_material_id_fkey"
  FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- Запрос, не давший результата. Если человек через минуту открыл нужный
-- материал, связка «запрос → материал» становится новым алиасом.
CREATE TABLE "search_misses" (
  "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
  "query"                TEXT         NOT NULL,
  "normalized"           TEXT         NOT NULL,
  "user_id"              UUID,
  "resolved_material_id" UUID,
  "resolved_at"          TIMESTAMP(3),
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "search_misses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "search_misses_normalized_idx" ON "search_misses" ("normalized");
CREATE INDEX "search_misses_resolved_material_id_idx" ON "search_misses" ("resolved_material_id");
