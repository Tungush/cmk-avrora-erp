/**
 * Права на уровне полей — фронтовое зеркало backend/src/common/field-access.ts.
 *
 * Основной источник прав — ответ /auth/login (permissions[]).
 * Эта копия матрицы нужна только для демо-режима, когда бэкенд недоступен.
 * Скрытие данных ей не доверяется: сервер режет закрытые поля из JSON сам.
 */

export type PermissionCode = string;

/** Группы полей ресурсов — для пресетов колонок и секций карточек */
export const FIELD_GROUP_LABELS: Record<string, Record<string, string>> = {
  order: {
    core: 'Основное',
    commercial: 'Финансы',
    production: 'Производство',
    logistics: 'Отгрузка',
    cost: 'Себестоимость',
  },
  article: { core: 'Основное', price: 'Цены', cost: 'Себестоимость' },
  material: { core: 'Основное', price: 'Цены' },
  bom: { core: 'Состав', cost: 'Стоимость' },
  routing: { norm: 'Норма', actual: 'Факт', cost: 'Стоимость' },
  payment: { core: 'Документ', amounts: 'Суммы' },
  stockFg: { core: 'Движения ГП' },
  stockMaterial: { core: 'Движения ТМЦ' },
  costingConfig: { core: 'Коэффициенты' },
};

type Grant = 'read' | 'write' | 'approve';

/** Матрица §1.7 07_ARCHITECTURE_AND_UX.md — зеркало серверной */
const ROLE_MATRIX: Record<string, Record<string, Grant>> = {
  sales_manager: {
    'order.core': 'write', 'order.commercial': 'write', 'order.production': 'read',
    'order.logistics': 'read', 'article.core': 'read', 'article.price': 'read',
    'payment.core': 'read', 'payment.amounts': 'read', 'stockFg.core': 'read',
  },
  accountant: {
    'order.core': 'read', 'order.commercial': 'write', 'order.logistics': 'read',
    'order.cost': 'read', 'article.core': 'read', 'article.price': 'read',
    'article.cost': 'read', 'material.price': 'read', 'payment.core': 'write',
    'payment.amounts': 'write', 'stockFg.core': 'read',
  },
  director: {
    'order.core': 'read', 'order.commercial': 'read', 'order.production': 'read',
    'order.logistics': 'read', 'order.cost': 'read', 'article.core': 'read',
    'article.price': 'approve', 'article.cost': 'read', 'bom.core': 'read',
    'bom.cost': 'read', 'routing.norm': 'read', 'routing.actual': 'read',
    'routing.cost': 'read', 'material.core': 'read', 'material.price': 'read',
    'payment.core': 'read', 'payment.amounts': 'read', 'stockFg.core': 'read',
    'stockMaterial.core': 'read', 'costingConfig.core': 'approve', audit: 'read',
  },
  engineer: {
    'order.core': 'read', 'order.production': 'read', 'order.cost': 'read',
    'article.core': 'write', 'article.cost': 'read', 'bom.core': 'write',
    'bom.cost': 'read', 'routing.norm': 'write', 'routing.actual': 'read',
    'routing.cost': 'read', 'material.core': 'read', 'material.price': 'read',
    'stockMaterial.core': 'read', 'costingConfig.core': 'read',
  },
  planner: {
    'order.core': 'read', 'order.production': 'write', 'order.logistics': 'read',
    'article.core': 'read', 'article.price': 'read', 'bom.core': 'read',
    'routing.norm': 'read', 'routing.actual': 'read', 'material.core': 'read',
    'stockFg.core': 'read', 'stockMaterial.core': 'read',
  },
  shop_foreman: {
    'order.core': 'read', 'order.production': 'read', 'order.logistics': 'read',
    'article.core': 'read', 'bom.core': 'read', 'routing.norm': 'read',
    'routing.actual': 'write', 'stockFg.core': 'read',
  },
  procurement: {
    'order.core': 'read', 'order.commercial': 'read', 'order.production': 'read',
    'article.core': 'read', 'article.price': 'read', 'bom.core': 'read',
    'material.core': 'write', 'material.price': 'write', 'payment.core': 'write',
    'payment.amounts': 'write', 'stockMaterial.core': 'read',
  },
  warehouse_material: {
    'order.core': 'read', 'article.core': 'read', 'material.core': 'write',
    'material.price': 'read', 'stockMaterial.core': 'write',
  },
  warehouse_fg: {
    'order.core': 'read', 'order.production': 'write', 'order.logistics': 'write',
    'article.core': 'read', 'stockFg.core': 'write',
  },
  viewer: {
    'order.core': 'read', 'order.logistics': 'read', 'article.core': 'read',
  },
};

/** Расчётные группы (write не выдаётся никому) */
const CALCULATED_GROUPS = new Set([
  'order.cost', 'article.cost', 'bom.cost', 'routing.cost',
]);

function expandGrant(key: string, grant: Grant): PermissionCode[] {
  const read = `${key}:read`;
  if (grant === 'read') return [read];
  if (grant === 'write') return [read, `${key}:write`];
  return [read, `${key}:approve`];
}

/** Все возможные права — для admin */
function allPermissionCodes(): PermissionCode[] {
  const set = new Set<PermissionCode>();
  for (const [resource, groups] of Object.entries(FIELD_GROUP_LABELS)) {
    for (const group of Object.keys(groups)) {
      const key = `${resource}.${group}`;
      set.add(`${key}:read`);
      if (!CALCULATED_GROUPS.has(key)) {
        set.add(`${key}:write`);
        set.add(`${key}:approve`);
      }
    }
  }
  set.add('audit:read');
  return [...set];
}

/** Права набора ролей (объединение). admin → всё. Демо-фолбэк /auth/login. */
export function permissionsForRoles(roles: string[]): PermissionCode[] {
  if (roles.includes('admin')) return allPermissionCodes();
  const set = new Set<PermissionCode>();
  for (const role of roles) {
    const matrix = ROLE_MATRIX[role];
    if (!matrix) continue;
    for (const [key, grant] of Object.entries(matrix)) {
      expandGrant(key, grant).forEach((c) => set.add(c));
    }
  }
  return [...set];
}

/** Семейства ролей для навигации */
export const ROLE_FAMILIES: Record<string, string> = {
  admin: 'admin',
  sales_manager: 'commercial', accountant: 'commercial', director: 'commercial',
  engineer: 'engineering', planner: 'engineering', shop_foreman: 'engineering',
  procurement: 'supply', warehouse_material: 'supply', warehouse_fg: 'supply',
  viewer: 'viewer',
};
