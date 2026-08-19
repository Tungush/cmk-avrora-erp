/**
 * Единый источник правды о правах на уровне полей.
 *
 * Три сущности:
 *  - FIELD_GROUPS  — какие поля каждой сущности входят в какую группу (order.commercial и т.д.);
 *  - ROLE_MATRIX   — матрица §1.7 из 07_ARCHITECTURE_AND_UX.md: роль → права;
 *  - хелперы       — permissionsForRoles / projectByPermissions / assertFieldWriteAllowed.
 *
 * Этот файл — источник и для сида БД (prisma/seeders/rbac.seeder.ts), и для
 * рантайм-фолбэка, когда БД недоступна (runWithFallback-паттерн проекта).
 */
import { ForbiddenException } from '@nestjs/common';

export type PermissionAction = 'read' | 'write' | 'approve';

export interface FieldGroupDef {
  /** Код группы: "core", "commercial", … */
  code: string;
  /** Человекочитаемое имя для UI */
  label: string;
  /** Поля сущности, входящие в группу */
  fields: string[];
  /** true — группа всегда read-only (расчётные поля), write-права не выдаются */
  isCalculated?: boolean;
}

/** resource → группы полей */
export const FIELD_GROUPS: Record<string, FieldGroupDef[]> = {
  order: [
    {
      code: 'core',
      label: 'Основное',
      fields: [
        'orderNumber', 'orderNumberAs', 'orderNumberA77', 'customerId', 'customer',
        'region', 'orderType', 'status', 'requestDate', 'plannedShipmentDate',
        'planQuarter', 'managerId', 'manager', 'comment', 'projectId', 'divisionId',
        'sourceSheet', 'sourceRowNumber', 'createdAt', 'updatedAt',
      ],
    },
    {
      code: 'commercial',
      label: 'Финансы',
      fields: [
        'unitPrice', 'lineTotalVat', 'prepayment', 'postPayment1', 'postPayment2',
        'penalty', 'balanceDue', 'paymentDate', 'paymentDocuments', 'totalAmount',
      ],
    },
    {
      code: 'production',
      label: 'Производство',
      fields: [
        'reservedQty', 'inStockQty', 'qtyToProduce', 'leadTimeDays',
        'productionStages', 'overdueDays',
      ],
    },
    {
      code: 'logistics',
      label: 'Отгрузка',
      fields: [
        'shippedQty', 'actNumber', 'waybillNumber', 'proxyNumber',
        'actualShipmentDate', 'readyDate', 'acceptanceActs',
      ],
    },
    {
      code: 'cost',
      label: 'Себестоимость',
      isCalculated: true,
      fields: ['costPrice', 'laborHours', 'margin', 'marginPct', 'tonnage'],
    },
  ],

  article: [
    {
      code: 'core',
      label: 'Основное',
      fields: [
        'articleCode', 'legacyCode', 'name', 'weightKg', 'series', 'description',
        'palletCapacity', 'isActive', 'createdAt', 'updatedAt',
      ],
    },
    {
      code: 'price',
      label: 'Цены',
      fields: ['approvedPrice', 'priceHistory', 'priceDeviationPct', 'leadTimeDays'],
    },
    {
      code: 'cost',
      label: 'Себестоимость',
      isCalculated: true,
      fields: ['specPrice', 'materialCost', 'laborCost', 'totalManHours', 'margin'],
    },
  ],

  material: [
    {
      code: 'core',
      label: 'Основное',
      fields: [
        'materialCode', 'name', 'category', 'unit', 'weightPerUnit', 'isActive',
        'stockQty', 'createdAt', 'updatedAt',
      ],
    },
    {
      code: 'price',
      label: 'Цены',
      fields: ['purchasePrice', 'priceUpdatedAt', 'lastPurchasePrice'],
    },
  ],

  bom: [
    {
      code: 'core',
      label: 'Состав',
      fields: [
        'articleId', 'materialId', 'qtyPerUnit', 'unit', 'operationType',
        'sortOrder', 'notes',
      ],
    },
    {
      code: 'cost',
      label: 'Стоимость',
      isCalculated: true,
      fields: ['lineCost', 'lineMass'],
    },
  ],

  routing: [
    {
      code: 'norm',
      label: 'Норма',
      fields: ['stage', 'workers', 'hoursPerUnit', 'workCenterId', 'notes'],
    },
    {
      code: 'actual',
      label: 'Факт',
      fields: ['actualWorkers', 'actualHours'],
    },
    {
      code: 'cost',
      label: 'Стоимость',
      isCalculated: true,
      fields: ['stageCost', 'manHours'],
    },
  ],

  payment: [
    {
      code: 'core',
      label: 'Документ',
      fields: [
        'doNumber', 'doDate', 'contractorId', 'contractor', 'currency', 'category',
        'status', 'orderId', 'invoiceNumber', 'invoiceDate', 'binIin',
      ],
    },
    {
      code: 'amounts',
      label: 'Суммы',
      fields: ['totalAmount', 'paidAmount', 'unpaidAmount', 'payments'],
    },
  ],

  stockFg: [
    {
      code: 'core',
      label: 'Движения ГП',
      fields: [
        'articleId', 'article', 'movementType', 'qty', 'unitPrice', 'totalAmount',
        'movementDate', 'comment', 'sourceDocumentId',
      ],
    },
  ],

  stockMaterial: [
    {
      code: 'core',
      label: 'Движения ТМЦ',
      fields: [
        'materialId', 'material', 'movementType', 'qty', 'unitPrice', 'totalAmount',
        'movementDate', 'comment', 'sourceDocumentId',
      ],
    },
  ],

  costingConfig: [
    {
      code: 'core',
      label: 'Коэффициенты',
      fields: [
        'hourlyRate', 'logisticsPct', 'utilitiesPct', 'vatPct', 'marginPct',
        'paymentTermDays', 'weldingFactor', 'validFrom', 'validTo',
      ],
    },
  ],
};

/** Код права: "order.commercial:write" | "routing:read" (без группы = вся сущность) */
export type PermissionCode = string;

export function permissionCode(
  resource: string,
  group: string | null,
  action: PermissionAction,
): PermissionCode {
  return group ? `${resource}.${group}:${action}` : `${resource}:${action}`;
}

/**
 * Матрица §1.7 (07_ARCHITECTURE_AND_UX.md): роль → права.
 * R → :read, W → :read + :write, A → :read + :approve.
 * Ключ "resource.group" или "resource" (все группы разом).
 */
const R = 'read' as const;
const W = 'write' as const;
const A = 'approve' as const;
type Grant = typeof R | typeof W | typeof A;

const ROLE_MATRIX: Record<string, Record<string, Grant>> = {
  sales_manager: {
    'order.core': W,
    'order.commercial': W,
    'order.production': R,
    'order.logistics': R,
    'article.core': R,
    'article.price': R,
    'payment.core': R,
    'payment.amounts': R,
    'stockFg.core': R,
  },
  accountant: {
    'order.core': R,
    'order.commercial': W,
    'order.logistics': R,
    'order.cost': R,
    'article.core': R,
    'article.price': R,
    'article.cost': R,
    'material.price': R,
    'payment.core': W,
    'payment.amounts': W,
    'stockFg.core': R,
  },
  director: {
    'order.core': R,
    'order.commercial': R,
    'order.production': R,
    'order.logistics': R,
    'order.cost': R,
    'article.core': R,
    'article.price': A,
    'article.cost': R,
    'bom.core': R,
    'bom.cost': R,
    'routing.norm': R,
    'routing.actual': R,
    'routing.cost': R,
    'material.core': R,
    'material.price': R,
    'payment.core': R,
    'payment.amounts': R,
    'stockFg.core': R,
    'stockMaterial.core': R,
    'costingConfig.core': A,
    audit: R,
  },
  engineer: {
    'order.core': R,
    'order.production': R,
    'order.cost': R,
    'article.core': W,
    'article.cost': R,
    'bom.core': W,
    'bom.cost': R,
    'routing.norm': W,
    'routing.actual': R,
    'routing.cost': R,
    'material.core': R,
    'material.price': R,
    'stockMaterial.core': R,
    'costingConfig.core': R,
  },
  planner: {
    'order.core': R,
    'order.production': W,
    'order.logistics': R,
    'article.core': R,
    'article.price': R,
    'bom.core': R,
    'routing.norm': R,
    'routing.actual': R,
    'material.core': R,
    'stockFg.core': R,
    'stockMaterial.core': R,
  },
  shop_foreman: {
    'order.core': R,
    'order.production': R,
    'order.logistics': R,
    'article.core': R,
    'bom.core': R,
    'routing.norm': R,
    'routing.actual': W,
    'stockFg.core': R,
  },
  procurement: {
    'order.core': R,
    'order.commercial': R,
    'order.production': R,
    'article.core': R,
    'article.price': R,
    'bom.core': R,
    'material.core': W,
    'material.price': W,
    'payment.core': W,
    'payment.amounts': W,
    'stockMaterial.core': R,
  },
  warehouse_material: {
    'order.core': R,
    'article.core': R,
    'material.core': W,
    'material.price': R,
    'stockMaterial.core': W,
  },
  warehouse_fg: {
    'order.core': R,
    'order.production': W,
    'order.logistics': W,
    'article.core': R,
    'stockFg.core': W,
  },
  viewer: {
    'order.core': R,
    'order.logistics': R,
    'article.core': R,
  },
  admin: {
    // admin получает все права автоматически (см. permissionsForRoles),
    // матрица оставлена пустой намеренно.
  },
};

/** Семейства ролей — для группировки в UI (§1.2) */
export const ROLE_FAMILIES: Record<string, string> = {
  admin: 'admin',
  sales_manager: 'commercial',
  accountant: 'commercial',
  director: 'commercial',
  engineer: 'engineering',
  planner: 'engineering',
  shop_foreman: 'engineering',
  procurement: 'supply',
  warehouse_material: 'supply',
  warehouse_fg: 'supply',
  viewer: 'viewer',
};

/** Полный список всех возможных прав (для сида и для admin) */
export function allPermissionCodes(): PermissionCode[] {
  const codes: PermissionCode[] = [];
  for (const [resource, groups] of Object.entries(FIELD_GROUPS)) {
    for (const group of groups) {
      codes.push(permissionCode(resource, group.code, 'read'));
      if (!group.isCalculated) {
        codes.push(permissionCode(resource, group.code, 'write'));
        codes.push(permissionCode(resource, group.code, 'approve'));
      }
    }
  }
  codes.push('audit:read');
  return codes;
}

function expandGrant(key: string, grant: Grant): PermissionCode[] {
  const [resource, group] = key.includes('.') ? key.split('.') : [key, null];
  const read = permissionCode(resource, group, 'read');
  if (grant === R) return [read];
  if (grant === W) return [read, permissionCode(resource, group, 'write')];
  return [read, permissionCode(resource, group, 'approve')];
}

/** Права набора ролей (объединение). admin → всё. */
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

/** Обратный индекс: resource → field → group code. Строится один раз. */
const fieldGroupIndex = new Map<string, Map<string, string>>();
for (const [resource, groups] of Object.entries(FIELD_GROUPS)) {
  const idx = new Map<string, string>();
  for (const group of groups) {
    for (const field of group.fields) idx.set(field, group.code);
  }
  fieldGroupIndex.set(resource, idx);
}

export function groupOfField(resource: string, field: string): string | null {
  return fieldGroupIndex.get(resource)?.get(field) ?? null;
}

function readableGroups(resource: string, permissions: PermissionCode[]): Set<string> {
  const set = new Set<string>();
  for (const group of FIELD_GROUPS[resource] ?? []) {
    if (permissions.includes(permissionCode(resource, group.code, 'read'))) {
      set.add(group.code);
    }
  }
  return set;
}

/**
 * Проекция ответа API: поля групп без права :read удаляются из объекта.
 * Поля, не описанные ни в одной группе (id, тех.поля), проходят как есть.
 * Работает рекурсивно для массивов и вложенных объектов первого уровня
 * (order.orderLines[] — те же группы, что и order).
 */
export function projectByPermissions<T>(
  payload: T,
  resource: string,
  permissions: PermissionCode[],
): T {
  const groups = FIELD_GROUPS[resource];
  if (!groups) return payload;
  const allowed = readableGroups(resource, permissions);
  // все группы читаемы — проекция не нужна
  if (allowed.size === groups.length) return payload;
  const idx = fieldGroupIndex.get(resource)!;

  const projectObject = (obj: unknown): unknown => {
    if (Array.isArray(obj)) return obj.map(projectObject);
    if (obj === null || typeof obj !== 'object' || obj instanceof Date) return obj;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const group = idx.get(key);
      if (group && !allowed.has(group)) continue; // поле закрытой группы — не отдаём
      // вложенные строки заказа проецируются по тем же правилам
      out[key] =
        value && typeof value === 'object' && (key === 'orderLines' || key === 'lines')
          ? projectObject(value)
          : value;
    }
    return out;
  };

  // пагинированный ответ { data, meta }
  if (payload && typeof payload === 'object' && 'data' in (payload as any) && 'meta' in (payload as any)) {
    return { ...(payload as any), data: projectObject((payload as any).data) };
  }
  return projectObject(payload) as T;
}

/**
 * Запись: каждое поле тела должно принадлежать группе с правом :write.
 * Поля вне групп (клиентские id и т.п.) отсекаются молча — их валидирует DTO.
 * Поле закрытой группы → 403 с перечислением полей.
 */
export function assertFieldWriteAllowed(
  body: Record<string, unknown>,
  resource: string,
  permissions: PermissionCode[],
): void {
  const idx = fieldGroupIndex.get(resource);
  if (!idx) return;
  const denied: string[] = [];
  for (const field of Object.keys(body)) {
    const group = idx.get(field);
    if (!group) continue;
    const def = FIELD_GROUPS[resource].find((g) => g.code === group)!;
    if (def.isCalculated) continue; // расчётные ловит assertNoCalculatedFieldUpdate
    if (!permissions.includes(permissionCode(resource, group, 'write'))) {
      denied.push(field);
    }
  }
  if (denied.length > 0) {
    throw new ForbiddenException({
      code: 'FIELD_WRITE_FORBIDDEN',
      message: `Нет прав на изменение полей: ${denied.join(', ')}`,
      fields: denied,
    });
  }
}


/**
 * Ограничение видимости строк (§1.8 07_ARCHITECTURE_AND_UX.md).
 *  'customer' — только строки привязанного заказчика (User.linkedCustomerId);
 *  'own'      — только свои (Order.managerId = User.employeeId);
 *  нет записи — видит все строки.
 * Скоупы для мастера цеха/менеджера — открытые вопросы №5/№1 плана,
 * до решения заказчика они не ограничены.
 */
export type RowScope = 'own' | 'customer';

export const ROLE_ROW_SCOPES: Record<string, Record<string, RowScope>> = {
  viewer: { order: 'customer' },
};

/**
 * Скоуп набора ролей: объединение — если хоть одна роль видит всё, видит всё.
 * admin всегда без ограничений.
 */
export function rowScopeForRoles(roles: string[], resource: string): RowScope | null {
  if (roles.length === 0) return null;
  if (roles.includes('admin')) return null;
  const scopes: RowScope[] = [];
  for (const role of roles) {
    const scope = ROLE_ROW_SCOPES[role]?.[resource];
    if (!scope) return null; // роль без ограничения расширяет видимость до всех строк
    scopes.push(scope);
  }
  // 'own' уже, чем 'customer' — при нескольких ограниченных ролях берём более широкий
  return scopes.includes('customer') ? 'customer' : scopes[0];
}

/** Описание групп для /auth/me — фронтенд строит формы и пресеты колонок из этого */
export function fieldGroupsForUi(): Record<
  string,
  Array<{ code: string; label: string; fields: string[]; isCalculated: boolean }>
> {
  const out: Record<string, Array<{ code: string; label: string; fields: string[]; isCalculated: boolean }>> = {};
  for (const [resource, groups] of Object.entries(FIELD_GROUPS)) {
    out[resource] = groups.map((g) => ({
      code: g.code,
      label: g.label,
      fields: g.fields,
      isCalculated: !!g.isCalculated,
    }));
  }
  return out;
}
