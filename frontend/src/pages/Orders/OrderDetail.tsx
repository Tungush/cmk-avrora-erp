import React, { useState } from 'react';
import {
  Stack, Group, Text, Card, Badge, Button, Textarea, Divider, Table, Skeleton, Box,
  Popover, ActionIcon,
} from '@mantine/core';
import { IconLock, IconAlertTriangle, IconHelpCircle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useOrder, useTransitionOrderStatus } from '../../hooks/useOrders';
import { useAuthStore } from '../../store/auth';
import { getAllowedTransitions, STATE_TRANSITIONS } from '../../utils/roles';
import { StatusBadge } from '../../components/StatusBadge';
import { formatCurrency, formatDate, ORDER_STATUS_LABELS } from '../../utils/formatters';

const ORDER_TYPE_LABELS: Record<string, string> = { FZ: 'ФЗ', VZ: 'ВЗ' };

/**
 * Раскрывающийся расчёт (§2.3 ③): кнопка [?] у расчётного поля показывает
 * разбор формулы построчно — вместо =IF(M6<0;"";IF($L6-SUM(...)>0;...)).
 */
function BalanceExplain({ lines }: { lines: any[] }) {
  const sum = (f: string) => lines.reduce((s, l) => s + Number(l?.[f] ?? 0), 0);
  const rows = [
    { label: 'Сумма с НДС', value: sum('lineTotalVat'), sign: '' },
    { label: 'Аванс', value: sum('prepayment'), sign: '−' },
    { label: 'Постоплата 1', value: sum('postPayment1'), sign: '−' },
    { label: 'Постоплата 2', value: sum('postPayment2'), sign: '−' },
    { label: 'Штраф', value: sum('penalty'), sign: '−' },
  ];
  const balance = sum('balanceDue');

  return (
    <Popover width={300} position="bottom-end" shadow="md" radius="md">
      <Popover.Target>
        <ActionIcon variant="subtle" color="gray" size="xs" aria-label="Разбор формулы">
          <IconHelpCircle size={14} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={4}>
          <Text size="xs" fw={700} mb={2}>Как считается остаток</Text>
          {rows.map((r) => (
            <Group key={r.label} justify="space-between" gap="xs">
              <Text size="xs" c="dimmed">{r.sign ? `${r.sign} ` : ''}{r.label}</Text>
              <Text size="xs" ff="monospace">{formatCurrency(r.value)}</Text>
            </Group>
          ))}
          <Divider my={2} />
          <Group justify="space-between" gap="xs">
            <Text size="xs" fw={700}>= Остаток к оплате</Text>
            <Text size="xs" fw={700} ff="monospace">{formatCurrency(balance)}</Text>
          </Group>
          <Text size="xs" c="dimmed" mt={4}>Суммируется по всем позициям заказа</Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Строка «метка — значение» внутри секции карточки */
function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="md">
      <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{label}</Text>
      <Text size="sm" fw={500} ff={mono ? 'monospace' : undefined} ta="right">
        {value ?? '—'}
      </Text>
    </Group>
  );
}

/** Секция карточки = группа полей (§1.3: группа полей = секция в карточке) */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card withBorder radius="md" padding="md">
      <Text fw={700} size="sm" mb="xs">{title}</Text>
      <Stack gap={6}>{children}</Stack>
    </Card>
  );
}

/** Блок «нет доступа» — честно подписан, а не пуст (§2.3 ①) */
function LockedSection({ title, roleName }: { title: string; roleName: string }) {
  return (
    <Card withBorder radius="md" padding="md" bg="var(--mantine-color-default-hover)">
      <Group gap="xs">
        <IconLock size={15} style={{ color: 'var(--mantine-color-gray-5)' }} />
        <Text fw={600} size="sm" c="dimmed">{title} — нет доступа</Text>
      </Group>
      <Text size="xs" c="dimmed" mt={4}>Данные существуют, но закрыты для роли «{roleName}»</Text>
    </Card>
  );
}

export function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: order, isLoading } = useOrder(id);
  const { mutateAsync: transitionStatus, isPending } = useTransitionOrderStatus();
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const [comment, setComment] = useState('');

  if (isLoading || !order) {
    return (
      <Stack gap="md">
        {[...Array(4)].map((_, i) => <Skeleton key={i} height={110} radius="md" />)}
      </Stack>
    );
  }

  const lines: any[] = (order as any).orderLines ?? (order as any).lines ?? [];
  const sum = (field: string) => lines.reduce((s, l) => s + Number(l?.[field] ?? 0), 0);

  const canCommercial = can('read', 'order.commercial');
  const canProduction = can('read', 'order.production');
  const canLogistics = can('read', 'order.logistics');
  const roleName = user?.roles?.[0] ?? '—';

  const allowedTransitions = getAllowedTransitions(order.status, user?.roles || []);
  const allPossibleTransitions = STATE_TRANSITIONS[order.status] || [];

  const handleTransition = async (toStatus: string) => {
    if (toStatus === 'CANCELLED' && !comment.trim()) {
      notifications.show({ title: 'Нужен комментарий', message: 'Укажите причину отмены', color: 'warning' });
      return;
    }
    try {
      await transitionStatus({ id, toStatus, comment: comment || undefined });
      notifications.show({
        title: 'Статус изменён',
        message: `${order.orderNumber} → ${ORDER_STATUS_LABELS[toStatus] ?? toStatus}`,
        color: 'success',
      });
      onClose();
    } catch (e: any) {
      const msg = e?.response?.data?.error?.message ?? 'Ошибка при смене статуса';
      notifications.show({ title: 'Переход отклонён', message: msg, color: 'danger', icon: <IconAlertTriangle size={16} /> });
    }
  };

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm">
          <Text fw={800} size="lg" ff="monospace">{order.orderNumber}</Text>
          <StatusBadge status={order.status} />
        </Group>
        {order.overdueDays > 0 && (
          <Badge color="danger" variant="light" radius="xl" leftSection={<IconAlertTriangle size={12} />}>
            Просрочка {order.overdueDays} дн
          </Badge>
        )}
      </Group>

      {/* ▼ Основное — order.core, читают все */}
      <Section title="Основное">
        <Row label="Заказчик" value={(order as any).customer?.name ?? order.customerName} />
        <Row label="Тип заказа" value={ORDER_TYPE_LABELS[order.orderType] ?? order.orderType} />
        <Row label="Регион" value={order.region || '—'} />
        <Row label="Заявка от" value={formatDate(order.requestDate)} mono />
        <Row label="План вывоза" value={formatDate(order.plannedShipmentDate)} mono />
      </Section>

      {/* ▼ Финансы — order.commercial; закрытый блок подписан, а не пуст */}
      {canCommercial ? (
        <Section title="Финансы">
          <Row label="Сумма с НДС" value={formatCurrency(sum('lineTotalVat'))} mono />
          <Row label="Аванс" value={formatCurrency(sum('prepayment'))} mono />
          <Group justify="space-between" wrap="nowrap" gap="md">
            <Group gap={4} wrap="nowrap">
              <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>Остаток к оплате</Text>
              <BalanceExplain lines={lines} />
            </Group>
            <Text size="sm" fw={500} ff="monospace" ta="right">{formatCurrency(sum('balanceDue'))}</Text>
          </Group>
        </Section>
      ) : (
        <LockedSection title="Финансы" roleName={roleName} />
      )}

      {/* ▼ Производство — order.production */}
      {canProduction ? (
        <Section title="Производство">
          <Row label="Заказано" value={`${sum('qty')} шт`} mono />
          <Row label="В резерве" value={`${sum('reservedQty')} шт`} mono />
          <Row label="Отгружено" value={`${sum('shippedQty')} шт`} mono />
        </Section>
      ) : (
        <LockedSection title="Производство" roleName={roleName} />
      )}

      {/* ▼ Отгрузка — order.logistics */}
      {canLogistics ? (
        <Section title="Отгрузка">
          <Row label="План вывоза" value={formatDate(order.plannedShipmentDate)} mono />
          <Row label="Факт отгрузки" value={formatDate(order.actualShipmentDate)} mono />
        </Section>
      ) : (
        <LockedSection title="Отгрузка" roleName={roleName} />
      )}

      {/* Позиции: колонки цен видны только с правом на order.commercial */}
      <Card withBorder radius="md" padding="md">
        <Text fw={700} size="sm" mb="xs">Позиции ({lines.length})</Text>
        {lines.length === 0 ? (
          <Text size="sm" c="dimmed">Позиций нет</Text>
        ) : (
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Артикул</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Кол-во</Table.Th>
                {canCommercial && <Table.Th style={{ textAlign: 'right' }}>Цена</Table.Th>}
                {canCommercial && <Table.Th style={{ textAlign: 'right' }}>Сумма с НДС</Table.Th>}
                {canCommercial && <Table.Th style={{ textAlign: 'right' }}>К оплате</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lines.map((l) => (
                <Table.Tr key={l.id}>
                  <Table.Td>
                    <Text size="sm" ff="monospace">{l.article?.articleCode ?? l.articleCode ?? '—'}</Text>
                    {l.article?.name && <Text size="xs" c="dimmed" lineClamp={1}>{l.article.name}</Text>}
                  </Table.Td>
                  <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{Number(l.qty)} {l.unit}</Table.Td>
                  {canCommercial && <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{formatCurrency(Number(l.unitPrice ?? 0))}</Table.Td>}
                  {canCommercial && <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{formatCurrency(Number(l.lineTotalVat ?? 0))}</Table.Td>}
                  {canCommercial && <Table.Td ff="monospace" fw={600} style={{ textAlign: 'right' }}>{formatCurrency(Number(l.balanceDue ?? 0))}</Table.Td>}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>

      {/* Действия — переходы статуса по state machine, кнопки только на разрешённые роли */}
      <Card withBorder radius="md" padding="md" bg="var(--mantine-color-default-hover)">
        <Text fw={700} size="sm" mb="xs">Действия</Text>
        {allPossibleTransitions.length === 0 ? (
          <Text size="sm" c="dimmed">Заказ в конечном статусе — действий нет</Text>
        ) : (
          <Stack gap="xs">
            {allPossibleTransitions.map((status) => {
              const isAllowed = allowedTransitions.includes(status);
              return (
                <Button
                  key={status}
                  variant={status === 'CANCELLED' ? 'light' : 'filled'}
                  color={status === 'CANCELLED' ? 'danger' : undefined}
                  disabled={!isAllowed || isPending}
                  onClick={() => handleTransition(status)}
                  justify="flex-start"
                  rightSection={!isAllowed ? <IconLock size={14} /> : undefined}
                  title={!isAllowed ? 'Нет прав для перехода' : undefined}
                >
                  {ORDER_STATUS_LABELS[status] ?? status}
                </Button>
              );
            })}
            {allPossibleTransitions.includes('CANCELLED') && (
              <Textarea
                placeholder="Причина отмены (обязательна для отмены)..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                size="sm"
              />
            )}
          </Stack>
        )}
      </Card>

      <Box />
    </Stack>
  );
}
