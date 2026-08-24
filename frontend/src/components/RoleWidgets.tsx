import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, SimpleGrid, Skeleton, Progress,
} from '@mantine/core';
import {
  IconAlertTriangle, IconCoin, IconRuler2, IconTruck, IconShoppingCart, IconScale,
} from '@tabler/icons-react';
import api from '../api/client';
import { StatusBadge } from './StatusBadge';
import { formatCurrency, formatDate, ORDER_STATUS_LABELS } from '../utils/formatters';
import { OrderRef } from './OrderCard/OrderCardProvider';

interface RoleWidgetsResponse {
  family: string | null;
  widgets: {
    orderFunnel?: Array<{ status: string; count: number }>;
    overdueOrders?: { count: number; top: Array<{ id: string; orderNumber: string; overdueDays: number; plannedShipmentDate: string | null; customer: { name: string } | null }> };
    awaitingPayment?: { linesCount: number; totalDue: number };
    specsWithoutNorms?: { count: number; top: Array<{ id: string; articleCode: string; name: string }> };
    priceDeviations?: Array<{ id: string; articleCode: string; name: string; approvedPrice: number; specPrice: number; deviationPct: number }>;
    procurement?: Array<{ status: string; count: number }>;
    readyToShip?: { count: number; top: Array<{ id: string; orderNumber: string; plannedShipmentDate: string | null; customer: { name: string } | null }> };
  };
}

function useRoleWidgets() {
  return useQuery({
    queryKey: ['role-widgets'],
    queryFn: () => api.get<RoleWidgetsResponse>('/dashboards/role-widgets').then((r) => r.data),
  });
}

function WidgetCard({ icon, title, badge, children }: {
  icon: React.ReactNode; title: string; badge?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <Card withBorder radius="md" padding="md">
      <Group gap="xs" mb="sm" justify="space-between">
        <Group gap="xs">
          {icon}
          <Text fw={700} size="sm">{title}</Text>
        </Group>
        {badge}
      </Group>
      {children}
    </Card>
  );
}

const PR_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Черновик', APPROVED: 'Утверждена', ORDERED: 'Заказано',
};

/**
 * Ролевые виджеты (§2.4): состав приходит с сервера по правам —
 * инженер не видит выручку, менеджер — очередь на расчёт норм.
 */
export function RoleWidgets() {
  const { data, isLoading } = useRoleWidgets();

  if (isLoading) {
    return (
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        {[...Array(2)].map((_, i) => <Skeleton key={i} height={180} radius="md" />)}
      </SimpleGrid>
    );
  }
  const w = data?.widgets;
  if (!w) return null;

  const funnelTotal = (w.orderFunnel ?? []).reduce((s, r) => s + r.count, 0);
  const cards: React.ReactNode[] = [];

  if (w.overdueOrders && w.overdueOrders.count > 0) {
    cards.push(
      <WidgetCard
        key="overdue"
        icon={<IconAlertTriangle size={17} style={{ color: 'var(--err-6, #E53228)' }} />}
        title="Просроченные заказы"
        badge={<Badge color="danger" variant="light" radius="xl">{w.overdueOrders.count}</Badge>}
      >
        <Stack gap={4}>
          {w.overdueOrders.top.map((o) => (
            <Group key={o.id} justify="space-between" wrap="nowrap" gap="xs">
              <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                <OrderRef id={o.id} number={o.orderNumber} size="xs" />
                <Text size="xs" c="dimmed" truncate>{o.customer?.name ?? '—'}</Text>
              </Group>
              <Badge size="sm" color="danger" variant="light" radius="xl">{o.overdueDays} дн</Badge>
            </Group>
          ))}
        </Stack>
      </WidgetCard>,
    );
  }

  if (w.orderFunnel && funnelTotal > 0) {
    cards.push(
      <WidgetCard
        key="funnel"
        icon={<IconShoppingCart size={17} style={{ color: 'var(--brand-6, #0057FF)' }} />}
        title="Воронка по стадиям"
        badge={<Text size="xs" c="dimmed" ff="monospace">{funnelTotal.toLocaleString('ru-RU')}</Text>}
      >
        <Stack gap={6}>
          {w.orderFunnel
            .slice()
            .sort((a, b) => b.count - a.count)
            .map((r) => (
              <Group key={r.status} justify="space-between" wrap="nowrap" gap="xs">
                <StatusBadge status={r.status} />
                <Group gap="xs" wrap="nowrap" style={{ flex: 1, maxWidth: '60%' }}>
                  <Progress value={(r.count / funnelTotal) * 100} size="sm" radius="xl" style={{ flex: 1 }} />
                  <Text size="xs" ff="monospace" w={54} ta="right">{r.count.toLocaleString('ru-RU')}</Text>
                </Group>
              </Group>
            ))}
        </Stack>
      </WidgetCard>,
    );
  }

  if (w.awaitingPayment && w.awaitingPayment.linesCount > 0) {
    cards.push(
      <WidgetCard
        key="payment"
        icon={<IconCoin size={17} style={{ color: 'var(--warn-6, #FF9500)' }} />}
        title="Ожидают оплаты"
        badge={<Badge color="warning" variant="light" radius="xl">{w.awaitingPayment.linesCount}</Badge>}
      >
        <Text size="xl" fw={800} ff="monospace">{formatCurrency(w.awaitingPayment.totalDue)}</Text>
        <Text size="xs" c="dimmed">остаток к оплате по {w.awaitingPayment.linesCount.toLocaleString('ru-RU')} позициям</Text>
      </WidgetCard>,
    );
  }

  if (w.specsWithoutNorms && w.specsWithoutNorms.count > 0) {
    cards.push(
      <WidgetCard
        key="norms"
        icon={<IconRuler2 size={17} style={{ color: 'var(--warn-6, #FF9500)' }} />}
        title="Спецификации без норм труда"
        badge={<Badge color="warning" variant="light" radius="xl">{w.specsWithoutNorms.count.toLocaleString('ru-RU')}</Badge>}
      >
        <Stack gap={4}>
          {w.specsWithoutNorms.top.map((a) => (
            <Group key={a.id} gap={8} wrap="nowrap">
              <Text size="xs" ff="monospace" fw={600} c="brand.7">{a.articleCode}</Text>
              <Text size="xs" c="dimmed" truncate>{a.name}</Text>
            </Group>
          ))}
          <Text size="xs" c="dimmed" mt={2}>
            До заполнения себестоимость помечается «неполная» (§6 плана)
          </Text>
        </Stack>
      </WidgetCard>,
    );
  }

  if (w.priceDeviations && w.priceDeviations.length > 0) {
    cards.push(
      <WidgetCard
        key="deviations"
        icon={<IconScale size={17} style={{ color: 'var(--info-6, #0B7FD4)' }} />}
        title="Топ-расхождения «цена ↔ себестоимость»"
      >
        <Stack gap={4}>
          {w.priceDeviations.map((a) => (
            <Group key={a.id} justify="space-between" wrap="nowrap" gap="xs">
              <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                <Text size="xs" ff="monospace" fw={600} c="brand.7">{a.articleCode}</Text>
                <Text size="xs" c="dimmed" truncate>{a.name}</Text>
              </Group>
              <Group gap={8} wrap="nowrap">
                <Text size="xs" ff="monospace" c="dimmed">
                  {formatCurrency(a.approvedPrice)} / {formatCurrency(a.specPrice)}
                </Text>
                <Badge
                  size="sm"
                  variant="light"
                  radius="xl"
                  color={Math.abs(a.deviationPct) > 15 ? 'danger' : 'warning'}
                >
                  {a.deviationPct > 0 ? '+' : ''}{a.deviationPct.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %
                </Badge>
              </Group>
            </Group>
          ))}
        </Stack>
      </WidgetCard>,
    );
  }

  if (w.procurement && w.procurement.length > 0) {
    cards.push(
      <WidgetCard
        key="procurement"
        icon={<IconShoppingCart size={17} style={{ color: 'var(--brand-6, #0057FF)' }} />}
        title="Заявки на закуп"
      >
        <Group gap="sm">
          {w.procurement.map((r) => (
            <Badge key={r.status} variant="light" color="gray" radius="xl" size="lg">
              {PR_STATUS_LABELS[r.status] ?? r.status}: {r.count}
            </Badge>
          ))}
        </Group>
      </WidgetCard>,
    );
  }

  if (w.readyToShip && w.readyToShip.count > 0) {
    cards.push(
      <WidgetCard
        key="ship"
        icon={<IconTruck size={17} style={{ color: 'var(--ok-6, #00A854)' }} />}
        title="К отгрузке"
        badge={<Badge color="success" variant="light" radius="xl">{w.readyToShip.count}</Badge>}
      >
        <Stack gap={4}>
          {w.readyToShip.top.map((o) => (
            <Group key={o.id} justify="space-between" wrap="nowrap" gap="xs">
              <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                <OrderRef id={o.id} number={o.orderNumber} size="xs" />
                <Text size="xs" c="dimmed" truncate>{o.customer?.name ?? '—'}</Text>
              </Group>
              <Text size="xs" ff="monospace" c="dimmed">{formatDate(o.plannedShipmentDate)}</Text>
            </Group>
          ))}
        </Stack>
      </WidgetCard>,
    );
  }

  if (cards.length === 0) return null;

  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
      {cards}
    </SimpleGrid>
  );
}
