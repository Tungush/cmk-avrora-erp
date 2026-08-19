-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "customer_id" UUID NOT NULL,
    "article_id" UUID,
    "manager_id" UUID,
    "qty_ordered" DECIMAL(12,2) NOT NULL,
    "qty_shipped" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount_ordered" DECIMAL(14,2) NOT NULL,
    "amount_paid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" VARCHAR(30) NOT NULL,
    "period_key" VARCHAR(10),
    "shipment_date" DATE,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_documents" (
    "id" UUID NOT NULL,
    "doc_number" VARCHAR(30) NOT NULL,
    "supplier_name" TEXT NOT NULL,
    "buyer_id" UUID,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(5) NOT NULL DEFAULT 'KZT',
    "category" VARCHAR(30),

    CONSTRAINT "supplier_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deals_customer_id_idx" ON "deals"("customer_id");

-- CreateIndex
CREATE INDEX "deals_article_id_idx" ON "deals"("article_id");

-- CreateIndex
CREATE INDEX "deals_manager_id_idx" ON "deals"("manager_id");

-- CreateIndex
CREATE INDEX "deals_source_status_idx" ON "deals"("source", "status");

-- CreateIndex
CREATE INDEX "deals_period_key_idx" ON "deals"("period_key");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_documents_doc_number_key" ON "supplier_documents"("doc_number");

-- CreateIndex
CREATE INDEX "supplier_documents_buyer_id_idx" ON "supplier_documents"("buyer_id");

-- CreateIndex
CREATE INDEX "supplier_documents_category_idx" ON "supplier_documents"("category");

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
