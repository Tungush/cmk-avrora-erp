import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Card, Stack, Group, Text, Badge, SimpleGrid, Box, Skeleton, Title,
  Table, Progress, ThemeIcon, Anchor, Tooltip,
} from '@mantine/core';
import {
  IconCoin, IconScale, IconAlertTriangle, IconInbox,
  IconGavel, IconClockExclamation, IconFlask, IconReceipt,
} from '@tabler/icons-react';
import { dashboardApi } from '../../api/dashboard';
import { KpiCard } from '../../components/KpiCard';
import { StatusBadge } from '../../components/StatusBadge';
import { formatCurrency } from '../../utils/formatters';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { FadeRise, Stagger } from '../../components/motion';

const HEALTH_COLORS: Record<string, string> = {
  OK: 'teal', WARN: 'yellow', CRITICAL: 'red', NO_COSTING: 'gray',
};
const HEALTH_LABELS: Record<string, string> = {
  OK: 'в норме', WARN: 'ниже цели', CRITICAL: 'критично', NO_COSTING: 'нет калькуляции',
};

/**
 * Экран директора (решение 22.08.2026): три вопроса одного взгляда —
 * «мы зарабатываем?» (маржа 35 % от цены план/факт), «что ждёт моего
 * решения?» (перехваты, цены, зависшие заявки), «где деньги?» (ДО).
 */
export function DirectorDashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', 'director'],
    queryFn: () => dashboardApi.getDirector().then((r) => r.data),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return (
      <Stack gap="lg">
        <Skeleton height={60} radius="lg" />
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="lg">
          {[...Array(4)].map((_, i) => <Skeleton key={i} height={140} radius="lg" />)}
        </SimpleGrid>
        <Skeleton height={400} radius="lg" />
      </Stack>
    );
  }

  const { margin, needsDecision, money, overdue } = data;
  const decisions: Array<{ icon: React.ReactNode; label: string; count: number; to: string; color: string }> = [
    { icon: <IconGavel size={18} />, label: 'Перехваты партий ждут решения', count: needsDecision.batchOverrides, to: '/warehouse?tab=batches', color: 'red' },
    { icon: <IconReceipt size={18} />, label: 'Заявки на пересмотр цены', count: needsDecision.priceReviews, to: '/dashboard', color: 'orange' },
    { icon: <IconClockExclamation size={18} />, label: 'Заявки на номенклатуру просрочили SLA', count: needsDecision.nomenclatureStuck, to: '/settings', color: 'orange' },
    { icon: <IconFlask size={18} />, label: 'Партии в карантине цен', count: needsDecision.quarantineBatches, to: '/warehouse?tab=batches', color: 'yellow' },
    { icon: <IconClockExclamation size={18} />, label: 'Резервы истекают в 3 дня', count: needsDecision.expiringReservations, to: '/warehouse?tab=batches', color: 'yellow' },
    { icon: <IconInbox size={18} />, label: 'Новые заказы из 1С ждут приёма', count: needsDecision.inboxOrders, to: '/orders/inbox', color: 'blue' },
  ].filter((d) => d.count > 0);

  const paidPct = money.totalContracted > 0 ? (money.totalPaid / money.totalContracted) * 100 : 0;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <Stack gap={4}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
            Экран директора
          </Text>
          <Title order={2} fw={700} style={{ letterSpacing: '-0.01em' }}>
            Маржа · Решения · Деньги
          </Title>
        </Stack>
        <Text size="sm" c="dimmed" ff="monospace">
          {new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
        </Text>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="lg">
        <Stagger>
        <KpiCard
          title="Маржа портфеля"
          value={margin.actualPct !== null ? `${margin.actualPct}%` : '—'}
          subtitle={`цель ${margin.targetPct}% от цены`}
          icon={<IconScale size={20} />}
        />
        <KpiCard
          title="Маржа, деньги"
          value={formatCurrency(margin.totalMargin)}
          subtitle={`при выручке ${formatCurrency(margin.totalPrice)}`}
          icon={<IconCoin size={20} />}
        />
        <KpiCard
          title="Не оплачено по ДО"
          value={formatCurrency(money.totalUnpaid)}
          subtitle={`из ${formatCurrency(money.totalContracted)} законтрактовано`}
          icon={<IconReceipt size={20} />}
        />
        <KpiCard
          title="Требует решения"
          value={decisions.reduce((s, d) => s + d.count, 0)}
          subtitle="перехваты · цены · заявки"
          icon={<IconAlertTriangle size={20} />}
        />
        </Stagger>
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        {/* Лента «требует решения» — то, ради чего директор открывает систему */}
        <Card withBorder padding="lg" radius="lg">
          <Text fw={800} size="lg" mb="md">Требует решения</Text>
          {decisions.length === 0 ? (
            <Text c="dimmed" size="sm">Всё разобрано — решений не ждёт ничего.</Text>
          ) : (
            <Stack gap="sm">
              {decisions.map((d) => (
                <Anchor component={Link} to={d.to} key={d.label} underline="never" c="inherit">
                  <Group justify="space-between" p="sm" style={{ borderRadius: 12, border: '1px solid var(--mantine-color-default-border)' }}>
                    <Group gap="sm">
                      <ThemeIcon variant="light" color={d.color} radius="md">{d.icon}</ThemeIcon>
                      <Text size="sm" fw={600}>{d.label}</Text>
                    </Group>
                    <Badge size="lg" variant="filled" color={d.color} radius="xl">{d.count}</Badge>
                  </Group>
                </Anchor>
              ))}
            </Stack>
          )}
        </Card>

        {/* Деньги по ДО */}
        <Card withBorder padding="lg" radius="lg">
          <Text fw={800} size="lg" mb="md">Деньги по договорам-основаниям</Text>
          <Stack gap="md">
            <Box>
              <Group justify="space-between" mb={6}>
                <Text size="sm" c="dimmed">Оплачено</Text>
                <Text size="sm" fw={700}>{formatCurrency(money.totalPaid)} · {paidPct.toFixed(0)}%</Text>
              </Group>
              <Progress value={paidPct} size="lg" radius="xl" color="teal" />
            </Box>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">Законтрактовано</Text>
              <Text fw={700}>{formatCurrency(money.totalContracted)}</Text>
            </Group>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">Остаток к оплате</Text>
              <Text fw={700} c="orange.7">{formatCurrency(money.totalUnpaid)}</Text>
            </Group>
            {overdue.length > 0 && (
              <Box>
                <Text size="sm" fw={700} c="red.7" mb={4}>Просроченные заказы</Text>
                {overdue.map((o) => (
                  <Group key={o.id} justify="space-between">
                    <Group gap={6}><OrderRef id={o.id} number={o.orderNumber} /><Text size="sm" c="dimmed">{o.customer.name}</Text></Group>
                    <Badge color="red" variant="light">{o.overdueDays} дн</Badge>
                  </Group>
                ))}
              </Box>
            )}
          </Stack>
        </Card>
      </SimpleGrid>

      {/* Маржа по заказам: отсортировано от худшего — проблемы сверху */}
      <Card withBorder padding="lg" radius="lg">
        <Group justify="space-between" mb="md">
          <Stack gap={2}>
            <Text fw={800} size="lg">Маржа по активным заказам</Text>
            <Text size="xs" c="dimmed">
              Целевая — {margin.targetPct} % от цены. Худшие сверху: на них и смотреть.
            </Text>
          </Stack>
        </Group>
        <Table.ScrollContainer minWidth={720}>
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Заказ</Table.Th>
                <Table.Th>Заказчик</Table.Th>
                <Table.Th>Статус</Table.Th>
                <Table.Th ta="right">Себестоимость</Table.Th>
                <Table.Th ta="right">Цена</Table.Th>
                <Table.Th ta="right">Маржа</Table.Th>
                <Table.Th>Здоровье</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {margin.orders.map((o) => (
                <Table.Tr key={o.id}>
                  <Table.Td><OrderRef id={o.id} number={o.orderNumber} focus="cost" /></Table.Td>
                  <Table.Td><Text size="sm">{o.customer.name}</Text></Table.Td>
                  <Table.Td><StatusBadge status={o.status} /></Table.Td>
                  <Table.Td ta="right" ff="monospace">{o.totalCost !== null ? formatCurrency(o.totalCost) : '—'}</Table.Td>
                  <Table.Td ta="right" ff="monospace">{o.totalPrice !== null ? formatCurrency(o.totalPrice) : '—'}</Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {o.marginPct !== null ? `${o.marginPct}%` : '—'}
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={o.marginHealth === 'NO_COSTING' ? 'Согласованной калькуляции нет — маржа неизвестна' : `Маржа ${o.marginPct}% при цели ${margin.targetPct}%`}>
                      <Badge color={HEALTH_COLORS[o.marginHealth]} variant="light" radius="xl">
                        {HEALTH_LABELS[o.marginHealth]}
                      </Badge>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </Stack>
  );
}
