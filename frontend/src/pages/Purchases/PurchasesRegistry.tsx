import React, { useState } from 'react';
import {
  Stack, Group, Text, Card, Table, Badge, Skeleton, Box, TextInput,
  Select, Pagination, Switch,
} from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useDebouncedValue } from '@mantine/hooks';
import { purchasesApi } from '../../api/purchases';
import { ReceiptRef } from '../../components/ReceiptCard/ReceiptCardProvider';
import { formatMoney, formatDate } from '../../utils/formatters';

const STATUS_LABELS: Record<string, string> = {
  UNPAID: 'Не оплачен', PARTIALLY_PAID: 'Частично', PAID: 'Оплачен', EXECUTED: 'Исполнен',
};
const STATUS_COLORS: Record<string, string> = {
  UNPAID: 'danger', PARTIALLY_PAID: 'warning', PAID: 'success', EXECUTED: 'gray',
};

/**
 * Реестр заказов поставщику. До него из интерфейса были достижимы только
 * те 85 документов, по которым импорт смог опознать материал и завести
 * партию — остальные 221 не существовали для пользователя (26.08.2026).
 */
export function PurchasesRegistry({ filters, onFiltersChange }: {
  filters: Record<string, string>;
  onFiltersChange: (f: Record<string, string>) => void;
}) {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['purchases-docs', debounced, filters, page],
    queryFn: () => purchasesApi.documents({
      search: debounced, page, pageSize: 50, ...filters,
    }).then((r) => r.data),
  });

  const rows = data?.data ?? [];
  const total = data?.meta?.total ?? 0;
  const pages = Math.ceil(total / 50);
  const activeFilters = Object.keys(filters).length;

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Group gap="sm" wrap="wrap">
          <TextInput
            placeholder="№ ДО, поставщик, номер поставщика..."
            leftSection={<IconSearch size={15} />}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            w={300}
            size="sm"
          />
          <Select
            placeholder="Направление"
            data={['ЦМК Телекоммуникации', 'ЦМК Другие']}
            value={filters.direction ?? null}
            onChange={(v) => { onFiltersChange(v ? { ...filters, direction: v } : omit(filters, 'direction')); setPage(1); }}
            clearable size="sm" w={200}
          />
          <Switch
            size="sm" label="Только неоплаченные"
            checked={filters.unpaidOnly === '1'}
            onChange={(e) => { onFiltersChange(e.currentTarget.checked ? { ...filters, unpaidOnly: '1' } : omit(filters, 'unpaidOnly')); setPage(1); }}
          />
          <Switch
            size="sm" label="Без прихода"
            checked={filters.hasBatches === '0'}
            onChange={(e) => { onFiltersChange(e.currentTarget.checked ? { ...filters, hasBatches: '0' } : omit(filters, 'hasBatches')); setPage(1); }}
          />
        </Group>
        <Group gap="sm">
          {activeFilters > 0 && (
            <Text
              size="xs" c="brand.7" fw={600} style={{ cursor: 'pointer' }}
              onClick={() => { onFiltersChange({}); setPage(1); }}
            >
              сбросить фильтры ({activeFilters})
            </Text>
          )}
          <Text size="sm" c="dimmed">
            Найдено: <Text span fw={700} ff="monospace">{total.toLocaleString('ru-RU')}</Text>
          </Text>
        </Group>
      </Group>

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">
            {[...Array(10)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}
          </Stack>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>№ ДО</Table.Th>
                  <Table.Th>Дата</Table.Th>
                  <Table.Th>Поставщик</Table.Th>
                  <Table.Th>Направление</Table.Th>
                  <Table.Th ta="right">Сумма</Table.Th>
                  <Table.Th ta="right">Остаток</Table.Th>
                  <Table.Th>Статус</Table.Th>
                  <Table.Th ta="center">Строк</Table.Th>
                  <Table.Th ta="center">Приход</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((d) => (
                  <Table.Tr key={d.id}>
                    <Table.Td><ReceiptRef id={d.id} number={d.doNumber} size="sm" /></Table.Td>
                    <Table.Td ff="monospace" fz="xs" style={{ whiteSpace: 'nowrap' }}>{formatDate(d.doDate)}</Table.Td>
                    <Table.Td><Text size="sm" lineClamp={1}>{d.supplier}</Text></Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed" lineClamp={1}>{d.businessDirection ?? '—'}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={600}>{formatMoney(d.totalAmount, d.currency)}</Table.Td>
                    <Table.Td ta="right" ff="monospace" c={d.unpaidAmount > 0 ? 'danger.7' : undefined}>
                      {d.unpaidAmount > 0 ? formatMoney(d.unpaidAmount, d.currency) : '—'}
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light" color={STATUS_COLORS[d.status] ?? 'gray'}>
                        {STATUS_LABELS[d.status] ?? d.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td ta="center" ff="monospace" fz="xs">{d.linesCount || '—'}</Table.Td>
                    <Table.Td ta="center">
                      {d.batchesCount > 0
                        ? <Text size="xs" ff="monospace">{d.batchesCount}</Text>
                        : <Text size="xs" c="dimmed">нет</Text>}
                    </Table.Td>
                  </Table.Tr>
                ))}
                {rows.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={9}>
                      <Text size="sm" c="dimmed" ta="center" py="lg">Ничего не найдено</Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Box>
        )}
        {pages > 1 && (
          <Group justify="center" p="md">
            <Pagination value={page} onChange={setPage} total={pages} size="sm" radius="md" />
          </Group>
        )}
      </Card>
    </Stack>
  );
}

function omit(obj: Record<string, string>, key: string) {
  const { [key]: _, ...rest } = obj;
  return rest;
}
