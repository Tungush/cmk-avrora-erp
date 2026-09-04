import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Skeleton, Table, TextInput,
} from '@mantine/core';
import { IconSearch, IconDownload } from '@tabler/icons-react';
import { Button } from '@mantine/core';
import api from '../../api/client';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { exportCsv } from '../../utils/exportCsv';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePageSize } from '../../components/PaginationBar';
import { FadeSwap } from '../../components/motion';
import { EmptyState } from '../../components/EmptyState';

/**
 * Реестр договоров-оснований (31.08.2026). Эндпоинт существовал с самого
 * начала, а экрана не было: 306 ДО на 663 млн ₸ можно было увидеть только
 * через сверку, агрегатом. Здесь они списком — как лист «19.20-7п».
 */
export function PaymentDocuments() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = usePageSize('finance-documents', 25);
  useEffect(() => { setPage(1); }, [pageSize]);

  const { data, isLoading } = useQuery({
    queryKey: ['payment-documents', page, pageSize],
    queryFn: () => api.get('/payment-documents', { params: { page, pageSize } }).then((r) => r.data),
  });

  const all: any[] = data?.data ?? [];
  const q = search.trim().toLowerCase();
  const rows = q
    ? all.filter((d) => `${d.doNumber ?? ''} ${d.contractor?.name ?? ''} ${d.supplierName ?? ''}`
        .toLowerCase().includes(q))
    : all;
  const total = data?.meta?.total ?? 0;

  return (
    <Stack gap="md">
      <div className="toolbar-sticky">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <TextInput
            placeholder="Номер ДО, контрагент…"
            leftSection={<IconSearch aria-hidden size={16} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            w={320}
            style={{ maxWidth: '100%' }}
          />
          <Group gap="sm">
            <Text size="sm" c="dimmed">
              Всего ДО: <Text span fw={700} ff="monospace">{total.toLocaleString('ru-RU')}</Text>
            </Text>
            <Button
              size="compact-sm" variant="light" leftSection={<IconDownload aria-hidden size={16} />}
              onClick={() => exportCsv(
                'договоры-основания',
                ['№ ДО', 'Дата', 'Контрагент', 'Сумма', 'Оплачено', 'Остаток'],
                rows.map((d: any) => [
                  d.doNumber, d.doDate ? String(d.doDate).slice(0, 10) : '',
                  d.contractor?.name ?? d.supplierName ?? '',
                  Number(d.totalAmount ?? 0), Number(d.paidAmount ?? 0), Number(d.unpaidAmount ?? 0),
                ]),
              )}
            >
              Экспорт CSV
            </Button>
          </Group>
        </Group>
      </div>

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">{[...Array(8)].map((_, i) => <Skeleton key={i} height={40} radius="sm" />)}</Stack>
        ) : (
          <FadeSwap swapKey={page}>
            <TableScroll minWidth={900}>
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>№ ДО</Table.Th>
                    <Table.Th>Дата</Table.Th>
                    <Table.Th>Контрагент</Table.Th>
                    <Table.Th ta="right">Сумма</Table.Th>
                    <Table.Th ta="right" data-priority="3">Оплачено</Table.Th>
                    <Table.Th ta="right">Остаток</Table.Th>
                    <Table.Th data-priority="2">Статус</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((d: any) => {
                    const unpaid = Number(d.unpaidAmount ?? 0);
                    return (
                      <Table.Tr key={d.id}>
                        <Table.Td>
                          <Text size="sm" ff="monospace" fw={600}>{d.doNumber ?? '—'}</Text>
                        </Table.Td>
                        <Table.Td ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                          {d.doDate ? formatDate(d.doDate) : '—'}
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" lineClamp={1}>
                            {d.contractor?.name ?? d.supplierName ?? '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                          {formatCurrency(Number(d.totalAmount ?? 0))}
                        </Table.Td>
                        <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }} data-priority="3">
                          {formatCurrency(Number(d.paidAmount ?? 0))}
                        </Table.Td>
                        <Table.Td ta="right" ff="monospace" fw={700} style={{ whiteSpace: 'nowrap' }}>
                          {unpaid > 0
                            ? <Text span c="danger.7">{formatCurrency(unpaid)}</Text>
                            : <Text span c="dimmed">—</Text>}
                        </Table.Td>
                        <Table.Td data-priority="2">
                          <Badge variant="light" radius="xl"
                            color={unpaid > 0 ? 'warning' : 'success'}>
                            {unpaid > 0 ? 'не закрыт' : 'оплачен'}
                          </Badge>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <Table.Tr>
                      <Table.Td colSpan={7}>
                        <EmptyState height={132} title="Документов по такому запросу нет" />
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Table.Tbody>
              </Table>
            </TableScroll>
          </FadeSwap>
        )}
      </Card>

      <PaginationBar
        page={page}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        noun="договоров"
        sticky
      />
    </Stack>
  );
}
