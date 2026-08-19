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
  const can = useAuthStore((s) => s.can);
  const canReceive = can('write', 'stockMaterial.core');

  const [materialSearch, setMaterialSearch] = useState('');
  const { data: materialsData } = useMaterials({ search: materialSearch, pageSize: 40 });
  const materials: any[] = (materialsData as any)?.data ?? [];

  const [materialId, setMaterialId] = useState<string | null>(null);
  const [qty, setQty] = useState<number | string>('');
  const [price, setPrice] = useState<number | string>('');
  const [supplier, setSupplier] = useState('');
  const [docNumber, setDocNumber] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [lastResult, setLastResult] = useState<any>(null);

  const [search, setSearch] = useState('');
  const { data: receiptsData, isLoading } = useReceipts({ search, pageSize: 50 });
  const receipts = receiptsData?.data ?? [];

  const postReceipt = usePostReceipt();

  const materialOptions = useMemo(
    () => materials.map((m) => ({ value: m.id, label: `${m.materialCode} · ${m.name}` })),
    [materials],
  );
  const selected = materials.find((m) => m.id === materialId);

  const handleSubmit = async () => {
    if (!materialId || !(Number(qty) > 0)) return;
    try {
      const res = await postReceipt.mutateAsync({
        materialId,
        qty: Number(qty),
        unitPrice: Number(price) || 0,
        movementDate: date,
        supplierName: supplier || undefined,
        documentNumber: docNumber || undefined,
      });
      setLastResult(res);
      setQty('');
      setPrice('');
      setDocNumber('');
      notifications.show({
        title: 'Приход занесён',
        message: res.price.changed
          ? `Учётная цена ${num(res.price.before)} → ${num(res.price.after)} ₸ · пересчитано изделий: ${res.affectedArticles}`
          : `Остаток: ${num(res.material.stockQty, 3)} ${res.material.unit}`,
        color: 'success',
        icon: <IconCheck size={16} />,
      });
    } catch (e: any) {
      notifications.show({
        title: 'Ошибка',
        message: e?.response?.data?.error?.message ?? 'Не удалось занести приход',
        color: 'danger',
      });
    }
  };

  return (
    <Stack gap="md">
      {/* Форма прихода */}
      {canReceive ? (
        <Card withBorder radius="md" padding="md">
          <Group gap="xs" mb="sm">
            <IconTruckDelivery size={17} style={{ color: 'var(--brand-6)' }} />
            <Text fw={700} size="sm">Занести приход</Text>
            <Text size="xs" c="dimmed">— обновит учётную цену и себестоимость изделий</Text>
          </Group>

          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
            <Select
              label="Материал"
              placeholder="Код или название..."
              data={materialOptions}
              value={materialId}
              onChange={setMaterialId}
              searchable
              onSearchChange={setMaterialSearch}
              clearable
              nothingFoundMessage="Не найдено в «Базе сырья»"
            />
            <NumberInput
              label={`Количество${selected ? `, ${selected.unit}` : ''}`}
              value={qty}
              onChange={setQty}
              min={0}
              step={0.001}
              decimalScale={3}
              thousandSeparator=" "
            />
            <NumberInput
              label="Цена за единицу"
              value={price}
              onChange={setPrice}
              min={0}
              suffix=" ₸"
              thousandSeparator=" "
            />
            <TextInput label="Поставщик" placeholder="ТОО …" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            <TextInput label="Документ / № заявки" placeholder="21358" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} />
            <TextInput label="Дата прихода" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </SimpleGrid>

          {selected && (
            <Group gap="lg" mt="sm">
              <Text size="xs" c="dimmed">
                Остаток: <Text span fw={600} ff="monospace">{num(Number(selected.stockQty), 3)} {selected.unit}</Text>
              </Text>
              <Text size="xs" c="dimmed">
                Учётная цена: <Text span fw={600} ff="monospace">{num(Number(selected.purchasePrice))} ₸</Text>
              </Text>
              {Number(qty) > 0 && Number(price) > 0 && (
                <Text size="xs" c="dimmed">
                  Сумма прихода: <Text span fw={700} ff="monospace">{num(Number(qty) * Number(price))} ₸</Text>
                </Text>
              )}
            </Group>
          )}

          <Group justify="flex-end" mt="sm">
            <Button
              onClick={handleSubmit}
              disabled={!materialId || !(Number(qty) > 0)}
              loading={postReceipt.isPending}
              leftSection={<IconTruckDelivery size={16} />}
            >
              Занести приход
            </Button>
          </Group>

          {/* Что изменилось после последнего прихода — эффект виден сразу */}
          {lastResult && (
            <Alert mt="md" color={lastResult.price.changed ? 'warning' : 'gray'} radius="md" variant="light">
              <Group gap="lg" wrap="wrap">
                <Text size="sm" fw={600}>{lastResult.material.materialCode} · {lastResult.material.name}</Text>
                {lastResult.price.changed ? (
                  <Group gap={6}>
                    <Text size="sm" ff="monospace" c="dimmed">{num(lastResult.price.before)} ₸</Text>
                    <IconArrowRight size={14} />
                    <Text size="sm" ff="monospace" fw={700}>{num(lastResult.price.after)} ₸</Text>
                    <Text size="xs" c="dimmed">учётная цена (средневзвешенная)</Text>
                  </Group>
                ) : (
                  <Text size="sm" c="dimmed">Учётная цена не изменилась</Text>
                )}
                <Text size="sm">
                  Пересчитано изделий: <Text span fw={700}>{lastResult.affectedArticles}</Text>
                </Text>
              </Group>
            </Alert>
          )}
        </Card>
      ) : (
        <Card withBorder radius="md" padding="md">
          <Group gap="xs">
            <IconLock size={15} style={{ color: 'var(--gray-5)' }} />
            <Text size="sm" c="dimmed">Приход заносит кладовщик сырья или снабжение</Text>
          </Group>
        </Card>
      )}

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
                        <Text size="xs" ff="monospace">{r.documentNumber ?? '—'}</Text>
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
