import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Skeleton, Table, Progress, Box,
} from '@mantine/core';
import { IconCalendarWeek, IconAlertTriangle } from '@tabler/icons-react';
import api from '../../api/client';
import { formatDate } from '../../utils/formatters';

interface WeeklyResponse {
  weeks: Array<{
    weekStart: string;
    ordersCount: number;
    totalQty: number;
    reservedQty: number;
    shippedQty: number;
    toProduce: number;
  }>;
  noDate: { ordersCount: number; totalQty: number; toProduce: number } | null;
}

const num = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });

/**
 * «К изготовлению по неделям» (Этап 5): агрегат активных заказов по неделе
 * плановой отгрузки. Заказы без даты — отдельной строкой: этот пробел данных
 * в Excel был невидим, а здесь он — первое, что нужно закрыть.
 */
export function WeeklyPlan() {
  const { data, isLoading } = useQuery({
    queryKey: ['production-weekly'],
    queryFn: () => api.get<WeeklyResponse>('/production-plan/weekly').then((r) => r.data),
  });

  if (isLoading || !data) return <Skeleton height={320} radius="md" />;

  const maxQty = Math.max(1, ...data.weeks.map((w) => w.totalQty));

  return (
    <Stack gap="md">
      {data.noDate && data.noDate.ordersCount > 0 && (
        <Card withBorder radius="md" padding="md" bg="light-dark(var(--mantine-color-warning-0), rgba(232, 147, 12, 0.12))"
          style={{ border: '1px solid var(--mantine-color-warning-3)' }}>
          <Group gap="xs">
            <IconAlertTriangle size={17} style={{ color: 'var(--warn-6, #FF9500)' }} />
            <Text size="sm" fw={600}>
              {data.noDate.ordersCount.toLocaleString('ru-RU')} активных заказов без плановой даты отгрузки
            </Text>
            <Text size="sm" c="dimmed">
              · {num(data.noDate.totalQty)} шт вне раскладки — в Excel этот пробел был невидим
            </Text>
          </Group>
        </Card>
      )}

      <Card withBorder radius="md" padding={0}>
        <Group gap="xs" p="md" pb="sm">
          <IconCalendarWeek size={17} style={{ color: 'var(--brand-6, #0057FF)' }} />
          <Text fw={700} size="sm">К изготовлению по неделям</Text>
          <Text size="xs" c="dimmed">— активные заказы по неделе плановой отгрузки</Text>
        </Group>
        <Box style={{ overflowX: 'auto' }}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Неделя с</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Заказов</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Заказано</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Резерв</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Отгружено</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>К изготовлению</Table.Th>
                <Table.Th w="30%">Объём</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.weeks.map((w) => (
                <Table.Tr key={w.weekStart}>
                  <Table.Td ff="monospace">{formatDate(w.weekStart)}</Table.Td>
                  <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{w.ordersCount}</Table.Td>
                  <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(w.totalQty)}</Table.Td>
                  <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(w.reservedQty)}</Table.Td>
                  <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(w.shippedQty)}</Table.Td>
                  <Table.Td style={{ textAlign: 'right' }}>
                    {w.toProduce > 0 ? (
                      <Badge variant="light" color="warning" radius="xl" ff="monospace">{num(w.toProduce)} шт</Badge>
                    ) : (
                      <Badge variant="light" color="success" radius="xl">закрыто</Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Progress value={(w.totalQty / maxQty) * 100} size="md" radius="xl" />
                  </Table.Td>
                </Table.Tr>
              ))}
              {data.weeks.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <Text size="sm" c="dimmed" ta="center" py="lg">
                      У активных заказов нет плановых дат — раскладка появится после их заполнения
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Box>
      </Card>
    </Stack>
  );
}
