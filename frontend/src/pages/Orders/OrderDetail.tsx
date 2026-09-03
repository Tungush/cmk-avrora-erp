import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Stack, Group, Text, Card, Badge, Button, Textarea, Divider, Table, Skeleton, Box,
  Popover, ActionIcon, Timeline, Select, Progress, Tooltip, Modal, NumberInput, Alert, TextInput,
} from '@mantine/core';
import {
  IconLock, IconAlertTriangle, IconHelpCircle, IconWand, IconCheck,
  IconPlayerPlay, IconTruck, IconCircle,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../api/client';
import { ordersApi } from '../../api/orders';
import { contractorRequestsApi } from '../../api/contractorRequests';
import { useOrder, useTransitionOrderStatus } from '../../hooks/useOrders';
import { useAuthStore } from '../../store/auth';
import { getAllowedTransitions, STATE_TRANSITIONS, DERIVED_STATUSES } from '../../utils/roles';
import { StatusBadge } from '../../components/StatusBadge';
import { OrderCostingPanel } from '../../components/OrderCostingPanel';
import { ArchivedHint, OrderCardFocus } from '../../components/OrderCard/OrderCardProvider';
import { RequestNomenclatureModal } from '../Specifications/NomenclaturePanel';
import { Collapse, FadeSwap } from '../../components/motion';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { CustomerPaymentsBlock, AcceptanceActsBlock } from '../../components/OrderCard/OrderMoneyExtras';
import {
  formatCurrency, formatDate, ORDER_STATUS_LABELS,
} from '../../utils/formatters';

const ORDER_TYPE_LABELS: Record<string, string> = { FZ: 'ФЗ', VZ: 'ВЗ' };

const EMPTY_LINES: any[] = [];
/** Длинные списки в шторке режем по 25 — короткие пагинацию не показывают */
const DRAWER_PAGE = 25;

/**
 * Объект / базовая станция на позиции (28.08.2026): телеком работает
 * объектами, и «что мы должны на ALM_Kalina» без этого поля не спросить.
 * Правится по клику; пусто — честное «не указан».
 */
function SiteCell({ orderId, line, canEdit }: { orderId: string; line: any; canEdit: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string>(line.siteCode ?? '');
  const save = useMutation({
    mutationFn: () => api.patch(`/orders/${orderId}/lines/${line.id}/site`, { siteCode: value }).then((r: any) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['order', orderId] });
      setEditing(false);
    },
    onError: (e: any) => notifications.show({
      title: 'Не сохранено',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });
  if (editing) {
    return (
      <TextInput
        size="sm" w={140} autoFocus
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
        placeholder="Б_103860"
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') save.mutate(); if (e.key === 'Escape') setEditing(false); }}
        onBlur={() => save.mutate()}
        disabled={save.isPending}
      />
    );
  }
  return (
    <Text
      size="sm" ff="monospace"
      c={line.siteCode ? undefined : 'dimmed'}
      style={canEdit ? { cursor: 'pointer' } : undefined}
      onClick={canEdit ? () => { setValue(line.siteCode ?? ''); setEditing(true); } : undefined}
    >
      {line.siteCode ?? (canEdit ? '— указать' : '—')}
    </Text>
  );
}

/** Пусто — это «нет данных», а не ноль. Ноль читается как факт и врёт */
const orDash = (v: React.ReactNode, empty: boolean) =>
  empty ? <Text span size="sm" c="dimmed">нет данных</Text> : v;

/**
 * Раскрывающийся расчёт (§2.3 ③): кнопка [?] у расчётного поля показывает
 * разбор формулы построчно — вместо =IF(M6<0;"";IF($L6-SUM(...)>0;...)).
 */
function BalanceExplain({ docs }: { docs: any[] }) {
  const sum = (f: string) => docs.reduce((s, d) => s + Number(d?.[f] ?? 0), 0);
  const rows = [
    { label: 'Сумма по ДО', value: sum('totalAmount'), sign: '' },
    { label: 'Оплачено', value: sum('paidAmount'), sign: '−' },
  ];
  return (
    <Popover width={300} position="bottom-end" shadow="md" radius="md">
      <Popover.Target>
        <ActionIcon variant="subtle" color="gray" size="xs" aria-label="Разбор формулы">
          <IconHelpCircle aria-hidden size={16} />
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
            <Text size="xs" fw={700}>= Остаток</Text>
            <Text size="xs" fw={700} ff="monospace">{formatCurrency(sum('unpaidAmount'))}</Text>
          </Group>
          <Text size="xs" c="dimmed" mt={4}>
            По договорам-основаниям из 1С — не по колонкам старой таблицы
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="md" align="flex-start">
      <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{label}</Text>
      <Text size="sm" fw={500} ff={mono ? 'monospace' : undefined} ta="right">
        {value ?? <Text span c="dimmed">нет данных</Text>}
      </Text>
    </Group>
  );
}

function Section({
  title, children, id, extra,
}: { title: string; children: React.ReactNode; id?: string; extra?: React.ReactNode }) {
  return (
    <Card withBorder radius="md" padding="md" id={id}>
      <Group justify="space-between" mb="xs">
        <Text fw={700} size="sm">{title}</Text>
        {extra}
      </Group>
      <Stack gap={6}>{children}</Stack>
    </Card>
  );
}

/**
 * Всё, что прислала 1С в заголовке заказа, дословно — не только те 10
 * колонок, для которых у нас завелось отдельное поле. 23 из 44 колонок
 * 1С-выгрузки не имеют своего места в схеме (Приоритет, Организация,
 * НаправлениеДеятельности и т.д.) — заводить под каждую отдельную
 * колонку смысла нет, но и терять эти данные не надо (решение
 * пользователя 25.08.2026: «вот из чего должна состоять наша сделка»).
 */
function RawDataSection({ rawColumns }: { rawColumns: Record<string, string | null> }) {
  const [opened, setOpened] = useState(false);
  const entries = Object.entries(rawColumns).filter(([, v]) => v != null && String(v).trim() !== '');
  return (
    <Section
      title="Все данные 1С"
      extra={
        <Button variant="subtle" size="compact-sm" onClick={() => setOpened((v) => !v)}>
          {opened ? 'Свернуть' : `Показать (${entries.length})`}
        </Button>
      }
    >
      <Collapse opened={opened}>
        <Stack gap={6} pt={2}>
          {entries.map(([k, v]) => (
            <Row key={k} label={k} value={String(v)} />
          ))}
        </Stack>
      </Collapse>
      {!opened && <Text size="xs" c="dimmed">Полный сырой ряд из ЗаказыШапки.csv — {entries.length} заполненных полей</Text>}
    </Section>
  );
}

function LockedSection({ title, roleName }: { title: string; roleName: string }) {
  return (
    <Card withBorder radius="md" padding="md" bg="var(--mantine-color-default-hover)">
      <Group gap="xs">
        <IconLock aria-hidden size={16} style={{ color: 'var(--mantine-color-gray-5)' }} />
        <Text fw={600} size="sm" c="dimmed">{title} — нет доступа</Text>
      </Group>
      <Text size="xs" c="dimmed" mt={4}>Данные существуют, но закрыты для роли «{roleName}»</Text>
    </Card>
  );
}

/**
 * Где сейчас заказ: что уже изготовлено (26.08.2026).
 *
 * Раньше здесь был таймлайн видов работ — резка / сборка / покраска. Цех
 * их больше не отмечает: он показывает, что готово конкретное изделие,
 * поэтому и карточка отвечает тем же — списком изделий, а не операций.
 * Сырьё и ТМЦ в списке не участвуют: завод их не изготавливает.
 */
function StagesSection({ stages, lines }: { stages: any[]; lines: any[] }) {
  const statusByLine = new Map<string, any>();
  for (const s of stages) {
    if (!s.orderLineId) continue;
    const prev = statusByLine.get(s.orderLineId);
    // DONE важнее IN_PROGRESS: одна закрывающая отметка решает
    if (s.status === 'DONE' || !prev) statusByLine.set(s.orderLineId, s);
  }

  const products = lines.filter((l) => l.article && !l.article.isMaterialResale);
  const resaleCount = lines.length - products.length;

  const steps = products.map((l) => {
    const st = statusByLine.get(l.id);
    return {
      id: l.id,
      code: l.article?.articleCode ?? '—',
      name: l.article?.name ?? l.description ?? '—',
      qty: Number(l.qty ?? 0),
      unit: l.unit ?? 'шт',
      status: st?.status ?? 'NOT_STARTED',
      hours: st?.actualHours != null ? Number(st.actualHours) : null,
      completedAt: st?.completedAt ?? null,
    };
  });

  const doneCount = steps.filter((s) => s.status === 'DONE').length;
  // Изделий бывает больше сотни — лента режется по 25, «текущее» ищем в
  // пределах страницы: всё до него сделано, оно — первое незакрытое
  const paged = usePagedList(steps, DRAWER_PAGE, stages);
  const active = paged.slice.findIndex((s) => s.status !== 'DONE');

  return (
    <Section
      title="Что изготовлено"
      id="card-stages"
      extra={steps.length > 0 ? (
        <Group gap="xs">
          <Progress value={(doneCount / steps.length) * 100} w={80} radius="xl"
            color={doneCount === steps.length ? 'success' : 'brand'} />
          <Text size="xs" ff="monospace" c="dimmed">{doneCount}/{steps.length}</Text>
        </Group>
      ) : undefined}
    >
      {steps.length === 0 ? (
        <Text size="sm" c="dimmed">
          Изготавливать нечего — в заказе только сырьё и ТМЦ
          {resaleCount > 0 ? ` (${resaleCount} позиций)` : ''}
        </Text>
      ) : (
        <>
          <FadeSwap swapKey={paged.page}>
            <Timeline active={active === -1 ? paged.slice.length : active} bulletSize={22} lineWidth={2} mt={4}>
              {paged.slice.map((s) => (
                <Timeline.Item
                  key={s.id}
                  title={
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" ff="monospace" fw={700}>{s.code}</Text>
                      <Text size="sm" fw={s.status === 'IN_PROGRESS' ? 700 : 500} lineClamp={1}>{s.name}</Text>
                    </Group>
                  }
                  color={s.status === 'DONE' ? 'success' : s.status === 'IN_PROGRESS' ? 'brand' : 'gray'}
                  bullet={
                    s.status === 'DONE' ? <IconCheck aria-hidden size={16} />
                      : s.status === 'IN_PROGRESS' ? <IconPlayerPlay aria-hidden size={16} />
                        : <IconCircle aria-hidden size={16} />
                  }
                >
                  <Group gap="sm">
                    <Text size="xs" c="dimmed">
                      {s.qty.toLocaleString('ru-RU')} {s.unit} ·{' '}
                      {s.status === 'DONE' ? 'изготовлено' : s.status === 'IN_PROGRESS' ? 'в работе' : 'не начато'}
                      {s.completedAt ? ` · ${formatDate(s.completedAt)}` : ''}
                    </Text>
                    {s.hours != null && s.hours > 0 && (
                      <Text size="xs" c="dimmed" ff="monospace">{s.hours} ч факт</Text>
                    )}
                  </Group>
                </Timeline.Item>
              ))}
            </Timeline>
            </FadeSwap>
          {paged.total > DRAWER_PAGE && (
            <PaginationBar
              page={paged.page}
              total={paged.total}
              pageSize={DRAWER_PAGE}
              onPageChange={paged.setPage}
              noun="изделий"
              variant="compact"
            />
          )}
          {resaleCount > 0 && (
            <Text size="xs" c="dimmed" mt="sm">
              Ещё {resaleCount} позиций — сырьё и ТМЦ, их не изготавливают
            </Text>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * Подряд по этому заказу и что он сделал с трудозатратами (26.08.2026,
 * запрос пользователя: «разнос по заказам надо мочь делать через сам
 * заказ… когда укажем подряд с суммой, у нас пересчитается трудозатрата.
 * Было базовая 2 часа, от неё сминусуется то, что сделал подряд»).
 *
 * Пересчёт работал в калькуляции с самого начала, но нигде не назывался
 * вслух: доля подряда вырезает свой кусок нормы, остаток достаётся штату.
 * Здесь та же арифметика показана в трёх колонках — было / подряд / штат.
 */
function ContractorSection({ orderId, orderNumber }: { orderId: string; orderNumber: string }) {
  const qc = useQueryClient();
  const [assigning, setAssigning] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [qty, setQty] = useState<number | string>('');
  const [sharePct, setSharePct] = useState<number | string>(100);

  const { data, isLoading } = useQuery({
    queryKey: ['contractor-work', orderId],
    queryFn: () => ordersApi.contractorWork(orderId).then((r) => r.data),
  });
  // Заявки, из которых ещё есть что разносить
  const { data: requests } = useQuery({
    queryKey: ['contractor-requests', 'open'],
    queryFn: () => contractorRequestsApi.list(),
    enabled: assigning,
  });
  const open = (requests?.data ?? []).filter(
    (r) => r.status !== 'CANCELLED' && r.contractor
      && (r.unallocatedQty == null || r.unallocatedQty > 0),
  );
  const chosen = open.find((r) => r.id === requestId) ?? null;

  const allocate = useMutation({
    mutationFn: () => contractorRequestsApi.allocate(requestId as string, {
      orderId, qty: Number(qty), share: Number(sharePct) / 100,
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['contractor-work', orderId] });
      qc.invalidateQueries({ queryKey: ['contractor-requests'] });
      setAssigning(false); setRequestId(null); setQty(''); setSharePct(100);
      notifications.show({
        title: 'Подряд записан на заказ',
        message: `${res.qty} ${res.unit} из ${chosen?.number ?? 'заявки'}.`
          + ` Штат по «${res.stageLabel}» пересчитан — пересчитайте себестоимость`,
        color: 'success',
        icon: <IconCheck aria-hidden size={16} />,
      });
    },
    onError: (e: any) => notifications.show({
      title: 'Не записано',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
      icon: <IconAlertTriangle aria-hidden size={16} />,
    }),
  });

  const impact = data?.laborImpact ?? [];
  const totals = data?.laborTotals;
  const works = data?.data ?? [];

  return (
    <Section
      title="Подряд и трудозатраты"
      id="card-contractor"
      extra={
        <Button size="compact-sm" variant="light" onClick={() => setAssigning(true)}>
          Указать подряд
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton height={90} radius="md" />
      ) : impact.length === 0 ? (
        <Text size="sm" c="dimmed">
          Норм труда по изделиям заказа нет — считать нечего
        </Text>
      ) : (
        <>
          <TableScroll minWidth={600}>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Вид работ</Table.Th>
                  <Table.Th ta="right">Норма</Table.Th>
                  <Table.Th ta="right">Забрал подряд</Table.Th>
                  <Table.Th ta="right">Осталось штату</Table.Th>
                  <Table.Th ta="right">Подрядчику, ₸</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {impact.map((r) => (
                  <Table.Tr key={r.stage}>
                    <Table.Td>
                      <Text size="sm">{r.stageLabel}</Text>
                      {r.contractors.length > 0 && (
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {r.contractors.map((c) => `${c.name} — ${c.sharePct} %`).join('; ')}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">{r.normHours} ч</Table.Td>
                    <Table.Td ta="right" ff="monospace" c={r.contractorSharePct > 0 ? 'warning.7' : 'dimmed'}>
                      {r.contractorSharePct > 0
                        ? `−${r.contractorHours} ч (${r.contractorSharePct} %)`
                        : '—'}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={600}>{r.staffHours} ч</Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {r.contractorAmount > 0 ? formatCurrency(r.contractorAmount) : '—'}
                    </Table.Td>
                  </Table.Tr>
                ))}
                {totals && (
                  <Table.Tr>
                    <Table.Td><Text size="sm" fw={700}>Итого</Text></Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={700}>{totals.normHours} ч</Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={700} c="warning.8">
                      {totals.contractorHours > 0 ? `−${totals.contractorHours} ч` : '—'}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={700}>{totals.staffHours} ч</Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={700}>
                      {totals.contractorAmount > 0 ? formatCurrency(totals.contractorAmount) : '—'}
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
            </TableScroll>
          {works.length > 0 && (
            <Text size="xs" c="dimmed" mt="xs">
              Часы подряда в мощность цеха не идут, если работы на площадке
              подрядчика. Себестоимость возьмёт эти цифры при пересчёте.
            </Text>
          )}
        </>
      )}

      <Modal
        opened={assigning}
        onClose={() => setAssigning(false)}
        title={<Text fw={700}>Подряд на заказ {orderNumber}</Text>}
        radius="md"
        centered
        /* Карточка заказа — шторка со своим слоем; без этого модалка
           открывается ПОД ней и выглядит нерабочей */
        zIndex={400}
      >
        <Stack gap="md">
          <Select
            label="Заявка на подряд"
            description="работа отдана партией — укажите, сколько из неё пришлось на этот заказ"
            placeholder={open.length === 0 ? 'открытых заявок нет' : 'выберите'}
            data={open.map((r) => ({
              value: r.id,
              label: `${r.number} · ${r.stageLabel} · ${r.contractor?.name ?? ''}`,
            }))}
            value={requestId}
            onChange={setRequestId}
            disabled={open.length === 0}
            searchable
            /* Слой модалки поднят над шторкой — выпадашке нужен ещё выше,
               иначе список открывается под ней и выглядит пустым */
            comboboxProps={{ withinPortal: true, zIndex: 500 }}
          />
          {chosen && (
            <Text size="sm" c="dimmed">
              {chosen.unallocatedQty != null
                ? <>осталось разнести <Text span fw={700} ff="monospace">
                    {chosen.unallocatedQty} {chosen.unit}</Text></>
                : 'объём по заявке не задан'}
            </Text>
          )}
          <NumberInput
            label={`Сколько ушло на этот заказ${chosen ? ` (${chosen.unit})` : ''}`}
            value={qty}
            onChange={setQty}
            min={0}
            decimalScale={3}
          />
          <NumberInput
            label="Какую долю работ забрал подряд, %"
            description="от неё зависит, сколько нормо-часов останется штату"
            value={sharePct}
            onChange={setSharePct}
            min={1}
            max={100}
          />
          {open.length === 0 && (
            <Alert color="gray" variant="light" p="xs" radius="md">
              <Text size="sm">
                Заявки заводятся в разделе «Подряд» — там же их отправляют в Б24
                и принимают акт из 1С.
              </Text>
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setAssigning(false)}>Отмена</Button>
            <Button
              loading={allocate.isPending}
              disabled={!requestId || !(Number(qty) > 0)}
              onClick={() => allocate.mutate()}
            >
              Записать на заказ
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Section>
  );
}

export function OrderDetail({
  id, onClose, focus,
}: { id: string; onClose: () => void; focus?: OrderCardFocus | null }) {
  const { data: order, isLoading } = useOrder(id);
  const { mutateAsync: transitionStatus, isPending } = useTransitionOrderStatus();
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const [comment, setComment] = useState('');
  const [costLineId, setCostLineId] = useState<string | null>(null);
  // Заявка на номенклатуру подаётся ИЗ СДЕЛКИ (26.08.2026): позиция без
  // артикула видна прямо здесь, производственник вписывает проф. название
  // и отправляет в 1С — сервис ждёт сигнала nomenclature.created
  const [nomenclatureFor, setNomenclatureFor] = useState<string | null>(null);
  const scrolled = useRef(false);

  // Позиции нужны до раннего return: хук пагинации зовётся всегда
  const lines: any[] = useMemo(
    () => (order as any)?.orderLines ?? (order as any)?.lines ?? EMPTY_LINES,
    [order],
  );
  const linesPaged = usePagedList(lines, DRAWER_PAGE, id);

  // Открыли из цеха — прокрутить к этапам, из финансов — к деньгам.
  // Секция не прячется, просто оказывается перед глазами
  useEffect(() => {
    if (!focus || !order || scrolled.current) return;
    const map: Record<string, string> = {
      stages: 'card-stages', money: 'card-money', cost: 'card-cost',
      supply: 'card-supply', lines: 'card-lines',
    };
    const el = document.getElementById(map[focus]);
    if (el) { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); scrolled.current = true; }
  }, [focus, order]);

  if (isLoading || !order) {
    return (
      <Stack gap="md">
        {[...Array(4)].map((_, i) => <Skeleton key={i} height={110} radius="md" />)}
      </Stack>
    );
  }

  const o: any = order;
  const docs: any[] = o.paymentDocuments ?? [];
  const stages: any[] = o.productionStages ?? [];

  const canCommercial = can('read', 'order.commercial');
  const canProduction = can('read', 'order.production');
  const canLogistics = can('read', 'order.logistics');
  // Себестоимость — отдельное право, а не «финансы». Панель гейтилась на
  // order.commercial, из-за чего менеджер по продажам и снабженец видели
  // себестоимость и ставки подрядчиков, а конструктор с правом order.cost —
  // не видел ничего (проверено по ROLE_MATRIX в field-access.ts)
  const canCost = can('read', 'order.cost');
  const roleName = user?.roles?.[0] ?? '—';

  const allowedTransitions = getAllowedTransitions(order.status, user?.roles || []);
  const allPossibleTransitions = STATE_TRANSITIONS[order.status] || [];
  const derivedNext = allPossibleTransitions.filter((s) => DERIVED_STATUSES.includes(s));
  const manualTransitions = allPossibleTransitions.filter((s) => !DERIVED_STATUSES.includes(s));

  // Деньги берём из ДО (их ведёт 1С), а не из колонок OrderLine — по живым
  // заказам те нули, потому что заполнялись только Excel-миграцией
  const docSum = (f: string) => docs.reduce((s, d) => s + Number(d?.[f] ?? 0), 0);
  const contracted = docs.length > 0 ? docSum('totalAmount') : Number(o.onecTotalAmount ?? 0);
  const paid = docs.length > 0 ? docSum('paidAmount') : Number(o.onecPaidAmount ?? 0);
  const unpaid = docs.length > 0 ? docSum('unpaidAmount') : Math.max(0, contracted - paid);
  const noMoney = contracted === 0 && paid === 0;

  const qtySum = lines.reduce((s, l) => s + Number(l?.qty ?? 0), 0);
  const reservedSum = lines.reduce((s, l) => s + Number(l?.reservedQty ?? 0), 0);
  const shippedSum = lines.reduce((s, l) => s + Number(l?.shippedQty ?? 0), 0);

  const activeCostLine = costLineId ?? lines.find((l) => l.id)?.id ?? null;

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
      notifications.show({ title: 'Переход отклонён', message: msg, color: 'danger', icon: <IconAlertTriangle aria-hidden size={16} /> });
    }
  };

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="sm" wrap="wrap">
          <Text fw={800} size="lg" ff="monospace">{order.orderNumber}</Text>
          <StatusBadge status={order.status} />
          {o.onecNum && (
            <Tooltip label={o.onecStatus ? `статус в 1С: ${o.onecStatus}` : '№ документа в 1С'}>
              <Badge variant="outline" color="gray" radius="xl" size="lg">1С: {o.onecNum}</Badge>
            </Tooltip>
          )}
          {o.isArchived && <ArchivedHint />}
        </Group>
        {order.overdueDays > 0 && (
          <Badge color="danger" variant="light" radius="xl" size="lg" leftSection={<IconAlertTriangle aria-hidden size={16} />}>
            Просрочка {order.overdueDays} дн
          </Badge>
        )}
      </Group>

      {/* ▼ Основное. Конечный заказчик и объект приходят из 1С и раньше
          нигде не показывались, хотя завод работает через генподрядчиков */}
      <Section title="Основное">
        <Row label="Заказчик" value={o.customer?.name ?? o.customerName} />
        {o.finalCustomer && <Row label="Конечный заказчик" value={o.finalCustomer} />}
        {o.projectSite && <Row label="Объект" value={o.projectSite} />}
        {o.customerOrderNum && <Row label="№ заказа с конечным" value={o.customerOrderNum} mono />}
        <Row label="Тип заказа" value={ORDER_TYPE_LABELS[order.orderType] ?? order.orderType} />
        <Row label="Регион" value={order.region || null} />
        {o.projectGroup && <Row label="Группа проектов" value={o.projectGroup} />}
        {o.divisionCode && <Row label="Подразделение" value={o.divisionCode} />}
        {o.bitrixDealId && <Row label="Сделка в Битрикс" value={o.bitrixDealId} mono />}
        {canCommercial && o.clientAgreement && <Row label="Соглашение" value={o.clientAgreement} />}
      </Section>

      {canCommercial && o.rawColumns && <RawDataSection rawColumns={o.rawColumns} />}

      {/* ▼ Позиции — то, по чему заказ узнают глазами */}
      <Card withBorder radius="md" padding="md" id="card-lines">
        <Text fw={700} size="sm" mb="xs">Позиции ({lines.length})</Text>
        {lines.length === 0 ? (
          <Text size="sm" c="dimmed">Позиций нет — не пришли из 1С</Text>
        ) : (
          <>
          <FadeSwap swapKey={linesPaged.page}>
            <TableScroll minWidth={560}>
                <Table highlightOnHover verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Артикул</Table.Th>
                      <Table.Th>Объект / БС</Table.Th>
                      <Table.Th ta="right">Кол-во</Table.Th>
                      {canCommercial && <Table.Th ta="right">Цена</Table.Th>}
                      {canCommercial && <Table.Th ta="right">Сумма с НДС</Table.Th>}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {linesPaged.slice.map((l) => (
                      <Table.Tr key={l.id}>
                        <Table.Td>
                          <Text size="sm" ff="monospace">
                            {l.article?.articleCode ?? l.articleCodeRaw ?? '—'}
                          </Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {l.article?.name ?? l.productNameRaw ?? 'без артикула'}
                          </Text>
                          {!l.articleId && (
                            <Group gap={6} mt={2}>
                              <Badge size="xs" color="warning" variant="light">нет в справочнике</Badge>
                              {canProduction && (
                                <Text
                                  size="xs" fw={600} style={{ cursor: 'pointer' }}
                                  onClick={() => setNomenclatureFor(l.productNameRaw ?? l.articleCodeRaw ?? '')}
                                >
                                  заявка в 1С
                                </Text>
                              )}
                            </Group>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <SiteCell orderId={id} line={l} canEdit={can('write', 'order.core') || canProduction} />
                        </Table.Td>
                        <Table.Td ff="monospace" ta="right">{Number(l.qty)} {l.unit}</Table.Td>
                        {canCommercial && (
                          <Table.Td ff="monospace" ta="right">
                            {orDash(formatCurrency(Number(l.unitPrice ?? 0)), !Number(l.unitPrice))}
                          </Table.Td>
                        )}
                        {canCommercial && (
                          <Table.Td ff="monospace" ta="right">
                            {orDash(formatCurrency(Number(l.lineTotalVat ?? 0)), !Number(l.lineTotalVat))}
                          </Table.Td>
                        )}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </TableScroll>
            </FadeSwap>
          {linesPaged.total > DRAWER_PAGE && (
            <PaginationBar
              page={linesPaged.page}
              total={linesPaged.total}
              pageSize={DRAWER_PAGE}
              onPageChange={linesPaged.setPage}
              noun="позиций"
              variant="compact"
            />
          )}
          </>
        )}
      </Card>

      {/* ▼ Где сейчас — этапы цеха */}
      {canProduction ? (
        <>
          <StagesSection stages={stages} lines={lines} />
          <ContractorSection orderId={id} orderNumber={o.orderNumber} />
        </>
      ) : (
        <LockedSection title="Где сейчас" roleName={roleName} />
      )}

      {/* ▼ Деньги — из договоров-оснований 1С */}
      {canCommercial ? (
        <Card withBorder radius="md" padding="md" id="card-money">
          <Group justify="space-between" mb="xs">
            <Text fw={700} size="sm">Деньги</Text>
            {docs.length > 0 && (
              <Badge variant="light" color="gray" size="sm">ДО: {docs.length}</Badge>
            )}
          </Group>
          {noMoney ? (
            <Text size="sm" c="dimmed">Договоров-оснований пока нет — не пришли из 1С</Text>
          ) : (
            <Stack gap={6}>
              <Row label="Законтрактовано" value={formatCurrency(contracted)} mono />
              <Row label="Оплачено" value={formatCurrency(paid)} mono />
              <Group justify="space-between" wrap="nowrap" gap="md">
                <Group gap={4} wrap="nowrap">
                  <Text size="sm" c="dimmed">Остаток</Text>
                  <BalanceExplain docs={docs} />
                </Group>
                <Text size="sm" fw={700} ff="monospace" c={unpaid > 0 ? 'warning.7' : undefined}>
                  {formatCurrency(unpaid)}
                </Text>
              </Group>
              {contracted > 0 && (
                <Progress value={(paid / contracted) * 100} radius="xl" color="success" mt={4} />
              )}
            </Stack>
          )}
          {/* Платежи и акты живут и без ДО: ручной ввод — как раз для
              случая, когда 1С ещё ничего не прислала (28.08.2026) */}
          <CustomerPaymentsBlock orderId={id} />
          <AcceptanceActsBlock orderId={id} lines={lines} />
        </Card>
      ) : (
        <LockedSection title="Деньги" roleName={roleName} />
      )}

      {/* ▼ Производство: количества. Ноль читается как факт, поэтому пусто — прочерк */}
      {canProduction && (
        <Section title="Количество">
          <Row label="Заказано" value={`${qtySum} шт`} mono />
          <Row label="В резерве" value={orDash(`${reservedSum} шт`, reservedSum === 0)} mono />
          <Row label="Отгружено" value={orDash(`${shippedSum} шт`, shippedSum === 0)} mono />
        </Section>
      )}

      {/* ▼ Сроки лентой, а не двумя полями вразнобой */}
      {canLogistics && (
        <Section title="Сроки">
          <Row label="Заявка от" value={orDash(formatDate(order.requestDate), !order.requestDate)} mono />
          <Row label="Принят в производство" value={orDash(formatDate(o.acceptedAt), !o.acceptedAt)} mono />
          <Row label="План вывоза" value={orDash(formatDate(order.plannedShipmentDate), !order.plannedShipmentDate)} mono />
          <Row label="Факт отгрузки" value={orDash(formatDate(order.actualShipmentDate), !order.actualShipmentDate)} mono />
        </Section>
      )}

      {/* ▼ Себестоимость — одна позиция за раз: их бывает больше сотни,
          и рисовать столько панелей разом бессмысленно и медленно */}
      {canCost ? (
        lines.length > 0 && (
          <Stack gap="xs" id="card-cost">
            {lines.length > 1 && (
              <Select
                size="sm"
                label="Себестоимость по позиции"
                data={lines.filter((l) => l.id).map((l) => ({
                  value: l.id,
                  label: `${l.article?.articleCode ?? '—'} · ${l.article?.name ?? l.productNameRaw ?? ''}`.slice(0, 60),
                }))}
                value={activeCostLine}
                onChange={setCostLineId}
                allowDeselect={false}
              />
            )}
            {activeCostLine && (
              <OrderCostingPanel orderId={order.id} orderLineId={activeCostLine} />
            )}
          </Stack>
        )
      ) : (
        <LockedSection title="Себестоимость" roleName={roleName} />
      )}

      {/* Действия — переходы статуса по state machine */}
      <Card withBorder radius="md" padding="md" bg="var(--mantine-color-default-hover)">
        <Text fw={700} size="sm" mb="xs">Действия</Text>
        {manualTransitions.length === 0 && derivedNext.length === 0 ? (
          <Text size="sm" c="dimmed">Заказ в конечном статусе — действий нет</Text>
        ) : (
          <Stack gap="xs">
            {derivedNext.map((status) => (
              <Group key={status} gap="xs" wrap="nowrap" px="xs" py={6}
                style={{ border: '1px dashed var(--mantine-color-default-border)', borderRadius: 8 }}>
                <IconWand aria-hidden size={16} style={{ color: 'var(--mantine-color-dimmed)', flexShrink: 0 }} />
                <Text size="sm" c="dimmed">
                  «{ORDER_STATUS_LABELS[status] ?? status}» ставится сам, когда цех отметит этапы
                </Text>
              </Group>
            ))}
            {manualTransitions.map((status) => {
              const isAllowed = allowedTransitions.includes(status);
              return (
                <Button
                  key={status}
                  variant={status === 'CANCELLED' ? 'light' : 'filled'}
                  color={status === 'CANCELLED' ? 'danger' : undefined}
                  disabled={!isAllowed || isPending}
                  onClick={() => handleTransition(status)}
                  justify="flex-start"
                  rightSection={!isAllowed ? <IconLock aria-hidden size={16} /> : undefined}
                  title={!isAllowed ? 'Нет прав для перехода' : undefined}
                >
                  {ORDER_STATUS_LABELS[status] ?? status}
                </Button>
              );
            })}
            {manualTransitions.includes('CANCELLED') && (
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
      <RequestNomenclatureModal
        opened={nomenclatureFor !== null}
        onClose={() => setNomenclatureFor(null)}
        initialName={nomenclatureFor ?? ''}
      />
    </Stack>
  );
}
