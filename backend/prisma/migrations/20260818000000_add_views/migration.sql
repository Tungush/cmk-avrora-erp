-- Migration: Add SQL Views for computed lists (CASCADE recalculation)
-- Date: 2026-08-18
-- Description: Creates views for procurement_needed, customer_debts, supplier_debts,
--              stock_summary, and min_stock_readiness

-- View 1: v_procurement_needed — what to buy
CREATE OR REPLACE VIEW v_procurement_needed AS
SELECT
    pr.id AS purchase_request_id,
    pr.material_id,
    m.material_code,
    m.name AS material_name,
    m.category,
    m.unit,
    m.stock_qty,
    pr.requested_qty,
    m.purchase_price,
    ROUND((pr.requested_qty * m.purchase_price)::numeric, 2) AS purchase_amount,
    pr.status AS purchase_request_status,
    pr.created_at
FROM purchase_requests pr
JOIN materials m ON pr.material_id = m.id
WHERE pr.status IN ('DRAFT', 'APPROVED', 'ORDERED');

-- View 2: v_customer_debts — who owes what
-- Агрегаты считаются независимыми подзапросами: JOIN заказов и ДО в одной
-- выборке перемножал суммы (fan-out), пока payment_documents были пустыми —
-- баг был невидим.
CREATE OR REPLACE VIEW v_customer_debts AS
SELECT
    c.id AS customer_id,
    c.name AS customer_name,
    c.bin_iin,
    c.customer_type,
    c.region,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS total_orders,
    (SELECT COUNT(*) FROM payment_documents pd WHERE pd.contractor_id = c.id) AS total_payment_docs,
    COALESCE((SELECT SUM(ol.balance_due) FROM order_lines ol
              JOIN orders o ON o.id = ol.order_id WHERE o.customer_id = c.id), 0) AS total_balance_due,
    COALESCE((SELECT SUM(pd.unpaid_amount) FROM payment_documents pd
              WHERE pd.contractor_id = c.id), 0) AS total_unpaid_amount,
    COALESCE((SELECT SUM(pd.paid_amount) FROM payment_documents pd
              WHERE pd.contractor_id = c.id), 0) AS total_paid_amount,
    COALESCE((SELECT SUM(ROUND((ol.qty * ol.unit_price * (1 + 0.12))::numeric, 2))
              FROM order_lines ol JOIN orders o ON o.id = ol.order_id
              WHERE o.customer_id = c.id), 0) AS total_order_value_vat
FROM customers c;

-- View 3: v_supplier_debts — who we owe
CREATE OR REPLACE VIEW v_supplier_debts AS
SELECT
    sd.id AS supplier_document_id,
    sd.doc_number,
    sd.supplier_name,
    sd.category,
    sd.currency,
    sd.total_amount,
    sd.paid_amount,
    sd.total_amount - sd.paid_amount AS unpaid_amount,
    sd.buyer_id,
    e.name AS buyer_name,
    e.department AS buyer_department
FROM supplier_documents sd
LEFT JOIN employees e ON sd.buyer_id = e.id
ORDER BY unpaid_amount DESC;

-- View 4: v_stock_summary — current stock state
CREATE OR REPLACE VIEW v_stock_summary AS
SELECT
    m.id AS material_id,
    m.material_code,
    m.name AS material_name,
    m.category,
    m.unit,
    m.unit_weight_kg,
    m.purchase_price,
    m.price_list_price,
    m.stock_qty,
    m.purchase_price_updated_at,
    COALESCE(SUM(msm.qty), 0) AS total_movement_qty
FROM materials m
LEFT JOIN material_stock_movements msm ON m.id = msm.item_id
GROUP BY m.id, m.material_code, m.name, m.category, m.unit, m.unit_weight_kg,
         m.purchase_price, m.price_list_price, m.stock_qty, m.purchase_price_updated_at
ORDER BY m.stock_qty DESC;

-- View 5: v_min_stock_readiness — readiness by article
CREATE OR REPLACE VIEW v_min_stock_readiness AS
SELECT
    a.id AS article_id,
    a.article_code,
    a.name AS article_name,
    a.approved_price,
    a.spec_price,
    a.price_deviation_pct,
    a.lead_time_days,
    a.pallet_capacity,
    COALESCE(msl.target_qty, 0) AS target_qty,
    COALESCE(msl.actual_qty, 0) AS actual_qty,
    COALESCE(msl.deficit_qty, 0) AS deficit_qty,
    COALESCE(msl.readiness_pct, 0) AS readiness_pct,
    COALESCE(fgm.total_in_stock, 0) AS finished_goods_in_stock
FROM articles a
LEFT JOIN min_stock_levels msl ON a.id = msl.article_id
LEFT JOIN (
    SELECT
        f.item_id,
        SUM(f.qty) AS total_in_stock
    FROM finished_goods_movements f
    WHERE f.movement_type = 'приход'
    GROUP BY f.item_id
) fgm ON fgm.item_id = a.id
ORDER BY readiness_pct DESC;