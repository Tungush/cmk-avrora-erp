-- AlterTable orders
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "source_sheet" VARCHAR(100);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "source_row_number" INTEGER;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "raw_columns" JSONB;
CREATE INDEX IF NOT EXISTS "orders_source_sheet_idx" ON "orders"("source_sheet");

-- AlterTable order_lines
ALTER TABLE "order_lines" ALTER COLUMN "article_id" DROP NOT NULL;
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "source_sheet" VARCHAR(100);
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "source_row_number" INTEGER;
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "article_code_raw" VARCHAR(50);
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "product_name_raw" TEXT;
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "raw_columns" JSONB;
CREATE INDEX IF NOT EXISTS "order_lines_source_sheet_source_row_number_idx" ON "order_lines"("source_sheet", "source_row_number");

-- CreateTable spreadsheet_imports
CREATE TABLE IF NOT EXISTS "spreadsheet_imports" (
    "id" UUID NOT NULL,
    "source_file" TEXT NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_sheets" INTEGER NOT NULL DEFAULT 0,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(30) NOT NULL DEFAULT 'completed',
    "report" JSONB,
    CONSTRAINT "spreadsheet_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable spreadsheet_sheets
CREATE TABLE IF NOT EXISTS "spreadsheet_sheets" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "header_row" INTEGER NOT NULL DEFAULT 1,
    "col_count" INTEGER NOT NULL DEFAULT 0,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "headers" JSONB NOT NULL,
    "header_rows" JSONB,
    CONSTRAINT "spreadsheet_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable spreadsheet_rows
CREATE TABLE IF NOT EXISTS "spreadsheet_rows" (
    "id" UUID NOT NULL,
    "sheet_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "cells" JSONB NOT NULL,
    "data" JSONB NOT NULL,
    "is_empty" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "spreadsheet_rows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "spreadsheet_sheets_import_id_name_key" ON "spreadsheet_sheets"("import_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "spreadsheet_rows_sheet_id_row_number_key" ON "spreadsheet_rows"("sheet_id", "row_number");
CREATE INDEX IF NOT EXISTS "spreadsheet_rows_sheet_id_row_number_idx" ON "spreadsheet_rows"("sheet_id", "row_number");

ALTER TABLE "spreadsheet_sheets" DROP CONSTRAINT IF EXISTS "spreadsheet_sheets_import_id_fkey";
ALTER TABLE "spreadsheet_sheets" ADD CONSTRAINT "spreadsheet_sheets_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "spreadsheet_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "spreadsheet_rows" DROP CONSTRAINT IF EXISTS "spreadsheet_rows_sheet_id_fkey";
ALTER TABLE "spreadsheet_rows" ADD CONSTRAINT "spreadsheet_rows_sheet_id_fkey" FOREIGN KEY ("sheet_id") REFERENCES "spreadsheet_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
