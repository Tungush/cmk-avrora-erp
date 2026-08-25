import React, { useMemo, useState } from 'react';
import {
  Card, Stack, Group, Text, Table, Badge, Button, Select, NumberInput, TextInput,
  Skeleton, Box, SimpleGrid, Divider, Alert,
} from '@mantine/core';
import { IconTruckDelivery, IconCheck, IconArrowRight, IconSearch, IconLock } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useReceipts, usePostReceipt } from '../../hooks/useWarehouse';
import { useMaterials } from '../../hooks/useCatalog';
import { useAuthStore } from '../../store/auth';
import { formatDate } from '../../utils/formatters';
import { ReceiptRef } from '../../components/ReceiptCard/ReceiptCardProvider';

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
  const { data: receiptsData, isLoading } = useReceipts({ search, pageSize: 50 });
  const receipts = receiptsData?.data ?? [];



  return (
    <Stack gap="md">
      {/* Приход руками здесь не заводится (решение 23.08.2026): сырьё
          приезжает из «Заказа поставщику» 1С вместе с фактической ценой.
          Второй способ создать ту же партию — это расхождение склада с 1С. */}
      <Alert color="gray" variant="light" radius="md" icon={<IconTruckDelivery size={17} />}>
        <Text size="sm">
          Приход не заносится руками — он приезжает из «Заказа поставщику» 1С вместе
          с фактической ценой, и из него сразу рождается партия материала.
        </Text>
      </Alert>

      {/* Журнал приходов */}
      <Card withBorder radius="md" padding={0}>
        <Group justify="space-between" p="md" pb="sm" wrap="wrap" gap="sm">
          <Group gap="xs">
            <Text fw={700} size="sm">Журнал приходов</Text>
            {receiptsData && (
              <Badge variant="light" color="gray" size="sm">
                {receiptsData.meta.total.toLocaleString('ru-RU')}
              </Badge>
            )}
          </Group>
          <TextInput
            placeholder="Материал, поставщик, документ..."
            leftSection={<IconSearch size={15} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="sm"
            w={280}
          />
        </Group>
        <Divider />
        {isLoading ? (
          <Stack gap={4} p="md">
            {[...Array(8)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}
          </Stack>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Дата</Table.Th>
                  <Table.Th>Материал</Table.Th>
                  <Table.Th>Категория</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Количество</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Цена</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Сумма</Table.Th>
                  <Table.Th>Документ</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {receipts.map((r) => {
                  const q = Number(r.qty);
                  const p = Number(r.unitPrice);
                  return (
                    <Table.Tr key={r.id}>
                      <Table.Td ff="monospace" style={{ whiteSpace: 'nowrap' }}>{formatDate(r.movementDate)}</Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace" fw={600} c="brand.7">{r.material?.materialCode ?? '—'}</Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>{r.material?.name ?? '—'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color="gray" size="sm">
                          {CATEGORY_LABELS[r.material?.category ?? ''] ?? r.material?.category ?? '—'}
                        </Badge>
                      </Table.Td>
                      <Table.Td ff="monospace" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {num(q, 3)} {r.material?.unit ?? ''}
                      </Table.Td>
                      <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{p > 0 ? `${num(p)} ₸` : '—'}</Table.Td>
                      <Table.Td ff="monospace" fw={600} style={{ textAlign: 'right' }}>
                        {p > 0 ? `${num(q * p)} ₸` : '—'}
                      </Table.Td>
                      <Table.Td>
                        {r.paymentDocumentId ? (
                          <ReceiptRef id={r.paymentDocumentId} number={r.documentNumber ?? '—'} size="xs" bold={false} />
                        ) : (
                          <Text size="xs" ff="monospace">{r.documentNumber ?? '—'}</Text>
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
          </Box>
        )}
      </Card>
    </Stack>
  );
}
