import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, SimpleGrid, Skeleton, Table, Progress, Alert,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import api from '../../api/client';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { TableScroll } from '../../components/TableScroll';
import { Stagger } from '../../components/motion';

interface ScheduleEntry {
  dueDate: string; totalAmount: number; principalAmount: number; interestAmount: number; trancheContract: string;
}
interface CreditLineRow {
  id: string; name: string; contractNumber: string;
  limitAmount: number; usedAmount: number; availableAmount: number;
  interestRatePct: number; asOfDate: string; sourceFile: string; tranchesCount: number;
  nextPayment: ScheduleEntry | null;
  upcomingTotal: number;
  recentPayments: Array<{ paymentDate: string; totalAmount: number; principalAmount: number; interestAmount: number; status: string }>;
}

/**
 * ДАМУ (31.08.2026) — кредитные линии фонда, не из 1С: данные заносятся
 * импортом Excel-выгрузки из личного кабинета банка (`npm run import:damu`).
 * Лимит/остаток — снимок на дату последнего импорта, не живые данные.
 */
export function CreditLines() {
  const { data, isLoading } = useQuery({
    queryKey: ['credit-lines'],
    queryFn: () => api.get<CreditLineRow[]>('/credit-lines').then((r) => r.data),
  });

  if (isLoading) {
    return <Stack gap="md">{[...Array(2)].map((_, i) => <Skeleton key={i} height={220} radius="md" />)}</Stack>;
  }

  const lines = data ?? [];

  return (
    <Stack gap="md">
      <Alert color="gray" variant="light" radius="md" icon={<IconInfoCircle size={16} />}>
        <Text size="sm">
          Не из 1С — данные заносятся вручную из выгрузки личного кабинета банка.
          Лимит и остаток верны на дату последнего импорта, не на сейчас.
        </Text>
      </Alert>

      {lines.length === 0 && (
        <Card withBorder radius="md" padding="xl">
          <Text size="sm" c="dimmed" ta="center">Кредитные линии не занесены</Text>
        </Card>
      )}

      <Stagger>
        {lines.map((line) => {
          const usedPct = line.limitAmount > 0 ? Math.min(100, (line.usedAmount / line.limitAmount) * 100) : 0;
          return (
            <Card key={line.id} withBorder radius="md" padding="lg">
              <Group justify="space-between" mb="md" wrap="wrap">
                <Stack gap={2}>
                  <Text fw={700} size="md">{line.name}</Text>
                  <Text size="xs" c="dimmed" ff="monospace">{line.contractNumber} · {line.interestRatePct}% годовых</Text>
                </Stack>
                <Text size="xs" c="dimmed">
                  на {formatDate(line.asOfDate)} · {line.sourceFile}
                </Text>
              </Group>

              <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md" mb="md">
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">Лимит</Text>
                  <Text fw={700} ff="monospace">{formatCurrency(line.limitAmount)}</Text>
                </Stack>
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">Использовано</Text>
                  <Text fw={700} ff="monospace">{formatCurrency(line.usedAmount)}</Text>
                </Stack>
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">Доступно</Text>
                  <Text fw={700} ff="monospace" c="success.7">{formatCurrency(line.availableAmount)}</Text>
                </Stack>
              </SimpleGrid>
              <Progress value={usedPct} size="md" radius="xl" color={usedPct > 85 ? 'warning' : 'brand'} mb="md" />

              <Group gap="lg" mb="md" wrap="wrap">
                {line.nextPayment && (
                  <Group gap={6}>
                    <Text size="sm" c="dimmed">Ближайший платёж</Text>
                    <Badge variant="light" color="brand" radius="xl" size="lg">
                      {formatDate(line.nextPayment.dueDate)} · {formatCurrency(line.nextPayment.totalAmount)}
                    </Badge>
                  </Group>
                )}
                {line.upcomingTotal > 0 && (
                  <Group gap={6}>
                    <Text size="sm" c="dimmed">Предстоит по графику</Text>
                    <Badge variant="light" color="gray" radius="xl" size="lg">{formatCurrency(line.upcomingTotal)}</Badge>
                  </Group>
                )}
                <Text size="xs" c="dimmed">{line.tranchesCount} транш(ей) выборки</Text>
              </Group>

              {line.recentPayments.length > 0 && (
                <TableScroll minWidth={620}>
                  <Table verticalSpacing={6}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Дата</Table.Th>
                        <Table.Th ta="right">Сумма</Table.Th>
                        <Table.Th ta="right" data-priority="3">ОД</Table.Th>
                        <Table.Th ta="right" data-priority="3">%</Table.Th>
                        <Table.Th>Статус</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {line.recentPayments.map((p, i) => (
                        <Table.Tr key={i}>
                          <Table.Td ff="monospace">{formatDate(p.paymentDate)}</Table.Td>
                          <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                            {formatCurrency(p.totalAmount)}
                            {/* Разбивка на ОД и % — подстрокой, когда колонки спрятаны */}
                            <Text size="xs" c="dimmed" hiddenFrom="xl">
                              ОД {formatCurrency(p.principalAmount)} · % {formatCurrency(p.interestAmount)}
                            </Text>
                          </Table.Td>
                          <Table.Td ta="right" ff="monospace" c="dimmed" data-priority="3">{formatCurrency(p.principalAmount)}</Table.Td>
                          <Table.Td ta="right" ff="monospace" c="dimmed" data-priority="3">{formatCurrency(p.interestAmount)}</Table.Td>
                          <Table.Td>
                            <Badge variant="light" color={p.status.toLowerCase().includes('оплач') ? 'success' : 'gray'}>
                              {p.status}
                            </Badge>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </TableScroll>
              )}
            </Card>
          );
        })}
      </Stagger>
    </Stack>
  );
}
