import { PrismaClient, PermissionAction } from '@prisma/client';
import {
  FIELD_GROUPS,
  ROLE_FAMILIES,
  allPermissionCodes,
  permissionsForRoles,
} from '../../src/common/field-access';

/**
 * Сид RBAC на уровне полей (Этап 1, 07_ARCHITECTURE_AND_UX.md).
 * Источник правды — src/common/field-access.ts; БД хранит копию,
 * которую админ сможет точечно править через UI.
 */
export async function seedRbac(prisma: PrismaClient) {
  console.log('Seeding field-level RBAC (permissions, role_permissions, field groups)...');

  // 1. Роль viewer (новая — в исходной таблице аналога нет)
  await prisma.role.upsert({
    where: { code: 'viewer' },
    update: {},
    create: {
      code: 'viewer',
      name: 'Наблюдатель',
      description: 'Только чтение итоговых статусов — для заказчиков и смежников',
    },
  });

  // 2. Семейства и признак системности
  for (const [code, family] of Object.entries(ROLE_FAMILIES)) {
    await prisma.role.updateMany({
      where: { code },
      data: { family, isSystem: code === 'admin' },
    });
  }

  // 3. Описания групп полей
  for (const [resource, groups] of Object.entries(FIELD_GROUPS)) {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      await prisma.fieldGroupDefinition.upsert({
        where: { resource_code: { resource, code: g.code } },
        update: { label: g.label, fields: g.fields, isCalculated: !!g.isCalculated, sortOrder: i },
        create: {
          resource,
          code: g.code,
          label: g.label,
          fields: g.fields,
          isCalculated: !!g.isCalculated,
          sortOrder: i,
        },
      });
    }
  }

  // 4. Права
  const actionMap: Record<string, PermissionAction> = {
    read: PermissionAction.READ,
    write: PermissionAction.WRITE,
    approve: PermissionAction.APPROVE,
  };
  const permissionIdByCode = new Map<string, string>();
  for (const code of allPermissionCodes()) {
    const [resourcePart, action] = code.split(':');
    const [resource, fieldGroup] = resourcePart.includes('.')
      ? resourcePart.split('.')
      : [resourcePart, null];
    const permission = await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, resource, fieldGroup, action: actionMap[action] },
    });
    permissionIdByCode.set(code, permission.id);
  }

  // 5. Привязка прав к ролям из матрицы §1.7
  const roles = await prisma.role.findMany();
  for (const role of roles) {
    const codes = permissionsForRoles([role.code]);
    for (const code of codes) {
      const permissionId = permissionIdByCode.get(code);
      if (!permissionId) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }

  console.log(`RBAC seeded: ${permissionIdByCode.size} permissions, ${roles.length} roles.`);
}
