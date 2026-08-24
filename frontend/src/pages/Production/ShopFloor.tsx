import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Skeleton, Box, TextInput, Button, Drawer,
  NumberInput, Select, Switch, Divider, Progress, ThemeIcon, Alert,
} from '@mantine/core';
import {
  IconSearch, IconAlertTriangle, IconCheck, IconPlayerPlay, IconTruck, IconArrowBackUp,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { ordersApi } from '../../api/orders';
import { useAuthStore } from '../../store/auth';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { Stagger, Collapse } from '../../components/motion';
import { formatDate } from '../../utils/formatters';

interface ContractorWorkBrief {
  id: string;
  contractorId: string;
  contractorName: string;
  share: number;
  rateType: string;
  rate: number;
  isAccepted: boolean;
  actualQty: number | null;
}
interface StageState {
  code: string;
  routingStage: string | null;
  key: string;
  label: string;
  status: string;
  lineCount: number;
  normHours: number | null;
  actualHours: number | null;
  contractorWorks: ContractorWorkBrief[];
  staffShare: number;
}
interface ShopFloorRow {
  id: string;
  orderNumber: string;
  customerName: string | null;
  plannedShipmentDate: string | null;
  overdueDays: number;
  qty: number;
  articles: string[];
  stages: StageState[];
  doneCount: number;
  totalStages: number;
  currentStage: string | null;
  stageTrackingMode: 'ORDER' | 'LINE';
}
interface ShopFloorResponse {
  orders: ShopFloorRow[];
  byStage: Array<{ key: string; code: string; routingStage: string | null; label: string; count: number }>;
  total: number;
}

/** Передел мастера запоминается: это контекст смены, а не фильтр */
const MY_STAGE_KEY = 'cmk.shopfloor.myStage';

const MY_STAGES = [
  { key: 'PRODUCTION:CUTTING', label: 'Резка' },
  { key: 'PRODUCTION:ASSEMBLY', label: 'Сборка / сварка' },
  { key: 'PRODUCTION:PAINTING', label: 'Покраска' },
  { key: 'DESIGN', label: 'КД' },
  { key: 'SUPPLY', label: 'Снабжение' },
];

const RATE_TYPE_LABELS: Record<string, string> = {
  PER_HOUR: 'за час', PER_UNIT: 'за штуку', PER_KG: 'за кг',
  PER_TON: 'за тонну', FIXED: 'фиксированная',
};
const RATE_UNITS: Record<string, string> = {
  PER_HOUR: 'ч', PER_UNIT: 'шт', PER_KG: 'кг', PER_TON: 'т', FIXED: '—',
};

/**
 * Лист «Готово» (решение 23.08.2026). Обычный случай — одно касание:
 * часы не спрашиваются, потому что «не ввёл» означает «как в спецификации»,
 * а не пропуск данных. Оба блока ниже — необязательные отклонения.
 */
function DoneSheet({
  order, stage, opened, onClose,
}: {
  order: ShopFloorRow | null;
  stage: StageState | null;
  opened: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [hours, setHours] = useState<number | string>('');
  const [outsourced, setOutsourced] = useState(false);
  const [contractorId, setContractorId] = useState<string | null>(null);
  const [share, setShare] = useState(100);
  const [rate, setRate] = useState<number | string>('');
  const [rateType, setRateType] = useState<string>('PER_HOUR');
  const [atOurShop, setAtOurShop] = useState(true);
  const [volume, setVolume] = useState<number | string>('');

  const { data: contractors } = useQuery({
    queryKey: ['contractors'],
    queryFn: () => ordersApi.contractors().then((r) => r.data),
    enabled: opened,
  });

  // Сброс при каждом открытии: лист не должен помнить прошлый заказ
  useEffect(() => {
    if (!opened) return;
    setHours('');
    setOutsourced(false);
    setContractorId(null);
    setShare(100);
    setVolume('');
  }, [opened, order?.id, stage?.key]);

  // Ставка и место работ подставляются из карточки подрядчика
  useEffect(() => {
    const c = contractors?.find((x) => x.id === contractorId);
    if (!c) return;
    setRate(Number(c.defaultRate) || '');
    setRateType(c.defaultRateType);
    setAtOurShop(c.defaultWorkLocation === 'OUR_SHOP');
  }, [contractorId, contractors]);

  const save = useMutation({
    mutationFn: async () => {
      if (!order || !stage) return;
      // Подряд заводится до отметки: иначе готовый этап на миг окажется
      // полностью штатным и себестоимость дрогнет
      if (outsourced && stage.routingStage) {
        // Молча пропустить подряд нельзя: мастер увидел бы зелёное «Готово»
        // и был уверен, что работа записана на подрядчика
        if (!contractorId) {
          throw new Error('Выберите подрядчика или выключите «Делал не наш цех»');
        }
        if (!(Number(rate) > 0)) {
          throw new Error('Укажите ставку подрядчика — иначе передел встанет в 0 ₸');
        }
        await ordersApi.assignContractor(order.id, stage.routingStage, {
          contractorId,
          share: share / 100,
          rateType,
          rate: Number(rate),
          workLocation: atOurShop ? 'OUR_SHOP' : 'CONTRACTOR_SITE',
          ...(Number(volume) > 0 && rateType !== 'PER_HOUR' && atOurShop
            ? { plannedHours: Number(volume) }
            : {}),
        });
      }
      await ordersApi.updateStage(order.id, stage.code, {
        status: 'done',
        routingStage: stage.routingStage,
        ...(Number(hours) > 0 ? { actualHours: Number(hours) } : {}),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shop-floor'] });
      notifications.show({
        title: 'Готово',
        message: `${stage?.label} по заказу ${order?.orderNumber} закрыт`,
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      onClose();
    },
    onError: (e: any) => notifications.show({
      title: 'Не сохранено',
      message: e?.response?.data?.error?.message ?? e?.response?.data?.message ?? e?.message ?? 'Ошибка',
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  if (!order || !stage) return null;
  const normText = stage.normHours != null && stage.normHours > 0
    ? `${stage.normHours} ч по норме`
    : 'нормы не заведены';

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="bottom"
      size="auto"
      title={<Text fw={700}>{stage.label} · {order.orderNumber}</Text>}
      padding="md"
    >
      <Stack gap="md" pb="md">
        <Button
          size="xl"
          leftSection={<IconCheck size={22} />}
          loading={save.isPending}
          onClick={() => save.mutate()}
          fullWidth
        >
          Готово
        </Button>
        <Text size="xs" c="dimmed" ta="center">
          Часы можно не вводить — тогда считается по спецификации ({normText})
        </Text>

        <Divider label="если было иначе" labelPosition="center" />

        <NumberInput
          label="Часов по факту"
          description={normText}
          placeholder={stage.normHours != null && stage.normHours > 0 ? String(stage.normHours) : 'сколько вышло'}
          value={hours}
          onChange={setHours}
          min={0}
          decimalScale={1}
          size="md"
        />

        {stage.routingStage && (
          <>
            <Switch
              size="md"
              label="Делал не наш цех"
              description="подряд возьмёт свою долю, остальное останется штату"
              checked={outsourced}
              onChange={(e) => setOutsourced(e.currentTarget.checked)}
            />

            {outsourced && (
              <Card withBorder radius="md" padding="sm" bg="var(--mantine-color-default-hover)">
                <Stack gap="sm">
                  <Select
                    label="Подрядчик"
                    placeholder="выберите"
                    data={(contractors ?? []).map((c) => ({ value: c.id, label: c.name }))}
                    value={contractorId}
                    onChange={setContractorId}
                    size="md"
                    searchable
                  />
                  <Group grow>
                    <NumberInput
                      label="Ставка"
                      value={rate}
                      onChange={setRate}
                      min={0}
                      size="md"
                      suffix={` ₸ ${RATE_TYPE_LABELS[rateType] ?? ''}`}
                    />
                    <Select
                      label="Тип ставки"
                      data={Object.entries(RATE_TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))}
                      value={rateType}
                      onChange={(v) => setRateType(v ?? 'PER_HOUR')}
                      size="md"
                    />
                  </Group>

                  <Box>
                    <Text size="sm" fw={500} mb={4}>Сколько передела взял подрядчик</Text>
                    <Group gap="xs">
                      {[25, 50, 75, 100].map((p) => (
                        <Button
                          key={p}
                          variant={share === p ? 'filled' : 'default'}
                          size="sm"
                          onClick={() => setShare(p)}
                        >
                          {p === 100 ? 'весь' : `${p} %`}
                        </Button>
                      ))}
                    </Group>
                    {share < 100 && (
                      <Text size="xs" c="dimmed" mt={4}>
                        Остальные {100 - share} % — штат по норме, вводить не нужно
                      </Text>
                    )}
                  </Box>

                  <Switch
                    label="Работали у нас в цеху"
                    description={atOurShop ? 'часы займут мощность участка' : 'на своей площадке — мощность не занимают'}
                    checked={atOurShop}
                    onChange={(e) => setAtOurShop(e.currentTarget.checked)}
                  />

                  {atOurShop && rateType !== 'PER_HOUR' && (
                    <NumberInput
                      label="Оценка часов"
                      description="сдельная ставка часов не содержит, а участок они занимают"
                      value={volume}
                      onChange={setVolume}
                      min={0}
                      size="md"
                      suffix=" ч"
                    />
                  )}
                </Stack>
              </Card>
            )}
          </>
        )}
      </Stack>
    </Drawer>
  );
}

/**
 * Цех: заказы, ждущие моего передела (решение 23.08.2026).
 *
 * Мастер один раз выбирает свой передел — дальше видит одну колонку карточек,
 * а не полосу из пяти квадратиков внутри горизонтально скроллящейся таблицы.
 * Нормальный путь — два касания: тап по карточке, тап «Готово».
 */
export function ShopFloor() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canEdit = hasRole(['shop_foreman', 'planner', 'admin']);

  const [myStage, setMyStage] = useState<string | null>(
    () => localStorage.getItem(MY_STAGE_KEY),
  );
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ order: ShopFloorRow; stage: StageState } | null>(null);
  // Ошибочное «Готово» надо уметь снять: без этого карточка исчезает
  // из очереди навсегда и исправить отметку неоткуда
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    if (myStage) localStorage.setItem(MY_STAGE_KEY, myStage);
    else localStorage.removeItem(MY_STAGE_KEY);
  }, [myStage]);

  const { data, isLoading } = useQuery({
    queryKey: ['shop-floor'],
    queryFn: () => api.get<ShopFloorResponse>('/production-plan/shop-floor').then((r) => r.data),
    refetchInterval: 60_000,
  });

  const start = useMutation({
    mutationFn: (input: { orderId: string; stage: StageState }) =>
      ordersApi.updateStage(input.orderId, input.stage.code, {
        status: 'in_progress',
        routingStage: input.stage.routingStage,
      }).then((r) => r.data),
    onSuccess: (_, v) => {
      qc.invalidateQueries({ queryKey: ['shop-floor'] });
      notifications.show({
        title: 'Начали',
        message: `${v.stage.label} — в работе`,
        color: 'success',
        icon: <IconPlayerPlay size={16} />,
      });
    },
    onError: (e: any) => notifications.show({
      title: 'Ошибка',
      message: e?.response?.data?.error?.message ?? 'Не удалось отметить',
      color: 'danger',
    }),
  });

  if (isLoading || !data) {
    return (
      <Stack gap="md">
        <Skeleton height={60} radius="md" />
        {[...Array(4)].map((_, i) => <Skeleton key={i} height={96} radius="md" />)}
      </Stack>
    );
  }

  // Мой передел выбран — показываю только заказы, где он ещё не закрыт
  const stageOf = (o: ShopFloorRow) => o.stages.find((s) => s.key === myStage) ?? null;
  const byMyStage = myStage
    ? data.orders.filter((o) => {
        const s = stageOf(o);
        return s && (showDone || s.status !== 'DONE');
      })
    : data.orders;

  const rows = search
    ? byMyStage.filter((o) =>
        o.orderNumber.toLowerCase().includes(search.toLowerCase()) ||
        (o.customerName ?? '').toLowerCase().includes(search.toLowerCase()))
    : byMyStage;

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      {/* Контекст смены: свой передел выбирается один раз и запоминается */}
      <Card withBorder radius="md" padding="sm">
        <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb="xs">Мой передел</Text>
        <Group gap="xs" wrap="wrap">
          {MY_STAGES.map((s) => {
            const count = data.byStage.find((b) => b.key === s.key)?.count ?? 0;
            const active = myStage === s.key;
            return (
              <Button
                key={s.key}
                variant={active ? 'filled' : 'default'}
                size="sm"
                onClick={() => setMyStage(active ? null : s.key)}
                rightSection={count > 0
                  ? <Badge size="sm" circle variant={active ? 'white' : 'light'}>{count}</Badge>
                  : undefined}
              >
                {s.label}
              </Button>
            );
          })}
          {myStage && (
            <>
              <Button
                variant={showDone ? 'light' : 'subtle'}
                size="sm"
                color="gray"
                onClick={() => setShowDone((v) => !v)}
              >
                {showDone ? 'Скрыть закрытые' : 'Показать закрытые'}
              </Button>
              <Button variant="subtle" size="sm" color="gray" onClick={() => setMyStage(null)}>
                Показать все
              </Button>
            </>
          )}
        </Group>
      </Card>

      <Group justify="space-between" wrap="wrap" gap="sm">
        <TextInput
          placeholder="№ заказа или заказчик..."
          leftSection={<IconSearch size={15} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          w={280}
          size="sm"
        />
        <Text size="sm" c="dimmed">
          {myStage ? 'Ждут моего передела: ' : 'В работе: '}
          <Text span fw={700} ff="monospace">{rows.length}</Text>
        </Text>
      </Group>

      {rows.length === 0 ? (
        <Card withBorder radius="md" padding="xl">
          <Stack align="center" gap="sm" py="lg">
            <ThemeIcon size={48} radius="xl" variant="light" color="teal">
              <IconCheck size={26} />
            </ThemeIcon>
            <Text fw={700}>{myStage ? 'На моём переделе всё закрыто' : 'Заказов в работе нет'}</Text>
          </Stack>
        </Card>
      ) : <Stagger>{rows.map((o) => {
        const mine = stageOf(o);
        const expanded = expandedId === o.id;
        const progress = o.totalStages > 0 ? (o.doneCount / o.totalStages) * 100 : 0;

        return (
          <Card
            key={o.id}
            withBorder
            radius="md"
            padding="md"
            onClick={() => setExpandedId(expanded ? null : o.id)}
            style={{ cursor: 'pointer' }}
          >
            <Group justify="space-between" wrap="nowrap" mb={6}>
              <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                <OrderRef id={o.id} number={o.orderNumber} size="lg" focus="stages" />
                {mine && mine.status === 'IN_PROGRESS' && (
                  <Badge color="brand" variant="light" radius="xl">в работе</Badge>
                )}
                {mine && mine.contractorWorks.length > 0 && (
                  <Badge color="orange" variant="light" radius="xl" leftSection={<IconTruck size={11} />}>
                    подряд
                  </Badge>
                )}
              </Group>
              <Group gap={6} wrap="nowrap">
                <Text size="sm" ff="monospace" c="dimmed">{formatDate(o.plannedShipmentDate)}</Text>
                {o.overdueDays > 0 && (
                  <Badge color="danger" variant="light" radius="xl" leftSection={<IconAlertTriangle size={10} />}>
                    {o.overdueDays} дн
                  </Badge>
                )}
              </Group>
            </Group>

            <Text size="sm" c="dimmed" lineClamp={1} mb={8}>
              {o.customerName ?? '—'} · {o.qty.toLocaleString('ru-RU')} шт
              {o.articles.length > 0 ? ` · ${o.articles.join(', ')}` : ''}
            </Text>

            <Group gap="sm" wrap="nowrap" mb={expanded ? 'md' : 0}>
              <Progress value={progress} size="sm" radius="xl" style={{ flex: 1 }}
                color={o.doneCount === o.totalStages ? 'teal' : 'brand'} />
              <Text size="xs" ff="monospace" c="dimmed">{o.doneCount}/{o.totalStages}</Text>
            </Group>

            <Collapse opened={Boolean(expanded && canEdit && mine)}>
              {mine && (
              <Stack gap="sm" pt="sm" onClick={(e) => e.stopPropagation()}>
                {mine.contractorWorks.length > 0 && (
                  <Alert color="orange" variant="light" p="xs" radius="md" icon={<IconTruck size={16} />}>
                    <Text size="sm">
                      {mine.contractorWorks.map((w) =>
                        `${w.contractorName} — ${Math.round(w.share * 100)} %${w.isAccepted ? ' (принято)' : ''}`,
                      ).join('; ')}
                      {mine.staffShare > 0 && `; штат — ${Math.round(mine.staffShare * 100)} %`}
                    </Text>
                  </Alert>
                )}

                {o.stageTrackingMode === 'LINE' ? (
                  <Alert color="gray" variant="light" p="xs" radius="md">
                    <Text size="sm">Заказ отмечается по позициям — откройте карточку заказа</Text>
                  </Alert>
                ) : mine.status === 'DONE' ? (
                  // Отмечено по ошибке — единственный путь назад
                  <Button
                    size="lg"
                    variant="default"
                    color="gray"
                    leftSection={<IconArrowBackUp size={20} />}
                    disabled={start.isPending}
                    onClick={() => start.mutate({ orderId: o.id, stage: mine })}
                    fullWidth
                  >
                    Снять готовность
                  </Button>
                ) : (
                  <Group grow>
                    <Button
                      size="lg"
                      variant="default"
                      leftSection={<IconPlayerPlay size={20} />}
                      disabled={mine.status === 'IN_PROGRESS' || start.isPending}
                      onClick={() => start.mutate({ orderId: o.id, stage: mine })}
                    >
                      Начал
                    </Button>
                    <Button
                      size="lg"
                      leftSection={<IconCheck size={20} />}
                      onClick={() => setSheet({ order: o, stage: mine })}
                    >
                      Готово
                    </Button>
                  </Group>
                )}
              </Stack>
              )}
            </Collapse>

            {expanded && !myStage && (
              <Text size="xs" c="dimmed" mt="xs">
                Выберите свой передел сверху, чтобы отмечать работу
              </Text>
            )}
          </Card>
        );
      })}</Stagger>}

      <DoneSheet
        order={sheet?.order ?? null}
        stage={sheet?.stage ?? null}
        opened={sheet !== null}
        onClose={() => setSheet(null)}
      />
    </Stack>
  );
}
