import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  Card, Group, Text, Skeleton, TextInput, Button, ActionIcon, Tooltip, Loader, Stack,
} from '@mantine/core';
import {
  IconSearch, IconCheck, IconArrowBackUp, IconRuler2, IconDots, IconTruck,
  IconClock, IconAlertTriangle, IconTool, IconChecks,
} from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { ordersApi } from '../../api/orders';
import { useAuthStore } from '../../store/auth';
import { FadeSwap } from '../../components/motion';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { PulseRow } from '../../components/SectionHeader';
import { FitScreen, useFitRows, usePageKeys, ROW_H } from '../../components/FitScreen';
import { MastLoader } from '../../components/Mast';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { formatDate } from '../../utils/formatters';
import type { ShopFloorOrder, ShopFloorResponse, ProductRow, MarkVars } from './shopfloor/types';
import { DetailsSheet } from './shopfloor/DetailsSheet';

/**
 * Цех: список изделий, которые надо изготовить (переписан 02.09.2026 —
 * «в разделе Цех вообще хаос, ничего не понятно»).
 *
 * Было: карточки ЗАКАЗОВ. Мастеру они не отвечали на его единственный
 * вопрос «что мне сейчас делать» — сначала выбрать заказ, потом открыть
 * шторку, и только там увидеть изделия. Плюс половину экрана занимали
 * заказы без спецификации, к которым цех вообще не может прикоснуться.
 *
 * Стало: плоский список ИЗДЕЛИЙ, по одной строке на каждое, кнопка
 * «Изготовлено» прямо в строке. Заказ, заказчик и срок — подпись рядом,
 * а не уровень вложенности. Изделия без спецификации убраны за плитку:
 * это работа инженера, а не цеха.
 *
 * Экран не прокручивается: строк ровно столько, сколько влезло, дальше —
 * страницами (стрелки ← → тоже листают).
 */

/** Срез списка — плитка сверху одновременно и цифра, и фильтр */
type Slice = 'todo' | 'overdue' | 'blocked' | 'done';

interface WorkRow extends ProductRow {
  order: ShopFloorOrder;
}

/** Нет состава или норм труда — изготовление записать нельзя */
const isBlocked = (p: ProductRow) => p.missingBom || p.missingNorms;

export function ShopFloor() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canEdit = hasRole(['shop_foreman', 'planner', 'admin']);

  const [search, setSearch] = useState('');
  const [slice, setSlice] = useState<Slice>('todo');
  const [sheet, setSheet] = useState<{ order: ShopFloorOrder; product: ProductRow } | null>(null);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['shop-floor', search],
    queryFn: () => api.get<ShopFloorResponse>('/production-plan/shop-floor', {
      params: search ? { search } : undefined,
    }).then((r) => r.data),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  // Единственное действие цеха: изделие сделано / отметка снята. Когда
  // готовы все изделия заказа, бэкенд сам переводит его в «готов к отгрузке»
  // и ставит в очередь сигнал 1С на «Производство без заказа»
  const mark = useMutation({
    mutationFn: (v: MarkVars) =>
      ordersApi.updateStage(v.orderId, 'PRODUCTION', {
        status: v.done ? 'done' : 'in_progress',
        orderLineId: v.productId,
      }).then((r) => r.data),
    onSuccess: (res: any, v) => {
      qc.invalidateQueries({ queryKey: ['shop-floor'] });
      if (res?.orderStatus === 'READY_TO_SHIP' && res?.orderStatusChanged) {
        notifications.show({
          title: 'Заказ изготовлен полностью',
          message: 'Все изделия готовы — заказ к отгрузке, сигнал в 1С поставлен в очередь',
          color: 'success',
          icon: <IconCheck size={16} />,
        });
      } else {
        notifications.show({
          title: v.done ? 'Изготовлено' : 'Отметка снята',
          message: '',
          color: v.done ? 'success' : 'warning',
          icon: v.done ? <IconCheck size={16} /> : <IconArrowBackUp size={16} />,
        });
      }
    },
    onError: (e: any) => notifications.show({
      title: 'Ошибка',
      message: e?.response?.data?.error?.message ?? 'Не удалось отметить',
      color: 'danger',
    }),
  });

  /**
   * Разворачиваем заказы в изделия и сортируем так, как работает цех:
   * сначала просроченное, потом ближайший срок. Внутри одного заказа —
   * порядок позиций, чтобы строки не прыгали между обновлениями.
   */
  const rows = useMemo<WorkRow[]>(() => {
    const out: WorkRow[] = [];
    for (const o of data?.orders ?? []) {
      for (const p of o.products) out.push({ ...p, order: o });
    }
    out.sort((a, b) => {
      if (a.order.overdueDays !== b.order.overdueDays) return b.order.overdueDays - a.order.overdueDays;
      const da = a.order.plannedShipmentDate ?? '9999';
      const db = b.order.plannedShipmentDate ?? '9999';
      if (da !== db) return da < db ? -1 : 1;
      if (a.order.orderNumber !== b.order.orderNumber) {
        return a.order.orderNumber.localeCompare(b.order.orderNumber, 'ru');
      }
      return a.lineNo - b.lineNo;
    });
    return out;
  }, [data]);

  const groups = useMemo(() => {
    const todo: WorkRow[] = [];
    const overdue: WorkRow[] = [];
    const blocked: WorkRow[] = [];
    const done: WorkRow[] = [];
    for (const r of rows) {
      if (r.status === 'DONE') { done.push(r); continue; }
      if (isBlocked(r)) { blocked.push(r); continue; }
      todo.push(r);
      if (r.order.overdueDays > 0) overdue.push(r);
    }
    return { todo, overdue, blocked, done };
  }, [rows]);

  const visible = groups[slice];

  // Сколько строк влезло в свободную высоту — столько и показываем
  const fit = useFitRows(ROW_H, 4, 40);
  const paged = usePagedList(visible, fit.rows, `${search}|${slice}|${fit.rows}`);
  const totalPages = Math.max(1, Math.ceil(paged.total / Math.max(1, fit.rows)));
  usePageKeys(paged.page, totalPages, paged.setPage);

  const tiles = [
    {
      key: 'todo',
      label: 'Изготовить',
      value: groups.todo.length.toLocaleString('ru-RU'),
      hint: 'можно отметить прямо сейчас',
      tone: 'brand' as const,
      icon: <IconTool size={16} />,
      onClick: () => setSlice('todo'),
      active: slice === 'todo',
    },
    {
      key: 'overdue',
      label: 'Просрочено',
      value: groups.overdue.length.toLocaleString('ru-RU'),
      hint: 'срок вывоза уже прошёл',
      tone: 'danger' as const,
      icon: <IconClock size={16} />,
      onClick: () => setSlice('overdue'),
      active: slice === 'overdue',
    },
    {
      key: 'blocked',
      label: 'Ждут инженера',
      value: groups.blocked.length.toLocaleString('ru-RU'),
      hint: 'нет состава или норм труда',
      tone: 'warn' as const,
      icon: <IconAlertTriangle size={16} />,
      onClick: () => setSlice('blocked'),
      active: slice === 'blocked',
    },
    {
      key: 'done',
      label: 'Изготовлено',
      value: groups.done.length.toLocaleString('ru-RU'),
      hint: 'отметку можно снять',
      tone: 'ok' as const,
      icon: <IconChecks size={16} />,
      onClick: () => setSlice('done'),
      active: slice === 'done',
    },
  ];

  const emptyText = search ? 'Ничего не найдено'
    : slice === 'todo' ? 'Всё изготовлено'
      : slice === 'overdue' ? 'Просроченных изделий нет'
        : slice === 'blocked' ? 'Все изделия со спецификацией'
          : 'Пока ничего не отмечено';

  const header = (
    <Stack gap="sm">
      <PulseRow items={tiles} loading={isLoading && !data} />
      <Group gap="sm" wrap="nowrap">
        <TextInput
          placeholder="Изделие, № заказа или заказчик..."
          leftSection={<IconSearch size={17} />}
          rightSection={isFetching && search ? <Loader size="xs" /> : undefined}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          size="sm"
          style={{ flex: '1 1 260px', maxWidth: 420 }}
        />
        <Text size="sm" c="dimmed" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
          Осталось изготовить{' '}
          <Text span fw={700} ff="var(--ff-num)" c="var(--ref-ink)">
            {(data?.waitingProducts ?? 0).toLocaleString('ru-RU')}
          </Text>
          {' '}из {(data?.totalProducts ?? 0).toLocaleString('ru-RU')}
        </Text>
      </Group>
    </Stack>
  );

  const footer = (
    <PaginationBar
      page={paged.page}
      total={paged.total}
      pageSize={Math.max(1, fit.rows)}
      onPageChange={paged.setPage}
      noun="изделий"
    />
  );

  return (
    <>
      <FitScreen header={header} footer={footer}>
        <Card withBorder radius="lg" padding={0} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
          <div className="worklist" ref={fit.ref}>
            <div className="worklist__head">
              <span>Изделие</span>
              <span>Заказ · срок · действие</span>
            </div>
            <div className="worklist__rows">
              {isLoading && !data ? (
                [...Array(8)].map((_, i) => (
                  <div key={i} className="worklist__row"><Skeleton height={18} radius="sm" /></div>
                ))
              ) : paged.total === 0 ? (
                <MastLoader title={emptyText} />
              ) : (
                <FadeSwap swapKey={`${paged.page}|${slice}|${fit.rows}`}>
                  {paged.slice.map((p) => (
                    <WorkRowView
                      key={p.id}
                      row={p}
                      canEdit={canEdit}
                      busy={mark.isPending && mark.variables?.productId === p.id}
                      onMark={(done) => mark.mutate({ orderId: p.order.id, productId: p.id, done })}
                      onDetails={() => setSheet({ order: p.order, product: p })}
                    />
                  ))}
                </FadeSwap>
              )}
            </div>
          </div>
        </Card>
      </FitScreen>

      <DetailsSheet
        order={sheet?.order ?? null}
        product={sheet?.product ?? null}
        requests={data?.openRequests ?? []}
        opened={sheet !== null}
        onClose={() => setSheet(null)}
      />
    </>
  );
}

/**
 * Одна строка работы. Всё, что нужно мастеру, — в одну линию: что делать,
 * сколько, для какого заказа, к какому числу и кнопка отметки.
 */
function WorkRowView({
  row: p, canEdit, busy, onMark, onDetails,
}: {
  row: WorkRow;
  canEdit: boolean;
  busy: boolean;
  onMark: (done: boolean) => void;
  onDetails: () => void;
}) {
  const done = p.status === 'DONE';
  const blocked = isBlocked(p);
  const overdue = p.order.overdueDays > 0;
  const specMissing = p.missingBom && p.missingNorms ? 'состава и норм'
    : p.missingBom ? 'состава' : 'норм труда';

  return (
    <div className="worklist__row" data-done={done ? 'true' : undefined}>
      <div className="worklist__main">
        <span className="worklist__qty">{p.qty.toLocaleString('ru-RU')} {p.unit}</span>
        <span className="worklist__code">{p.articleCode}</span>
        <span className="worklist__name" title={p.articleName}>{p.articleName}</span>
        {p.isDuplicateCode && <span className="worklist__chip">поз. {p.lineNo}</span>}
        {p.siteCode && <span className="worklist__chip" data-tone="info">{p.siteCode}</span>}
        {p.contractors.length > 0 && (
          <span className="worklist__chip" data-tone="warn"><IconTruck size={11} /> подряд</span>
        )}
        {blocked && !done && (
          <span className="worklist__chip" data-tone="danger">нет {specMissing}</span>
        )}
      </div>

      <div className="worklist__meta">
        <OrderRef id={p.order.id} number={p.order.orderNumber} size="sm" focus="stages" />
        <span className="worklist__meta-hide" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {p.order.customerName ?? '—'}
        </span>
        <span style={{ fontFamily: 'var(--ff-num)', color: overdue ? 'var(--ref-coral-ink)' : undefined }}>
          {formatDate(p.order.plannedShipmentDate)}
          {overdue && ` · −${p.order.overdueDays} дн`}
        </span>

        {canEdit && (done ? (
          <Button size="compact-sm" variant="default" h={30}
            leftSection={<IconArrowBackUp size={15} />}
            loading={busy} onClick={() => onMark(false)}>
            Снять
          </Button>
        ) : blocked ? (
          <Button size="compact-sm" variant="light" color="danger" h={30}
            component={Link} to={p.articleId ? `/specs?article=${p.articleId}` : '/specs'}
            leftSection={<IconRuler2 size={15} />}>
            Спецификация
          </Button>
        ) : (
          <Group gap={6} wrap="nowrap">
            <Button size="compact-sm" h={30} leftSection={<IconCheck size={15} />}
              loading={busy} onClick={() => onMark(true)}>
              Изготовлено
            </Button>
            <Tooltip label="Часы, подряд, обеспеченность" openDelay={400}>
              <ActionIcon variant="default" size={30} aria-label="Подробности" onClick={onDetails}>
                <IconDots size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        ))}
      </div>
    </div>
  );
}
