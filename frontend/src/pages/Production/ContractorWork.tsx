import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Card, Stack, Group, Text, Badge, Table, Skeleton, Button, Select,
  NumberInput, Modal, ThemeIcon, SimpleGrid, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconTruck, IconCheck, IconAlertTriangle, IconBuildingFactory,
} from '@tabler/icons-react';
import api from '../../api/client';
import { ordersApi } from '../../api/orders';
import { useAuthStore } from '../../store/auth';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';

interface WorkRow {
  id: string;
  order: { id: string; orderNumber: string; status: string; plannedShipmentDate: string | null };
  contractor: { id: string; name: string; binIin: string | null };
  routingStage: string;
  share: number;
  rateType: string;
  rate: number;
  actualQty: number | null;
  amount: number | null;
  workLocation: 'OUR_SHOP' | 'CONTRACTOR_SITE';
  isAccepted: boolean;
  acceptedAt: string | null;
  decidedAt: string;
  reason: string | null;
}
interface Response {
  data: WorkRow[];
  byContractor: Array<{ id: string; name: string; open: number; accepted: number; amount: number }>;
  total: number;
}

const STAGE_LABELS: Record<string, string> = {
  CUTTING: 'Резка',
  ASSEMBLY: 'Сборка / сварка',
  PAINTING: 'Покраска',
  'резка': 'Резка',
  'сборка/сварка/обшивка': 'Сборка / сварка',
  'зачистка/покраска': 'Покраска',
};
const RATE_UNITS: Record<string, string> = {
  PER_HOUR: 'ч', PER_UNIT: 'шт', PER_KG: 'кг', PER_TON: 'т', FIXED: '—',
};
const RATE_LABELS: Record<string, string> = {
  PER_HOUR: '₸/час', PER_UNIT: '₸/шт', PER_KG: '₸/кг', PER_TON: '₸/т', FIXED: '₸ фикс',
};

/**
 * Подряд: кто из сторонних делает наши переделы, сколько мы им должны
 * и что уже принято (решение 23.08.2026).
 *
 * Раньше подряд существовал только внутри отметки этапа и карточки заказа —
 * увидеть картину целиком было негде, хотя это прямые деньги наружу.
 */
export function ContractorWork() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canAccept = hasRole(['shop_foreman', 'planner', 'admin']);

  const [contractorId, setContractorId] = useState<string | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [accepting, setAccepting] = useState<WorkRow | null>(null);
  const [qty, setQty] = useState<number | string>('');

  const { data, isLoading } = useQuery({
    queryKey: ['contractor-work-all', contractorId, onlyOpen],
    queryFn: () => api
      .get<Response>('/contractor-work', {
        params: {
          ...(contractorId ? { contractorId } : {}),
          ...(onlyOpen ? { onlyOpen: 'true' } : {}),
        },
      })
      .then((r) => r.data),
    refetchInterval: 60_000,
  });

  const accept = useMutation({
    mutationFn: (input: { id: string; actualQty: number }) =>
      ordersApi.acceptContractorWork(input.id, { actualQty: input.actualQty }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contractor-work-all'] });
      qc.invalidateQueries({ queryKey: ['contractor-work'] });
      notifications.show({
        title: 'Работа принята',
        message: 'Сумма заморожена — пересчёт калькуляции её больше не двигает',
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      setAccepting(null);
      setQty('');
    },
    onError: (e: any) => notifications.show({
      title: 'Не принято',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
      icon: <IconAlertTriangle size={16} />,
    }),
  });

  if (isLoading || !data) {
    return (
      <Stack gap="md">
        <Skeleton height={80} radius="md" />
        <Skeleton height={320} radius="md" />
      </Stack>
    );
  }

  const totalOwed = data.data.reduce((s, w) => s + (w.isAccepted ? w.amount ?? 0 : 0), 0);
  const openCount = data.data.filter((w) => !w.isAccepted).length;

  return (
    <Stack gap="md">
      <Stack gap={4}>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
          Производство · Подряд
        </Text>
        <Text fw={700} size="xl">Кто делает наши работы на стороне</Text>
        <Text size="sm" c="dimmed">
          Штат считается по нормам спецификации и здесь не показывается — тут только то,
          что отдано подрядчикам
        </Text>
      </Stack>

      {/* Итог по подрядчикам */}
      {data.byContractor.length > 0 && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
          {data.byContractor.map((c) => (
            <Card key={c.id} withBorder radius="md" padding="md">
              <Group gap="xs" mb={6} wrap="nowrap">
                <ThemeIcon variant="light" color="orange" radius="md" size="sm">
                  <IconBuildingFactory size={14} />
                </ThemeIcon>
                <Text fw={700} size="sm" truncate>{c.name}</Text>
              </Group>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">В работе</Text>
                <Text size="sm" fw={600}>{c.open}</Text>
              </Group>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">Принято</Text>
                <Text size="sm" fw={600}>{c.accepted}</Text>
              </Group>
              <Group justify="space-between" mt={4}>
                <Text size="xs" c="dimmed">Должны</Text>
                <Text size="sm" fw={700} ff="monospace">{formatCurrency(c.amount)}</Text>
              </Group>
            </Card>
          ))}
        </SimpleGrid>
      )}

      <Group gap="sm" wrap="wrap">
        <Select
          size="sm"
          w={240}
          placeholder="Все подрядчики"
          clearable
          data={data.byContractor.map((c) => ({ value: c.id, label: c.name }))}
          value={contractorId}
          onChange={setContractorId}
        />
        <Button
          size="sm"
          variant={onlyOpen ? 'filled' : 'default'}
          onClick={() => setOnlyOpen((v) => !v)}
        >
          Только не принятые {openCount > 0 ? `(${openCount})` : ''}
        </Button>
        <Text size="sm" c="dimmed" ml="auto">
          Принято на <Text span fw={700} ff="monospace">{formatCurrency(totalOwed)}</Text>
        </Text>
      </Group>

      <Card withBorder radius="md" padding={0}>
        {data.data.length === 0 ? (
          <Stack align="center" gap="sm" py="xl">
            <ThemeIcon size={48} radius="xl" variant="light" color="gray">
              <IconTruck size={26} />
            </ThemeIcon>
            <Text fw={700}>Подряда нет</Text>
            <Text size="sm" c="dimmed" ta="center" maw={420}>
              Работа отдаётся подрядчику из отметки этапа в цеху — переключателем
              «Делал не наш цех»
            </Text>
          </Stack>
        ) : (
          <Table.ScrollContainer minWidth={860}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Заказ</Table.Th>
                  <Table.Th>Подрядчик</Table.Th>
                  <Table.Th>Вид работ</Table.Th>
                  <Table.Th ta="right">Доля</Table.Th>
                  <Table.Th ta="right">Ставка</Table.Th>
                  <Table.Th ta="right">Объём</Table.Th>
                  <Table.Th ta="right">Сумма</Table.Th>
                  <Table.Th>Состояние</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.data.map((w) => (
                  <Table.Tr key={w.id}>
                    <Table.Td>
                      <OrderRef id={w.order.id} number={w.order.orderNumber} focus="cost" />
                      {w.order.plannedShipmentDate && (
                        <Text size="xs" c="dimmed">{formatDate(w.order.plannedShipmentDate)}</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{w.contractor.name}</Text>
                      {w.workLocation === 'OUR_SHOP' && (
                        <Text size="xs" c="dimmed">в нашем цеху</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{STAGE_LABELS[w.routingStage] ?? w.routingStage}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">{Math.round(w.share * 100)} %</Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {formatCurrency(w.rate)}
                      <Text size="xs" c="dimmed">{RATE_LABELS[w.rateType] ?? w.rateType}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {w.actualQty != null ? `${w.actualQty} ${RATE_UNITS[w.rateType] ?? ''}` : '—'}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={600}>
                      {w.amount != null ? formatCurrency(w.amount) : '—'}
                    </Table.Td>
                    <Table.Td>
                      {w.isAccepted ? (
                        <Tooltip label={`принято ${formatDate(w.acceptedAt)}`}>
                          <Badge color="teal" variant="light" radius="xl">принято</Badge>
                        </Tooltip>
                      ) : canAccept ? (
                        <Button
                          size="compact-sm"
                          variant="light"
                          onClick={() => { setAccepting(w); setQty(''); }}
                        >
                          Принять
                        </Button>
                      ) : (
                        <Badge color="gray" variant="light" radius="xl">в работе</Badge>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      {/* Приёмка: объём в единицах ставки замораживает сумму */}
      <Modal
        opened={accepting !== null}
        onClose={() => setAccepting(null)}
        title={<Text fw={700}>Принять работу</Text>}
        radius="md"
        centered
      >
        {accepting && (
          <Stack gap="md">
            <Stack gap={2}>
              <Text size="sm">
                {accepting.contractor.name} · {STAGE_LABELS[accepting.routingStage] ?? accepting.routingStage}
              </Text>
              <Text size="sm" c="dimmed">
                Заказ {accepting.order.orderNumber} · ставка {formatCurrency(accepting.rate)}{' '}
                {RATE_LABELS[accepting.rateType]}
              </Text>
            </Stack>
            <NumberInput
              label={`Сколько сдал (${RATE_UNITS[accepting.rateType] ?? 'ед.'})`}
              description="сумма посчитается по ставке и заморозится — пересчёт её больше не двигает"
              value={qty}
              onChange={setQty}
              min={0}
              size="md"
              autoFocus
            />
            {Number(qty) > 0 && accepting.rateType !== 'FIXED' && (
              <Text size="sm">
                К оплате: <Text span fw={700} ff="monospace">
                  {formatCurrency(Number(qty) * accepting.rate)}
                </Text>
              </Text>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setAccepting(null)}>Отмена</Button>
              <Button
                loading={accept.isPending}
                disabled={!(Number(qty) >= 0) || qty === ''}
                onClick={() => accept.mutate({ id: accepting.id, actualQty: Number(qty) })}
              >
                Принять
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
