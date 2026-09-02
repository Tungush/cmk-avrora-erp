import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, SimpleGrid, Skeleton, Table, Box, Alert,
} from '@mantine/core';
import { IconCoin, IconWallet, IconHelpCircle, IconDownload } from '@tabler/icons-react';
import { Button } from '@mantine/core';
import api from '../../api/client';
import { formatCurrency } from '../../utils/formatters';
import { exportCsv } from '../../utils/exportCsv';

interface CustomerDebtRow {
  customerId: string;
  customerName: string;
  orders: number;
  contracted: number;
  paid: number;
  debt: number;
  unknownOrders: number;
  unknownAmount: number;
}

interface CustomerDebtsResponse {
  customers: CustomerDebtRow[];
  totals: {
    customers: number; orders: number;
    contracted: number; paid: number; debt: number;
    unknownOrders: number; unknownAmount: number;
  };
}

/**
 * Дебиторка «нам должны» (31.08.2026). Раньше этот экран читал долг из
 * order_lines.balance_due — поля, которое 1С не заполняет, поэтому
 * показывал ноль при живом долге в полтора миллиарда.
 *
 * Считается по onecTotalAmount − onecPaidAmount. Заказы без данных об
 * оплате не считаются оплаченными на ноль: они собраны отдельной строкой
 * «оплата неизвестна», чтобы долг был занижен честно, а не завышен молча.
 */
export function Receivables() {
  const { data, isLoading } = useQuery({
    queryKey: ['customer-debts'],
    queryFn: () => api.get<CustomerDebtsResponse>('/payment-documents/customer-debts').then((r) => r.data),
  });

  if (isLoading || !data) {
    return (
      <Stack gap="md">
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
          {[...Array(3)].map((_, i) => <Skeleton key={i} height={90} radius="md" />)}
        </SimpleGrid>
        <Skeleton height={320} radius="md" />
      </Stack>
    );
  }

  const { customers, totals } = data;
  const withDebt = customers.filter((c) => c.debt > 0 || c.unknownAmount > 0);

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
        <Card withBorder radius="md" padding="md">
          <Group gap="xs" mb={4}>
            <IconCoin size={15} style={{ color: 'var(--mantine-color-brand-6)' }} />
            <Text size="xs" c="dimmed" fw={600}>ЗАКОНТРАКТОВАНО</Text>
          </Group>
          <Text fw={800} size="xl" ff="monospace">{formatCurrency(totals.contracted)}</Text>
          <Text size="xs" c="dimmed">{totals.orders} активных заказов</Text>
        </Card>

        <Card withBorder radius="md" padding="md">
          <Group gap="xs" mb={4}>
            <IconWallet size={15} style={{ color: 'var(--mantine-color-success-6)' }} />
            <Text size="xs" c="dimmed" fw={600}>ДОЛЖНЫ НАМ</Text>
          </Group>
          <Text fw={800} size="xl" ff="monospace" c="danger.7">{formatCurrency(totals.debt)}</Text>
          <Text size="xs" c="dimmed">оплачено {formatCurrency(totals.paid)}</Text>
        </Card>

        <Card withBorder radius="md" padding="md">
          <Group gap="xs" mb={4}>
            <IconHelpCircle size={15} style={{ color: 'var(--mantine-color-gray-6)' }} />
            <Text size="xs" c="dimmed" fw={600}>ОПЛАТА НЕИЗВЕСТНА</Text>
          </Group>
          <Text fw={800} size="xl" ff="monospace" c="dimmed">{formatCurrency(totals.unknownAmount)}</Text>
          <Text size="xs" c="dimmed">{totals.unknownOrders} заказов без данных 1С</Text>
        </Card>
      </SimpleGrid>

      {totals.unknownOrders > 0 && (
        <Alert color="gray" variant="light" radius="md" icon={<IconHelpCircle size={16} />}>
          <Text size="sm">
            По {totals.unknownOrders} заказам из {totals.orders} 1С не прислала данных об оплате.
            Эта сумма не приравнена к нулю и не попала в «должны нам» — реальный долг
            может быть больше на {formatCurrency(totals.unknownAmount)}.
          </Text>
        </Alert>
      )}

      <Card withBorder radius="md" padding={0}>
        <Group justify="space-between" p="md" pb="sm">
          <Group gap="xs">
            <Text fw={700} size="sm">Заказчики</Text>
            <Badge variant="light" color="gray" radius="xl">{withDebt.length}</Badge>
          </Group>
          <Button
            size="compact-xs" variant="light" leftSection={<IconDownload size={13} />}
            onClick={() => exportCsv(
              'нам-должны',
              ['Заказчик', 'Заказов', 'Законтрактовано', 'Оплачено', 'Должны нам', 'Оплата неизвестна, ₸', 'Заказов без данных'],
              withDebt.map((c) => [c.customerName, c.orders, c.contracted, c.paid, c.debt, c.unknownAmount, c.unknownOrders]),
            )}
          >
            Экспорт CSV
          </Button>
        </Group>
        <Box style={{ overflowX: 'auto' }}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Заказчик</Table.Th>
                <Table.Th ta="right">Заказов</Table.Th>
                <Table.Th ta="right">Законтрактовано</Table.Th>
                <Table.Th ta="right">Оплачено</Table.Th>
                <Table.Th ta="right">Должны нам</Table.Th>
                <Table.Th ta="right">Оплата неизвестна</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {withDebt.map((c) => (
                <Table.Tr key={c.customerId}>
                  <Table.Td><Text size="sm" fw={600}>{c.customerName}</Text></Table.Td>
                  <Table.Td ta="right" ff="monospace" fz="sm">{c.orders}</Table.Td>
                  <Table.Td ta="right" ff="monospace" fz="sm" style={{ whiteSpace: 'nowrap' }}>
                    {formatCurrency(c.contracted)}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" fz="sm" style={{ whiteSpace: 'nowrap' }}>
                    {c.paid > 0 ? formatCurrency(c.paid) : <Text span c="dimmed">—</Text>}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" fz="sm" fw={700} style={{ whiteSpace: 'nowrap' }}>
                    {c.debt > 0
                      ? <Text span c="danger.7">{formatCurrency(c.debt)}</Text>
                      : <Text span c="dimmed">—</Text>}
                  </Table.Td>
                  <Table.Td ta="right" style={{ whiteSpace: 'nowrap' }}>
                    {c.unknownAmount > 0 ? (
                      <Stack gap={0} align="flex-end">
                        <Text size="sm" ff="monospace" c="dimmed">{formatCurrency(c.unknownAmount)}</Text>
                        <Text size="xs" c="dimmed">{c.unknownOrders} зак.</Text>
                      </Stack>
                    ) : <Text size="sm" c="dimmed">—</Text>}
                  </Table.Td>
                </Table.Tr>
              ))}
              {withDebt.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text size="sm" c="dimmed" ta="center" py="lg">Долгов нет</Text>
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
