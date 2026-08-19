import React from 'react';
import { Tooltip, Box } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useAuthStore } from '../store/auth';

interface CanProps {
  /** Действие: read | write | approve */
  I: 'read' | 'write' | 'approve';
  /** Цель: "order.commercial", "routing.norm", … */
  a: string;
  /** Что показать при отсутствии права (по умолчанию — ничего) */
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Условный рендер по праву на группу полей (§1.6 07_ARCHITECTURE_AND_UX.md).
 *
 *   <Can I="write" a="order.commercial" fallback={<LockedField label="Цена" value={price} />}>
 *     <NumberInput label="Цена" … />
 *   </Can>
 *
 * Это только UI-удобство: сервер всё равно режет закрытые поля из JSON
 * и отклоняет запись без права (FIELD_WRITE_FORBIDDEN).
 */
export function Can({ I, a, fallback = null, children }: CanProps) {
  const can = useAuthStore((s) => s.can);
  return <>{can(I, a) ? children : fallback}</>;
}

interface LockedFieldProps {
  label?: string;
  /** undefined — данные не пришли (нет и права чтения) */
  value?: React.ReactNode;
  /** Почему заблокировано — показывается в подсказке и под полем */
  reason?: string;
}

/**
 * Поле без права записи/чтения — визуальный словарь §4.5:
 * значение видно (если есть право чтения), замок и причина — всегда.
 */
export function LockedField({ label, value, reason = 'Недоступно для вашей роли' }: LockedFieldProps) {
  return (
    <Box>
      {label && (
        <Box component="label" display="block" fz="sm" fw={500} mb={4} c="dimmed">
          {label}
        </Box>
      )}
      <Tooltip label={reason} withArrow position="top-start">
        <Box
          px={12}
          py={8}
          fz="sm"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            minHeight: 38,
            borderRadius: 'var(--mantine-radius-md)',
            border: '1px dashed var(--mantine-color-gray-4)',
            background: 'var(--mantine-color-gray-1)',
            color: value === undefined ? 'var(--mantine-color-gray-5)' : 'var(--mantine-color-gray-7)',
          }}
        >
          <span>{value === undefined ? '•••' : value}</span>
          <IconLock size={14} style={{ flexShrink: 0, color: 'var(--mantine-color-gray-5)' }} />
        </Box>
      </Tooltip>
      <Box fz={11} c="dimmed" mt={2}>
        {reason}
      </Box>
    </Box>
  );
}
