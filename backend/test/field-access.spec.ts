import { ForbiddenException } from '@nestjs/common';
import {
  permissionsForRoles,
  projectByPermissions,
  assertFieldWriteAllowed,
  groupOfField,
  allPermissionCodes,
  FIELD_GROUPS,
} from '../src/common/field-access';

describe('Field-level RBAC (Этап 1, 07_ARCHITECTURE_AND_UX.md §1)', () => {
  describe('permissionsForRoles', () => {
    it('admin получает все права', () => {
      expect(permissionsForRoles(['admin']).sort()).toEqual(allPermissionCodes().sort());
    });

    it('sales_manager пишет order.commercial, но не видит order.cost', () => {
      const perms = permissionsForRoles(['sales_manager']);
      expect(perms).toContain('order.commercial:write');
      expect(perms).toContain('order.core:write');
      expect(perms).not.toContain('order.cost:read');
    });

    it('engineer видит себестоимость, но не пишет коммерцию', () => {
      const perms = permissionsForRoles(['engineer']);
      expect(perms).toContain('order.cost:read');
      expect(perms).toContain('routing.norm:write');
      expect(perms).not.toContain('order.commercial:read');
      expect(perms).not.toContain('order.commercial:write');
    });

    it('director утверждает цену (approve), но не пишет её', () => {
      const perms = permissionsForRoles(['director']);
      expect(perms).toContain('article.price:approve');
      expect(perms).not.toContain('article.price:write');
    });

    it('shop_foreman пишет только факт трудочасов, норму — нет', () => {
      const perms = permissionsForRoles(['shop_foreman']);
      expect(perms).toContain('routing.actual:write');
      expect(perms).toContain('routing.norm:read');
      expect(perms).not.toContain('routing.norm:write');
    });

    it('viewer видит только core и logistics заказа', () => {
      const perms = permissionsForRoles(['viewer']);
      expect(perms).toContain('order.core:read');
      expect(perms).toContain('order.logistics:read');
      expect(perms).not.toContain('order.commercial:read');
      expect(perms).not.toContain('order.production:read');
      expect(perms.some((p) => p.endsWith(':write'))).toBe(false);
    });

    it('несколько ролей = объединение прав', () => {
      const perms = permissionsForRoles(['engineer', 'planner']);
      expect(perms).toContain('routing.norm:write');   // от engineer
      expect(perms).toContain('order.production:write'); // от planner
    });

    it('расчётные группы не имеют write-прав ни у кого', () => {
      const all = allPermissionCodes();
      for (const [resource, groups] of Object.entries(FIELD_GROUPS)) {
        for (const g of groups) {
          if (g.isCalculated) {
            expect(all).not.toContain(`${resource}.${g.code}:write`);
          }
        }
      }
    });
  });

  describe('projectByPermissions — проекция ответа API', () => {
    const order = {
      id: 'o-1',
      orderNumber: 'П-88192-21',
      customerId: 'c-1',
      status: 'CONFIRMED',
      unitPrice: 52300,
      lineTotalVat: 58576,
      prepayment: 26150,
      costPrice: 37280,
      margin: 15020,
      reservedQty: 2,
      shippedQty: 0,
      orderLines: [
        { id: 'l-1', qty: 1, unitPrice: 52300, costPrice: 37280, reservedQty: 2 },
      ],
    };

    it('инженер не получает unitPrice в JSON вообще (не hidden, а отсутствует)', () => {
      const projected: any = projectByPermissions(order, 'order', permissionsForRoles(['engineer']));
      expect(projected.unitPrice).toBeUndefined();
      expect(projected.prepayment).toBeUndefined();
      expect('unitPrice' in projected).toBe(false);
      // но себестоимость инженеру видна
      expect(projected.costPrice).toBe(37280);
      // и базовые поля на месте
      expect(projected.orderNumber).toBe('П-88192-21');
    });

    it('вложенные orderLines проецируются по тем же правилам', () => {
      const projected: any = projectByPermissions(order, 'order', permissionsForRoles(['engineer']));
      expect(projected.orderLines[0].unitPrice).toBeUndefined();
      expect(projected.orderLines[0].costPrice).toBe(37280);
      expect(projected.orderLines[0].qty).toBe(1);
    });

    it('менеджер видит цену, но не себестоимость', () => {
      const projected: any = projectByPermissions(order, 'order', permissionsForRoles(['sales_manager']));
      expect(projected.unitPrice).toBe(52300);
      expect(projected.costPrice).toBeUndefined();
      expect(projected.margin).toBeUndefined();
    });

    it('пагинированный ответ { data, meta } проецируется по data', () => {
      const paged = { data: [order], meta: { page: 1, pageSize: 50, total: 1 } };
      const projected: any = projectByPermissions(paged, 'order', permissionsForRoles(['viewer']));
      expect(projected.meta.total).toBe(1);
      expect(projected.data[0].unitPrice).toBeUndefined();
      expect(projected.data[0].reservedQty).toBeUndefined(); // production закрыт для viewer
      expect(projected.data[0].shippedQty).toBe(0);          // logistics для viewer открыт
    });

    it('admin получает объект без изменений', () => {
      const projected = projectByPermissions(order, 'order', permissionsForRoles(['admin']));
      expect(projected).toEqual(order);
    });

    it('поля вне групп (id) всегда проходят', () => {
      const projected: any = projectByPermissions(order, 'order', permissionsForRoles(['viewer']));
      expect(projected.id).toBe('o-1');
    });
  });

  describe('assertFieldWriteAllowed — контроль записи по полям', () => {
    it('менеджер может писать цену', () => {
      expect(() =>
        assertFieldWriteAllowed({ unitPrice: 60000 }, 'order', permissionsForRoles(['sales_manager'])),
      ).not.toThrow();
    });

    it('плановик не может писать цену — 403 с перечнем полей', () => {
      try {
        assertFieldWriteAllowed(
          { unitPrice: 60000, reservedQty: 5 },
          'order',
          permissionsForRoles(['planner']),
        );
        fail('должен был бросить ForbiddenException');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect(e.getResponse().code).toBe('FIELD_WRITE_FORBIDDEN');
        expect(e.getResponse().fields).toEqual(['unitPrice']); // reservedQty ему можно
      }
    });

    it('инженер не может писать утверждённую цену артикула', () => {
      expect(() =>
        assertFieldWriteAllowed({ approvedPrice: 1000 }, 'article', permissionsForRoles(['engineer'])),
      ).toThrow(ForbiddenException);
    });

    it('инженер может править core-поля артикула', () => {
      expect(() =>
        assertFieldWriteAllowed({ name: 'Новое имя', weightKg: 1.2 }, 'article', permissionsForRoles(['engineer'])),
      ).not.toThrow();
    });

    it('кладовщик сырья не может править закупочную цену', () => {
      expect(() =>
        assertFieldWriteAllowed({ purchasePrice: 500 }, 'material', permissionsForRoles(['warehouse_material'])),
      ).toThrow(ForbiddenException);
    });

    it('поля вне групп отсекаются молча (валидирует DTO, а не RBAC)', () => {
      expect(() =>
        assertFieldWriteAllowed({ someUnknownField: 1 }, 'order', permissionsForRoles(['viewer'])),
      ).not.toThrow();
    });
  });

  describe('groupOfField', () => {
    it('находит группу поля', () => {
      expect(groupOfField('order', 'unitPrice')).toBe('commercial');
      expect(groupOfField('order', 'reservedQty')).toBe('production');
      expect(groupOfField('article', 'approvedPrice')).toBe('price');
      expect(groupOfField('routing', 'actualHours')).toBe('actual');
    });

    it('null для неизвестных полей', () => {
      expect(groupOfField('order', 'nope')).toBeNull();
      expect(groupOfField('nope', 'nope')).toBeNull();
    });
  });
});

describe('rowScopeForRoles — ограничение видимости строк (§1.8)', () => {
  const { rowScopeForRoles } = require('../src/common/field-access');

  it('viewer видит только заказы своего заказчика', () => {
    expect(rowScopeForRoles(['viewer'], 'order')).toBe('customer');
  });

  it('роль без ограничения видит всё', () => {
    expect(rowScopeForRoles(['sales_manager'], 'order')).toBeNull();
    expect(rowScopeForRoles(['engineer'], 'order')).toBeNull();
  });

  it('admin всегда без ограничений', () => {
    expect(rowScopeForRoles(['admin'], 'order')).toBeNull();
    expect(rowScopeForRoles(['viewer', 'admin'], 'order')).toBeNull();
  });

  it('объединение ролей: неограниченная роль расширяет видимость', () => {
    expect(rowScopeForRoles(['viewer', 'sales_manager'], 'order')).toBeNull();
  });

  it('скоуп действует только на описанный ресурс', () => {
    expect(rowScopeForRoles(['viewer'], 'article')).toBeNull();
  });

  it('пустой набор ролей — без скоупа (эндпоинт закрыт RbacGuard раньше)', () => {
    expect(rowScopeForRoles([], 'order')).toBeNull();
  });
});
