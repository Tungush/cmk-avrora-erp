import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Card, Stack, Group, Text, Badge, Box, Skeleton,
  Table, Progress, ThemeIcon, Tooltip,
} from '@mantine/core';
import {
  IconScale, IconAlertTriangle, IconInbox,
  IconGavel, IconClockExclamation, IconFlask, IconReceipt,
  IconBuildingBank, IconInfoCircle,
} from '@tabler/icons-react';
import { dashboardApi, type DirectorDashboard as DirectorDashboardData } from '../../api/dashboard';
import { PulseRow } from '../../components/SectionHeader';
import { StatusBadge } from '../../components/StatusBadge';
import { formatCurrency, formatCompactMoney } from '../../utils/formatters';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { FadeSwap, TextReveal } from '../../components/motion';
import { FitScreen, useFitRows, usePageKeys } from '../../components/FitScreen';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import './Dashboard.css';

const HEALTH_COLORS: Record<string, string> = {
  OK: 'teal', WARN: 'yellow', CRITICAL: 'red', NO_COSTING: 'gray',
};
const HEALTH_LABELS: Record<string, string> = {
  OK: 'в норме', WARN: 'ниже цели', CRITICAL: 'критично', NO_COSTING: 'нет калькуляции',
};

/** Плитка = срез экрана. Ключ плитки решает, что показать под ней */
type Tile = 'decisions' | 'margin' | 'supplier' | 'customer';
const TILE_VIEW: Record<Tile, 'decisions' | 'margin' | 'money'> = {
  decisions: 'decisions', margin: 'margin', supplier: 'money', customer: 'money',
};

/** Высота строки таблицы маржи */
const ROW_H = 45;

/**
 * Экран директора (решение 22.08.2026): три вопроса одного взгляда —
 * «мы зарабатываем?» (маржа 35 % от цены план/факт), «что ждёт моего
 * решения?» (перехваты, цены, зависшие заявки), «где деньги?» (ДО).
 *
 * 03.09.2026. Все три ответа стояли друг под другом и давали 936 px
 * прокрутки: «Требует решения» начиналось на 302 px ниже сгиба, маржа —
 * на 1210. Директор видел четыре числа и пустоту. Теперь плитки сверху
 * не только показывают числа, но и переключают экран: под ними стоит
 * ровно один ответ и занимает всю оставшуюся высоту. Ничего не убрано —
 * три вопроса разведены по трём срезам, между ними один клик.
 */
export function DirectorDashboard() {
  const [tile, setTile] = useState<Tile>('decisions');
  const view = TILE_VIEW[tile];

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', 'director'],
    queryFn: () => dashboardApi.getDirector().then((r) => r.data),
    refetchInterval: 60_000,
  });
  const { data: cash } = useQuery({
    queryKey: ['dashboard', 'cash-forecast'],
    queryFn: () => dashboardApi.getCashForecast().then((r) => r.data),
    refetchInterval: 60_000,
  });

  // Просроченные заказы — короткий список, но и он не должен вылезать
  const overdueAll = data?.overdue ?? [];
  const overduePaged = usePagedList(overdueAll, 5, overdueAll.length);

  if (isLoading || !data) {
    return (
      <Stack gap="lg">
        <Skeleton height={60} radius="lg" />
        <Skeleton height={140} radius="lg" />
        <Skeleton height={400} radius="lg" />
      </Stack>
    );
  }

  const { margin, needsDecision, money } = data;
  const decisions: Array<{ icon: React.ReactNode; label: string; count: number; to: string; color: string }> = [
    { icon: <IconGavel size={18} />, label: 'Перехваты партий ждут решения', count: needsDecision.batchOverrides, to: '/warehouse?tab=batches', color: 'red' },
    { icon: <IconReceipt size={18} />, label: 'Заявки на пересмотр цены', count: needsDecision.priceReviews, to: '/prices', color: 'orange' },
    { icon: <IconClockExclamation size={18} />, label: 'Заявки на номенклатуру просрочили SLA', count: needsDecision.nomenclatureStuck, to: '/settings', color: 'orange' },
    { icon: <IconFlask size={18} />, label: 'Партии в карантине цен', count: needsDecision.quarantineBatches, to: '/warehouse?tab=batches', color: 'yellow' },
    { icon: <IconClockExclamation size={18} />, label: 'Резервы истекают в 3 дня', count: needsDecision.expiringReservations, to: '/warehouse?tab=batches', color: 'yellow' },
    { icon: <IconInbox size={18} />, label: 'Новые заказы из 1С ждут приёма', count: needsDecision.inboxOrders, to: '/orders/inbox', color: 'blue' },
  ].filter((d) => d.count > 0);

  const paidPct = money.totalContracted > 0 ? (money.totalPaid / money.totalContracted) * 100 : 0;
  const decisionsTotal = decisions.reduce((s, d) => s + d.count, 0);

  const header = (
    <Stack gap="sm">
      <Group justify="space-between" align="baseline" wrap="nowrap" gap="md">
        <Group gap="sm" wrap="nowrap" align="baseline" style={{ minWidth: 0 }}>
          <Text component="h1" className="page-title" style={{ fontSize: 26, lineHeight: 1.1, whiteSpace: 'nowrap', margin: 0 }}>
            <TextReveal text="Маржа · Решения · Деньги" />
          </Text>
          <Text size="sm" c="dimmed" lineClamp={1}>
            экран директора — плитка выбирает, что показать ниже
          </Text>
        </Group>
        <Text size="sm" c="dimmed" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
          {new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
        </Text>
      </Group>

      <PulseRow
        items={[
          {
            key: 'decisions', label: 'Требует решения',
            value: decisionsTotal.toLocaleString('ru-RU'),
            hint: 'перехваты · цены · заявки', tone: 'danger',
            icon: <IconAlertTriangle size={17} />,
            onClick: () => setTile('decisions'), active: tile === 'decisions',
          },
          {
            key: 'margin', label: 'Маржа портфеля',
            value: margin.actualPct !== null ? `${margin.actualPct}%` : '—',
            hint: `цель ${margin.targetPct}% от цены · ${formatCompactMoney(margin.totalMargin)}`,
            tone: margin.actualPct !== null && margin.actualPct >= margin.targetPct ? 'ok' : 'warn',
            icon: <IconScale size={17} />,
            onClick: () => setTile('margin'), active: tile === 'margin',
          },
          {
            key: 'supplier', label: 'Мы должны поставщикам',
            value: formatCompactMoney(money.totalUnpaid),
            hint: `из ${formatCompactMoney(money.totalContracted)} по ДО закупа`,
            tone: 'brand', icon: <IconReceipt size={17} />,
            onClick: () => setTile('supplier'), active: tile === 'supplier',
          },
          {
            key: 'customer', label: 'Заказчики нам должны',
            value: cash ? formatCompactMoney(cash.receivables.owed) : '…',
            hint: 'по активным заказам, данные 1С',
            icon: <IconBuildingBank size={17} />,
            onClick: () => setTile('customer'), active: tile === 'customer',
          },
        ]}
      />
    </Stack>
  );

  return (
    <FitScreen header={header}>
      <FadeSwap swapKey={view} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>

        {/* Ради этого директор и открывает систему */}
        {view === 'decisions' && (
          <Card padding="md" radius="lg" className="dd-body">
            <Text fw={800} size="lg" mb="sm">Требует решения</Text>
            {decisions.length === 0 ? (
              <Text c="dimmed" size="sm">Всё разобрано — решений не ждёт ничего.</Text>
            ) : (
              <div className="dd-decisions">
                {decisions.map((d) => (
                  <Link to={d.to} key={d.label} className="dd-decision">
                    <ThemeIcon variant="light" color={d.color} radius="md" size="lg">{d.icon}</ThemeIcon>
                    <Text size="md" fw={600} lineClamp={1}>{d.label}</Text>
                    <Badge size="lg" variant="filled" color={d.color} radius="xl">{d.count}</Badge>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* Деньги: кому должны мы, кто должен нам, что уже просрочено */}
        {view === 'money' && (
          <div className="dd-money">
            <Card padding="md" radius="lg">
              <Text fw={800} size="lg" mb="sm">Поставщикам (закуп по ДО)</Text>
              <Stack gap="sm">
                <Box>
                  <Group justify="space-between" mb={6}>
                    <Text size="sm" c="dimmed">Оплачено</Text>
                    <Text size="sm" fw={700}>{formatCurrency(money.totalPaid)} · {paidPct.toFixed(0)}%</Text>
                  </Group>
                  <Progress value={paidPct} size="lg" radius="xl" color="success" />
                </Box>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Законтрактовано</Text>
                  <Text fw={700}>{formatCurrency(money.totalContracted)}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Остаток к оплате</Text>
                  <Text fw={700} c="warning.8">{formatCurrency(money.totalUnpaid)}</Text>
                </Group>
              </Stack>
            </Card>

            {/* Заказчики нам должны (запрос «сам прогнозировал», 24.08.2026) */}
            <Card padding="md" radius="lg">
              <Group gap="xs" mb="sm">
                <ThemeIcon variant="light" color="brand" radius="md"><IconBuildingBank size={18} /></ThemeIcon>
                <Text fw={800} size="lg">Заказчики (нам должны)</Text>
              </Group>
              {!cash ? (
                <Text size="sm" c="dimmed">Считается…</Text>
              ) : (
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Text size="sm" c="dimmed">Законтрактовано</Text>
                    <Text fw={700}>{formatCurrency(cash.receivables.contracted)}</Text>
                  </Group>
                  <Group justify="space-between">
                    <Text size="sm" c="dimmed">Оплачено по данным 1С</Text>
                    <Text fw={700}>{formatCurrency(cash.receivables.paid)}</Text>
                  </Group>
                  <Group justify="space-between">
                    <Text size="sm" c="dimmed">Должны нам</Text>
                    <Text fw={700} c="brand.7">{formatCurrency(cash.receivables.owed)}</Text>
                  </Group>
                  {cash.receivables.ordersWithoutPaymentData > 0 && (
                    <Group gap={6} wrap="nowrap" align="flex-start">
                      <IconInfoCircle size={14} style={{ marginTop: 2, flexShrink: 0, opacity: 0.6 }} />
                      <Text size="xs" c="dimmed">
                        По {cash.receivables.ordersWithoutPaymentData} из {cash.receivables.activeOrders} активных
                        заказов 1С не прислала данных об оплате — «должны нам» может быть занижено.
                      </Text>
                    </Group>
                  )}
                </Stack>
              )}
            </Card>

            <Card padding="md" radius="lg">
              <Text fw={800} size="lg" mb="sm" c="danger.7">Просроченные заказы</Text>
              {overduePaged.total === 0 ? (
                <Text size="sm" c="dimmed">Просроченных заказов нет.</Text>
              ) : (
                <Stack gap={6}>
                  {overduePaged.slice.map((o) => (
                    <Group key={o.id} justify="space-between" wrap="nowrap" gap="sm">
                      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                        <OrderRef id={o.id} number={o.orderNumber} />
                        <Text size="sm" c="dimmed" lineClamp={1}>{o.customer.name}</Text>
                      </Group>
                      <Badge color="danger" variant="light" style={{ flexShrink: 0 }}>{o.overdueDays} дн</Badge>
                    </Group>
                  ))}
                  {overduePaged.totalPages > 1 && (
                    <PaginationBar
                      page={overduePaged.page}
                      total={overduePaged.total}
                      pageSize={5}
                      onPageChange={overduePaged.setPage}
                      noun="заказов"
                      variant="compact"
                    />
                  )}
                </Stack>
              )}
            </Card>
          </div>
        )}

        {/* Маржа по заказам: отсортировано от худшего — проблемы сверху */}
        {view === 'margin' && (
          <MarginTable
            orders={margin.orders}
            targetPct={margin.targetPct}
            shown={margin.ordersShown}
            ordersTotal={margin.ordersTotal}
          />
        )}
      </FadeSwap>
    </FitScreen>
  );
}

type MarginOrder = DirectorDashboardData['margin']['orders'][number];

/**
 * Таблица маржи — отдельный компонент не по красоте, а по необходимости:
 * useFitRows ставит наблюдатель за размером ОДИН раз, при монтировании.
 * Пока таблица была куском общего JSX, ref навешивался только при выборе
 * среза, наблюдатель к нему уже не приезжал, и на экране оставалось
 * три строки вместо девяти (03.09.2026).
 */
function MarginTable({
  orders, targetPct, shown, ordersTotal,
}: {
  orders: MarginOrder[];
  targetPct: number;
  shown: number;
  ordersTotal: number;
}) {
  const fit = useFitRows(ROW_H, 3, 40, 44);
  const paged = usePagedList(orders, Math.max(1, fit.rows), `${orders.length}|${fit.rows}`);
  usePageKeys(paged.page, paged.totalPages, paged.setPage);

  return (
    <Card padding={0} radius="lg" className="dd-body" style={{ overflow: 'hidden' }}>
      <Group justify="space-between" px="md" pt="md" pb="xs" wrap="nowrap">
        <Text fw={800} size="lg" style={{ whiteSpace: 'nowrap' }}>Маржа по активным заказам</Text>
        <Text size="sm" c="dimmed" lineClamp={1}>
          цель {targetPct} % от цены · худшие сверху
          {ordersTotal > shown ? ` · в расчёте ${shown} из ${ordersTotal}` : ''}
        </Text>
      </Group>
      <div className="dd-margin" ref={fit.ref}>
        <FadeSwap swapKey={paged.page}>
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Заказ</Table.Th>
                <Table.Th>Заказчик</Table.Th>
                <Table.Th data-priority="3">Статус</Table.Th>
                <Table.Th ta="right" data-priority="2">Себестоимость</Table.Th>
                <Table.Th ta="right" data-priority="2">Цена</Table.Th>
                <Table.Th ta="right">Маржа</Table.Th>
                <Table.Th>Здоровье</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {paged.slice.map((o) => (
                <Table.Tr key={o.id}>
                  <Table.Td><OrderRef id={o.id} number={o.orderNumber} focus="cost" /></Table.Td>
                  <Table.Td><Text size="sm" lineClamp={1}>{o.customer.name}</Text></Table.Td>
                  <Table.Td data-priority="3"><StatusBadge status={o.status} /></Table.Td>
                  <Table.Td ta="right" ff="monospace" data-priority="2">{o.totalCost !== null ? formatCurrency(o.totalCost) : '—'}</Table.Td>
                  <Table.Td ta="right" ff="monospace" data-priority="2">{o.totalPrice !== null ? formatCurrency(o.totalPrice) : '—'}</Table.Td>
                  <Table.Td ta="right" ff="monospace" fw={700}>
                    {o.marginPct !== null ? `${o.marginPct}%` : '—'}
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={o.marginHealth === 'NO_COSTING' ? 'Согласованной калькуляции нет — маржа неизвестна' : `Маржа ${o.marginPct}% при цели ${targetPct}%`}>
                      <Badge color={HEALTH_COLORS[o.marginHealth]} variant="light" radius="xl">
                        {HEALTH_LABELS[o.marginHealth]}
                      </Badge>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </FadeSwap>
      </div>
      <Box px="md" pb={4}>
        <PaginationBar
          page={paged.page}
          total={paged.total}
          pageSize={Math.max(1, fit.rows)}
          onPageChange={paged.setPage}
          noun="заказов"
          variant="compact"
        />
      </Box>
    </Card>
  );
}
