import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Table, Skeleton, Select, Tooltip, Progress, Button,
} from '@mantine/core';
import { IconFlask, IconCalculator, IconAlertTriangle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { costingsApi } from '../api/costings';
import { ordersApi } from '../api/orders';
import { formatCurrency, formatDate } from '../utils/formatters';

const PRICE_STATE_LABELS: Record<string, string> = {
  ESTIMATE: 'Оценка',
  ORDERED: 'Заказано',
  ACTUAL: 'Факт',
};
const PRICE_STATE_COLORS: Record<string, string> = {
  ESTIMATE: 'gray',
  ORDERED: 'cyan',
  ACTUAL: 'teal',
};

/**
 * Себестоимость позиции заказа (09 §3, §4, §6) — то, что раньше существовало
 * только в API. Показывает: последнюю версию калькуляции, стадию цены
 * каждого материала (оценка → заказано → факт) со ссылкой на партию/документ,
 * и — если в заказе есть подрядчик — журнал работ со сверкой против актов 1С.
 */
export function OrderCostingPanel({ orderId, orderLineId }: { orderId: string; orderLineId: string }) {
  const qc = useQueryClient();
  const { data: versions, isLoading: loadingVersions } = useQuery({
    queryKey: ['costings', orderLineId],
    queryFn: () => costingsApi.list(orderLineId).then((r) => r.data),
  });

  const latest = versions?.data?.[0];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeId = selectedId ?? latest?.id ?? null;

  const { data: detail, isLoading: loadingDetail } = useQuery({
    queryKey: ['costing', orderLineId, activeId],
    queryFn: () => costingsApi.get(orderLineId, activeId as string).then((r) => r.data),
    enabled: Boolean(activeId),
  });

  const { data: work } = useQuery({
    queryKey: ['contractor-work', orderId],
    queryFn: () => ordersApi.contractorWork(orderId).then((r) => r.data),
  });

  // Показывать «не считалась» и не давать посчитать — тупик.
  // Считает по составу изделия, нормам труда и заведённому подряду.
  const build = useMutation({
    mutationFn: () => costingsApi.build(orderLineId).then((r) => r.data),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['costings', orderLineId] });
      qc.invalidateQueries({ queryKey: ['costing', orderLineId] });
      setSelectedId(d.id);
      notifications.show({
        title: `Версия ${d.version} посчитана`,
        message: `Себестоимость ${formatCurrency(d.totalCost)} · цена ${formatCurrency(d.price)}`,
        color: 'success',
        icon: <IconCalculator size={16} />,
      });
    },
    onError: (e: any) => notifications.show({
      title: 'Не посчиталось',
      message: e?.response?.data?.error?.message ?? e?.message ?? 'Ошибка расчёта',
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  if (loadingVersions) return <Skeleton height={200} radius="md" />;
  if (!versions?.data?.length) {
    return (
      <Card withBorder radius="md" padding="md">
        <Text fw={700} size="sm" mb={4}>Себестоимость</Text>
        <Text size="sm" c="dimmed" mb="sm">
          Ещё не считалась. Расчёт возьмёт состав изделия, нормы труда и заведённый подряд.
        </Text>
        <Button
          leftSection={<IconCalculator size={16} />}
          loading={build.isPending}
          onClick={() => build.mutate()}
        >
          Посчитать себестоимость
        </Button>
      </Card>
    );
  }

  const hasReconciliation = (work?.reconciliation?.length ?? 0) > 0;
  // marginPct в БД хранится долей (0.35), а не процентом
  const marginPctDisplay = detail ? detail.marginPct * (detail.marginPct <= 1 ? 100 : 1) : 0;

  return (
    <Stack gap="md">
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="xs">
          <Group gap="xs">
            <Text fw={700} size="sm">Себестоимость</Text>
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconCalculator size={13} />}
              loading={build.isPending}
              onClick={() => build.mutate()}
            >
              Пересчитать
            </Button>
          </Group>
          {versions.data.length > 1 && (
            <Select
              size="xs"
              w={180}
              data={versions.data.map((v) => ({
                value: v.id,
                label: `v${v.version} · ${v.status === 'APPROVED' ? 'согласована' : 'черновик'} · ${formatDate(v.calculatedAt)}`,
              }))}
              value={activeId}
              onChange={setSelectedId}
              allowDeselect={false}
            />
          )}
        </Group>

        {loadingDetail || !detail ? (
          <Skeleton height={120} radius="md" />
        ) : (
          <>
            <Group gap="xl" mb="sm">
              <Stack gap={0}>
                <Text size="xs" c="dimmed">Себестоимость</Text>
                <Text fw={700} ff="monospace">{formatCurrency(detail.totalCost)}</Text>
              </Stack>
              <Stack gap={0}>
                <Text size="xs" c="dimmed">Цена</Text>
                <Text fw={700} ff="monospace">{formatCurrency(detail.price)}</Text>
              </Stack>
              <Stack gap={0}>
                <Text size="xs" c="dimmed">Маржа</Text>
                <Text fw={700} ff="monospace" c={marginPctDisplay >= 30 ? 'teal.7' : marginPctDisplay >= 25 ? 'yellow.7' : 'red.7'}>
                  {marginPctDisplay.toFixed(1)}%
                </Text>
              </Stack>
              {detail.hasShortage && (
                <Badge color="red" variant="light">есть дефицит материалов</Badge>
              )}
              {detail.hasMissingBom && (
                <Badge color="red" variant="light">нет состава — себестоимость материалов не посчитана</Badge>
              )}
              {detail.hasMissingNorm && (
                <Badge color="orange" variant="light">нет нормы труда — себестоимость труда не посчитана</Badge>
              )}
            </Group>

            <Table.ScrollContainer minWidth={480}>
              <Table verticalSpacing="xs" fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Материал</Table.Th>
                    <Table.Th ta="right">Кол-во</Table.Th>
                    <Table.Th ta="right">Цена</Table.Th>
                    <Table.Th ta="right">Сумма</Table.Th>
                    <Table.Th>Стадия / источник</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {detail.materials.map((m) => {
                    const source = m.batch
                      ? (m.batch.documentNumber ?? m.batch.id.slice(0, 8))
                      : m.supplierOrderNumber ?? null;
                    const tooltip = m.batch
                      ? `${m.batch.supplierName ?? '—'} · ${formatDate(m.batch.receiptDate)}${m.batch.batchType === 'TOLLING' ? ' · давальческое' : ''}`
                      : m.priceStateChangedAt ? `с ${formatDate(m.priceStateChangedAt)}` : '';
                    return (
                      <Table.Tr key={m.id}>
                        <Table.Td>
                          <Text size="sm">{m.materialName}</Text>
                          {m.materialCode && <Text size="xs" c="dimmed" ff="monospace">{m.materialCode}</Text>}
                        </Table.Td>
                        <Table.Td ta="right" ff="monospace">{m.qtyTotal}</Table.Td>
                        <Table.Td ta="right" ff="monospace">{formatCurrency(m.unitPrice)}</Table.Td>
                        <Table.Td ta="right" ff="monospace" fw={600}>{formatCurrency(m.lineCost)}</Table.Td>
                        <Table.Td>
                          <Tooltip label={tooltip} disabled={!tooltip}>
                            <Stack gap={2}>
                              <Group gap={4} wrap="nowrap">
                                <Badge size="sm" variant="light" color={PRICE_STATE_COLORS[m.priceState]} radius="xl">
                                  {PRICE_STATE_LABELS[m.priceState]}
                                </Badge>
                                {m.batch?.batchType === 'TOLLING' && (
                                  <Badge size="sm" color="orange" variant="light" radius="xl">давалец</Badge>
                                )}
                              </Group>
                              {source && <Text size="xs" ff="monospace" c="dimmed">{source}</Text>}
                            </Stack>
                          </Tooltip>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>

            {detail.labor.length > 0 && (
              <>
                <Text fw={700} size="sm" mt="md" mb={4}>Труд</Text>
                <Table.ScrollContainer minWidth={420}>
                  <Table verticalSpacing="xs" fz="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Передел</Table.Th>
                        <Table.Th>Исполнитель</Table.Th>
                        <Table.Th ta="right">Часы</Table.Th>
                        <Table.Th ta="right">Сумма</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {detail.labor.map((l) => (
                        <Table.Tr key={l.id}>
                          <Table.Td><Text size="sm">{l.stage}</Text></Table.Td>
                          <Table.Td style={{ maxWidth: 180 }}>
                            {l.laborKind === 'CONTRACTOR' ? (
                              <Tooltip label={l.contractor?.name ?? 'подрядчик'} disabled={!l.contractor?.name}>
                                <Stack gap={2}>
                                  <Badge size="sm" variant="light" color="orange" radius="xl">
                                    подряд · {Math.round(l.share * 100)}%
                                  </Badge>
                                  {l.contractor?.name && (
                                    <Text size="xs" c="dimmed" truncate>{l.contractor.name}</Text>
                                  )}
                                </Stack>
                              </Tooltip>
                            ) : (
                              <Text size="sm" c="dimmed">свой цех</Text>
                            )}
                          </Table.Td>
                          <Table.Td ta="right" ff="monospace">{l.manHours}</Table.Td>
                          <Table.Td ta="right" ff="monospace">{formatCurrency(l.lineCost)}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </>
            )}
          </>
        )}
      </Card>

      {hasReconciliation && (
        <Card withBorder radius="md" padding="md">
          <Group gap="xs" mb="xs">
            <IconFlask size={16} />
            <Text fw={700} size="sm">Подряд: журнал работ и сверка с актами 1С</Text>
          </Group>
          <Stack gap="sm">
            {work!.reconciliation.map((r) => {
              const pct = r.acted > 0 ? Math.min(100, (r.logged / r.acted) * 100) : 0;
              return (
                <Card key={r.contractorId} withBorder radius="md" padding="sm" bg="var(--mantine-color-default-hover)">
                  <Group justify="space-between" mb={6} wrap="nowrap" gap="xs">
                    <Text size="sm" fw={600} truncate style={{ minWidth: 0, flex: 1 }}>{r.name}</Text>
                    <Badge
                      color={r.status === 'MATCHED' ? 'teal' : r.status === 'WAITING_ACT' ? 'gray' : 'red'}
                      variant="light" radius="xl" style={{ flexShrink: 0 }}
                    >
                      {r.status === 'MATCHED' ? 'сходится' : r.status === 'WAITING_ACT' ? 'ждём акт' : `расхождение ${formatCurrency(Math.abs(r.delta))}`}
                    </Badge>
                  </Group>
                  <Group justify="space-between" mb={4}>
                    <Text size="xs" c="dimmed">Внесено (оперативно)</Text>
                    <Text size="xs" ff="monospace">{formatCurrency(r.logged)}</Text>
                  </Group>
                  <Group justify="space-between" mb={6}>
                    <Text size="xs" c="dimmed">Акт из 1С</Text>
                    <Text size="xs" ff="monospace">{r.acted > 0 ? formatCurrency(r.acted) : 'ещё нет'}</Text>
                  </Group>
                  {r.acted > 0 && <Progress value={pct} size="sm" radius="xl" color={r.status === 'MATCHED' ? 'teal' : 'red'} />}
                </Card>
              );
            })}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
