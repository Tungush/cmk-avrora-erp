import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, SimpleGrid, Skeleton, Table, Alert,
} from '@mantine/core';
import { IconCoin, IconWallet, IconHelpCircle, IconDownload } from '@tabler/icons-react';
import { Button } from '@mantine/core';
import api from '../../api/client';
import { formatCurrency, formatCompactMoney } from '../../utils/formatters';
import { exportCsv } from '../../utils/exportCsv';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePagedList, usePageSize } from '../../components/PaginationBar';
import { FadeSwap } from '../../components/motion';
import { DigestCard, DigestGrid } from '../../components/Digest';
import { ViewSwitch } from '../../components/ViewSwitch';
import { Ref, useEntity } from '../../components/EntityRef';

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
  const { open: openEntity } = useEntity();
  // Экран открывается сводкой, а не таблицей: список — за переключателем
  const [view, setView] = useState<'digest' | 'list'>('digest');
  const { data, isLoading } = useQuery({
    queryKey: ['customer-debts'],
    queryFn: () => api.get<CustomerDebtsResponse>('/payment-documents/customer-debts').then((r) => r.data),
  });

  // Список приходит целиком — страницы режем на клиенте
  const withDebt = useMemo(
    () => (data?.customers ?? []).filter((c) => c.debt > 0 || c.unknownAmount > 0),
    [data],
  );
  const [pageSize, setPageSize] = usePageSize('finance-receivables', 25);
  const { page, setPage, slice, total } = usePagedList(withDebt, pageSize);

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

  const { totals } = data;

  const top = (key: 'debt' | 'contracted' | 'unknownAmount', limit = 4) => {
    const rows = [...(data.customers ?? [])].filter((c) => c[key] > 0).sort((a, b) => b[key] - a[key]);
    const max = rows[0]?.[key] ?? 1;
    return rows.slice(0, limit).map((c) => ({
      id: c.customerId,
      label: c.customerName,
      value: formatCurrency(c[key]),
      sub: key === 'unknownAmount' ? `${c.unknownOrders} зак. без данных 1С` : `${c.orders} зак.`,
      share: c[key] / max,
      // Карточка заказчика вместо ухода в реестр: долг, оплата и его заказы
      // видны разом, и человек не теряет сводку (03.09.2026)
      onClick: () => openEntity({ kind: 'customer', id: c.customerId, label: c.customerName }),
    }));
  };

  const paidPct = totals.contracted > 0 ? Math.round((totals.paid / totals.contracted) * 100) : 0;

  return (
    <Stack gap="md">
      <ViewSwitch
        value={view}
        onChange={setView}
        digestLabel="Кто должен"
        listLabel={`Все заказчики · ${withDebt.length}`}
      />

      {view === 'digest' ? (
        <DigestGrid>
          <DigestCard
            title="Должны нам"
            tone="danger"
            icon={<IconCoin aria-hidden size={20} />}
            value={totals.debt}
            format={(v) => formatCompactMoney(v)}
            caption={`оплачено ${formatCompactMoney(totals.paid)} из ${formatCompactMoney(totals.contracted)} · ${paidPct} %`}
            items={top('debt')}
            emptyText="Долгов нет — всё оплачено"
            action={{ label: 'Все должники', onClick: () => setView('list') }}
          />

          <DigestCard
            title="Законтрактовано"
            tone="brand"
            icon={<IconWallet aria-hidden size={20} />}
            value={totals.contracted}
            format={(v) => formatCompactMoney(v)}
            caption={`${totals.orders} активных заказов у ${totals.customers} заказчиков`}
            items={top('contracted')}
            emptyText="Активных заказов нет"
          />

          <DigestCard
            title="Оплата неизвестна"
            tone="warn"
            icon={<IconHelpCircle aria-hidden size={20} />}
            value={totals.unknownAmount}
            format={(v) => formatCompactMoney(v)}
            caption={`${totals.unknownOrders} заказов без платежей из 1С`}
            items={top('unknownAmount')}
            emptyText="По всем заказам оплата известна"
          />
        </DigestGrid>
      ) : (
      <>
      <Card withBorder radius="md" padding={0}>
        <Group justify="space-between" p="md" pb="sm" wrap="wrap" gap="sm">
          <Group gap="xs">
            <Text fw={700} size="sm">Заказчики</Text>
            <Badge variant="light" color="gray" radius="xl" size="lg">{withDebt.length}</Badge>
          </Group>
          <Button
            size="compact-sm" variant="light" leftSection={<IconDownload aria-hidden size={16} />}
            onClick={() => exportCsv(
              'нам-должны',
              ['Заказчик', 'Заказов', 'Законтрактовано', 'Оплачено', 'Должны нам', 'Оплата неизвестна, ₸', 'Заказов без данных'],
              withDebt.map((c) => [c.customerName, c.orders, c.contracted, c.paid, c.debt, c.unknownAmount, c.unknownOrders]),
            )}
          >
            Экспорт CSV
          </Button>
        </Group>
        <FadeSwap swapKey={page}>
          <TableScroll minWidth={820}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Заказчик</Table.Th>
                  <Table.Th ta="right" data-priority="3">Заказов</Table.Th>
                  <Table.Th ta="right">Законтрактовано</Table.Th>
                  <Table.Th ta="right">Оплачено</Table.Th>
                  <Table.Th ta="right">Должны нам</Table.Th>
                  <Table.Th ta="right">Оплата неизвестна</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {slice.map((c) => (
                  <Table.Tr key={c.customerId}>
                    <Table.Td>
                      <Ref kind="customer" id={c.customerId} label={c.customerName} tone="text" size="sm" bold>
                        {c.customerName}
                      </Ref>
                      {/* Число заказов дублируем подстрокой: на ноутбуке колонка спрятана */}
                      <Text size="xs" c="dimmed">{c.orders} зак.</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" data-priority="3">{c.orders}</Table.Td>
                    <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                      {formatCurrency(c.contracted)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                      {c.paid > 0 ? formatCurrency(c.paid) : <Text span c="dimmed">—</Text>}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={700} style={{ whiteSpace: 'nowrap' }}>
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
                {slice.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={6}>
                      <Text size="sm" c="dimmed" ta="center" py="lg">Долгов нет</Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </TableScroll>
        </FadeSwap>
      </Card>

      <PaginationBar
        page={page}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        noun="заказчиков"
        sticky
      />
      </>
      )}
    </Stack>
  );
}
