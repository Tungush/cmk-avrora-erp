import React, { useState } from 'react';
import {
  Stack, Group, Text, Card, SimpleGrid, Table, Skeleton, Box,
  SegmentedControl, Alert, Anchor,
} from '@mantine/core';
import { IconInfoCircle, IconAlertTriangle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import api from '../../api/client';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { formatMoney } from '../../utils/formatters';

const pct = (v: number) => `${(v * 100).toFixed(1).replace('.0', '')} %`;

const DIMENSIONS = [
  { value: 'direction', label: 'Направление' },
  { value: 'manager', label: 'Менеджер' },
  { value: 'customer', label: 'Заказчик' },
  { value: 'project', label: 'Проект' },
  { value: 'region', label: 'Регион' },
  { value: 'division', label: 'Подразделение' },
];

function Kpi({ label, value, hint, tone }: {
  label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: string;
}) {
  return (
    <Card withBorder radius="md" padding="md">
      <Text size="xs" c="dimmed" fw={600} tt="uppercase" style={{ letterSpacing: '0.05em' }}>
        {label}
      </Text>
      <Text fw={800} c={tone} style={{ fontSize: 'clamp(18px, 2vw, 24px)', lineHeight: 1.2 }} mt={6}>
        {value}
      </Text>
      {hint && <Text size="xs" c="dimmed" mt={4}>{hint}</Text>}
    </Card>
  );
}

/**
 * Дашборд заказов клиента (26.08.2026). Ключевое отличие от «нарисуем
 * красиво»: слепые зоны названы слепыми зонами. Оплата известна по 75
 * заказам из 383 — остальные серые, а не «долг 0».
 */
export function OrdersDashboard() {
  const [dim, setDim] = useState('direction');
  const { data, isLoading } = useQuery({
    queryKey: ['orders-dashboard'],
    queryFn: () => api.get('/orders-dashboard').then((r) => r.data),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return <Stack gap="md">{[...Array(3)].map((_, i) => <Skeleton key={i} height={120} radius="md" />)}</Stack>;
  }

  const { kpi, gaps } = data;
  const rows: any[] = data.dimensions[dim] ?? [];
  const degenerate = rows.length <= 1;
  const trend = kpi.contractedMonth.prevAmount
    ? (kpi.contractedMonth.amount - kpi.contractedMonth.prevAmount) / kpi.contractedMonth.prevAmount
    : null;
  const isDirection = dim === 'direction';

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        <Kpi
          label="Портфель в работе"
          value={formatMoney(kpi.portfolio.amount)}
          hint={<>{kpi.portfolio.orders} активных заказов</>}
        />
        <Kpi
          label="Подтверждённый долг"
          value={formatMoney(kpi.debt.amount)}
          tone="danger.7"
          hint={<>по {kpi.debt.orders} заказам — только там, где 1С отдала оплату ({kpi.debt.paymentKnownOrders} заказов)</>}
        />
        <Kpi
          label="Оплата неизвестна"
          value={formatMoney(kpi.unknownPayment.amount)}
          tone="gray.6"
          hint={<>{kpi.unknownPayment.orders} активных заказов без данных об оплате в 1С. Это слепая зона, а не долг</>}
        />
        <Kpi
          label="Законтрактовано за месяц"
          value={formatMoney(kpi.contractedMonth.amount)}
          hint={
            <>
              {kpi.contractedMonth.orders} заказов
              {trend != null && <> · {trend >= 0 ? '+' : ''}{pct(trend)} к прошлым 30 дням</>}
              {kpi.contractedMonth.biggest && (
                <> · крупнейший{' '}
                  <OrderRef
                    id={kpi.contractedMonth.biggest.id}
                    number={kpi.contractedMonth.biggest.orderNumber}
                    size="xs" bold={false}
                  />
                </>
              )}
            </>
          }
        />
      </SimpleGrid>

      {/* Блок А. Разрезы портфеля */}
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="sm" wrap="wrap" gap="sm">
          <Text fw={700} size="sm">Из чего состоит портфель</Text>
          <SegmentedControl size="xs" data={DIMENSIONS} value={dim} onChange={setDim} />
        </Group>

        {degenerate ? (
          <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
            <Text size="sm">
              «{rows[0]?.key ?? 'не заполнено'}» — все {rows[0]?.orders ?? 0} заказов.
              Разрез не работает: в 1С у всех заказов здесь одно значение.
            </Text>
          </Alert>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{DIMENSIONS.find((d) => d.value === dim)?.label}</Table.Th>
                  <Table.Th ta="right">Заказов</Table.Th>
                  <Table.Th ta="right">Законтрактовано</Table.Th>
                  <Table.Th ta="right">Доля</Table.Th>
                  <Table.Th ta="right">Средний чек</Table.Th>
                  {isDirection && <Table.Th ta="right">Закуп по направлению</Table.Th>}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.slice(0, 15).map((r: any) => (
                  <Table.Tr key={r.key ?? '__none__'}>
                    <Table.Td>
                      {r.key
                        ? <Text size="sm" lineClamp={1}>{r.key}</Text>
                        : <Text size="sm" c="dimmed" fs="italic">не указано в 1С</Text>}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">{r.orders}</Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={700}>{formatMoney(r.total)}</Table.Td>
                    <Table.Td ta="right" ff="monospace" fz="xs" c="dimmed">
                      {data.totalContracted ? pct(r.total / data.totalContracted) : '—'}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fz="xs">
                      {r.orders ? formatMoney(Math.round(r.total / r.orders)) : '—'}
                    </Table.Td>
                    {isDirection && (
                      <Table.Td ta="right" ff="monospace" fz="xs" c="dimmed">
                        {r.key && data.procurementByDir[r.key] != null
                          ? formatMoney(data.procurementByDir[r.key])
                          : '—'}
                      </Table.Td>
                    )}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        )}
        {isDirection && !degenerate && (
          <Text size="xs" c="dimmed" mt="sm">
            «Закуп по направлению» — это не маржа и не себестоимость: заказы и закуп между
            собой не связаны, периоды признания разные. Цифра показывает, куда утекают
            деньги, а не рентабельность.
          </Text>
        )}
      </Card>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        {/* Блок Б. Кто нам должен */}
        <Card withBorder radius="md" padding="md">
          <Text fw={700} size="sm" mb="xs">Кто нам должен</Text>
          <Box style={{ overflowX: 'auto', maxHeight: 340, overflowY: 'auto' }}>
            <Table highlightOnHover verticalSpacing={4} fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Заказчик</Table.Th>
                  <Table.Th ta="right">Заказов</Table.Th>
                  <Table.Th ta="right">Законтрактовано</Table.Th>
                  <Table.Th ta="right">Долг</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.customers.map((c: any) => (
                  <Table.Tr key={c.id}>
                    <Table.Td>
                      <Text size="xs" lineClamp={1}>{c.name}</Text>
                      {c.unknown > 0 && (
                        <Text size="xs" c="dimmed">оплата неизвестна по {c.unknown}</Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">{c.orders}</Table.Td>
                    <Table.Td ta="right" ff="monospace">{formatMoney(c.total)}</Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={600} c={c.debt > 0 ? 'danger.7' : 'dimmed'}>
                      {c.debt > 0 ? formatMoney(c.debt) : '—'}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
          <Text size="xs" c="dimmed" mt="sm">
            Аврора Сервис и Аврора 75 — компании группы. Пока контрагенты не помечены
            «внутренний/внешний», внешнюю выручку отделить нельзя.
          </Text>
        </Card>

        {/* Блок В. Возраст открытых заказов */}
        <Card withBorder radius="md" padding="md">
          <Text fw={700} size="sm" mb="xs">Возраст открытых заказов</Text>
          <Stack gap={8}>
            {data.ageBuckets.map((b: any) => (
              <Group key={b.label} justify="space-between">
                <Text size="sm" c={b.label.includes('180') ? 'orange.7' : undefined}>{b.label}</Text>
                <Group gap="md">
                  <Text size="sm" ff="monospace" fw={700}>{b.orders}</Text>
                  <Text size="sm" ff="monospace" c="dimmed" style={{ minWidth: 130, textAlign: 'right' }}>
                    {formatMoney(b.amount)}
                  </Text>
                </Group>
              </Group>
            ))}
          </Stack>
          <Text size="xs" c="dimmed" mt="sm">
            Заказы старше полугода — либо отгружены и не закрыты в 1С, либо мертвы.
            Отгрузка не отмечена ни у одного заказа — система пока не может отличить
            сделанное от забытого.
          </Text>
        </Card>
      </SimpleGrid>

      {/* Блок Г. Честно о пробелах */}
      <Card withBorder radius="md" padding="md">
        <Group gap="xs" mb="xs">
          <IconAlertTriangle size={16} style={{ color: 'var(--mantine-color-orange-6)' }} />
          <Text fw={700} size="sm">Маржу по заказам показать нечем</Text>
        </Group>
        <Stack gap={4}>
          <Text size="sm" c="dimmed">
            · калькуляций себестоимости — {gaps.costings} на {gaps.ordersTotal} заказов,
            утверждённых — {gaps.approvedCostings}
          </Text>
          <Text size="sm" c="dimmed">
            · изделий без состава — {gaps.noBomArticles} (их себестоимость считается нулём)
          </Text>
          <Text size="sm" c="dimmed">
            · заказов без данных об оплате — {gaps.unknownPaymentOrders}
          </Text>
        </Stack>
        <Text size="xs" c="dimmed" mt="sm">
          Когда появятся утверждённые калькуляции — здесь встанет маржа план/факт.
        </Text>
      </Card>
    </Stack>
  );
}
