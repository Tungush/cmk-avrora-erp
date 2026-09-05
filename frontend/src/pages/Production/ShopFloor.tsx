import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  Card, Group, Text, Skeleton, TextInput, Button, ActionIcon, Tooltip, Loader, Stack,
} from '@mantine/core';
import {
  IconSearch, IconCheck, IconArrowBackUp, IconRuler2, IconDots, IconTruck,
  IconClock, IconAlertTriangle, IconTool, IconChecks, IconArrowLeft, IconChevronRight,
} from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { ordersApi } from '../../api/orders';
import { useAuthStore } from '../../store/auth';
import { FadeSwap } from '../../components/motion';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { PulseRow } from '../../components/SectionHeader';
import { FitScreen, useFitRows, usePageKeys } from '../../components/FitScreen';
import { EmptyState } from '../../components/EmptyState';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { Ref } from '../../components/EntityRef';
import { formatDate } from '../../utils/formatters';
import type { ShopFloorOrder, ShopFloorResponse, ProductRow, MarkVars } from './shopfloor/types';
import { DetailsSheet } from './shopfloor/DetailsSheet';

/**
 * Цех: заказы в работе, по нажатию — карточка заказа с отметками
 * (переписан 05.09.2026 по просьбе владельца: «в цеху лучше показывать
 * заказ, и при нажатии открывается карточка для взаимодействия»).
 *
 * История. 02.09 плоский список изделий заменил карточки заказов, потому
 * что в старых карточках было два уровня вложенности до кнопки. Плоский
 * список решил это, но 693 строки изделий из 241 заказа — стена: мастер
 * работает заказом («сделать 2528 к среде»), а не россыпью позиций.
 *
 * Теперь два слоя, без третьего: список ЗАКАЗОВ (номер, заказчик,
 * объекты, срок, сколько изделий сделано, что мешает) → нажатие →
 * карточка ЗАКАЗА во весь экран: те же строки изделий с кнопкой
 * «Изготовлено» и «⋯» для часов, подряда и обеспеченности. Полный
 * паспорт заказа — по номеру в шапке карточки.
 *
 * Экран не прокручивается: заказов ровно столько, сколько влезло, дальше
 * страницами; изделия внутри карточки крутятся сами.
 */

/** Срез списка — плитка сверху одновременно и цифра, и фильтр */
type Slice = 'todo' | 'overdue' | 'blocked' | 'done';

/** Нет состава или норм труда — изготовление записать нельзя */
const isBlocked = (p: ProductRow) => p.missingBom || p.missingNorms;
const isFullyDone = (o: ShopFloorOrder) => o.totalProducts > 0 && o.doneCount >= o.totalProducts;
/** Есть хоть одно изделие, которое можно отметить прямо сейчас */
const hasWork = (o: ShopFloorOrder) => o.products.some((p) => p.status !== 'DONE' && !isBlocked(p));

export function ShopFloor() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canEdit = hasRole(['shop_foreman', 'planner', 'admin']);

  const [search, setSearch] = useState('');
  const [slice, setSlice] = useState<Slice>('todo');
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ order: ShopFloorOrder; product: ProductRow } | null>(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
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
          icon: <IconCheck aria-hidden size={16} />,
        });
      } else {
        notifications.show({
          title: v.done ? 'Изготовлено' : 'Отметка снята',
          message: '',
          color: v.done ? 'success' : 'warning',
          icon: v.done ? <IconCheck aria-hidden size={16} /> : <IconArrowBackUp aria-hidden size={16} />,
        });
      }
    },
    onError: (e: any) => notifications.show({
      title: 'Ошибка',
      message: e?.response?.data?.error?.message ?? 'Не удалось отметить',
      color: 'danger',
    }),
  });

  /** Заказы в порядке цеха: сначала просроченное, потом ближайший срок */
  const orders = useMemo<ShopFloorOrder[]>(() => {
    const out = [...(data?.orders ?? [])];
    out.sort((a, b) => {
      if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays;
      const da = a.plannedShipmentDate ?? '9999';
      const db = b.plannedShipmentDate ?? '9999';
      if (da !== db) return da < db ? -1 : 1;
      return a.orderNumber.localeCompare(b.orderNumber, 'ru');
    });
    return out;
  }, [data]);

  const groups = useMemo(() => ({
    todo: orders.filter((o) => !isFullyDone(o) && hasWork(o)),
    overdue: orders.filter((o) => !isFullyDone(o) && o.overdueDays > 0),
    blocked: orders.filter((o) => !isFullyDone(o) && o.blockedCount > 0),
    done: orders.filter(isFullyDone),
  }), [orders]);

  const visible = groups[slice];
  const opened = openedId ? orders.find((o) => o.id === openedId) ?? null : null;

  // Сколько строк влезло в свободную высоту — столько и показываем (56 px строка)
  const fit = useFitRows(56, 4, 40);
  const paged = usePagedList(visible, fit.rows, `${search}|${slice}|${fit.rows}`);
  const totalPages = Math.max(1, Math.ceil(paged.total / Math.max(1, fit.rows)));
  usePageKeys(paged.page, totalPages, paged.setPage);

  const tiles = [
    { key: 'todo', label: 'В работе', value: groups.todo.length.toLocaleString('ru-RU'), hint: 'есть что отметить', tone: 'brand' as const, icon: <IconTool aria-hidden size={16} />, onClick: () => setSlice('todo'), active: slice === 'todo' },
    { key: 'overdue', label: 'Просрочено', value: groups.overdue.length.toLocaleString('ru-RU'), hint: 'срок вывоза прошёл', tone: 'danger' as const, icon: <IconClock aria-hidden size={16} />, onClick: () => setSlice('overdue'), active: slice === 'overdue' },
    { key: 'blocked', label: 'Ждут инженера', value: groups.blocked.length.toLocaleString('ru-RU'), hint: 'нет состава или норм', tone: 'warn' as const, icon: <IconAlertTriangle aria-hidden size={16} />, onClick: () => setSlice('blocked'), active: slice === 'blocked' },
    { key: 'done', label: 'Изготовлены', value: groups.done.length.toLocaleString('ru-RU'), hint: 'все изделия готовы', tone: 'ok' as const, icon: <IconChecks aria-hidden size={16} />, onClick: () => setSlice('done'), active: slice === 'done' },
  ];

  const emptyText = search ? 'Ничего не найдено'
    : slice === 'todo' ? 'Всё изготовлено'
      : slice === 'overdue' ? 'Просроченных заказов нет'
        : slice === 'blocked' ? 'Все изделия со спецификацией'
          : 'Пока ни один заказ не готов целиком';

  /* ---- карточка заказа во весь экран ---- */
  if (opened) {
    return (
      <>
        <FitScreen>
          <Card withBorder radius="lg" padding={0} className="shop-card">
            <div className="shop-card__head">
              <Button variant="default" size="sm" radius="xl" leftSection={<IconArrowLeft aria-hidden size={16} />} onClick={() => setOpenedId(null)}>
                Все заказы
              </Button>
              <div className="shop-card__title">
                <OrderRef id={opened.id} number={opened.orderNumber} size="md" focus="stages" />
              </div>
              <span className="shop-card__cust">
                <Ref kind="customer" id={opened.customerName} label={opened.customerName ?? undefined} tone="text" size="14px">
                  {opened.customerName ?? '—'}
                </Ref>
              </span>
              <span className="shop-order__date" data-overdue={opened.overdueDays > 0 ? 'true' : undefined}>
                срок {formatDate(opened.plannedShipmentDate)}{opened.overdueDays > 0 && ` · −${opened.overdueDays} дн`}
              </span>
              <span className="shop-card__progress">
                <span className="bar" data-tone={isFullyDone(opened) ? 'ok' : undefined}>
                  <span style={{ width: `${opened.totalProducts ? Math.round((opened.doneCount / opened.totalProducts) * 100) : 0}%` }} />
                </span>
                {opened.doneCount} / {opened.totalProducts} изделий
              </span>
              {opened.blockedCount > 0 && (
                <span className="worklist__chip" data-tone="danger">ждут инженера · {opened.blockedCount}</span>
              )}
            </div>
            <div className="shop-card__rows">
              {opened.products.map((p) => (
                <ProductRowView
                  key={p.id}
                  product={p}
                  canEdit={canEdit}
                  busy={mark.isPending && mark.variables?.productId === p.id}
                  onMark={(done) => mark.mutate({ orderId: opened.id, productId: p.id, done })}
                  onDetails={() => setSheet({ order: opened, product: p })}
                />
              ))}
              {opened.resaleCount > 0 && (
                <Text size="sm" c="dimmed" px="md" py="sm">
                  Ещё {opened.resaleCount} позиций — перепродажа материалов, цех их не изготавливает.
                </Text>
              )}
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

  /* ---- список заказов ---- */
  const header = (
    <Stack gap="sm">
      <PulseRow items={tiles} loading={isLoading && !data} />
      <Group gap="sm" wrap="nowrap">
        <TextInput
          placeholder="№ заказа, заказчик или изделие..."
          leftSection={<IconSearch aria-hidden size={16} />}
          rightSection={isFetching && search ? <Loader size="xs" /> : undefined}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          size="sm"
          style={{ flex: '1 1 260px', maxWidth: 420 }}
        />
        <Text size="sm" c="dimmed" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
          Осталось изготовить{' '}
          <Text span fw={700} ff="var(--ff-num)" c="var(--s-text)">
            {(data?.waitingProducts ?? 0).toLocaleString('ru-RU')}
          </Text>
          {' '}изделий из {(data?.totalProducts ?? 0).toLocaleString('ru-RU')}
        </Text>
      </Group>
    </Stack>
  );

  const footer = (
    <PaginationBar page={paged.page} total={paged.total} pageSize={Math.max(1, fit.rows)} onPageChange={paged.setPage} noun="заказов" />
  );

  return (
    <FitScreen header={header} footer={footer}>
      <Card withBorder radius="lg" padding={0} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
        <div className="worklist" ref={fit.ref}>
          <div className="shop-order shop-order--head" aria-hidden>
            <span>Заказ · заказчик</span><span>Объекты</span><span>Срок</span><span>Изготовлено</span><span>Внимание</span><span />
          </div>
          <div className="worklist__rows">
            {isLoading && !data ? (
              [...Array(8)].map((_, i) => (
                <div key={i} className="shop-order"><Skeleton height={18} radius="sm" /></div>
              ))
            ) : paged.total === 0 ? (
              <EmptyState title={emptyText} error={error} onRetry={() => refetch()} />
            ) : (
              <FadeSwap swapKey={`${paged.page}|${slice}|${fit.rows}`}>
                {paged.slice.map((o) => (
                  <OrderRowView key={o.id} order={o} onOpen={() => setOpenedId(o.id)} />
                ))}
              </FadeSwap>
            )}
          </div>
        </div>
      </Card>
    </FitScreen>
  );
}

/** Строка заказа: одна строка — один заказ, нажатие открывает карточку */
function OrderRowView({ order: o, onOpen }: { order: ShopFloorOrder; onOpen: () => void }) {
  const sites = Array.from(new Set(o.products.map((p) => p.siteCode).filter(Boolean))) as string[];
  const contractors = o.products.some((p) => p.contractors.length > 0);
  const overdue = o.overdueDays > 0;
  const done = isFullyDone(o);
  const pct = o.totalProducts ? Math.round((o.doneCount / o.totalProducts) * 100) : 0;
  return (
    <button type="button" className="shop-order" data-done={done ? 'true' : undefined} onClick={onOpen}>
      <span className="shop-order__who">
        <span className="shop-order__num">{o.orderNumber}</span>
        <span className="shop-order__cust">{o.customerName ?? '—'}</span>
      </span>
      <span className="shop-order__sites">
        {sites.slice(0, 2).map((s) => <span key={s} className="worklist__chip" data-tone="info">{s}</span>)}
        {sites.length > 2 && <span className="worklist__chip">+{sites.length - 2}</span>}
        {sites.length === 0 && <span className="shop-order__cust">—</span>}
      </span>
      <span className="shop-order__date" data-overdue={overdue ? 'true' : undefined}>
        {formatDate(o.plannedShipmentDate)}{overdue && ` · −${o.overdueDays} дн`}
      </span>
      <span className="shop-order__progress">
        <span className="bar" data-tone={done ? 'ok' : undefined}><span style={{ width: `${pct}%` }} /></span>
        {o.doneCount} / {o.totalProducts}
      </span>
      <span className="shop-order__flags">
        {o.blockedCount > 0 && <span className="worklist__chip" data-tone="danger">инженер · {o.blockedCount}</span>}
        {contractors && <span className="worklist__chip" data-tone="warn"><IconTruck aria-hidden size={14} /> подряд</span>}
      </span>
      <IconChevronRight aria-hidden size={16} className="shop-order__chev" />
    </button>
  );
}

/**
 * Одна строка изделия внутри карточки заказа: что делать, сколько,
 * что мешает — и кнопка отметки. Заказ и срок уже в шапке карточки.
 */
function ProductRowView({
  product: p, canEdit, busy, onMark, onDetails,
}: {
  product: ProductRow;
  canEdit: boolean;
  busy: boolean;
  onMark: (done: boolean) => void;
  onDetails: () => void;
}) {
  const done = p.status === 'DONE';
  const blocked = isBlocked(p);
  const specMissing = p.missingBom && p.missingNorms ? 'состава и норм'
    : p.missingBom ? 'состава' : 'норм труда';

  return (
    <div className="worklist__row" data-done={done ? 'true' : undefined}>
      <div className="worklist__main">
        <span className="worklist__qty">{p.qty.toLocaleString('ru-RU')} {p.unit}</span>
        <span className="worklist__code">
          <Ref kind="article" id={p.articleId} label={p.articleName} tone="code" size="sm">{p.articleCode}</Ref>
        </span>
        <span className="worklist__name" title={p.articleName}>
          <Ref kind="article" id={p.articleId} label={p.articleName} tone="text" size="15px">{p.articleName}</Ref>
        </span>
        {p.isDuplicateCode && <span className="worklist__chip">поз. {p.lineNo}</span>}
        {p.siteCode && (
          <span className="worklist__chip" data-tone="info">
            <Ref kind="site" id={p.siteCode} label={p.siteCode} tone="text" size="13px" bold>{p.siteCode}</Ref>
          </span>
        )}
        {p.contractors.length > 0 && (
          <span className="worklist__chip" data-tone="warn"><IconTruck aria-hidden size={16} /> подряд</span>
        )}
        {blocked && !done && <span className="worklist__chip" data-tone="danger">нет {specMissing}</span>}
      </div>

      <div className="worklist__meta">
        {canEdit && (done ? (
          <Button size="compact-sm" variant="default" h={44} leftSection={<IconArrowBackUp aria-hidden size={16} />} loading={busy} onClick={() => onMark(false)}>
            Снять
          </Button>
        ) : blocked ? (
          <Button size="compact-sm" variant="light" color="danger" h={44} component={Link} to={p.articleId ? `/specs?article=${p.articleId}` : '/specs'} leftSection={<IconRuler2 aria-hidden size={16} />}>
            Спецификация
          </Button>
        ) : (
          <Group gap={6} wrap="nowrap">
            <Button size="compact-sm" h={44} leftSection={<IconCheck aria-hidden size={16} />} loading={busy} onClick={() => onMark(true)}>
              Изготовлено
            </Button>
            <Tooltip label="Часы, подряд, обеспеченность" openDelay={400}>
              <ActionIcon variant="default" size={44} aria-label="Подробности" onClick={onDetails}>
                <IconDots aria-hidden size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        ))}
      </div>
    </div>
  );
}
