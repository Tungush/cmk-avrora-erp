import {
  calculateSpecPrice,
  calculatePriceDeviationPct,
  calculateLeadTimeDays,
  calculateHourCost,
  calculatePlanLaborCost,
  calculateMinStockLevel,
  calculateDemandFromOrders,
  calculateQtyToProduce,
  calculatePurchaseQty,
  calculateBalanceDue,
  calculateOverdueDays,
} from '../src/services/formulas.service';

describe('Formulas Service Unit Tests', () => {
  it('2.1 calculateSpecPrice: should calculate sum of bom items line cost', () => {
    const bomItems = [
      { qtyPerUnit: 2.5, purchasePrice: 100 }, // 250
      { qtyPerUnit: 10, purchasePrice: 15 },   // 150
      { qtyPerUnit: 0.5, purchasePrice: 500 },  // 250
    ];
    const specPrice = calculateSpecPrice(bomItems);
    expect(specPrice).toBe(650);
  });

  it('2.2 calculatePriceDeviationPct: should calculate deviation ratio correctly', () => {
    // Approved price = 800, Spec price = 650 -> (800/650) - 1 = +23.08%
    const dev1 = calculatePriceDeviationPct(800, 650);
    expect(dev1).toBe(0.2308);

    // Approved price = 600, Spec price = 650 -> (600/650) - 1 = -7.69% (Loss margin alert)
    const dev2 = calculatePriceDeviationPct(600, 650);
    expect(dev2).toBe(-0.0769);

    // Invalid inputs return null
    expect(calculatePriceDeviationPct(0, 650)).toBeNull();
    expect(calculatePriceDeviationPct(800, 0)).toBeNull();
  });

  it('2.3 calculateLeadTimeDays: should round up total labor hours to full shifts', () => {
    // 12 hours total labor / 8 hours per shift = 1.5 shifts -> CEIL(1.5) = 2 days
    expect(calculateLeadTimeDays(12, 8)).toBe(2);
    // 24 hours / 8 = 3 days
    expect(calculateLeadTimeDays(24, 8)).toBe(3);
    // 0 hours -> 0 days
    expect(calculateLeadTimeDays(0, 8)).toBe(0);
  });

  it('2.4 calculateHourCost & calculatePlanLaborCost', () => {
    // Fund = 1,000,000, 10 employees, 160 hrs/month -> cost per hour = 1,000,000 / (10 * 160) = 625.00
    const hourCost = calculateHourCost(1000000, 10, 160);
    expect(hourCost).toBe(625);

    // Plan labor cost for 40 hours = 40 * 625 = 25,000.00
    const planCost = calculatePlanLaborCost(40, hourCost);
    expect(planCost).toBe(25000);
  });

  it('2.6 calculateMinStockLevel: target, actual, readiness, deficit', () => {
    // Base norm = 100, correction = +10% (0.10) -> target = 110
    // Actual stock = 70 -> readiness = 70/110 = 0.64 (64%), deficit = 110 - 70 = 40
    const res = calculateMinStockLevel({
      baseNorm: 100,
      correctionPct: 0.10,
      actualQty: 70,
    });

    expect(res.targetQty).toBe(110);
    expect(res.actualQty).toBe(70);
    expect(res.readinessPct).toBe(0.64);
    expect(res.deficitQty).toBe(40);
  });

  it('2.7 calculateDemandFromOrders: should sum unfulfilled line items', () => {
    const lines = [
      { qty: 10, shippedQty: 2, reservedQty: 3 }, // 10 - 2 - 3 = 5
      { qty: 5, shippedQty: 5, reservedQty: 0 },  // 5 - 5 - 0 = 0
      { qty: 20, shippedQty: 0, reservedQty: 10 }, // 20 - 0 - 10 = 10
    ];
    const demand = calculateDemandFromOrders(lines);
    expect(demand).toBe(15);
  });

  it('2.8 calculateQtyToProduce: demand + minStock - reserved - inStock', () => {
    // demand = 50, minStock = 20, reserved = 10, inStock = 30 -> (50 + 20 - 10 - 30) = 30
    expect(calculateQtyToProduce(50, 20, 10, 30)).toBe(30);

    // Surplus stock: demand = 10, minStock = 0, reserved = 0, inStock = 50 -> MAX(-40, 0) = 0
    expect(calculateQtyToProduce(10, 0, 0, 50)).toBe(0);
  });

  it('2.10 calculatePurchaseQty & Amount', () => {
    // Demand for material = 100, stock = 40, purchase price = 250
    // purchaseQty = 60, purchaseAmount = 60 * 250 = 15,000
    const res = calculatePurchaseQty(100, 40, 250);
    expect(res.purchaseQty).toBe(60);
    expect(res.purchaseAmount).toBe(15000);
  });

  it('2.11 calculateBalanceDue: should calculate line VAT total and subtract payments', () => {
    // Qty = 10, unit price = 1000, VAT = 12% -> lineTotalVat = 10 * 1000 * 1.12 = 11,200
    // Prepayment = 3,000, post1 = 2,000, post2 = 1,000, penalty = 500
    // balanceDue = 11,200 - (3000 + 2000 + 1000 + 500) = 4,700
    const res = calculateBalanceDue({
      qty: 10,
      unitPrice: 1000,
      vatRate: 0.12,
      prepayment: 3000,
      postPayment1: 2000,
      postPayment2: 1000,
      penalty: 500,
    });

    expect(res.lineTotalVat).toBe(11200);
    expect(res.balanceDue).toBe(4700);
  });

  it('2.12 calculateOverdueDays: should calculate days past planned shipment date', () => {
    const planned = new Date('2026-08-01');
    const actual = null;
    const today = new Date('2026-08-11'); // 10 days overdue

    expect(calculateOverdueDays(planned, actual, today)).toBe(10);

    // If shipped, overdue is 0
    const actualShipped = new Date('2026-08-05');
    expect(calculateOverdueDays(planned, actualShipped, today)).toBe(0);

    // If today <= planned date, overdue is 0
    const futurePlanned = new Date('2026-08-15');
    expect(calculateOverdueDays(futurePlanned, null, today)).toBe(0);
  });
});
