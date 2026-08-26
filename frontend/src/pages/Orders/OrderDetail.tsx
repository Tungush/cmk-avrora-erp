import React, { useEffect, useRef, useState } from 'react';
import {
  Stack, Group, Text, Card, Badge, Button, Textarea, Divider, Table, Skeleton, Box,
  Popover, ActionIcon, Timeline, Select, Progress, Tooltip,
} from '@mantine/core';
import {
  IconLock, IconAlertTriangle, IconHelpCircle, IconWand, IconCheck,
  IconPlayerPlay, IconTruck, IconCircle,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useOrder, useTransitionOrderStatus } from '../../hooks/useOrders';
import { useAuthStore } from '../../store/auth';
import { getAllowedTransitions, STATE_TRANSITIONS, DERIVED_STATUSES } from '../../utils/roles';
import { StatusBadge } from '../../components/StatusBadge';
import { OrderCostingPanel } from '../../components/OrderCostingPanel';
import { ArchivedHint, OrderCardFocus } from '../../components/OrderCard/OrderCardProvider';
import { RequestNomenclatureModal } from '../Specifications/NomenclaturePanel';
import { Collapse } from '../../components/motion';
import {
  formatCurrency, formatDate, ORDER_STATUS_LABELS, STAGE_LABELS, STAGE_ORDER,
} from '../../utils/formatters';

const ORDER_TYPE_LABELS: Record<string, string> = { FZ: 'ФЗ', VZ: 'ВЗ' };

/** Ключ шага так, как его отдаёт бэкенд: «PRODUCTION:CUTTING» либо «DESIGN» */
const stepKey = (code: string, routingStage?: string | null) =>
  routingStage ? `${code}:${routingStage}` : code;

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
          <IconHelpCircle size={14} />
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
        <Button variant="subtle" size="xs" onClick={() => setOpened((v) => !v)}>
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
        <IconLock size={15} style={{ color: 'var(--mantine-color-gray-5)' }} />
        <Text fw={600} size="sm" c="dimmed">{title} — нет доступа</Text>
      </Group>
      <Text size="xs" c="dimmed" mt={4}>Данные существуют, но закрыты для роли «{roleName}»</Text>
    </Card>
  );
}

/**
 * Где сейчас заказ: пять шагов от чертежа до покраски.
 *
 * Данные приходили в ответе API с самого начала и выбрасывались — из-за
 * этого карточка отвечала на вопрос «что это за заказ» и молчала о том,
 * «что с ним происходит», хотя за этим в неё идут мастер, снабженец
 * и плановик (решение 23.08.2026).
 */
function StagesSection({ stages }: { stages: any[] }) {
  const byKey = new Map<string, any[]>();
  for (const s of stages) {
    const k = stepKey(s.stageCode, s.routingStage);
    byKey.set(k, [...(byKey.get(k) ?? []), s]);
  }

  const steps = STAGE_ORDER.map((key) => {
    const rows = byKey.get(key) ?? [];
    const status = rows.length === 0
      ? 'NOT_STARTED'
      : rows.every((r) => r.status === 'DONE')
        ? 'DONE'
        : rows.some((r) => r.status === 'DONE' || r.status === 'IN_PROGRESS')
          ? 'IN_PROGRESS'
          : 'NOT_STARTED';
    const hours = rows.reduce((s, r) => s + Number(r.actualHours ?? 0), 0);
    const done = rows.find((r) => r.completedAt)?.completedAt ?? null;
    return { key, label: STAGE_LABELS[key] ?? key, status, hours, completedAt: done };
  });

  const doneCount = steps.filter((s) => s.status === 'DONE').length;
  const active = steps.findIndex((s) => s.status !== 'DONE');

  return (
    <Section
      title="Где сейчас"
      id="card-stages"
      extra={
        <Group gap="xs">
          <Progress value={(doneCount / steps.length) * 100} w={80} size="sm" radius="xl"
            color={doneCount === steps.length ? 'teal' : 'brand'} />
          <Text size="xs" ff="monospace" c="dimmed">{doneCount}/{steps.length}</Text>
        </Group>
      }
    >
      <Timeline active={active === -1 ? steps.length : active} bulletSize={22} lineWidth={2} mt={4}>
        {steps.map((s) => (
          <Timeline.Item
            key={s.key}
            title={<Text size="sm" fw={s.status === 'IN_PROGRESS' ? 700 : 500}>{s.label}</Text>}
            color={s.status === 'DONE' ? 'teal' : s.status === 'IN_PROGRESS' ? 'brand' : 'gray'}
            bullet={
              s.status === 'DONE' ? <IconCheck size={12} />
                : s.status === 'IN_PROGRESS' ? <IconPlayerPlay size={12} />
                  : <IconCircle size={10} />
            }
          >
            <Group gap="sm">
              <Text size="xs" c="dimmed">
                {s.status === 'DONE' ? 'закрыт' : s.status === 'IN_PROGRESS' ? 'в работе' : 'не начат'}
                {s.completedAt ? ` · ${formatDate(s.completedAt)}` : ''}
              </Text>
              {s.hours > 0 && (
                <Text size="xs" c="dimmed" ff="monospace">{s.hours} ч факт</Text>
              )}
            </Group>
          </Timeline.Item>
        ))}
      </Timeline>
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
  const lines: any[] = o.orderLines ?? o.lines ?? [];
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
      notifications.show({ title: 'Переход отклонён', message: msg, color: 'danger', icon: <IconAlertTriangle size={16} /> });
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
              <Badge variant="outline" color="gray" radius="xl">1С: {o.onecNum}</Badge>
            </Tooltip>
          )}
          {o.isArchived && <ArchivedHint />}
        </Group>
        {order.overdueDays > 0 && (
          <Badge color="danger" variant="light" radius="xl" leftSection={<IconAlertTriangle size={12} />}>
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
          <Table.ScrollContainer minWidth={420}>
            <Table highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Артикул</Table.Th>
                  <Table.Th ta="right">Кол-во</Table.Th>
                  {canCommercial && <Table.Th ta="right">Цена</Table.Th>}
                  {canCommercial && <Table.Th ta="right">Сумма с НДС</Table.Th>}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {lines.map((l) => (
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
                          <Badge size="xs" color="orange" variant="light">нет в справочнике</Badge>
                          {canProduction && (
                            <Text
                              size="xs" c="brand.7" fw={600} style={{ cursor: 'pointer' }}
                              onClick={() => setNomenclatureFor(l.productNameRaw ?? l.articleCodeRaw ?? '')}
                            >
                              заявка в 1С
                            </Text>
                          )}
                        </Group>
                      )}
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
          </Table.ScrollContainer>
        )}
      </Card>

      {/* ▼ Где сейчас — этапы цеха */}
      {canProduction ? (
        <StagesSection stages={stages} />
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
                <Text size="sm" fw={700} ff="monospace" c={unpaid > 0 ? 'orange.7' : undefined}>
                  {formatCurrency(unpaid)}
                </Text>
              </Group>
              {contracted > 0 && (
                <Progress value={(paid / contracted) * 100} size="sm" radius="xl" color="teal" mt={4} />
              )}
            </Stack>
          )}
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
                size="xs"
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
                <IconWand size={15} style={{ color: 'var(--mantine-color-dimmed)', flexShrink: 0 }} />
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
                  rightSection={!isAllowed ? <IconLock size={14} /> : undefined}
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
