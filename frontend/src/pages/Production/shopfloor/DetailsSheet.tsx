import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Button, Drawer, Alert, NumberInput, Select, Switch, Divider,
  SegmentedControl,
} from '@mantine/core';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import api from '../../../api/client';
import { ordersApi } from '../../../api/orders';
import { Collapse } from '../../../components/motion';
import {
  STAGE_SHORT, RATE_TYPE_LABELS, type ShopFloorOrder, type ProductRow, type OpenRequest,
} from './types';
import { MaterialAvailability } from './MaterialAvailability';
import { OffcutHint } from './OffcutHint';

/**
 * Отклонения по изделию — часы по факту и «делал не наш цех» (26.08.2026).
 * За «⋯», а не на главном пути: обычный случай — один тап «Изготовлено»,
 * а «не ввёл часы» означает «как по норме», а не пропуск данных.
 */
export function DetailsSheet({
  order, product, requests, opened, onClose,
}: {
  order: ShopFloorOrder | null;
  product: ProductRow | null;
  requests: OpenRequest[];
  opened: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [hours, setHours] = useState<number | string>('');
  const [outsourced, setOutsourced] = useState(false);
  // Главный случай — «по заявке»: работа уже отдана партией, мастер лишь
  // говорит, сколько из неё ушло на этот заказ. Разовый подряд остаётся
  // вторым вариантом для «договорились на месте»
  const [mode, setMode] = useState<'request' | 'adhoc'>('request');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [reqQty, setReqQty] = useState<number | string>('');
  const [contractorId, setContractorId] = useState<string | null>(null);
  const [rate, setRate] = useState<number | string>('');
  const [rateType, setRateType] = useState<string>('PER_UNIT');
  const [atOurShop, setAtOurShop] = useState(false);

  const { data: contractors } = useQuery({
    queryKey: ['contractors'],
    queryFn: () => ordersApi.contractors().then((r) => r.data),
    enabled: opened && outsourced && mode === 'adhoc',
  });

  const chosen = requests.find((r) => r.id === requestId) ?? null;

  const save = useMutation({
    mutationFn: async () => {
      if (!order || !product) return null;
      let allocated: any = null;
      // Подряд заводится ДО отметки: иначе вид работ на миг окажется
      // полностью штатным и себестоимость дрогнет
      if (outsourced && mode === 'request') {
        // Молча пропустить нельзя: мастер увидел бы зелёное «Изготовлено»
        // и был уверен, что работа записана на подрядчика
        if (!requestId) throw new Error('Выберите заявку на подряд или переключитесь на «разово»');
        if (!(Number(reqQty) > 0)) throw new Error('Укажите, сколько из заявки ушло на этот заказ');
        const r = await api.post(`/contractor-requests/${requestId}/allocate`, {
          orderId: order.id,
          qty: Number(reqQty),
        });
        allocated = r.data;
      } else if (outsourced) {
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
      return { stage: res.data, allocated };
    },
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['shop-floor'] });
      const a = res?.allocated;
      notifications.show({
        title: 'Изготовлено',
        // Подтверждение словами: мастер должен видеть последствие, а не
        // просто галочку — «штат по этим работам больше не считается»
        message: a
          ? `Записано: ${a.qty} ${a.unit} из ${chosen?.number ?? 'заявки'} на заказ ${a.orderNumber}.`
            + ` Штат по «${a.stageLabel}» на этом заказе больше не считается.`
            + (a.recalculatedRows > 1 ? ` Пересчитано разнесение по ${a.recalculatedRows} заказам.` : '')
          : product?.articleName ?? '',
        color: 'success',
        icon: <IconCheck size={16} />,
        autoClose: a ? 9000 : 4000,
      });
      onClose();
      setHours(''); setOutsourced(false); setContractorId(null); setRate('');
      setRequestId(null); setReqQty('');
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
      title={<Text fw={700} size="lg">{product.articleName}</Text>}
    >
      <Stack gap="md" pb="md">
        <Text size="sm" c="dimmed">
          {order.orderNumber} · {product.articleCode} · {product.qty.toLocaleString('ru-RU')} {product.unit}
        </Text>

        {/* Обеспеченность сырьём и остатки-обрезки — здесь, а не в списке:
            в очереди мастеру нужна работа, а не сводка по заказу */}
        <Group gap="sm" wrap="wrap">
          <MaterialAvailability orderId={order.id} orderNumber={order.orderNumber} />
        </Group>
        <OffcutHint orderId={order.id} orderNumber={order.orderNumber} />

        <Button
          size="xl"
          leftSection={<IconCheck size={22} />}
          loading={save.isPending}
          onClick={() => save.mutate()}
          fullWidth
        >
          Изготовлено
        </Button>
        <Text size="sm" c="dimmed" ta="center">
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

        {/* Блок подряда раскрывается по высоте — видно, откуда он взялся */}
        <Collapse opened={outsourced}>
          <Card withBorder radius="md" padding="md" bg="var(--mantine-color-default-hover)">
            <Stack gap="md">
              <SegmentedControl
                fullWidth
                size="md"
                value={mode}
                onChange={(v) => setMode(v as 'request' | 'adhoc')}
                data={[
                  { value: 'request', label: 'По заявке на подряд' },
                  { value: 'adhoc', label: 'Разово' },
                ]}
              />

              {mode === 'request' ? (
                requests.length === 0 ? (
                  <Alert color="gray" variant="light" p="sm" radius="md">
                    <Text size="sm">
                      Открытых заявок нет. Заявка заводится на экране «Подряд» — там же
                      её отправляют в Б24. Если работу отдали без заявки, выберите «Разово».
                    </Text>
                  </Alert>
                ) : (
                  <>
                    <Select
                      label="Заявка на подряд"
                      placeholder="выберите"
                      size="md"
                      searchable
                      data={requests.map((r) => ({
                        value: r.id,
                        label: `${r.number} · ${STAGE_SHORT[r.routingStage] ?? r.routingStage}`
                          + ` · ${r.contractorName ?? 'подрядчик не выбран'}`,
                      }))}
                      value={requestId}
                      onChange={setRequestId}
                    />
                    {chosen && (
                      <Text size="sm" c="dimmed">
                        {chosen.description}
                        {chosen.remainingQty != null && (
                          <> · осталось разнести <Text span fw={700} ff="monospace">
                            {chosen.remainingQty} {chosen.unit}
                          </Text>{chosen.targetQty != null ? ` из ${chosen.targetQty}` : ''}</>
                        )}
                      </Text>
                    )}
                    {/* Мастер вводит одно число. Ставок и сумм ему не показываем
                        вовсе: деньги — на экране «Подряд», у того, кто их платит */}
                    <NumberInput
                      label={`Сколько ушло на этот заказ${chosen ? ` (${chosen.unit})` : ''}`}
                      value={reqQty}
                      onChange={setReqQty}
                      min={0}
                      decimalScale={3}
                      size="md"
                      max={chosen?.remainingQty ?? undefined}
                    />
                  </>
                )
              ) : (
                <>
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
                    size="md"
                    label="Работали у нас в цеху"
                    description={atOurShop ? 'часы займут мощность участка' : 'на своей площадке — мощность не занимают'}
                    checked={atOurShop}
                    onChange={(e) => setAtOurShop(e.currentTarget.checked)}
                  />
                </>
              )}
            </Stack>
          </Card>
        </Collapse>
      </Stack>
    </Drawer>
  );
}
