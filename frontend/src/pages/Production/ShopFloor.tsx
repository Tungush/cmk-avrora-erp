import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Skeleton, TextInput, Button, Drawer,
  NumberInput, Select, Switch, Divider, ThemeIcon, ActionIcon, Progress, Box,
} from '@mantine/core';
import {
  IconSearch, IconAlertTriangle, IconCheck, IconTruck, IconArrowBackUp, IconDots,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { ordersApi } from '../../api/orders';
import { useAuthStore } from '../../store/auth';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { Stagger } from '../../components/motion';
import { formatDate } from '../../utils/formatters';

interface ProductRow {
  id: string;
  lineNo: number;
  isDuplicateCode: boolean;
  articleCode: string;
  articleName: string;
  qty: number;
  unit: string;
  status: string;
  normHours: number;
  actualHours: number | null;
  contractors: Array<{ name: string; sharePct: number; isAccepted: boolean }>;
}
interface ShopFloorOrder {
  id: string;
  orderNumber: string;
  customerName: string | null;
  status: string;
  plannedShipmentDate: string | null;
  overdueDays: number;
  products: ProductRow[];
  doneCount: number;
  totalProducts: number;
  resaleCount: number;
}
interface ShopFloorResponse {
  orders: ShopFloorOrder[];
  total: number;
  totalProducts: number;
  doneProducts: number;
  waitingProducts: number;
}

const RATE_TYPE_LABELS: Record<string, string> = {
  PER_HOUR: 'за час', PER_UNIT: 'за штуку', PER_KG: 'за кг',
  PER_TON: 'за тонну', FIXED: 'фиксированная',
};

/**
 * Отклонения по изделию — часы по факту и «делал не наш цех» (26.08.2026).
 * За «⋯», а не на главном пути: обычный случай — один тап «Изготовлено»,
 * а «не ввёл часы» означает «как по норме», а не пропуск данных.
 */
function DetailsSheet({
  order, product, opened, onClose,
}: {
  order: ShopFloorOrder | null;
  product: ProductRow | null;
  opened: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [hours, setHours] = useState<number | string>('');
  const [outsourced, setOutsourced] = useState(false);
  const [contractorId, setContractorId] = useState<string | null>(null);
  const [rate, setRate] = useState<number | string>('');
  const [rateType, setRateType] = useState<string>('PER_UNIT');
  const [atOurShop, setAtOurShop] = useState(false);

  const { data: contractors } = useQuery({
    queryKey: ['contractors'],
    queryFn: () => ordersApi.contractors().then((r) => r.data),
    enabled: opened,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!order || !product) return null;
      if (outsourced) {
        // Молча пропустить подряд нельзя: мастер увидел бы зелёное «Изготовлено»
        // и был уверен, что работа записана на подрядчика
        if (!contractorId) throw new Error('Выберите подрядчика или выключите «Делал не наш цех»');
        if (!(Number(rate) > 0)) throw new Error('Укажите ставку подрядчика — иначе работа встанет в 0 ₸');
        // Цех больше не выбирает операцию, а деньгам подрядчика нужен адрес
        // в расчёте — пишем на сборку, самый ёмкий вид работ
        await ordersApi.assignContractor(order.id, 'ASSEMBLY', {
          contractorId,
          share: 1,
          rate: Number(rate),
          rateType,
          workLocation: atOurShop ? 'OUR_SHOP' : 'CONTRACTOR_SITE',
          ...(atOurShop && rateType !== 'PER_HOUR' && product.normHours > 0
            ? { plannedHours: product.normHours }
            : {}),
        });
      }
      const res = await ordersApi.updateStage(order.id, 'PRODUCTION', {
        status: 'done',
        orderLineId: product.id,
        ...(Number(hours) > 0 ? { actualHours: Number(hours) } : {}),
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shop-floor'] });
      notifications.show({
        title: 'Изготовлено',
        message: product?.articleName ?? '',
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      onClose();
      setHours(''); setOutsourced(false); setContractorId(null); setRate('');
    },
    onError: (e: any) => notifications.show({
      title: 'Не сохранено',
      message: e?.response?.data?.error?.message ?? e?.message ?? 'Ошибка',
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  if (!order || !product) return null;
  const normText = product.normHours > 0 ? `${product.normHours} ч по норме` : 'нормы не заведены';

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="bottom"
      size="auto"
      padding="md"
      title={<Text fw={700}>{product.articleName}</Text>}
    >
      <Stack gap="md" pb="md">
        <Text size="sm" c="dimmed">
          {order.orderNumber} · {product.articleCode} · {product.qty.toLocaleString('ru-RU')} {product.unit}
        </Text>

        <Button
          size="xl"
          leftSection={<IconCheck size={22} />}
          loading={save.isPending}
          onClick={() => save.mutate()}
          fullWidth
        >
          Изготовлено
        </Button>
        <Text size="xs" c="dimmed" ta="center">
          Часы можно не вводить — тогда считается по спецификации ({normText})
        </Text>

        <Divider label="если было иначе" labelPosition="center" />

        <NumberInput
          label="Часов по факту"
          description={normText}
          placeholder={product.normHours > 0 ? String(product.normHours) : 'сколько вышло'}
          value={hours}
          onChange={setHours}
          min={0}
          decimalScale={1}
          size="md"
        />

        <Switch
          size="md"
          label="Делал не наш цех"
          description="подряд возьмёт работу на себя, штатные часы уменьшатся"
          checked={outsourced}
          onChange={(e) => setOutsourced(e.currentTarget.checked)}
        />

        {outsourced && (
          <Card withBorder radius="md" padding="sm" bg="var(--mantine-color-default-hover)">
            <Stack gap="sm">
              <Select
                label="Подрядчик"
                placeholder="выберите"
                data={(contractors ?? []).map((c: any) => ({ value: c.id, label: c.name }))}
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
                  onChange={(v) => setRateType(v ?? 'PER_UNIT')}
                  size="md"
                />
              </Group>
              <Switch
                label="Работали у нас в цеху"
                description={atOurShop ? 'часы займут мощность участка' : 'на своей площадке — мощность не занимают'}
                checked={atOurShop}
                onChange={(e) => setAtOurShop(e.currentTarget.checked)}
              />
            </Stack>
          </Card>
        )}
      </Stack>
    </Drawer>
  );
}

/**
 * Обеспеченность заказа сырьём (26.08.2026). Считается по живым партиям
 * минус чужие резервы; если не хватает — кнопка кладёт дефицит в очередь
 * заявок, откуда снабженец отправляет накопленное в Б24 одной сделкой.
 */
function MaterialAvailability({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['order-availability', orderId],
    queryFn: () => api.get(`/orders/${orderId}/material-availability`).then((r) => r.data),
    staleTime: 60_000,
  });
  const toQueue = useMutation({
    mutationFn: () => api.post(`/purchase-requests/from-order/${orderId}`).then((r) => r.data),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['purchase-requests'] });
      notifications.show({
        title: 'В очереди на закуп',
        message: res.message ?? `Добавлено позиций: ${res.created}, дополнено: ${res.updated}`,
        color: 'success',
      });
    },
    onError: (e: any) => notifications.show({
      title: 'Не удалось', message: e?.response?.data?.error?.message ?? 'Ошибка', color: 'danger',
    }),
  });

  if (isLoading) return <Skeleton height={22} width={180} radius="xl" />;
  if (!data || data.checkedMaterials === 0) {
    return <Text size="xs" c="dimmed">состав изделий не заведён</Text>;
  }
  if (data.ok) {
    return (
      <Badge color="teal" variant="light" radius="xl" leftSection={<IconCheck size={11} />}>
        сырья хватает
      </Badge>
    );
  }
  return (
    <Group gap="xs" wrap="nowrap">
      <Badge color="danger" variant="light" radius="xl" leftSection={<IconAlertTriangle size={11} />}>
        не хватает {data.shortages.length} позиций
      </Badge>
      <Button
        size="compact-xs"
        variant="light"
        color="orange"
        loading={toQueue.isPending}
        onClick={() => toQueue.mutate()}
      >
        В заявку на закуп
      </Button>
    </Group>
  );
}

/**
 * Цех: список изделий, которые надо изготовить (26.08.2026).
 *
 * Видов работ здесь больше нет — мастер не выбирает «свои работы» и не
 * закрывает операции, он показывает, что конкретное изделие сделано.
 * Сырьё и ТМЦ в очередь не попадают вовсе: завод их не изготавливает,
 * а перепродаёт — это была пятая часть прежнего списка (378 строк из 1942).
 */
export function ShopFloor() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canEdit = hasRole(['shop_foreman', 'planner', 'admin']);

  const [search, setSearch] = useState('');
  // Ошибочное «Изготовлено» надо уметь снять: без этого строка исчезает
  // из очереди навсегда и исправить отметку неоткуда
  const [showDone, setShowDone] = useState(false);
  const [sheet, setSheet] = useState<{ order: ShopFloorOrder; product: ProductRow } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['shop-floor', search],
    queryFn: () => api.get<ShopFloorResponse>('/production-plan/shop-floor', {
      params: search ? { search } : undefined,
    }).then((r) => r.data),
    refetchInterval: 60_000,
  });

  // Единственное действие цеха: изделие сделано / отметка снята. Когда
  // готовы все изделия заказа, бэкенд сам переводит его в «готов к отгрузке»
  // и ставит в очередь сигнал 1С на «Производство без заказа»
  const mark = useMutation({
    mutationFn: (v: { orderId: string; productId: string; done: boolean }) =>
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

  if (isLoading || !data) {
    return (
      <Stack gap="md">
        <Skeleton height={54} radius="md" />
        {[...Array(4)].map((_, i) => <Skeleton key={i} height={140} radius="md" />)}
      </Stack>
    );
  }

  const orders = data.orders
    .map((o) => ({
      ...o,
      products: showDone ? o.products : o.products.filter((p) => p.status !== 'DONE'),
    }))
    .filter((o) => o.products.length > 0);

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <TextInput
          placeholder="Изделие, № заказа или заказчик..."
          leftSection={<IconSearch size={15} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          w={320}
          size="sm"
        />
        <Group gap="sm">
          <Button
            variant={showDone ? 'light' : 'subtle'}
            size="sm"
            color="gray"
            onClick={() => setShowDone((v) => !v)}
          >
            {showDone ? 'Скрыть изготовленные' : 'Показать изготовленные'}
          </Button>
          <Text size="sm" c="dimmed">
            Осталось изготовить:{' '}
            <Text span fw={700} ff="monospace">{data.waitingProducts.toLocaleString('ru-RU')}</Text>
            {' '}из {data.totalProducts.toLocaleString('ru-RU')}
          </Text>
        </Group>
      </Group>

      {orders.length === 0 ? (
        <Card withBorder radius="md" padding="xl">
          <Stack align="center" gap="sm" py="lg">
            <ThemeIcon size={48} radius="xl" variant="light" color="teal">
              <IconCheck size={26} />
            </ThemeIcon>
            <Text fw={700}>{search ? 'Ничего не найдено' : 'Всё изготовлено'}</Text>
          </Stack>
        </Card>
      ) : <Stagger>{orders.map((o) => (
        <Card key={o.id} withBorder radius="md" padding="md">
          <Group justify="space-between" wrap="nowrap" mb={6}>
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
              <OrderRef id={o.id} number={o.orderNumber} size="lg" focus="stages" />
              <Text size="sm" c="dimmed" lineClamp={1}>{o.customerName ?? '—'}</Text>
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

          <Group gap="sm" wrap="nowrap" mb="xs">
            <Progress
              value={o.totalProducts > 0 ? (o.doneCount / o.totalProducts) * 100 : 0}
              size="sm" radius="xl" style={{ flex: 1 }}
              color={o.doneCount === o.totalProducts ? 'teal' : 'brand'}
            />
            <Text size="xs" ff="monospace" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {o.doneCount}/{o.totalProducts} изделий
            </Text>
            {o.resaleCount > 0 && (
              <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                + {o.resaleCount} сырьё, изготавливать не надо
              </Text>
            )}
          </Group>

          <Box mb="xs"><MaterialAvailability orderId={o.id} /></Box>

          <Stack gap={6}>
            {o.products.map((p) => {
              const busy = mark.isPending && mark.variables?.productId === p.id;
              const isDone = p.status === 'DONE';
              return (
                <Group
                  key={p.id}
                  justify="space-between"
                  wrap="nowrap"
                  gap="sm"
                  px="sm"
                  py={8}
                  style={{
                    borderRadius: 'var(--mantine-radius-md)',
                    background: isDone
                      ? 'light-dark(var(--mantine-color-teal-0), rgba(32,201,151,0.10))'
                      : 'var(--mantine-color-default-hover)',
                  }}
                >
                  <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" ff="monospace" fw={700} c="brand.7">{p.articleCode}</Text>
                      {/* Две одинаковые строки в заказе — иначе не понять, какую отметил */}
                      {p.isDuplicateCode && (
                        <Badge size="xs" variant="default" radius="xl">поз. {p.lineNo}</Badge>
                      )}
                      {p.contractors.length > 0 && (
                        <Badge color="orange" variant="light" radius="xl" size="xs"
                          leftSection={<IconTruck size={10} />}>
                          подряд
                        </Badge>
                      )}
                    </Group>
                    <Text size="sm" lineClamp={1}>{p.articleName}</Text>
                    <Text size="xs" c="dimmed">
                      {p.qty.toLocaleString('ru-RU')} {p.unit}
                      {p.normHours > 0 && ` · норма ${p.normHours} ч`}
                      {p.actualHours != null && ` · факт ${p.actualHours} ч`}
                    </Text>
                  </Stack>

                  {canEdit && (isDone ? (
                    <Button
                      size="compact-sm"
                      variant="default"
                      color="gray"
                      leftSection={<IconArrowBackUp size={14} />}
                      loading={busy}
                      onClick={() => mark.mutate({ orderId: o.id, productId: p.id, done: false })}
                    >
                      Снять
                    </Button>
                  ) : (
                    <Group gap={6} wrap="nowrap">
                      <Button
                        size="sm"
                        leftSection={<IconCheck size={16} />}
                        loading={busy}
                        onClick={() => mark.mutate({ orderId: o.id, productId: p.id, done: true })}
                      >
                        Изготовлено
                      </Button>
                      <ActionIcon
                        variant="default"
                        size="lg"
                        aria-label="Часы и подряд"
                        onClick={() => setSheet({ order: o, product: p })}
                      >
                        <IconDots size={16} />
                      </ActionIcon>
                    </Group>
                  ))}
                </Group>
              );
            })}
          </Stack>
        </Card>
      ))}</Stagger>}

      <DetailsSheet
        order={sheet?.order ?? null}
        product={sheet?.product ?? null}
        opened={sheet !== null}
        onClose={() => setSheet(null)}
      />
    </Stack>
  );
}
