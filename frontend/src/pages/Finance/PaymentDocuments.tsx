import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Skeleton, Table, Box, TextInput, Pagination,
} from '@mantine/core';
import { IconSearch, IconDownload } from '@tabler/icons-react';
import { Button } from '@mantine/core';
import api from '../../api/client';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { exportCsv } from '../../utils/exportCsv';

/**
 * Реестр договоров-оснований (31.08.2026). Эндпоинт существовал с самого
 * начала, а экрана не было: 306 ДО на 663 млн ₸ можно было увидеть только
 * через сверку, агрегатом. Здесь они списком — как лист «19.20-7п».
 */
export function PaymentDocuments() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const pageSize = 50;

  const { data, isLoading } = useQuery({
    queryKey: ['payment-documents', page],
    queryFn: () => api.get('/payment-documents', { params: { page, pageSize } }).then((r) => r.data),
  });

  const all: any[] = data?.data ?? [];
  const q = search.trim().toLowerCase();
  const rows = q
    ? all.filter((d) => `${d.doNumber ?? ''} ${d.contractor?.name ?? ''} ${d.supplierName ?? ''}`
        .toLowerCase().includes(q))
    : all;
  const totalPages = Math.max(1, Math.ceil((data?.meta?.total ?? 0) / pageSize));

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <TextInput
          placeholder="Номер ДО, контрагент…"
          leftSection={<IconSearch size={15} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          w={300}
          size="sm"
        />
        <Group gap="sm">
          <Text size="sm" c="dimmed">
            Всего ДО: <Text span fw={700} ff="monospace">{data?.meta?.total ?? 0}</Text>
          </Text>
          <Button
            size="compact-xs" variant="light" leftSection={<IconDownload size={13} />}
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

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">{[...Array(8)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}</Stack>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>№ ДО</Table.Th>
                  <Table.Th>Дата</Table.Th>
                  <Table.Th>Контрагент</Table.Th>
                  <Table.Th ta="right">Сумма</Table.Th>
                  <Table.Th ta="right">Оплачено</Table.Th>
                  <Table.Th ta="right">Остаток</Table.Th>
                  <Table.Th>Статус</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((d: any) => {
                  const unpaid = Number(d.unpaidAmount ?? 0);
                  return (
                    <Table.Tr key={d.id}>
                      <Table.Td>
                        <Text size="sm" ff="monospace" fw={600} c="brand.7">{d.doNumber ?? '—'}</Text>
                      </Table.Td>
                      <Table.Td ff="monospace" fz="xs" style={{ whiteSpace: 'nowrap' }}>
                        {d.doDate ? formatDate(d.doDate) : '—'}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" lineClamp={1}>
                          {d.contractor?.name ?? d.supplierName ?? '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" fz="sm" style={{ whiteSpace: 'nowrap' }}>
                        {formatCurrency(Number(d.totalAmount ?? 0))}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" fz="sm" style={{ whiteSpace: 'nowrap' }}>
                        {formatCurrency(Number(d.paidAmount ?? 0))}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" fz="sm" fw={700} style={{ whiteSpace: 'nowrap' }}>
                        {unpaid > 0
                          ? <Text span c="danger.7">{formatCurrency(unpaid)}</Text>
                          : <Text span c="dimmed">—</Text>}
                      </Table.Td>
                      <Table.Td>
                        <Badge size="xs" variant="light" radius="xl"
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
                      <Text size="sm" c="dimmed" ta="center" py="lg">Ничего не найдено</Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Card>

      {totalPages > 1 && (
        <Group justify="center">
          <Pagination value={page} onChange={setPage} total={totalPages} size="sm" radius="md" />
        </Group>
      )}
    </Stack>
  );
}
