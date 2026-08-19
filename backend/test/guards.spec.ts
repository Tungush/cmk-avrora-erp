import {
  validateOrderLineQtyGuard,
  validateShippedReservationGuard,
  validateMaterialDeletionGuard,
  validatePurchaseRequestMaterialGuard,
  validatePriceChangeIsolation,
  BusinessGuardError,
} from '../src/services/guards.service';

describe('Business Guards Unit Tests', () => {
  it('should validate positive order line quantity', () => {
    expect(() => validateOrderLineQtyGuard(10)).not.toThrow();
    expect(() => validateOrderLineQtyGuard(0)).toThrow(BusinessGuardError);
    expect(() => validateOrderLineQtyGuard(-5)).toThrow('strictly greater than zero');
  });

  it('should prevent shipment when reserved_qty < qty', () => {
    const validLines = [
      { qty: 10, reservedQty: 10, articleCode: 'ART-001' },
      { qty: 5, reservedQty: 5, articleCode: 'ART-002' },
    ];
    expect(() => validateShippedReservationGuard(validLines)).not.toThrow();

    const insufficientLines = [
      { qty: 10, reservedQty: 10, articleCode: 'ART-001' },
      { qty: 5, reservedQty: 2, articleCode: 'ART-002' },
    ];
    expect(() => validateShippedReservationGuard(insufficientLines)).toThrow(BusinessGuardError);
    expect(() => validateShippedReservationGuard(insufficientLines)).toThrow('INSUFFICIENT_RESERVED_QTY');
  });

  it('should prevent material deletion if referenced in BOM items', () => {
    expect(() => validateMaterialDeletionGuard(0, 'MAT-001')).not.toThrow();
    expect(() => validateMaterialDeletionGuard(3, 'MAT-001')).toThrow(BusinessGuardError);
    expect(() => validateMaterialDeletionGuard(3, 'MAT-001')).toThrow('MATERIAL_IN_USE_IN_BOM');
  });

  it('should prevent purchase request creation for inactive materials', () => {
    expect(() => validatePurchaseRequestMaterialGuard(true, 'MAT-001')).not.toThrow();
    expect(() => validatePurchaseRequestMaterialGuard(false, 'MAT-001')).toThrow(BusinessGuardError);
    expect(() => validatePurchaseRequestMaterialGuard(false, 'MAT-001')).toThrow('MATERIAL_IS_INACTIVE');
  });

  it('should preserve existing order line unit price during price list updates', () => {
    const historicalUnitPrice = 1500;
    const newCatalogApprovedPrice = 2000;
    const price = validatePriceChangeIsolation(historicalUnitPrice, newCatalogApprovedPrice);
    expect(price).toBe(1500); // Must remain untouched
  });
});
