import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, SimpleGrid, Skeleton, Table, Box, Alert,
} from '@mantine/core';
import { IconScale, IconAlertTriangle, IconFileOff } from '@tabler/icons-react';
import api from '../../api/client';
import { formatCurrency } from '../../utils/formatters';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';

interface ReconciliationResponse {
  customers: Array<{
    customerId: string;
    customerName: string;
    ordersCount: number;
    paymentDocsCount: number;
    balanceDueOrders: number;
    unknownAmount: number;
    unpaidByDo: number;
    paidByDo: number;
    discrepancy: number;
  }>;
  orders: Array<{
    orderId: string;
    orderNumber: string;
    customerName: string;
    orderTotal: number;
    procurementTotal: number;
    procurementUnpaid: number;
    docsCount: number;
  }>;
  totals: {
    customersWithDebt: number;
    balanceDueOrders: number;
    unpaidByDo: number;
    procurementTotal: number;
    docsCount: number;
    shippedWithoutDo: number;
    docsWithoutOrder: number;
  };
}

const num = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

/**
 * Сверка «заказ ↔ ДО» (Этап 5): долг по заказам против неоплаченного по
 * договорам-основаниям, по заказчикам. В Excel это был ручной свод «Долги»,
 * который расходился молча.
 */
export function Reconciliation() {
  const { data, isLoading } = useQuery({
    queryKey: ['finance-reconciliation'],
    queryFn: () => api.get<ReconciliationResponse>('/payment-documents/reconciliation').then((r) => r.data),
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

  const { customers, orders, totals } = data;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
        <Card withBorder radius="md" padding="md">
          <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={4}>Долг по заказам</Text>
          <Text size="xl" fw={800} ff="monospace">{formatCurrency(totals.balanceDueOrders)}</Text>
          <Text size="xs" c="dimmed">{totals.customersWithDebt} заказчиков с долгом</Text>
        </Card>
        <Card withBorder radius="md" padding="md">
          <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={4}>Закуп: не оплачено по ДО</Text>
          <Text size="xl" fw={800} ff="monospace">{formatCurrency(totals.unpaidByDo)}</Text>
          <Text size="xs" c="dimmed">
            из {formatCurrency(totals.procurementTotal)} по {totals.docsCount.toLocaleString('ru-RU')} ДО
          </Text>
        </Card>
        <Card withBorder radius="md" padding="md">
          <Group gap="xs" mb={4}>
            <IconFileOff size={15} style={{ color: 'var(--warn-6, #FF9500)' }} />
            <Text size="xs" c="dimmed" fw={600} tt="uppercase">Пробелы данных</Text>
          </Group>
          <Text size="sm">
            Отгружено без ДО: <Text span fw={700} ff="monospace">{totals.shippedWithoutDo.toLocaleString('ru-RU')}</Text>
          </Text>
          <Text size="sm">
            ДО без заказа: <Text span fw={700} ff="monospace">{totals.docsWithoutOrder.toLocaleString('ru-RU')}</Text>
          </Text>
        </Card>
      </SimpleGrid>

      <Card withBorder radius="md" padding={0}>
        <Group gap="xs" p="md" pb="sm">
          <IconScale size={17} style={{ color: 'var(--brand-6, #0057FF)' }} />
          <Text fw={700} size="sm">Встречные долги по контрагентам</Text>
          <Text size="xs" c="dimmed">
            — «+» они должны нам больше, «−» мы им. Компании группы бывают
            и заказчиком, и поставщиком одновременно
          </Text>
        </Group>
        <Box style={{ overflowX: 'auto' }}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Заказчик</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Заказов</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>ДО</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Они должны нам</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Мы должны им</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Сальдо</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {customers.map((c) => {
                const big = Math.abs(c.discrepancy) > 1;
                return (
                  <Table.Tr key={c.customerId}>
                    <Table.Td><Text size="sm" lineClamp={1}>{c.customerName}</Text></Table.Td>
                    <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{c.ordersCount}</Table.Td>
                    <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{c.paymentDocsCount}</Table.Td>
                    <Table.Td ff="monospace" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {c.balanceDueOrders > 0 ? `${num(c.balanceDueOrders)} ₸` : <Text span c="dimmed">—</Text>}
                      {c.unknownAmount > 0 && (
                        <Text size="xs" c="dimmed">+{num(c.unknownAmount)} ₸ неизв.</Text>
                      )}
                    </Table.Td>
                    <Table.Td ff="monospace" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {c.unpaidByDo > 0 ? `${num(c.unpaidByDo)} ₸` : <Text span c="dimmed">—</Text>}
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      {big ? (
                        <Badge
                          color={c.discrepancy > 0 ? 'success' : 'warning'}
                          variant="light"
                          radius="xl"
                          leftSection={<IconAlertTriangle size={11} />}
                        >
                          {c.discrepancy > 0 ? '+' : ''}{num(c.discrepancy)} ₸
                        </Badge>
                      ) : (
                        <Badge color="gray" variant="light" radius="xl">в ноль</Badge>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
              {customers.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text size="sm" c="dimmed" ta="center" py="lg">Долгов нет — сверять нечего</Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Box>
      </Card>

      {orders.length === 0 ? (
        <Alert color="gray" variant="light" radius="md" icon={<IconFileOff size={16} />}>
          <Text size="sm" fw={600} mb={4}>Закуп под конкретный заказ пока не виден</Text>
          <Text size="sm">
            Все {totals.docsWithoutOrder.toLocaleString('ru-RU')} договоров-оснований пришли
            из 1С без ссылки на заказ на продажу — колонка «Заказ на продажу» листа «19.20-7п»
            в выгрузке пустая. Пока её не заполнят, ответить «сколько закупили под этот
            заказ» нельзя ни здесь, ни в таблице.
          </Text>
        </Alert>
      ) : (
      <Card withBorder radius="md" padding={0}>
        <Group gap="xs" p="md" pb="sm">
          <IconScale size={17} style={{ color: 'var(--warn-6, #FF9500)' }} />
          <Text fw={700} size="sm">Закуп под заказы</Text>
          <Text size="xs" c="dimmed">— ДО из «19.20-7п», привязанные к заказу на продажу</Text>
        </Group>
        <Box style={{ overflowX: 'auto' }}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>№ заказа</Table.Th>
                <Table.Th>Заказчик</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>ДО</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Сумма заказа</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Закуп по ДО</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Не оплачено</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {orders.map((o) => (
                <Table.Tr key={o.orderId}>
                  <Table.Td><OrderRef id={o.orderId} number={o.orderNumber} focus="money" /></Table.Td>
                  <Table.Td><Text size="sm" lineClamp={1}>{o.customerName}</Text></Table.Td>
                  <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{o.docsCount}</Table.Td>
                  <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(o.orderTotal)} ₸</Table.Td>
                  <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(o.procurementTotal)} ₸</Table.Td>
                  <Table.Td style={{ textAlign: 'right' }}>
                    {o.procurementUnpaid > 0 ? (
                      <Badge color="warning" variant="light" radius="xl" ff="monospace">
                        {num(o.procurementUnpaid)} ₸
                      </Badge>
                    ) : (
                      <Badge color="success" variant="light" radius="xl">оплачено</Badge>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      </Card>
      )}
    </Stack>
  );
}
