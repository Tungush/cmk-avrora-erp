import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Button, Skeleton,
  ThemeIcon, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconInbox, IconCircleCheck, IconAlertTriangle, IconArrowRight, IconRefresh,
} from '@tabler/icons-react';
import { ordersApi } from '../../api/orders';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { FadeSwap, TextReveal } from '../../components/motion';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { FitScreen, useFitRows, usePageKeys } from '../../components/FitScreen';
import { formatDate } from '../../utils/formatters';
import './Orders.css';

type InboxOrder = Awaited<ReturnType<typeof ordersApi.inbox>>['data']['data'][number];
const EMPTY: InboxOrder[] = [];

/** Высота строки заказа — по ней считается, сколько их влезло */
const ROW_H = 92;
/** Сколько строк показывать, когда инбокс встроен в чужой экран */
const EMBEDDED_ROWS = 5;

/**
 * Инбокс «Новые заказы» (решение 22.08.2026): сделка Б24 → документ 1С →
 * сюда. Производство принимает заказ явно, кнопкой; пока висят блокеры
 * (позиция без артикула, нет БИН) — принять нельзя, и это видно.
 *
 * 03.09.2026: страница не прокручивается. Заказ был карточкой на
 * 106–200 px с блокерами в три абзаца — девять заказов давали 814 px
 * прокрутки, и кнопка «Принять» у нижних была за краем. Теперь заказ —
 * строка постоянной высоты, блокеры — пилюли с полным текстом в
 * подсказке, а лишние заказы уходят на следующую страницу (← →).
 *
 * `embedded` — когда инбокс вставлен в чужой экран («Моя работа»):
 * там своей высоты у него нет, и рамку он не ставит.
 */
export function OrdersInbox({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['orders', 'inbox'],
    queryFn: () => ordersApi.inbox().then((r) => r.data),
    refetchInterval: 30_000,
  });

  const accept = useMutation({
    mutationFn: (id: string) => ordersApi.accept(id),
    onMutate: (id) => setAcceptingId(id),
    onSettled: () => setAcceptingId(null),
    onSuccess: (_r, id) => {
      const order = data?.data.find((o) => o.id === id);
      notifications.show({
        title: 'Заказ принят в производство',
        message: `${order?.orderNumber ?? ''} — статус «Подтверждён», можно планировать этапы`,
        color: 'teal',
      });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e: any) => {
      notifications.show({
        title: 'Не принят',
        message: e?.response?.data?.message ?? 'Ошибка при приёме заказа',
        color: 'red',
      });
    },
  });

  // Инбокс приходит целиком — страницы режем на клиенте по высоте экрана
  const orders = useMemo(() => data?.data ?? EMPTY, [data]);
  const fit = useFitRows(ROW_H, 3, 40, 0);
  const perPage = embedded ? EMBEDDED_ROWS : Math.max(1, fit.rows);
  const paged = usePagedList(orders, perPage, `${orders.length}|${perPage}`);
  usePageKeys(paged.page, embedded ? 1 : paged.totalPages, paged.setPage);

  const blocked = orders.filter((o) => !o.canAccept).length;

  const header = (
    <Group justify="space-between" align="center" wrap="nowrap" gap="md">
      <Group gap="sm" wrap="nowrap" align="baseline" style={{ minWidth: 0 }}>
        <Text component="h1" className="page-title" style={{ fontSize: 26, lineHeight: 1.1, whiteSpace: 'nowrap', margin: 0 }}>
          <TextReveal text="Новые заказы из 1С" />
        </Text>
        <Text size="sm" c="dimmed" lineClamp={1}>
          {orders.length === 0
            ? 'принимать нечего'
            : `${orders.length - blocked} можно принять сейчас, ${blocked} держат блокеры`}
        </Text>
        {orders.length > 0 && (
          <Badge size="lg" variant="filled" color="brand" radius="xl">{orders.length}</Badge>
        )}
      </Group>
      <Button
        variant="light" leftSection={<IconRefresh size={16} />}
        loading={isFetching} onClick={() => refetch()}
      >
        Обновить
      </Button>
    </Group>
  );

  const body = isLoading ? (
    <Stack gap={4} p="md">
      {[...Array(4)].map((_, i) => <Skeleton key={i} height={72} radius="md" />)}
    </Stack>
  ) : orders.length === 0 ? (
    <Stack align="center" gap="sm" py="xl">
      <ThemeIcon size={56} radius="xl" variant="light" color="success">
        <IconInbox size={28} />
      </ThemeIcon>
      <Text fw={700}>Инбокс пуст</Text>
      <Text size="sm" c="dimmed" ta="center">
        Новые заказы появятся здесь после синхронизации с 1С —
        сделка Б24 создаёт «Заказ клиента», мы его забираем.
      </Text>
    </Stack>
  ) : (
    <FadeSwap swapKey={paged.page}>
      {paged.slice.map((o) => (
        <InboxRow
          key={o.id}
          order={o}
          busy={acceptingId === o.id}
          onAccept={() => accept.mutate(o.id)}
        />
      ))}
    </FadeSwap>
  );

  const list = (
    <Card withBorder radius="lg" padding={0} style={{ display: 'flex', flexDirection: 'column', height: embedded ? undefined : '100%', minHeight: 0, overflow: 'hidden' }}>
      <div className="inbox-list" ref={embedded ? undefined : fit.ref}>{body}</div>
    </Card>
  );

  const pagination = (
    <PaginationBar
      page={paged.page}
      total={paged.total}
      pageSize={perPage}
      onPageChange={paged.setPage}
      noun="заказов"
    />
  );

  // Встроенный вариант («Моя работа») рамку не ставит: высоту ему задаёт
  // хозяйский экран, а не окно браузера
  if (embedded) {
    return <Stack gap="sm">{list}{orders.length > perPage && pagination}</Stack>;
  }

  return (
    <FitScreen header={header} footer={orders.length > 0 ? pagination : undefined}>
      {list}
    </FitScreen>
  );
}

/** Одна строка инбокса: кто, что, чем держится и кнопка приёма */
function InboxRow({
  order: o, busy, onAccept,
}: {
  order: InboxOrder;
  busy: boolean;
  onAccept: () => void;
}) {
  const lines = (o as any).orderLines?.length ?? 0;
  const customer = (o as any).customer?.name ?? '';

  return (
    <div className="inbox-row">
      <div className="inbox-row__main">
        <div className="inbox-row__line">
          <OrderRef id={o.id} number={o.orderNumber} />
          {o.onecNum && <Badge variant="outline" color="gray" radius="xl" size="sm">1С: {o.onecNum}</Badge>}
          {o.onecStatus && <Badge variant="light" color="brand" radius="xl" size="sm">{o.onecStatus}</Badge>}
        </div>

        <Text size="sm" c="dimmed" lineClamp={1}>
          {customer}
          {o.plannedShipmentDate ? ` · отгрузка ${formatDate(o.plannedShipmentDate)}` : ''}
          {` · позиций: ${lines}`}
          {` · получен ${formatDate(o.createdAt as unknown as string)}`}
        </Text>

        <div className="inbox-row__line">
          {o.blockers.length === 0 ? (
            <span className="inbox-chip">блокеров нет</span>
          ) : o.blockers.map((b) => (
            // Полный текст блокера — в подсказке и в title: в строку он
            // не влезает, но и терять его нельзя (03.09.2026)
            <Tooltip key={b.code} label={b.message} multiline w={340} openDelay={200}>
              <span className="inbox-chip" data-tone={b.code === 'NO_BOM' ? undefined : 'danger'} title={b.message}>
                {b.message}
              </span>
            </Tooltip>
          ))}
        </div>
      </div>

      <div className="inbox-row__side">
        <Tooltip
          label={o.canAccept
            ? 'NEW → Подтверждён: заказ уйдёт в планирование'
            : 'Сначала разрешите блокеры — сопоставьте артикулы или подайте заявку на номенклатуру'}
        >
          <Button
            size="sm"
            leftSection={o.canAccept ? <IconCircleCheck size={17} /> : <IconAlertTriangle size={17} />}
            rightSection={<IconArrowRight size={15} />}
            disabled={!o.canAccept}
            loading={busy}
            onClick={onAccept}
          >
            Принять в производство
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
