import React, { useState } from 'react';
import {
  Card, Stack, Text, Table, Skeleton, Box, Group, Button, Modal,
  Select, NumberInput, Progress, Badge, Alert,
} from '@mantine/core';
import { IconPlus, IconInfoCircle, IconCheck, IconTrash } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { useAuthStore } from '../../store/auth';
import { useArticles } from '../../hooks/useCatalog';
import { formatMoney } from '../../utils/formatters';

const num = (n: number, d = 2) => n.toLocaleString('ru-RU', { maximumFractionDigits: d });

/**
 * Минимальные остатки ГП (28.08.2026). API существовал с самого начала,
 * но не был подключён ни к одной странице — норматив вести было негде.
 * Факт считается живым из движений склада ГП, дефицит — в штуках и деньгах.
 */
export function MinStock() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canEdit = hasRole(['planner', 'admin']);

  const [open, setOpen] = useState(false);
  const [articleId, setArticleId] = useState<string | null>(null);
  const [target, setTarget] = useState<number | string>('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<any | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['min-stock'],
    queryFn: () => api.get('/min-stock-levels').then((r) => r.data),
  });
  const { data: articles } = useArticles({ search, pageSize: 30 });

  const save = useMutation({
    mutationFn: (input: { articleId: string; targetQty: number }) =>
      api.patch(`/min-stock-levels/${input.articleId}`, { targetQty: input.targetQty }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['min-stock'] });
      notifications.show({ title: 'Норматив сохранён', message: '', color: 'success', icon: <IconCheck size={16} /> });
      setOpen(false); setEditing(null); setArticleId(null); setTarget('');
    },
    onError: (e: any) => notifications.show({
      title: 'Не сохранено', message: e?.response?.data?.error?.message ?? 'Ошибка', color: 'danger',
    }),
  });

  const remove = useMutation({
    mutationFn: (aid: string) => api.delete(`/min-stock-levels/${aid}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['min-stock'] });
      notifications.show({ title: 'Норматив снят', message: '', color: 'warning' });
    },
  });

  const rows: any[] = Array.isArray(data) ? data : [];
  const totalDeficit = rows.reduce((s, r) => s + (r.deficitValue ?? 0), 0);

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="sm" c="dimmed">
          Дефицит к нормативу:{' '}
          <Text span fw={700} ff="monospace" c={totalDeficit > 0 ? 'danger' : undefined}>
            {formatMoney(totalDeficit)}
          </Text>
        </Text>
        {canEdit && (
          <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => { setEditing(null); setArticleId(null); setTarget(''); setOpen(true); }}>
            Задать норматив
          </Button>
        )}
      </Group>

      {rows.length === 0 && !isLoading && (
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />} radius="md">
          <Text size="sm">
            Нормативов пока нет. Норматив — это «сколько изделий держать на складе
            всегда»: система сверит его с живым остатком ГП и покажет, что пора
            изготавливать в запас.
          </Text>
        </Alert>
      )}

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">{[...Array(5)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}</Stack>
        ) : rows.length > 0 && (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Изделие</Table.Th>
                  <Table.Th ta="right">Норматив</Table.Th>
                  <Table.Th ta="right">На складе</Table.Th>
                  <Table.Th ta="right">Дефицит</Table.Th>
                  <Table.Th w={160}>Готовность</Table.Th>
                  {canEdit && <Table.Th w={90} />}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      <Text size="sm" ff="monospace" fw={600} c="brand.7">{r.article?.articleCode}</Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>{r.article?.name}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">{num(r.targetQty, 2)}</Table.Td>
                    <Table.Td ta="right" ff="monospace">{num(r.actualQty, 2)}</Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {r.deficitQty > 0 ? (
                        <Text span fw={700} c="danger">{num(r.deficitQty, 2)}</Text>
                      ) : (
                        <Badge size="xs" variant="light" color="teal">хватает</Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <Progress
                          value={r.readinessPct}
                          size="sm" radius="xl" style={{ flex: 1 }}
                          color={r.readinessPct >= 100 ? 'teal' : r.readinessPct >= 50 ? 'yellow' : 'red'}
                        />
                        <Text size="xs" ff="monospace" c="dimmed" w={40} ta="right">
                          {num(r.readinessPct, 0)} %
                        </Text>
                      </Group>
                    </Table.Td>
                    {canEdit && (
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          <Button
                            size="compact-xs" variant="subtle"
                            onClick={() => {
                              setEditing(r); setArticleId(r.articleId);
                              setTarget(r.targetQty); setOpen(true);
                            }}
                          >
                            Изменить
                          </Button>
                          <Button
                            size="compact-xs" variant="subtle" color="gray"
                            loading={remove.isPending && remove.variables === r.articleId}
                            onClick={() => remove.mutate(r.articleId)}
                          >
                            <IconTrash size={13} />
                          </Button>
                        </Group>
                      </Table.Td>
                    )}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Card>

      <Modal
        opened={open}
        onClose={() => setOpen(false)}
        title={<Text fw={700}>{editing ? `Норматив: ${editing.article?.articleCode}` : 'Норматив минимального остатка'}</Text>}
        radius="md" centered
      >
        <Stack gap="md">
          {!editing && (
            <Select
              label="Изделие"
              placeholder="код или название…"
              searchable
              data={(articles?.data ?? []).map((a: any) => ({ value: a.id, label: `${a.articleCode} · ${a.name}` }))}
              value={articleId}
              onChange={setArticleId}
              onSearchChange={setSearch}
            />
          )}
          <NumberInput
            label="Держать на складе не меньше, шт"
            value={target}
            onChange={setTarget}
            min={0}
            autoFocus={Boolean(editing)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>Отмена</Button>
            <Button
              loading={save.isPending}
              disabled={!articleId || !(Number(target) >= 0)}
              onClick={() => save.mutate({ articleId: articleId!, targetQty: Number(target) })}
            >
              Сохранить
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
