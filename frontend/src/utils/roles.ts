import type { OrderStatus } from '../types';

export const ROLES = {
  SALES_MANAGER: 'sales_manager',
  PLANNER: 'planner',
  ENGINEER: 'engineer',
  PROCUREMENT: 'procurement',
  WAREHOUSE_MATERIAL: 'warehouse_material',
  WAREHOUSE_FG: 'warehouse_fg',
  SHOP_FOREMAN: 'shop_foreman',
  ACCOUNTANT: 'accountant',
  DIRECTOR: 'director',
  ADMIN: 'admin',
} as const;

export type RoleCode = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_LABELS: Record<string, string> = {
  sales_manager: 'Менеджер по продажам',
  planner: 'Плановик',
  engineer: 'Конструктор',
  procurement: 'Закупщик',
  warehouse_material: 'Кладовщик (сырьё)',
  warehouse_fg: 'Кладовщик (ГП)',
  shop_foreman: 'Мастер цеха',
  accountant: 'Бухгалтер',
  director: 'Директор',
  admin: 'Администратор',
};

/**
 * Модуль виден, если у пользователя есть хотя бы одно :read-право
 * на его ресурсы (§2.2 07_ARCHITECTURE_AND_UX.md).
 * Ключи прав — группы полей из utils/fieldAccess.ts.
 */
export const MODULE_PERMISSIONS: Record<string, string[]> = {
  // Меню сведено к шести пунктам (решение 23.08.2026): раньше роль видела
  // 9–13, хотя мастеру нужен один, а кладовщику два. Разделы теперь —
  // способ НАЙТИ, а не место, куда надо идти: всё про заказ живёт
  // в карточке, доступной отовсюду, плюс общий поиск по Cmd+K.
  work: [],                                              // Моя работа — всем
  orders: ['order.core:read'],                           // Заказы
  specs: ['routing.norm:read', 'bom.core:read'],         // Изделия
  materials: ['stockMaterial.core:read', 'material.core:read', 'stockFg.core:read'],
  money: ['payment.core:read'],                          // Деньги
  settings: ['audit:read'],                              // Настройки и обмен

  // Старые ключи оставлены: на них ещё ссылаются внутренние переходы
  dashboard: [],
  production: ['order.production:read', 'routing.norm:read'],
  kanban: ['order.production:read'],
  warehouse: ['stockFg.core:read', 'stockMaterial.core:read'],
  finance: ['payment.core:read', 'order.commercial:read'],
  catalog: ['article.core:read', 'material.core:read'],
  audit: ['audit:read'],
};


/** Есть ли доступ к модулю при данном наборе прав */
export function canAccessModule(module: string, permissions: string[]): boolean {
  const required = MODULE_PERMISSIONS[module];
  if (!required) return false;
  if (required.length === 0) return true;
  return required.some((p) => permissions.includes(p));
}

/** Check if any of the user's roles is in the allowed set */
export function hasRole(userRoles: string[], allowedRoles: string[]): boolean {
  if (userRoles.includes('admin')) return true;
  return allowedRoles.some((r) => userRoles.includes(r));
}

/** Status transition → allowed roles (mirroring backend) */
export const STATUS_TRANSITION_ROLES: Record<string, string[]> = {
  CONFIRMED: ['sales_manager', 'planner', 'director', 'admin'],
  DRAFT: ['sales_manager', 'planner', 'director', 'admin'],
  IN_PRODUCTION: ['planner', 'admin'],
  READY_TO_SHIP: ['warehouse_fg', 'admin'],
  SHIPPED: ['warehouse_fg', 'admin'],
  CLOSED: ['accountant', 'admin'],
  CANCELLED: ['sales_manager', 'director', 'admin'],
};

/** State machine transitions: fromStatus → allowed toStatus[] */
/**
 * Статусы, которые заказ занимает сам по отметкам цеха (решение 23.08.2026).
 * Кнопок для них не показываем: иначе одну работу делают дважды — мастер
 * отмечает этап, а кто-то ещё двигает статус вручную. Зеркалит
 * DERIVED_STATUSES на бэкенде.
 */
export const DERIVED_STATUSES: OrderStatus[] = ['IN_PRODUCTION', 'READY_TO_SHIP'];

export const STATE_TRANSITIONS: Record<string, OrderStatus[]> = {
  NEW: ['CONFIRMED', 'DRAFT', 'CANCELLED'],
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PRODUCTION', 'CANCELLED'],
  IN_PRODUCTION: ['READY_TO_SHIP', 'CANCELLED'],
  READY_TO_SHIP: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

/** Get allowed transitions for a given status + user roles */
export function getAllowedTransitions(
  currentStatus: OrderStatus,
  userRoles: string[]
): OrderStatus[] {
  const possibleNext = STATE_TRANSITIONS[currentStatus] || [];
  return possibleNext.filter((nextStatus) => {
    const allowedRoles = STATUS_TRANSITION_ROLES[nextStatus] || ['admin'];
    return hasRole(userRoles, allowedRoles);
  });
}
