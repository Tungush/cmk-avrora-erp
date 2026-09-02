import React, { useEffect, useMemo, useState } from 'react';
import {
  Stack, Group, Text, Card, TextInput, Select, SegmentedControl, Table, Badge,
  Skeleton, Button, Modal, ActionIcon, Menu, Divider,
} from '@mantine/core';
import {
  IconSearch, IconAlertTriangle, IconBookmark, IconBookmarkPlus, IconTrash,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useMediaQuery } from '@mantine/hooks';
import { useOrders } from '../../hooks/useOrders';
import { useAuthStore } from '../../store/auth';
import { StatusBadge } from '../../components/StatusBadge';
import { formatCurrency, formatDate, ORDER_STATUS_LABELS } from '../../utils/formatters';
import { useSavedViews, useCreateSavedView, useDeleteSavedView } from '../../hooks/useSavedViews';
import { OrderRef, useOrderCard } from '../../components/OrderCard/OrderCardProvider';
import { useQueries } from '@tanstack/react-query';
import { ordersApi } from '../../api/orders';
import { PulseRow } from '../../components/SectionHeader';
import { IconClockExclamation, IconInbox, IconTruckDelivery, IconLayoutGrid } from '@tabler/icons-react';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePageSize } from '../../components/PaginationBar';
import { FadeSwap, Stagger } from '../../components/motion';

const ORDER_TYPE_LABELS: Record<string, string> = { FZ: 'ФЗ', VZ: 'ВЗ' };

type PresetCode = 'core' | 'commercial' | 'production' | 'logistics';

interface ColumnDef {
  key: string;
  label: string;
  align?: 'right';
  /** 2 — прячется до 1100 px, 3 — до 1400 px. Скрытое остаётся в карточке */
  priority?: 2 | 3;
  render: (o: any) => React.ReactNode;
}

const sumLines = (o: any, field: string) =>
  ((o.orderLines ?? []) as any[]).reduce((s, l) => s + Number(l?.[field] ?? 0), 0);

const num = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

/** Общие колонки каждого пресета: № и заказчик слева, статус справа */
const colNumber: ColumnDef = {
  key: 'orderNumber', label: '№ заказа',
  render: (o) => <OrderRef id={o.id} number={o.orderNumber} bold={false} />,
};
const colCustomer: ColumnDef = {
  key: 'customer', label: 'Заказчик',
  render: (o) => <Text size="sm" lineClamp={1}>{o.customer?.name ?? '—'}</Text>,
};
const colStatus: ColumnDef = {
  key: 'status', label: 'Статус',
  render: (o) => <StatusBadge status={o.status} />,
};
const colOverdue: ColumnDef = {
  key: 'overdue', label: 'Просрочка', align: 'right',
  render: (o) => o.overdueDays > 0
    ? (
      <Badge color="danger" variant="light" radius="xl" size="sm" leftSection={<IconAlertTriangle size={12} />}>
        {o.overdueDays} дн
      </Badge>
    )
    : <Text size="sm" c="dimmed">—</Text>,
};

/**
 * Пресеты колонок = группы полей (§1.3): «Основное / Финансы / Производство / Отгрузка».
 * 5–7 колонок вместо 66; всё остальное — в карточке по клику (§2.3 ①).
 */
const PRESETS: Record<PresetCode, { label: string; permission: string | null; columns: ColumnDef[] }> = {
  core: {
    label: 'Основное',
    permission: null, // order.core читают все, кто вообще видит модуль
    columns: [
      colNumber, colCustomer,
      { key: 'type', label: 'Тип', priority: 3, render: (o) => <Text size="sm">{ORDER_TYPE_LABELS[o.orderType] ?? o.orderType}</Text> },
      { key: 'region', label: 'Регион', priority: 3, render: (o) => <Text size="sm" c="dimmed">{o.region || '—'}</Text> },
      { key: 'planned', label: 'План вывоза', align: 'right', render: (o) => <Text size="sm" ff="monospace">{formatDate(o.plannedShipmentDate)}</Text> },
      colStatus, colOverdue,
    ],
  },
  commercial: {
    label: 'Финансы',
    permission: 'order.commercial',
    columns: [
      colNumber, colCustomer,
      { key: 'total', label: 'Сумма с НДС', align: 'right', render: (o) => <Text size="sm" ff="monospace">{formatCurrency(sumLines(o, 'lineTotalVat'))}</Text> },
      { key: 'prepay', label: 'Аванс', align: 'right', render: (o) => <Text size="sm" ff="monospace">{formatCurrency(sumLines(o, 'prepayment'))}</Text> },
      { key: 'due', label: 'К оплате', align: 'right', render: (o) => {
        const due = sumLines(o, 'balanceDue');
        return <Text size="sm" ff="monospace" fw={600} c={due > 0 ? 'danger.7' : undefined}>{formatCurrency(due)}</Text>;
      } },
      colStatus,
    ],
  },
  production: {
    label: 'Производство',
    permission: 'order.production',
    columns: [
      colNumber, colCustomer,
      { key: 'qty', label: 'Заказано', align: 'right', render: (o) => <Text size="sm" ff="monospace">{num(sumLines(o, 'qty'))} шт</Text> },
      { key: 'reserved', label: 'Резерв', align: 'right', render: (o) => <Text size="sm" ff="monospace">{num(sumLines(o, 'reservedQty'))} шт</Text> },
      { key: 'shipped', label: 'Отгружено', align: 'right', render: (o) => <Text size="sm" ff="monospace">{num(sumLines(o, 'shippedQty'))} шт</Text> },
      colStatus, colOverdue,
    ],
  },
  logistics: {
    label: 'Отгрузка',
    permission: 'order.logistics',
    columns: [
      colNumber, colCustomer,
      { key: 'planned', label: 'План вывоза', align: 'right', render: (o) => <Text size="sm" ff="monospace">{formatDate(o.plannedShipmentDate)}</Text> },
      { key: 'actual', label: 'Факт отгрузки', align: 'right', render: (o) => <Text size="sm" ff="monospace">{formatDate(o.actualShipmentDate)}</Text> },
      colStatus, colOverdue,
    ],
  },
};

/**
 * Счётчики срезов для «пульса»: три коротких запроса на одну строку —
 * нужен только meta.total. Дешевле, чем тянуть списки, и всегда честно
 * показывает, сколько сейчас в каждом состоянии.
 */
function useSliceCounts() {
  const slices = [
    { key: 'overdue', params: { page: 1, pageSize: 1, overdueOnly: true } },
    { key: 'new', params: { page: 1, pageSize: 1, status: 'NEW' } },
    { key: 'ready', params: { page: 1, pageSize: 1, status: 'READY_TO_SHIP' } },
  ] as const;
  const results = useQueries({
    queries: slices.map((s) => ({
      queryKey: ['orders', s.params],
      queryFn: () => ordersApi.list(s.params as Record<string, string | number | boolean>).then((r) => r.data),
      staleTime: 60_000,
    })),
  });
  return {
    overdue: (results[0].data as any)?.meta?.total ?? null,
    fresh: (results[1].data as any)?.meta?.total ?? null,
    ready: (results[2].data as any)?.meta?.total ?? null,
    loading: results.some((r) => r.isLoading),
  };
}

export function OrdersRegistry() {
  const can = useAuthStore((s) => s.can);
  const { open: openCard } = useOrderCard();
  // < 768px: таблица превращается в ленту карточек (§4.6)
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [preset, setPreset] = useState<PresetCode>('core');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);
  // Размер страницы помнится для реестра заказов отдельно (25 / 50 / 100)
  const [pageSize, setPageSize] = usePageSize('orders', 25);
  const [viewName, setViewName] = useState('');
  const [saveViewOpened, setSaveViewOpened] = useState(false);

  const { data: savedViews } = useSavedViews('orders');
  const createView = useCreateSavedView('orders');
  const deleteView = useDeleteSavedView('orders');

  /** Применить сохранённый вид: фильтры + пресет колонок одним кликом (§2.1) */
  const applyView = (v: { config: Record<string, unknown> }) => {
    const c = v.config as any;
    setSearch(c.search ?? '');
    setStatus(c.status ?? null);
    setOverdueOnly(!!c.overdueOnly);
    if (c.preset && PRESETS[c.preset as PresetCode]) setPreset(c.preset as PresetCode);
    setPage(1);
  };

  const handleSaveView = async () => {
    try {
      await createView.mutateAsync({
        name: viewName,
        config: { search, status, overdueOnly, preset },
      });
      setSaveViewOpened(false);
      setViewName('');
      notifications.show({ title: 'Вид сохранён', message: viewName, color: 'success' });
    } catch (e: any) {
      notifications.show({
        title: 'Ошибка',
        message: e?.response?.data?.error?.message ?? 'Не удалось сохранить вид',
        color: 'danger',
      });
    }
  };

  // Пресет виден, только если есть право на чтение его группы полей (§1.3)
  const availablePresets = useMemo(
    () => (Object.entries(PRESETS) as Array<[PresetCode, (typeof PRESETS)[PresetCode]]>)
      .filter(([, p]) => !p.permission || can('read', p.permission)),
    [can],
  );

  const params: Record<string, string | number | boolean> = { page, pageSize };
  if (search) params.search = search;
  if (status) params.status = status;
  if (overdueOnly) params.overdueOnly = true;

  const { data, isLoading } = useOrders(params);
  const orders: any[] = (data as any)?.data ?? [];
  const meta = (data as any)?.meta;

  // Пока грузится следующая страница, счётчик не должен мигать «Нет заказов»
  const [knownTotal, setKnownTotal] = useState(0);
  useEffect(() => { if (meta) setKnownTotal(Number(meta.total ?? 0)); }, [meta]);
  const total = meta ? Number(meta.total ?? 0) : knownTotal;

  const columns = PRESETS[preset].columns;

  const counts = useSliceCounts();
  // Плитка = включённый срез. Второй клик по той же плитке снимает фильтр:
  // из среза всегда есть выход, тупика не остаётся
  const applySlice = (slice: 'all' | 'overdue' | 'new' | 'ready') => {
    setPage(1);
    if (slice === 'all') { setStatus(null); setOverdueOnly(false); return; }
    if (slice === 'overdue') { setStatus(null); setOverdueOnly(!overdueOnly); return; }
    const code = slice === 'new' ? 'NEW' : 'READY_TO_SHIP';
    setOverdueOnly(false);
    setStatus(status === code ? null : code);
  };
  const isAll = !status && !overdueOnly;
  const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('ru-RU'));

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <PulseRow
        loading={counts.loading && !meta}
        items={[
          {
            key: 'all', label: 'Всего в реестре', value: fmt(meta ? total : null),
            hint: 'все заказы', icon: <IconLayoutGrid size={17} />,
            onClick: () => applySlice('all'), active: isAll,
          },
          {
            key: 'overdue', label: 'Просрочено', value: fmt(counts.overdue),
            hint: 'план вывоза прошёл', tone: 'danger', icon: <IconClockExclamation size={17} />,
            onClick: () => applySlice('overdue'), active: overdueOnly,
          },
          {
            key: 'new', label: 'Новые из 1С', value: fmt(counts.fresh),
            hint: 'ждут приёма в производство', tone: 'brand', icon: <IconInbox size={17} />,
            onClick: () => applySlice('new'), active: status === 'NEW',
          },
          {
            key: 'ready', label: 'К отгрузке', value: fmt(counts.ready),
            hint: 'изготовлены полностью', tone: 'ok', icon: <IconTruckDelivery size={17} />,
            onClick: () => applySlice('ready'), active: status === 'READY_TO_SHIP',
          },
        ]}
      />

      <div className="toolbar-sticky">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="sm" wrap="wrap">
            <TextInput
              placeholder="№ заказа, заказчик или БС..."
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              w={260}
            />
            <Select
              placeholder="Все статусы"
              data={Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
              value={status}
              onChange={(v) => { setStatus(v); setPage(1); }}
              clearable
              w={200}
            />
            {/* Переключателя «Только просроченные» здесь больше нет (02.09.2026):
                он делал ровно то же, что плитка «Просрочено» сверху, и рядом
                со «Все статусы» читался как ещё один, непонятно чем отличающийся
                фильтр. Срез включается кликом по плитке — в одном месте */}
          </Group>

          <Group gap="sm" wrap="wrap">
            {/* Сохраняемые представления (§2.1): фильтры + пресет под именем */}
            <Menu shadow="md" width={260} position="bottom-end">
              <Menu.Target>
                <Button variant="default" size="md" leftSection={<IconBookmark size={16} />}>
                  Виды{savedViews && savedViews.length > 0 ? ` (${savedViews.length})` : ''}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {(savedViews ?? []).map((v) => (
                  <Menu.Item
                    key={v.id}
                    onClick={() => applyView(v)}
                    rightSection={
                      <ActionIcon
                        component="div"
                        variant="subtle"
                        color="gray"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); deleteView.mutate(v.id); }}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    }
                  >
                    {v.name}
                  </Menu.Item>
                ))}
                {(savedViews ?? []).length === 0 && (
                  <Menu.Label>Сохранённых видов нет</Menu.Label>
                )}
                <Menu.Divider />
                <Menu.Item leftSection={<IconBookmarkPlus size={16} />} onClick={() => setSaveViewOpened(true)}>
                  Сохранить текущий вид
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>

            {/* Переключатель пресетов колонок — собирается из прав */}
            <SegmentedControl
              value={preset}
              onChange={(v) => setPreset(v as PresetCode)}
              data={availablePresets.map(([code, p]) => ({ value: code, label: p.label }))}
              size="md"
              radius="md"
            />
          </Group>
        </Group>
      </div>

      <FadeSwap swapKey={isLoading ? 'loading' : `${preset}:${page}`}>
        <Card withBorder radius="md" padding={0}>
          {isLoading ? (
            <Stack gap={4} p="md">
              {[...Array(10)].map((_, i) => <Skeleton key={i} height={44} radius="sm" />)}
            </Stack>
          ) : isMobile ? (
            /* Мобильная лента (§4.6): № + статус, заказчик, суммы, план вывоза */
            <Stack gap="sm" p="sm">
              <Stagger>
                {orders.map((o) => {
                  const qty = sumLines(o, 'qty');
                  const total = sumLines(o, 'lineTotalVat');
                  return (
                    <Card key={o.id} withBorder radius="md" padding="sm" onClick={() => openCard(o.id)} style={{ cursor: 'pointer' }}>
                      <Group justify="space-between" wrap="nowrap" mb={4}>
                        <OrderRef id={o.id} number={o.orderNumber} />
                        <StatusBadge status={o.status} />
                      </Group>
                      <Text size="sm" c="dimmed" lineClamp={1}>
                        {o.customer?.name ?? '—'}{o.region ? ` · ${o.region}` : ''}
                      </Text>
                      <Divider my={8} />
                      <Group justify="space-between" wrap="nowrap">
                        <Text size="sm" ff="monospace">{num(qty)} шт</Text>
                        {can('read', 'order.commercial') && (
                          <Text size="sm" ff="monospace" fw={600}>{formatCurrency(total)}</Text>
                        )}
                      </Group>
                      <Group justify="space-between" wrap="nowrap" mt={2}>
                        <Text size="xs" c="dimmed">План вывоза</Text>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm" ff="monospace">{formatDate(o.plannedShipmentDate)}</Text>
                          {o.overdueDays > 0 && (
                            <Badge color="danger" variant="light" radius="xl" size="md" fz={12}>{o.overdueDays} дн</Badge>
                          )}
                        </Group>
                      </Group>
                    </Card>
                  );
                })}
              </Stagger>
              {orders.length === 0 && (
                <Text size="sm" c="dimmed" ta="center" py="lg">Заказы не найдены</Text>
              )}
            </Stack>
          ) : (
            <TableScroll minWidth={820}>
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    {columns.map((c) => (
                      <Table.Th
                        key={c.key}
                        data-priority={c.priority}
                        style={c.align === 'right' ? { textAlign: 'right' } : undefined}
                      >
                        {c.label}
                      </Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {orders.map((o) => (
                    <Table.Tr
                      key={o.id}
                      onClick={() => openCard(o.id)}
                      data-clickable
                    >
                      {columns.map((c) => (
                        <Table.Td
                          key={c.key}
                          data-priority={c.priority}
                          style={c.align === 'right' ? { textAlign: 'right' } : undefined}
                        >
                          {c.render(o)}
                        </Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                  {orders.length === 0 && (
                    <Table.Tr>
                      <Table.Td colSpan={columns.length}>
                        <Text size="sm" c="dimmed" ta="center" py="lg">Заказы не найдены</Text>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Table.Tbody>
              </Table>
            </TableScroll>
          )}
        </Card>
      </FadeSwap>

      <PaginationBar
        page={page}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        noun="заказов"
        sticky
      />

      {/* Мастера создания заказа здесь нет намеренно (решение 23.08.2026):
          заказ рождается сделкой Б24 → документом 1С → приходит в инбокс
          «Новые из 1С». Руками его завести негде, и это правильно. */}

      {/* Имя для сохраняемого вида */}
      <Modal
        opened={saveViewOpened}
        onClose={() => setSaveViewOpened(false)}
        title={<Text fw={700}>Сохранить вид</Text>}
        size="sm"
        radius="md"
        centered
      >
        <Stack gap="sm">
          <TextInput
            label="Название"
            placeholder="Мои просроченные"
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            data-autofocus
          />
          <Text size="xs" c="dimmed">
            Сохранится: поиск «{search || '—'}», статус {status ?? 'любой'},
            {overdueOnly ? ' только просроченные,' : ''} пресет «{PRESETS[preset].label}»
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setSaveViewOpened(false)}>Отмена</Button>
            <Button onClick={handleSaveView} disabled={!viewName.trim()} loading={createView.isPending}>
              Сохранить
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Карточка заказа — общая шторка из Layout, открывается по адресу */}
    </Stack>
  );
}
