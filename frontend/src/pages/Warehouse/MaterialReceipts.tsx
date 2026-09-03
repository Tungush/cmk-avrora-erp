import React, { useState } from 'react';
import {
  Card, Stack, Group, Text, Table, Badge, TextInput, Skeleton, Alert,
} from '@mantine/core';
import { IconTruckDelivery, IconSearch } from '@tabler/icons-react';
import { useReceipts } from '../../hooks/useWarehouse';
import { formatDate } from '../../utils/formatters';
import { ReceiptRef } from '../../components/ReceiptCard/ReceiptCardProvider';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePageSize } from '../../components/PaginationBar';
import { FadeSwap } from '../../components/motion';

const num = (n: number, d = 2) => n.toLocaleString('ru-RU', { maximumFractionDigits: d });

const CATEGORY_LABELS: Record<string, string> = {
  METAL: 'Металл',
  HARDWARE: 'Метизы',
  COMPONENTS: 'Комплектующие',
  CONSUMABLES: 'Расходники',
  INSTRUMENTS: 'Инструменты',
};

/**
 * Приход материалов: «занесли то, что купили».
 * Учётная цена пересчитывается как средневзвешенная по остатку, и сразу
 * каскадом уходит в себестоимость всех изделий, где материал используется —
 * то, чего в Excel не было: там цену правили вручную и связь терялась.
 */
export function MaterialReceipts() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize('warehouse-receipts', 50);
  const { data: receiptsData, isLoading } = useReceipts({ search, page, pageSize });
  const receipts = receiptsData?.data ?? [];
  const total = receiptsData?.meta?.total ?? receipts.length;

  return (
    <Stack gap="md">
      {/* Приход руками здесь не заводится (решение 23.08.2026): сырьё
          приезжает из «Заказа поставщику» 1С вместе с фактической ценой.
          Второй способ создать ту же партию — это расхождение склада с 1С. */}
      <Alert color="gray" variant="light" radius="md" icon={<IconTruckDelivery aria-hidden size={16} />}>
        <Text size="sm">
          Приход не заносится руками — он приезжает из «Заказа поставщику» 1С вместе
          с фактической ценой, и из него сразу рождается партия материала.
        </Text>
      </Alert>

      <div className="toolbar-sticky">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <TextInput
            placeholder="Материал, поставщик, документ…"
            leftSection={<IconSearch aria-hidden size={16} />}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            w={320}
          />
          <Group gap="xs">
            <Text fw={700} size="sm">Журнал приходов</Text>
            <Badge variant="light" color="gray" size="md">
              {total.toLocaleString('ru-RU')}
            </Badge>
          </Group>
        </Group>
      </div>

      {/* Журнал приходов */}
      <FadeSwap swapKey={`${page}-${pageSize}`}>
        <Card withBorder radius="md" padding={0}>
          {isLoading ? (
            <Stack gap={6} p="md">
              {[...Array(8)].map((_, i) => <Skeleton key={i} height={40} radius="sm" />)}
            </Stack>
          ) : (
            <TableScroll minWidth={980}>
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Материал</Table.Th>
                    <Table.Th>Дата</Table.Th>
                    <Table.Th data-priority="3">Категория</Table.Th>
                    <Table.Th ta="right">Количество</Table.Th>
                    <Table.Th ta="right" data-priority="2">Цена</Table.Th>
                    <Table.Th ta="right">Сумма</Table.Th>
                    <Table.Th>Документ</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {receipts.map((r) => {
                    const q = Number(r.qty);
                    const p = Number(r.unitPrice);
                    return (
                      <Table.Tr key={r.id}>
                        <Table.Td>
                          <Text size="sm" ff="monospace" fw={600} c="brand.7">{r.material?.materialCode ?? '—'}</Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>{r.material?.name ?? '—'}</Text>
                        </Table.Td>
                        <Table.Td ff="monospace">{formatDate(r.movementDate)}</Table.Td>
                        <Table.Td data-priority="3">
                          <Badge variant="light" color="gray" size="sm">
                            {CATEGORY_LABELS[r.material?.category ?? ''] ?? r.material?.category ?? '—'}
                          </Badge>
                        </Table.Td>
                        <Table.Td ff="monospace" ta="right">
                          {num(q, 3)} {r.material?.unit ?? ''}
                        </Table.Td>
                        <Table.Td ff="monospace" ta="right" data-priority="2">{p > 0 ? `${num(p)} ₸` : '—'}</Table.Td>
                        <Table.Td ff="monospace" fw={600} ta="right">
                          {p > 0 ? `${num(q * p)} ₸` : '—'}
                        </Table.Td>
                        <Table.Td>
                          {r.paymentDocumentId ? (
                            <ReceiptRef id={r.paymentDocumentId} number={r.documentNumber ?? '—'} size="sm" bold={false} />
                          ) : (
                            <Text size="sm" ff="monospace">{r.documentNumber ?? '—'}</Text>
                          )}
                          {r.supplierName && <Text size="xs" c="dimmed" lineClamp={1}>{r.supplierName}</Text>}
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                  {receipts.length === 0 && (
                    <Table.Tr>
                      <Table.Td colSpan={7}>
                        <Text size="sm" c="dimmed" ta="center" py="lg">Приходов нет</Text>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Table.Tbody>
              </Table>
            </TableScroll>
          )}
        </Card>
      </FadeSwap>

      <PaginationBar
        page={page}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        noun="приходов"
        sticky
      />
    </Stack>
  );
}
