import React, { useMemo, useState } from 'react';
import {
  Card, Stack, Group, Text, Table, Badge, Button, Select, NumberInput,
  ActionIcon, Skeleton, Box, Tooltip,
} from '@mantine/core';
import { IconPlus, IconTrash, IconCheck, IconLock } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useBom, useMaterials, useAddBomItem, useUpdateBomItem, useRemoveBomItem } from '../../hooks/useCatalog';
import { useAuthStore } from '../../store/auth';
import { formatDate } from '../../utils/formatters';

const num = (n: number, d = 2) => n.toLocaleString('ru-RU', { maximumFractionDigits: d });

/** Строка состава: расход правится инлайн (engineer), удаление — крестиком */
function BomRow({
  item, articleId, canEdit,
}: {
  item: any;
  articleId: string;
  canEdit: boolean;
}) {
  const [qty, setQty] = useState<number | string>(Number(item.qtyPerUnit));
  const update = useUpdateBomItem(articleId);
  const remove = useRemoveBomItem(articleId);

  const price = Number(item.material?.purchasePrice ?? 0);
  const lastPrice = Number(item.material?.lastPurchasePrice ?? 0);
  const q = Number(qty) || 0;
  const dirty = q !== Number(item.qtyPerUnit);

  const save = async () => {
    if (!dirty || q <= 0) return;
    try {
      await update.mutateAsync({ id: item.id, qtyPerUnit: q });
    } catch {
      notifications.show({ title: 'Ошибка', message: 'Не удалось изменить расход', color: 'danger' });
    }
  };

  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm" ff="monospace" fw={600} c="brand.7">{item.material?.materialCode ?? '—'}</Text>
        <Text size="xs" c="dimmed" lineClamp={1}>{item.material?.name ?? '—'}</Text>
      </Table.Td>
      <Table.Td style={{ textAlign: 'right' }}>
        {canEdit ? (
          <NumberInput
            value={qty}
            onChange={setQty}
            onBlur={save}
            min={0}
            step={0.01}
            decimalScale={4}
            size="xs"
            w={100}
            styles={{ input: { textAlign: 'right', fontFamily: 'var(--ff-num)' } }}
            rightSection={dirty ? <IconCheck size={12} style={{ color: 'var(--ok-6)' }} /> : undefined}
          />
        ) : (
          <Text size="sm" ff="monospace">{num(Number(item.qtyPerUnit), 4)}</Text>
        )}
      </Table.Td>
      <Table.Td><Text size="sm" c="dimmed">{item.material?.unit ?? '—'}</Text></Table.Td>
      <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(price)} ₸</Table.Td>
      <Table.Td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {lastPrice > 0 ? (
          <>
            <Text size="sm" ff="monospace">{num(lastPrice)} ₸</Text>
            {item.material?.lastPurchaseDate && (
              <Text size="xs" c="dimmed">{formatDate(item.material.lastPurchaseDate)}</Text>
            )}
          </>
        ) : (
          <Text size="sm" c="dimmed">—</Text>
        )}
      </Table.Td>
      <Table.Td ff="monospace" fw={600} style={{ textAlign: 'right' }}>{num(q * price)} ₸</Table.Td>
      {canEdit && (
        <Table.Td>
          <Tooltip label="Убрать из состава">
            <ActionIcon
              variant="subtle"
              color="danger"
              size="sm"
              onClick={() => remove.mutate(item.id)}
              loading={remove.isPending}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
        </Table.Td>
      )}
    </Table.Tr>
  );
}

/**
 * Состав изделия (BOM): из чего собирается ГП и что уйдёт на единицу.
 * Вкладка «Материалы» из макета §3.3 — при выборе изделия видно состав,
 * инженер добавляет позиции и указывает расход; каскад пересчитывает
 * себестоимость точечно.
 */
export function BomPanel({ articleId }: { articleId: string }) {
  const can = useAuthStore((s) => s.can);
  const canEdit = can('write', 'bom.core');

  const { data: bom, isLoading } = useBom(articleId);
  const [materialSearch, setMaterialSearch] = useState('');
  const { data: materialsData } = useMaterials({ search: materialSearch, pageSize: 40 });
  const addItem = useAddBomItem(articleId);

  const [newMaterialId, setNewMaterialId] = useState<string | null>(null);
  const [newQty, setNewQty] = useState<number | string>('');
  const [newOp, setNewOp] = useState<string>('WELDING_ASSEMBLY');

  const materials: any[] = (materialsData as any)?.data ?? [];
  const materialOptions = useMemo(
    () => materials.map((m) => ({ value: m.id, label: `${m.materialCode} · ${m.name}` })),
    [materials],
  );

  const items: any[] = bom ?? [];
  const total = items.reduce(
    (s, i) => s + Number(i.qtyPerUnit) * Number(i.material?.purchasePrice ?? 0),
    0,
  );

  const handleAdd = async () => {
    if (!newMaterialId || !(Number(newQty) > 0)) return;
    try {
      await addItem.mutateAsync({ materialId: newMaterialId, qtyPerUnit: Number(newQty), operationType: newOp });
      setNewMaterialId(null);
      setNewQty('');
      notifications.show({ title: 'Позиция добавлена', message: 'Себестоимость пересчитана', color: 'success', icon: <IconCheck size={16} /> });
    } catch (e: any) {
      notifications.show({
        title: 'Ошибка',
        message: e?.response?.data?.error?.message ?? 'Не удалось добавить позицию',
        color: 'danger',
      });
    }
  };

  if (isLoading) return <Skeleton height={280} radius="md" />;

  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
        <Group gap="xs">
          <Text fw={700} size="sm">Состав изделия</Text>
          <Badge variant="light" color="gray" size="sm">{items.length} позиций</Badge>
        </Group>
        <Group gap="xs">
          <Text size="sm" ff="monospace" fw={700}>Материалы: {num(total)} ₸/ед.</Text>
          <Tooltip label="Учётная цена — средневзвешенная по приходам со склада. Занести закуп: Склад → Приход материалов" multiline w={260}>
            <Text size="xs" c="dimmed" style={{ cursor: 'help' }}>ⓘ</Text>
          </Tooltip>
        </Group>
      </Group>

      {items.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          Состав не заполнен — себестоимость материалов считается нулевой.
          {canEdit ? ' Добавьте позиции ниже.' : ''}
        </Text>
      ) : (
        <Box style={{ overflowX: 'auto' }}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Материал</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Расход на ед.</Table.Th>
                <Table.Th>Ед.</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Учётная цена</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Последний закуп</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Стоимость</Table.Th>
                {canEdit && <Table.Th w={40} />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((item) => (
                <BomRow key={item.id} item={item} articleId={articleId} canEdit={canEdit} />
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      )}

      {canEdit ? (
        <Group align="flex-end" gap="sm" mt="md" wrap="wrap">
          <Select
            label="Материал"
            placeholder="Код или название..."
            data={materialOptions}
            value={newMaterialId}
            onChange={setNewMaterialId}
            searchable
            onSearchChange={setMaterialSearch}
            clearable
            style={{ flex: 1, minWidth: 260 }}
            size="sm"
            nothingFoundMessage="Материал не найден в «Базе сырья»"
          />
          <NumberInput
            label="Расход на ед."
            value={newQty}
            onChange={setNewQty}
            min={0}
            step={0.01}
            decimalScale={4}
            w={130}
            size="sm"
          />
          <Button
            size="sm"
            leftSection={<IconPlus size={15} />}
            onClick={handleAdd}
            disabled={!newMaterialId || !(Number(newQty) > 0)}
            loading={addItem.isPending}
          >
            Добавить
          </Button>
        </Group>
      ) : (
        <Group gap="xs" mt="sm">
          <IconLock size={13} style={{ color: 'var(--gray-5)' }} />
          <Text size="xs" c="dimmed">Состав меняет инженер (право bom:write)</Text>
        </Group>
      )}
    </Card>
  );
}
