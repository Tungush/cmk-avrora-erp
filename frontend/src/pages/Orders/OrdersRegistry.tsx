import React, { useMemo, useState } from 'react';
import {
  Stack, Group, Text, Card, TextInput, Select, SegmentedControl, Table, Badge,
  Skeleton, Pagination, Drawer, Switch, Box, Button, Modal, ActionIcon, Menu,
} from '@mantine/core';
import {
  IconSearch, IconAlertTriangle, IconBookmark, IconBookmarkPlus, IconTrash,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useMediaQuery } from '@mantine/hooks';
import { useOrders } from '../../hooks/useOrders';
import { useAuthStore } from '../../store/auth';
import { StatusBadge } from '../../components/StatusBadge';
import { Divider } from '@mantine/core';
import { formatCurrency, formatDate, ORDER_STATUS_LABELS } from '../../utils/formatters';
import { useSavedViews, useCreateSavedView, useDeleteSavedView } from '../../hooks/useSavedViews';
import { OrderRef, useOrderCard } from '../../components/OrderCard/OrderCardProvider';

const ORDER_TYPE_LABELS: Record<string, string> = { FZ: 'ФЗ', VZ: 'ВЗ' };

type PresetCode = 'core' | 'commercial' | 'production' | 'logistics';

interface ColumnDef {
  key: string;
  label: string;
  align?: 'right';
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
      <Badge color="danger" variant="light" radius="xl" size="sm" leftSection={<IconAlertTriangle size={11} />}>
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
      { key: 'type', label: 'Тип', render: (o) => <Text size="sm">{ORDER_TYPE_LABELS[o.orderType] ?? o.orderType}</Text> },
      { key: 'region', label: 'Регион', render: (o) => <Text size="sm" c="dimmed">{o.region || '—'}</Text> },
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

  const params: Record<string, string | number | boolean> = { page, pageSize: 25 };
  if (search) params.search = search;
  if (status) params.status = status;
  if (overdueOnly) params.overdueOnly = true;

  const { data, isLoading } = useOrders(params);
  const orders: any[] = (data as any)?.data ?? [];
  const meta = (data as any)?.meta;
  const totalPages = meta ? Math.max(1, Math.ceil(meta.total / meta.pageSize)) : 1;

  const columns = PRESETS[preset].columns;

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Group gap="sm" wrap="wrap">
          <TextInput
            placeholder="№ заказа или заказчик..."
            leftSection={<IconSearch size={15} />}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            w={240}
            size="sm"
          />
          <Select
            placeholder="Все статусы"
            data={Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
            value={status}
            onChange={(v) => { setStatus(v); setPage(1); }}
            clearable
            w={190}
            size="sm"
          />
          <Switch
            label="Только просроченные"
            size="sm"
            checked={overdueOnly}
            onChange={(e) => { setOverdueOnly(e.currentTarget.checked); setPage(1); }}
          />
        </Group>

        <Group gap="sm" wrap="wrap">
          {/* Сохраняемые представления (§2.1): фильтры + пресет под именем */}
          <Menu shadow="md" width={260} position="bottom-end">
            <Menu.Target>
              <Button variant="default" size="sm" leftSection={<IconBookmark size={15} />}>
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
                      <IconTrash size={13} />
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
              <Menu.Item leftSection={<IconBookmarkPlus size={15} />} onClick={() => setSaveViewOpened(true)}>
                Сохранить текущий вид
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>

          {/* Переключатель пресетов колонок — собирается из прав */}
          <SegmentedControl
            value={preset}
            onChange={(v) => setPreset(v as PresetCode)}
            data={availablePresets.map(([code, p]) => ({ value: code, label: p.label }))}
            size="sm"
            radius="md"
          />

        </Group>
      </Group>

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">
            {[...Array(10)].map((_, i) => <Skeleton key={i} height={38} radius="sm" />)}
          </Stack>
        ) : isMobile ? (
          /* Мобильная лента (§4.6): № + статус, заказчик, суммы, план вывоза */
          <Stack gap="sm" p="sm">
            {orders.map((o) => {
              const qty = sumLines(o, 'qty');
              const total = sumLines(o, 'lineTotalVat');
              return (
                <Card key={o.id} withBorder radius="md" padding="sm" onClick={() => openCard(o.id)} style={{ cursor: 'pointer' }}>
                  <Group justify="space-between" wrap="nowrap" mb={4}>
                    <OrderRef id={o.id} number={o.orderNumber} />
                    <StatusBadge status={o.status} />
                  </Group>
                  <Text size="xs" c="dimmed" lineClamp={1}>
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
                      <Text size="xs" ff="monospace">{formatDate(o.plannedShipmentDate)}</Text>
                      {o.overdueDays > 0 && (
                        <Badge color="danger" variant="light" radius="xl" size="xs">{o.overdueDays} дн</Badge>
                      )}
                    </Group>
                  </Group>
                </Card>
              );
            })}
            {orders.length === 0 && (
              <Text size="sm" c="dimmed" ta="center" py="lg">Заказы не найдены</Text>
            )}
          </Stack>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  {columns.map((c) => (
                    <Table.Th key={c.key} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>
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
                    style={{ cursor: 'pointer' }}
                  >
                    {columns.map((c) => (
                      <Table.Td key={c.key} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>
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
          </Box>
        )}
      </Card>

      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          {meta ? `${meta.total.toLocaleString('ru-RU')} заказов · стр. ${meta.page} из ${totalPages}` : ''}
        </Text>
        <Pagination value={page} onChange={setPage} total={totalPages} size="sm" radius="md" />
      </Group>

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
