-- CreateEnum
CREATE TYPE "MaterialCategory" AS ENUM ('╨Ш╨╜╤Б╤В╤А╤Г╨╝╨╡╨╜╤В╤Л', '╨Ь╨╡╤В╨░╨╗╨╗', '╨Ь╨╡╤В╨╕╨╖╤Л', '╨Ъ╨╛╨╝╨┐╨╗╨╡╨║╤В╤Г╤О╤Й╨╕╨╡', '╨а╨░╤Б╤Е╨╛╨┤╨╜╨╕╨║╨╕');

-- CreateEnum
CREATE TYPE "OperationType" AS ENUM ('╤А╨╡╨╖╨║╨░', '╤Б╨▒╨╛╤А╨║╨░/╤Б╨▓╨░╤А╨║╨░', '╨╛╨▒╤И╨╕╨▓╨║╨░', '╨┐╨╛╨║╤А╨░╤Б╨║╨░');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('╨Т╨╜╨╡╤И╨╜╨╕╨╣', '╨Т╨╜╤Г╤В╤А╨╡╨╜╨╜╨╕╨╣');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('╨д╨Ч', '╨Т╨Ч');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentDocStatus" AS ENUM ('╨Э╨╡ ╨╛╨┐╨╗╨░╤З╨╡╨╜', '╨з╨░╤Б╤В╨╕╤З╨╜╨╛ ╨╛╨┐╨╗╨░╤З╨╡╨╜', '╨Ю╨┐╨╗╨░╤З╨╡╨╜╨╛', '╨Ш╤Б╨┐╨╛╨╗╨╜╨╡╨╜');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('╨┐╤А╨╕╤Е╨╛╨┤', '╤А╨░╤Б╤Е╨╛╨┤', '╨▓_╨┐╤А╨╛╨╕╨╖╨▓╨╛╨┤╤Б╤В╨▓╨╛', '╤Б_╨┐╤А╨╛╨╕╨╖╨▓╨╛╨┤╤Б╤В╨▓╨░', '╨▓╨╛╨╖╨▓╤А╨░╤В', '╨║╨╛╤А╤А╨╡╨║╤Ж╨╕╤П');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('WEEK', 'MONTH', 'QUARTER');

-- CreateEnum
CREATE TYPE "StageCode" AS ENUM ('╨Ю╨б_╤Б_╨╖╨░╨║╨░╨╖╤З╨╕╨║╨╛╨╝', '╨Ю╨▒╤Й╨╕╨╣_╨▓╨╕╨┤', '╨з╨╡╤А╤В╨╡╨╢╨╕', '╨Ч╨░╨║╤Г╨┐', '╨а╨╡╨╖╨║╨░', '╨б╨▒╨╛╤А╨║╨░_╤Б╨▓╨░╤А╨║╨░', '╨Я╨╛╨║╤А╨░╤Б╨║╨░', '╨Ю╨▒╤И╨╕╨▓╨║╨░');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('not_started', 'in_progress', 'done');

-- CreateEnum
CREATE TYPE "PurchaseRequestStatus" AS ENUM ('DRAFT', 'APPROVED', 'ORDERED', 'REJECTED');

-- CreateTable
CREATE TABLE "articles" (
    "id" UUID NOT NULL,
    "article_code" VARCHAR(20) NOT NULL,
    "legacy_code" VARCHAR(20),
    "name" TEXT NOT NULL,
    "weight_kg" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "series" VARCHAR(10),
    "description" TEXT,
    "approved_price" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "spec_price" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "price_deviation_pct" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "lead_time_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "pallet_capacity" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "valid_from" DATE NOT NULL,
    "changed_by" UUID NOT NULL,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "materials" (
    "id" UUID NOT NULL,
    "material_code" VARCHAR(20) NOT NULL,
    "category" "MaterialCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "unit" VARCHAR(10) NOT NULL,
    "unit_weight_kg" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "purchase_price" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "purchase_price_updated_at" DATE,
    "price_list_price" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "stock_qty" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_items" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "qty_per_unit" DECIMAL(12,4) NOT NULL,
    "operation_type" "OperationType" NOT NULL,
    "labor_hours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "line_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "bom_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "bin_iin" VARCHAR(20) NOT NULL,
    "region" VARCHAR(50),
    "customer_type" "CustomerType" NOT NULL DEFAULT '╨Т╨╜╨╡╤И╨╜╨╕╨╣',

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_number" VARCHAR(30) NOT NULL,
    "customer_id" UUID NOT NULL,
    "region" VARCHAR(50),
    "manager_id" UUID,
    "order_type" "OrderType" NOT NULL,
    "bitrix_deal_id" VARCHAR(50),
    "bitrix_stage" VARCHAR(50),
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "planned_shipment_date" DATE,
    "actual_shipment_date" DATE,
    "overdue_days" INTEGER NOT NULL DEFAULT 0,
    "request_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "unit" VARCHAR(10) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "line_total_vat" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "prepayment" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "post_payment_1" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "post_payment_2" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "penalty" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance_due" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reserved_qty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "shipped_qty" DECIMAL(12,3) NOT NULL DEFAULT 0,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_documents" (
    "id" UUID NOT NULL,
    "do_number" VARCHAR(30) NOT NULL,
    "do_date" DATE,
    "contractor_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'KZT',
    "total_amount" DECIMAL(14,2) NOT NULL,
    "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unpaid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "category" VARCHAR(30),
    "status" "PaymentDocStatus" NOT NULL DEFAULT '╨Э╨╡ ╨╛╨┐╨╗╨░╤З╨╡╨╜',
    "order_id" UUID,

    CONSTRAINT "payment_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "payment_document_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "payment_date" DATE NOT NULL,
    "payment_type" VARCHAR(30),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acceptance_acts" (
    "id" UUID NOT NULL,
    "app_number" VARCHAR(30) NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "act_date" DATE NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "acceptance_acts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_stock_movements" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "movement_type" "StockMovementType" NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "movement_date" DATE NOT NULL,
    "project" VARCHAR(50),
    "source_document_id" UUID,

    CONSTRAINT "material_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_movements" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "movement_type" "StockMovementType" NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "movement_date" DATE NOT NULL,
    "project" VARCHAR(50),
    "source_document_id" UUID,

    CONSTRAINT "finished_goods_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "min_stock_levels" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "period_months" DECIMAL(6,3) NOT NULL DEFAULT 0.517,
    "target_qty" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "actual_qty" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deficit_qty" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "readiness_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,

    CONSTRAINT "min_stock_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_requests" (
    "id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "requested_qty" DECIMAL(14,3) NOT NULL,
    "status" "PurchaseRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_plan_items" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "period_type" "PeriodType" NOT NULL,
    "period_key" VARCHAR(10) NOT NULL,
    "qty_from_orders" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "qty_min_stock" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "qty_reserved" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "qty_in_stock" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "qty_to_produce" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "production_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_stages" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "stage_code" "StageCode" NOT NULL,
    "status" "StageStatus" NOT NULL DEFAULT 'not_started',
    "completed_at" TIMESTAMP(3),
    "completed_by_id" UUID,
    "defect_photo_url" TEXT,

    CONSTRAINT "production_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_calendar_days" (
    "date" DATE NOT NULL,
    "week_number" INTEGER NOT NULL,
    "is_working_day" BOOLEAN NOT NULL,
    "cumulative_working_day_no" INTEGER NOT NULL,

    CONSTRAINT "work_calendar_days_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" VARCHAR(50),
    "department" VARCHAR(50),
    "telegram_id" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(100) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "employee_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "user_id" UUID,
    "user_role" VARCHAR(50),
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comment" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "articles_article_code_key" ON "articles"("article_code");

-- CreateIndex
CREATE UNIQUE INDEX "materials_material_code_key" ON "materials"("material_code");

-- CreateIndex
CREATE UNIQUE INDEX "bom_items_article_id_material_id_operation_type_key" ON "bom_items"("article_id", "material_id", "operation_type");

-- CreateIndex
CREATE UNIQUE INDEX "customers_bin_iin_key" ON "customers"("bin_iin");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "payment_documents_do_number_key" ON "payment_documents"("do_number");

-- CreateIndex
CREATE UNIQUE INDEX "acceptance_acts_app_number_key" ON "acceptance_acts"("app_number");

-- CreateIndex
CREATE UNIQUE INDEX "min_stock_levels_article_id_key" ON "min_stock_levels"("article_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_plan_items_article_id_period_type_period_key_key" ON "production_plan_items"("article_id", "period_type", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "production_stages_order_id_stage_code_key" ON "production_stages"("order_id", "stage_code");

-- CreateIndex
CREATE UNIQUE INDEX "employees_telegram_id_key" ON "employees"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_documents" ADD CONSTRAINT "payment_documents_contractor_id_fkey" FOREIGN KEY ("contractor_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_documents" ADD CONSTRAINT "payment_documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_document_id_fkey" FOREIGN KEY ("payment_document_id") REFERENCES "payment_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acceptance_acts" ADD CONSTRAINT "acceptance_acts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acceptance_acts" ADD CONSTRAINT "acceptance_acts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_stock_movements" ADD CONSTRAINT "material_stock_movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_movements" ADD CONSTRAINT "finished_goods_movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "articles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "min_stock_levels" ADD CONSTRAINT "min_stock_levels_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_items" ADD CONSTRAINT "production_plan_items_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stages" ADD CONSTRAINT "production_stages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stages" ADD CONSTRAINT "production_stages_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

