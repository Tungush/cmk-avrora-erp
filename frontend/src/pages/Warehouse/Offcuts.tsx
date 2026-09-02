import React, { useState } from 'react';
import {
  Card, Stack, Text, Table, Skeleton, Box, Group, Button, Modal,
  Select, NumberInput, TextInput, Badge, ActionIcon, Tooltip,
} from '@mantine/core';
import { IconPlus, IconCheck, IconSearch, IconTrash, IconPencil } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { useAuthStore } from '../../store/auth';
import { useMaterials } from '../../hooks/useCatalog';
import { formatDate } from '../../utils/formatters';

const num = (n: number, d = 1) => n.toLocaleString('ru-RU', { maximumFractionDigits: d });

interface OffcutRow {
  id: string;
  lengthMm: string;
  widthMm: string | null;
  qty: string;
  note: string | null;
  updatedAt: string;
  material: { id: string; materialCode: string; name: string; unit: string; category: string };
}

/**
 * Обрезки — деловой отход (запрос бизнеса 31.08.2026). «Круг ф12, длина
 * заготовки и количество в штуках» — обрезки бывают разных длин с разным
 * количеством, поэтому каждая длина — своя строка. Кладовщик ведёт
 * список руками: что забрали — минус, что появилось — новая строка.
 */
export function Offcuts() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canEdit = hasRole(['warehouse_material', 'shop_foreman', 'admin']);

  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<OffcutRow | null>(null);
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [matSearch, setMatSearch] = useState('');
  const [lengthMm, setLengthMm] = useState<number | string>('');
  const [widthMm, setWidthMm] = useState<number | string>('');
  const [qty, setQty] = useState<number | string>('');
  const [note, setNote] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['offcuts', search],
    queryFn: () => api.get('/warehouse/offcuts', { params: { search } }).then((r) => r.data),
  });
  const { data: materials } = useMaterials({ search: matSearch, pageSize: 30 });

  const fail = (e: any) => notifications.show({
    title: 'Не сохранено',
    message: e?.response?.data?.error?.message ?? 'Ошибка',
    color: 'danger',
  });
  const done = (title: string) => {
    qc.invalidateQueries({ queryKey: ['offcuts'] });
    notifications.show({ title, message: '', color: 'success', icon: <IconCheck size={16} /> });
    setModalOpen(false); setEditing(null);
    setMaterialId(null); setLengthMm(''); setWidthMm(''); setQty(''); setNote('');
  };

  const create = useMutation({
    mutationFn: () => api.post('/warehouse/offcuts', {
      materialId, lengthMm: Number(lengthMm),
      widthMm: Number(widthMm) > 0 ? Number(widthMm) : null,
      qty: Number(qty), note: note || undefined,
    }).then((r) => r.data),
    onSuccess: () => done('Обрезок записан'),
    onError: fail,
  });
  const update = useMutation({
    mutationFn: () => api.patch(`/warehouse/offcuts/${editing!.id}`, {
      qty: Number(qty), note,
    }).then((r) => r.data),
    onSuccess: (res: any) => done(res.deleted ? 'Строка убрана — обрезков не осталось' : 'Количество обновлено'),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/warehouse/offcuts/${id}`).then((r) => r.data),
    onSuccess: () => done('Строка убрана'),
    onError: fail,
  });

  const rows: OffcutRow[] = data?.data ?? [];

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <TextInput
          placeholder="Код или наименование материала…"
          leftSection={<IconSearch size={15} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          w={280}
          size="sm"
        />
        {canEdit && (
          <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => setModalOpen(true)}>
            Записать обрезок
          </Button>
        )}
      </Group>

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">{[...Array(6)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}</Stack>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Материал</Table.Th>
                  <Table.Th ta="right">Длина, мм</Table.Th>
                  <Table.Th ta="right">Ширина, мм</Table.Th>
                  <Table.Th ta="right">Штук</Table.Th>
                  <Table.Th>Заметка</Table.Th>
                  <Table.Th>Обновлено</Table.Th>
                  {canEdit && <Table.Th w={90} />}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      <Text size="sm" ff="monospace" fw={600} c="brand.7">{r.material.materialCode}</Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>{r.material.name}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={700}>{num(Number(r.lengthMm))}</Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {r.widthMm ? num(Number(r.widthMm)) : <Text span c="dimmed">—</Text>}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={700}>{num(Number(r.qty), 0)}</Table.Td>
                    <Table.Td><Text size="xs" c="dimmed" lineClamp={1}>{r.note ?? '—'}</Text></Table.Td>
                    <Table.Td ff="monospace" fz="xs">{formatDate(r.updatedAt)}</Table.Td>
                    {canEdit && (
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          <Tooltip label="Изменить количество">
                            <ActionIcon variant="subtle" size="sm"
                              onClick={() => { setEditing(r); setQty(Number(r.qty)); setNote(r.note ?? ''); }}>
                              <IconPencil size={14} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Убрать строку">
                            <ActionIcon variant="subtle" color="danger" size="sm" onClick={() => remove.mutate(r.id)}>
                              <IconTrash size={14} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Table.Td>
                    )}
                  </Table.Tr>
                ))}
                {rows.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={canEdit ? 7 : 6}>
                      <Text size="sm" c="dimmed" ta="center" py="lg">
                        Обрезков не записано — кладовщик добавляет их кнопкой сверху
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Card>
      <Text size="xs" c="dimmed">
        Каждая длина — отдельная строка: обрезки разных длин с разным количеством.
        Ноль штук убирает строку.
      </Text>

      {/* Новый обрезок */}
      <Modal opened={modalOpen} onClose={() => setModalOpen(false)}
        title={<Text fw={700}>Записать обрезок</Text>} radius="md" centered>
        <Stack gap="md">
          <Select
            label="Материал"
            placeholder="код или название из склада сырья…"
            searchable
            data={((materials as any)?.data ?? []).map((m: any) => ({
              value: m.id, label: `${m.materialCode} · ${m.name}`,
            }))}
            value={materialId}
            onChange={setMaterialId}
            onSearchChange={setMatSearch}
          />
          <Group grow>
            <NumberInput label="Длина, мм" value={lengthMm} onChange={setLengthMm} min={1} />
            <NumberInput label="Ширина, мм" description="для листа; у трубы и круга пусто"
              value={widthMm} onChange={setWidthMm} min={0} />
          </Group>
          <NumberInput label="Количество, шт" value={qty} onChange={setQty} min={1} />
          <TextInput label="Заметка" placeholder="откуда обрезок, состояние…" value={note}
            onChange={(e) => setNote(e.target.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setModalOpen(false)}>Отмена</Button>
            <Button loading={create.isPending}
              disabled={!materialId || !(Number(lengthMm) > 0) || !(Number(qty) > 0)}
              onClick={() => create.mutate()}>
              Записать
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Правка количества */}
      <Modal opened={editing !== null} onClose={() => setEditing(null)}
        title={<Text fw={700}>{editing?.material.name} · {editing && num(Number(editing.lengthMm))} мм</Text>}
        radius="md" centered size="sm">
        {editing && (
          <Stack gap="md">
            <NumberInput
              label="Количество, шт"
              description="ноль — обрезков не осталось, строка уберётся"
              value={qty} onChange={setQty} min={0} autoFocus
            />
            <TextInput label="Заметка" value={note} onChange={(e) => setNote(e.target.value)} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setEditing(null)}>Отмена</Button>
              <Button loading={update.isPending} onClick={() => update.mutate()}>Сохранить</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
