import React, { useEffect, useMemo, useState } from 'react';
import {
  Stack, Group, Text, Card, TextInput, Select, SegmentedControl, Table, Badge,
  Skeleton, Button, Modal, ActionIcon, Menu, Divider,
} from '@mantine/core';
import {
  IconSearch, IconAlertTriangle, IconBookmark, IconBookmarkPlus, IconTrash,
  IconArrowLeft,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useMediaQuery } from '@mantine/hooks';
import { useOrders } from '../../hooks/useOrders';
import { useAuthStore } from '../../store/auth';
import { StatusBadge } from '../../components/StatusBadge';
import { formatCurrency, formatDate, ORDER_STATUS_LABELS } from '../../utils/formatters';
import { useSavedViews, useCreateSavedView, useDeleteSavedView } from '../../hooks/useSavedViews';
import { OrderRef, useOrderCard, useInlineOrderCard } from '../../components/OrderCard/OrderCardProvider';
import { OrderDetail } from './OrderDetail';
import { Ref } from '../../components/EntityRef';
import { useQueries } from '@tanstack/react-query';
import { ordersApi } from '../../api/orders';
import { PulseRow } from '../../components/SectionHeader';
import { DigestCard, DigestGrid } from '../../components/Digest';
import { IconClockExclamation, IconInbox, IconTruckDelivery, IconLayoutGrid } from '@tabler/icons-react';
import { TableScroll } from '../../components/TableScroll';
import { useFitHeight } from '../../components/FitScreen';
import { PaginationBar, usePageSize } from '../../components/PaginationBar';
import { FadeSwap, Stagger } from '../../components/motion';
import { EmptyState } from '../../components/EmptyState';

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
  // Имя ведёт в карточку заказчика, клик по строке — по-прежнему в заказ:
  // Ref гасит всплытие, поэтому оба клика не спорят (03.09.2026)
  render: (o) => (
    <Text size="sm" lineClamp={1}>
      <Ref
        kind="customer"
        id={o.customer?.id ?? o.customerId}
        label={o.customer?.name}
        tone="text"
        size="sm"
      >
        {o.customer?.name ?? '—'}
      </Ref>
    </Text>
  ),
};
const colStatus: ColumnDef = {
  key: 'status', label: 'Статус',
  render: (o) => <StatusBadge status={o.status} />,
};
const colOverdue: ColumnDef = {
  key: 'overdue', label: 'Просрочка', align: 'right',
  render: (o) => o.overdueDays > 0
    ? (
      <Badge color="danger" variant="light" radius="xl" size="sm" leftSection={<IconAlertTriangle aria-hidden size={16} />}>
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
  // Просим по 5 строк вместо одной: то же число в meta.total, но заодно
  // приезжают сами заказы — сводке нужны не цифры, а виновники (02.09.2026)
  const slices = [
    { key: 'overdue', params: { page: 1, pageSize: 5, overdueOnly: true } },
    { key: 'new', params: { page: 1, pageSize: 5, status: 'NEW' } },
    { key: 'ready', params: { page: 1, pageSize: 5, status: 'READY_TO_SHIP' } },
  ] as const;
  const results = useQueries({
    queries: slices.map((s) => ({
      queryKey: ['orders', s.params],
      queryFn: () => ordersApi.list(s.params as Record<string, string | number | boolean>).then((r) => r.data),
      staleTime: 60_000,
    })),
  });
  const rows = (i: number): any[] => ((results[i].data as any)?.data ?? []);
  return {
    overdue: (results[0].data as any)?.meta?.total ?? null,
    fresh: (results[1].data as any)?.meta?.total ?? null,
    ready: (results[2].data as any)?.meta?.total ?? null,
    overdueRows: rows(0),
    freshRows: rows(1),
    readyRows: rows(2),
    loading: results.some((r) => r.isLoading),
  };
}

export function OrdersRegistry({ view, onViewChange }: {
  /** Вид выбирается ВЫШЕ, одним рядом вкладок вместе с «Дашбордом»
      (04.09.2026): раньше здесь стоял второй переключатель, и два ряда
      делали одну работу, съедая высоту у таблицы */
  view: 'digest' | 'list';
  onViewChange: (v: 'digest' | 'list') => void;
}) {
  const can = useAuthStore((s) => s.can);
  const { open: openCard, openedId, close: closeCard } = useOrderCard();
  /* Паспорт показываем панелью справа, а не шторкой поверх списка
     (04.09.2026, эталон): список и карточка видны одновременно, и
     переход между заказами не требует закрывать-открывать. */
  /* Карточка рисуется этим разделом на весь экран, поэтому общая
     шторка поверх списка не нужна ни на какой ширине. */
  useInlineOrderCard();
  // < 768px: таблица превращается в ленту карточек (§4.6)
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [preset, setPreset] = useState<PresetCode>('core');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);
  // Размер страницы помнится для реестра заказов отдельно (25 / 50 / 100)
  const [pageSize, setPageSize] = usePageSize('orders', 25);
  /**
   * Реестр держался в высоту 25 строк независимо от экрана (04.09.2026).
   *
   * У обёртки таблицы не было maxHeight вовсе: 25 строк по 50 px давали
   * 1250 px, страница уезжала вниз на 1018 px, и на экране 900 px было
   * видно ДВЕ строки из 384 заказов — остальное за сгибом. Это прямо
   * противоречит правилу «страница не прокручивается»: список должен
   * показывать столько строк, сколько поместилось.
   *
   * Теперь высота таблицы меряется, а размер страницы из неё следует.
   * Ручной выбор «25/50/100 на стр.» остаётся: если человек сознательно
   * просит больше — таблица прокрутится внутри себя, а не страница.
   */
  /* 16, а не 42 (04.09.2026): запас закладывался под зазоры по 16 px
     между блоками раздела. Зазоры уменьшены до 8, и прежние 42
     превратились в пустую полосу внизу. */
  const fit = useFitHeight(16, 220);
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

  const openList = (slice: 'all' | 'overdue' | 'new' | 'ready') => {
    applySlice(slice);
    onViewChange('list');
  };

  return (
    <Stack gap={8} style={{ minWidth: 0 }}>
      {view === 'digest' ? (
        <DigestGrid>
          <DigestCard
            title="Просрочено"
            tone="danger"
            icon={<IconClockExclamation aria-hidden size={20} />}
            value={counts.overdue ?? 0}
            format={(v) => Math.round(v).toLocaleString('ru-RU')}
            caption="заказов, у которых плановая дата вывоза уже прошла"
            loading={counts.loading}
            items={counts.overdueRows.map((o: any) => ({
              id: o.id,
              label: `${o.orderNumber} · ${o.customer?.name ?? '—'}`,
              value: `${o.overdueDays} дн`,
              sub: `план ${formatDate(o.plannedShipmentDate)} · ${ORDER_STATUS_LABELS[o.status] ?? o.status}`,
              onClick: () => openCard(o.id),
            }))}
            emptyText="Просроченных заказов нет"
            action={{ label: 'Все просроченные', onClick: () => openList('overdue') }}
          />

          <DigestCard
            title="Новые из 1С"
            tone="brand"
            icon={<IconInbox aria-hidden size={20} />}
            value={counts.fresh ?? 0}
            format={(v) => Math.round(v).toLocaleString('ru-RU')}
            caption="ждут приёма в производство — пока не приняты, цех их не видит"
            loading={counts.loading}
            items={counts.freshRows.map((o: any) => ({
              id: o.id,
              label: `${o.orderNumber} · ${o.customer?.name ?? '—'}`,
              value: formatDate(o.plannedShipmentDate),
              sub: o.projectSite ? `объект ${o.projectSite}` : undefined,
              onClick: () => openCard(o.id),
            }))}
            emptyText="Новых заказов нет"
            action={{ label: 'Принять в работу', onClick: () => openList('new') }}
          />

          <DigestCard
            title="К отгрузке"
            tone="ok"
            icon={<IconTruckDelivery aria-hidden size={20} />}
            value={counts.ready ?? 0}
            format={(v) => Math.round(v).toLocaleString('ru-RU')}
            caption="изготовлены полностью — можно вывозить"
            loading={counts.loading}
            items={counts.readyRows.map((o: any) => ({
              id: o.id,
              label: `${o.orderNumber} · ${o.customer?.name ?? '—'}`,
              value: formatDate(o.plannedShipmentDate),
              onClick: () => openCard(o.id),
            }))}
            emptyText="Готовых к отгрузке нет"
            action={{ label: 'Показать', onClick: () => openList('ready') }}
          />

          <DigestCard
            title="Всего в реестре"
            icon={<IconLayoutGrid aria-hidden size={20} />}
            value={total}
            format={(v) => Math.round(v).toLocaleString('ru-RU')}
            caption="активных заказов после приёма из 1С"
            emptyText=""
            action={{ label: 'Открыть реестр', onClick: () => openList('all') }}
          />
        </DigestGrid>
      ) : (
      <>
      {/* Фильтры и плитки списка прячутся, пока открыта карточка
          (04.09.2026): они управляют СПИСКОМ, которого сейчас не видно,
          и отнимают у карточки около 100 px. */}
      {!openedId && (
      <>
      {/* Компактно: здесь плитки переключают список, а не отчитываются */}
      <PulseRow
        compact
        loading={counts.loading && !meta}
        items={[
          {
            key: 'all', label: 'Всего в реестре', value: fmt(meta ? total : null),
            hint: 'все заказы', icon: <IconLayoutGrid aria-hidden size={16} />,
            onClick: () => applySlice('all'), active: isAll,
          },
          {
            key: 'overdue', label: 'Просрочено', value: fmt(counts.overdue),
            hint: 'план вывоза прошёл', tone: 'danger', icon: <IconClockExclamation aria-hidden size={16} />,
            onClick: () => applySlice('overdue'), active: overdueOnly,
          },
          {
            key: 'new', label: 'Новые из 1С', value: fmt(counts.fresh),
            hint: 'ждут приёма в производство', tone: 'brand', icon: <IconInbox aria-hidden size={16} />,
            onClick: () => applySlice('new'), active: status === 'NEW',
          },
          {
            key: 'ready', label: 'К отгрузке', value: fmt(counts.ready),
            hint: 'изготовлены полностью', tone: 'ok', icon: <IconTruckDelivery aria-hidden size={16} />,
            onClick: () => applySlice('ready'), active: status === 'READY_TO_SHIP',
          },
        ]}
      />
      </>
      )}

      {!openedId && (
      <div className="toolbar-sticky">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="sm" wrap="wrap">
            <TextInput
              placeholder="№ заказа, заказчик или БС..."
              leftSection={<IconSearch aria-hidden size={16} />}
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
                <Button variant="default" size="md" leftSection={<IconBookmark aria-hidden size={16} />}>
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
                        aria-label="Удалить сохранённый вид"
                      >
                        <IconTrash aria-hidden size={16} />
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
                <Menu.Item leftSection={<IconBookmarkPlus aria-hidden size={16} />} onClick={() => setSaveViewOpened(true)}>
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
      )}

      {/* Заказ открыт — карточка во весь экран (04.09.2026, решение
          владельца). Боковая панель на 420 px была тесной: в карточке
          этапы по позициям, количества, деньги, подряд и себестоимость,
          и всё это в узкой колонке читалось лентой. Порядок работы:
          увидел список → выбрал заказ → делаешь всё в карточке. */}
      {openedId ? (
      <div className="order-full">
        <div className="order-full__head">
          <button type="button" className="order-full__back" onClick={closeCard}>
            <IconArrowLeft aria-hidden size={16} />
            Все заказы
          </button>
        </div>
        <div className="order-full__body" ref={fit.ref as any} style={{ maxHeight: fit.height }}>
          <OrderDetail id={openedId} onClose={closeCard} />
        </div>
      </div>
      ) : (
      <>
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
                        <Ref
                          kind="customer"
                          id={o.customer?.id ?? o.customerId}
                          label={o.customer?.name}
                          tone="text"
                          size="sm"
                        >
                          {o.customer?.name ?? '—'}
                        </Ref>
                        {o.region ? ` · ${o.region}` : ''}
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
                <EmptyState height={132} title="Заказов по такому запросу нет" />
              )}
            </Stack>
          ) : (
            <TableScroll minWidth={820} maxHeight={fit.height} containerRef={fit.ref}>
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
                        <EmptyState height={132} title="Заказов по такому запросу нет" />
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Table.Tbody>
              </Table>
            </TableScroll>
          )}
        </Card>
      </FadeSwap>

      <div ref={fit.footerRef}>
        <PaginationBar
          page={page}
          total={total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          noun="заказов"
          sticky
        />
      </div>
      </>
      )}
      </>
      )}

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
