/**
 * Business Logic Validation Guards
 * Enforces business rules specified in Section 4 of docs/02_BUSINESS_LOGIC.md.
 */

export class BusinessGuardError extends Error {
  constructor(message: string, public code: string = 'BUSINESS_RULE_VIOLATION') {
    super(`[${code}] ${message}`);
    this.name = 'BusinessGuardError';
  }
}

/**
 * Validates OrderLine quantity > 0
 */
export function validateOrderLineQtyGuard(qty: number): void {
  if (typeof qty !== 'number' || isNaN(qty) || qty <= 0) {
    throw new BusinessGuardError('Order line quantity must be strictly greater than zero', 'INVALID_ORDER_LINE_QTY');
  }
}

/**
 * Prevents transition to SHIPPED if reserved_qty < qty
 */
export function validateShippedReservationGuard(lines: { qty: number; reservedQty: number; articleCode?: string }[]): void {
  for (const line of lines) {
    if (line.reservedQty < line.qty) {
      throw new BusinessGuardError(
        `Cannot ship order: item ${line.articleCode || ''} has reserved quantity (${line.reservedQty}) less than required (${line.qty})`,
        'INSUFFICIENT_RESERVED_QTY'
      );
    }
  }
}

/**
 * Prevents deleting or deactivating a material if referenced by active BOM items
 */
export function validateMaterialDeletionGuard(activeBomItemCount: number, materialCode: string): void {
  if (activeBomItemCount > 0) {
    throw new BusinessGuardError(
      `Cannot delete or deactivate material ${materialCode}: referenced by ${activeBomItemCount} active BOM item(s)`,
      'MATERIAL_IN_USE_IN_BOM'
    );
  }
}

/**
 * Prevents creating purchase requests for inactive materials
 */
export function validatePurchaseRequestMaterialGuard(materialIsActive: boolean, materialCode: string): void {
  if (!materialIsActive) {
    throw new BusinessGuardError(
      `Cannot create purchase request for material ${materialCode}: material is inactive`,
      'MATERIAL_IS_INACTIVE'
    );
  }
}

/**
 * Ensures approved_price changes do not retroactively alter existing order line unit prices
 */
export function validatePriceChangeIsolation(existingLineUnitPrice: number, newApprovedPrice: number): number {
  // Returns existing line unit price unchanged for historical integrity
  return existingLineUnitPrice;
}
