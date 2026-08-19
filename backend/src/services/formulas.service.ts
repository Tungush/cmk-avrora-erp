/**
 * 02. Business Logic Formulas Service (CASCADE recalculation)
 * — добавлены: cascadeSpecUpdate, cascadePriceDeviation
 */

export interface BomItemCostInput {
  qtyPerUnit: number;
  purchasePrice: number;
}

export interface MinStockInput {
  baseNorm: number;
  correctionPct: number; // e.g. 0.10 for +10%
  actualQty: number;
}

export interface OrderDemandLineInput {
  qty: number;
  shippedQty: number;
  reservedQty: number;
}

export interface BalanceDueInput {
  qty: number;
  unitPrice: number;
  vatRate: number; // e.g. 0.12 for 12% VAT
  prepayment: number;
  postPayment1: number;
  postPayment2: number;
  penalty: number;
}

/**
 * 2.1 Specification Cost (articles.spec_price)
 * spec_price = SUM(qty_per_unit * material.purchase_price)
 */
export function calculateSpecPrice(bomItems: BomItemCostInput[]): number {
  const sum = bomItems.reduce((acc, item) => acc + item.qtyPerUnit * item.purchasePrice, 0);
  return Number(sum.toFixed(2));
}

/**
 * 2.13 CASCADE: Recalculate spec_price from BOM items
 * Returns { specPrice, priceDeviationPct, leadTimeDays }
 */
export function cascadeSpecUpdate(
  bomItems: BomItemCostInput[],
  approvedPrice: number,
  laborHours = 0
): { specPrice: number; priceDeviationPct: number | null; leadTimeDays: number } {
  const specPrice = calculateSpecPrice(bomItems);
  const priceDeviationPct = calculatePriceDeviationPct(approvedPrice, specPrice);
  const leadTimeDays = calculateLeadTimeDays(laborHours);
  return { specPrice, priceDeviationPct, leadTimeDays };
}

/**
 * 2.14 CASCADE: Recalculate price_deviation_pct after price change
 */
export function cascadePriceDeviation(approvedPrice: number, specPrice: number): number | null {
  return calculatePriceDeviationPct(approvedPrice, specPrice);
}

/**
 * 2.2 Price Deviation Percentage (articles.price_deviation_pct)
 * price_deviation_pct = approved_price / spec_price - 1
 */
export function calculatePriceDeviationPct(approvedPrice: number, specPrice: number): number | null {
  if (!approvedPrice || approvedPrice <= 0 || !specPrice || specPrice <= 0) {
    return null;
  }
  const deviation = approvedPrice / specPrice - 1;
  return Number(deviation.toFixed(4));
}

/**
 * 2.3 Lead Time in Days (articles.lead_time_days)
 * lead_time_days = CEIL(SUM(labor_hours for cutting, welding/assembly, cladding) / WORK_SHIFT_HOURS)
 */
export function calculateLeadTimeDays(totalLaborHours: number, workShiftHours = 8): number {
  if (totalLaborHours <= 0 || workShiftHours <= 0) return 0;
  return Math.ceil(totalLaborHours / workShiftHours);
}

/**
 * 2.4 Hourly Labor Cost & Plan Cost
 * hour_cost = payroll_fund_total / (employee_count * working_hours_per_month)
 */
export function calculateHourCost(
  payrollFundTotal: number,
  employeeCount: number,
  workingHoursPerMonth: number
): number {
  if (employeeCount <= 0 || workingHoursPerMonth <= 0) return 0;
  const cost = payrollFundTotal / (employeeCount * workingHoursPerMonth);
  return Number(cost.toFixed(2));
}

export function calculatePlanLaborCost(planLaborHoursTotal: number, hourCost: number): number {
  const cost = planLaborHoursTotal * hourCost;
  return Number(cost.toFixed(2));
}

/**
 * 2.6 Minimum Stock & Deficit calculation
 * target_qty = base_norm * (1 + correction_pct)
 * actual_qty = SUM(finished_goods_movements balance)
 * readiness_pct = MIN(actual_qty / target_qty, 1)
 * deficit_qty = MAX(target_qty - actual_qty, 0)
 */
export function calculateMinStockLevel(input: MinStockInput) {
  const targetQty = Number((input.baseNorm * (1 + input.correctionPct)).toFixed(2));
  const actualQty = Math.max(0, input.actualQty);
  
  let readinessPct = 0;
  if (targetQty > 0) {
    readinessPct = Number(Math.min(actualQty / targetQty, 1).toFixed(2));
  }
  
  const deficitQty = Number(Math.max(targetQty - actualQty, 0).toFixed(2));

  return {
    targetQty,
    actualQty,
    readinessPct,
    deficitQty,
  };
}

/**
 * 2.7 Demand from Orders
 * demand_from_orders = SUM(order_lines.qty - shipped_qty - reserved_qty)
 */
export function calculateDemandFromOrders(lines: OrderDemandLineInput[]): number {
  const demand = lines.reduce((acc, line) => {
    const unfulfilled = line.qty - line.shippedQty - line.reservedQty;
    return acc + Math.max(0, unfulfilled);
  }, 0);
  return Number(demand.toFixed(2));
}

/**
 * 2.8 Final Production Quantity to Produce
 * qty_to_produce = MAX(demand_from_orders + qty_min_stock - qty_reserved - qty_in_stock, 0)
 */
export function calculateQtyToProduce(
  demandFromOrders: number,
  qtyMinStock: number,
  qtyReserved: number,
  qtyInStock: number
): number {
  const rawQty = demandFromOrders + qtyMinStock - qtyReserved - qtyInStock;
  return Number(Math.max(0, rawQty).toFixed(2));
}

/**
 * 2.10 Purchase Request Quantity & Amount
 * purchase_qty = MAX(demand_for_material - stock_qty, 0)
 * purchase_amount = purchase_qty * purchase_price
 */
export function calculatePurchaseQty(
  demandForMaterial: number,
  stockQty: number,
  purchasePrice: number
) {
  const purchaseQty = Number(Math.max(0, demandForMaterial - stockQty).toFixed(3));
  const purchaseAmount = Number((purchaseQty * purchasePrice).toFixed(2));

  return {
    purchaseQty,
    purchaseAmount,
  };
}

/**
 * 2.11 Balance Due for Order Line
 * line_total_vat = qty * unit_price * (1 + vat_rate)
 * balance_due = line_total_vat - prepayment - post_payment_1 - post_payment_2 - penalty
 */
export function calculateBalanceDue(input: BalanceDueInput) {
  const lineTotalVat = Number((input.qty * input.unitPrice * (1 + input.vatRate)).toFixed(2));
  const paidAndPenaltySum = input.prepayment + input.postPayment1 + input.postPayment2 + input.penalty;
  const balanceDue = Number(Math.max(0, lineTotalVat - paidAndPenaltySum).toFixed(2));

  return {
    lineTotalVat,
    balanceDue,
  };
}

/**
 * 2.12 Shipment Overdue Days (orders.overdue_days)
 * IF actual_shipment_date IS NULL AND today > planned_shipment_date:
 *   overdue_days = today - planned_shipment_date
 * ELSE: overdue_days = 0
 */
export function calculateOverdueDays(
  plannedShipmentDate: Date | null,
  actualShipmentDate: Date | null,
  currentDate: Date = new Date()
): number {
  if (!plannedShipmentDate || actualShipmentDate) {
    return 0;
  }

  // Clear time portions for date comparison
  const planned = new Date(plannedShipmentDate.getFullYear(), plannedShipmentDate.getMonth(), plannedShipmentDate.getDate());
  const current = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());

  if (current > planned) {
    const diffTime = current.getTime() - planned.getTime();
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
  }

  return 0;
}
