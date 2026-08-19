import { PrismaClient, MaterialCategory, CustomerType, OrderType } from '@prisma/client';
import { seedWorkCalendar } from '../prisma/seeders/calendar.seeder';
import { seedDictionaries, SYSTEM_ROLES } from '../prisma/seeders/dictionary.seeder';

// Helper validator for OrderLine input
export function validateOrderLineInput(input: { qty: number }) {
  if (input.qty <= 0) {
    throw new Error('OrderLine qty must be greater than 0');
  }
}

describe('Data Layer Constraints & Seeders Tests', () => {
  describe('Seeder Logic Unit Tests', () => {
    it('should correctly configure 10 system roles', () => {
      expect(SYSTEM_ROLES.length).toBe(10);
      const roleCodes = SYSTEM_ROLES.map((r) => r.code);
      expect(roleCodes).toContain('sales_manager');
      expect(roleCodes).toContain('planner');
      expect(roleCodes).toContain('engineer');
      expect(roleCodes).toContain('procurement');
      expect(roleCodes).toContain('warehouse_material');
      expect(roleCodes).toContain('warehouse_fg');
      expect(roleCodes).toContain('shop_foreman');
      expect(roleCodes).toContain('accountant');
      expect(roleCodes).toContain('director');
      expect(roleCodes).toContain('admin');
    });

    it('should validate order line qty constraint (qty > 0)', () => {
      expect(() => validateOrderLineInput({ qty: 10 })).not.toThrow();
      expect(() => validateOrderLineInput({ qty: 0 })).toThrow('OrderLine qty must be greater than 0');
      expect(() => validateOrderLineInput({ qty: -5 })).toThrow('OrderLine qty must be greater than 0');
    });
  });

  describe('Database Constraints Simulation', () => {
    it('should enforce unique constraint error pattern on duplicate keys', () => {
      const existingCodes = new Set(['a-001', 'm-001']);
      
      const createArticle = (code: string) => {
        if (existingCodes.has(code)) {
          const error = new Error(`Unique constraint failed on the fields: (article_code)`);
          (error as any).code = 'P2002';
          throw error;
        }
        existingCodes.add(code);
        return { articleCode: code };
      };

      expect(() => createArticle('a-002')).not.toThrow();
      expect(() => createArticle('a-001')).toThrow('Unique constraint failed');
    });

    it('should enforce foreign key validation error pattern on non-existent references', () => {
      const existingArticles = new Set(['art-uuid-1']);

      const createOrderLine = (articleId: string) => {
        if (!existingArticles.has(articleId)) {
          const error = new Error(`Foreign key constraint failed on the field: (article_id)`);
          (error as any).code = 'P2003';
          throw error;
        }
        return { articleId };
      };

      expect(() => createOrderLine('art-uuid-1')).not.toThrow();
      expect(() => createOrderLine('art-uuid-non-existent')).toThrow('Foreign key constraint failed');
    });
  });
});
