import React, { useEffect, useState } from 'react';
import {
  Stack, Group, Text, Card, Table, Badge, Skeleton, TextInput,
  Select, Switch,
} from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useDebouncedValue } from '@mantine/hooks';
import { purchasesApi } from '../../api/purchases';
import { ReceiptRef } from '../../components/ReceiptCard/ReceiptCardProvider';
import { Ref } from '../../components/EntityRef';
import { formatMoney, formatDate } from '../../utils/formatters';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePageSize } from '../../components/PaginationBar';
import { FadeSwap } from '../../components/motion';
import { EmptyState } from '../../components/EmptyState';

const STATUS_LABELS: Record<string, string> = {
  UNPAID: 'Не оплачен', PARTIALLY_PAID: 'Частично', PAID: 'Оплачен', EXECUTED: 'Исполнен',
};
/* Кирпичный — только на то, что требует решения (04.09.2026).
   Замер на этом экране: тревожный цвет стоял на 46 элементах — колонка
   «Остаток» и бейдж «Не оплачен». Но неоплаченных документов 306 из
   306: это обычное состояние закупа, а не тревога. Когда тревожным
   цветом помечено всё, он перестаёт быть тревогой и просто давит.
   Статус читается подписью, она и так есть. */
const STATUS_COLORS: Record<string, string> = {
  UNPAID: 'gray', PARTIALLY_PAID: 'warning', PAID: 'success', EXECUTED: 'gray',
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
  const [pageSize, setPageSize] = usePageSize('purchases-registry', 25);
  useEffect(() => { setPage(1); }, [pageSize]);

  const { data, isLoading } = useQuery({
    queryKey: ['purchases-docs', debounced, filters, page, pageSize],
    queryFn: () => purchasesApi.documents({
      search: debounced, page, pageSize, ...filters,
    }).then((r) => r.data),
  });

  const rows = data?.data ?? [];
  const total = data?.meta?.total ?? 0;
  const activeFilters = Object.keys(filters).length;

  return (
    <Stack gap="md">
      <div className="toolbar-sticky">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="sm" wrap="wrap">
            <TextInput
              placeholder="№ ДО, поставщик, номер поставщика..."
              leftSection={<IconSearch aria-hidden size={16} />}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              w={320}
              style={{ maxWidth: '100%' }}
            />
            <Select
              placeholder="Направление"
              data={['ЦМК Телекоммуникации', 'ЦМК Другие']}
              value={filters.direction ?? null}
              onChange={(v) => { onFiltersChange(v ? { ...filters, direction: v } : omit(filters, 'direction')); setPage(1); }}
              clearable w={220}
            />
            <Switch
              size="md" label="Только неоплаченные"
              checked={filters.unpaidOnly === '1'}
              onChange={(e) => { onFiltersChange(e.currentTarget.checked ? { ...filters, unpaidOnly: '1' } : omit(filters, 'unpaidOnly')); setPage(1); }}
            />
            <Switch
              size="md" label="Без прихода"
              checked={filters.hasBatches === '0'}
              onChange={(e) => { onFiltersChange(e.currentTarget.checked ? { ...filters, hasBatches: '0' } : omit(filters, 'hasBatches')); setPage(1); }}
            />
          </Group>
          <Group gap="sm">
            {activeFilters > 0 && (
              <Text
                size="sm" fw={600} style={{ cursor: 'pointer' }}
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
      </div>

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">
            {[...Array(10)].map((_, i) => <Skeleton key={i} height={40} radius="sm" />)}
          </Stack>
        ) : (
          <FadeSwap swapKey={page}>
            <TableScroll minWidth={1040}>
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>№ ДО</Table.Th>
                    <Table.Th>Дата</Table.Th>
                    <Table.Th>Поставщик</Table.Th>
                    <Table.Th data-priority="2">Направление</Table.Th>
                    <Table.Th ta="right">Сумма</Table.Th>
                    <Table.Th ta="right">Остаток</Table.Th>
                    <Table.Th>Статус</Table.Th>
                    <Table.Th ta="center" data-priority="3">Строк</Table.Th>
                    <Table.Th ta="center">Приход</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((d) => (
                    <Table.Tr key={d.id}>
                      <Table.Td><ReceiptRef id={d.id} number={d.doNumber} size="sm" /></Table.Td>
                      <Table.Td ff="monospace" style={{ whiteSpace: 'nowrap' }}>{formatDate(d.doDate)}</Table.Td>
                      <Table.Td>
                        <Text size="sm" lineClamp={1}>
                          <Ref kind="supplier" id={d.supplierId ?? d.supplier} label={d.supplier} tone="text" size="sm">
                            {d.supplier}
                          </Ref>
                        </Text>
                        {/* Направление дублируем подстрокой: на ноутбуке колонка спрятана */}
                        {d.businessDirection && (
                          <Text size="xs" c="dimmed" lineClamp={1} hiddenFrom="lg">{d.businessDirection}</Text>
                        )}
                      </Table.Td>
                      <Table.Td data-priority="2">
                        <Text size="sm" c="dimmed" lineClamp={1}>{d.businessDirection ?? '—'}</Text>
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" fw={600} style={{ whiteSpace: 'nowrap' }}>{formatMoney(d.totalAmount, d.currency)}</Table.Td>
                      <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                        {d.unpaidAmount > 0 ? formatMoney(d.unpaidAmount, d.currency) : '—'}
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={STATUS_COLORS[d.status] ?? 'gray'}>
                          {STATUS_LABELS[d.status] ?? d.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td ta="center" ff="monospace" data-priority="3">{d.linesCount || '—'}</Table.Td>
                      <Table.Td ta="center">
                        {d.batchesCount > 0
                          ? <Text size="sm" ff="monospace">{d.batchesCount}</Text>
                          : <Text size="sm" c="dimmed">нет</Text>}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  {rows.length === 0 && (
                    <Table.Tr>
                      <Table.Td colSpan={9}>
                        <EmptyState height={132} title="Закупок по такому запросу нет" />
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
        noun="документов"
        sticky
      />
    </Stack>
  );
}

function omit(obj: Record<string, string>, key: string) {
  const { [key]: _, ...rest } = obj;
  return rest;
}
