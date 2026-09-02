import React, { useState } from 'react';
import {
  Card, Stack, Text, Table, Skeleton, Group, Button, Modal,
  Select, NumberInput, Progress, Badge, Alert,
} from '@mantine/core';
import { IconPlus, IconInfoCircle, IconCheck, IconTrash } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { useAuthStore } from '../../store/auth';
import { useArticles } from '../../hooks/useCatalog';
import { formatMoney } from '../../utils/formatters';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePagedList, usePageSize } from '../../components/PaginationBar';
import { FadeSwap } from '../../components/motion';

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
  const deficitCount = rows.filter((r) => r.deficitQty > 0).length;

  // Список приходит целиком — страницы режем на клиенте
  const [pageSize, setPageSize] = usePageSize('warehouse-minstock', 50);
  const paged = usePagedList(rows, pageSize);

  return (
    <Stack gap="md">
      <div className="toolbar-sticky">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="lg" wrap="wrap">
            <Text size="sm" c="dimmed">
              Дефицит к нормативу:{' '}
              <Text span fw={700} ff="monospace" c={totalDeficit > 0 ? 'danger' : 'var(--gray-9)'}>
                {formatMoney(totalDeficit)}
              </Text>
            </Text>
            <Text size="sm" c="dimmed">
              Нормативов:{' '}
              <Text span fw={700} ff="monospace" c="var(--gray-9)">{rows.length.toLocaleString('ru-RU')}</Text>
              {deficitCount > 0 && (
                <>
                  , в дефиците{' '}
                  <Text span fw={700} ff="monospace" c="danger">{deficitCount}</Text>
                </>
              )}
            </Text>
          </Group>
          {canEdit && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => { setEditing(null); setArticleId(null); setTarget(''); setOpen(true); }}>
              Задать норматив
            </Button>
          )}
        </Group>
      </div>

      {rows.length === 0 && !isLoading && (
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />} radius="md">
          <Text size="sm">
            Нормативов пока нет. Норматив — это «сколько изделий держать на складе
            всегда»: система сверит его с живым остатком ГП и покажет, что пора
            изготавливать в запас.
          </Text>
        </Alert>
      )}

      {(isLoading || rows.length > 0) && (
        <FadeSwap swapKey={`${paged.page}-${pageSize}`}>
          <Card withBorder radius="md" padding={0}>
            {isLoading ? (
              <Stack gap={6} p="md">{[...Array(5)].map((_, i) => <Skeleton key={i} height={40} radius="sm" />)}</Stack>
            ) : (
              <TableScroll minWidth={canEdit ? 880 : 760}>
                <Table highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Изделие</Table.Th>
                      <Table.Th ta="right">Норматив</Table.Th>
                      <Table.Th ta="right">На складе</Table.Th>
                      <Table.Th ta="right">Дефицит</Table.Th>
                      <Table.Th w={180} data-priority="2">Готовность</Table.Th>
                      {canEdit && <Table.Th w={150} />}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {paged.slice.map((r) => (
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
                            <Badge size="sm" variant="light" color="teal">хватает</Badge>
                          )}
                        </Table.Td>
                        <Table.Td data-priority="2">
                          <Group gap={8} wrap="nowrap">
                            <Progress
                              value={r.readinessPct}
                              size="md" radius="xl" style={{ flex: 1, minWidth: 80 }}
                              color={r.readinessPct >= 100 ? 'teal' : r.readinessPct >= 50 ? 'yellow' : 'red'}
                            />
                            <Text size="xs" ff="monospace" c="dimmed" w={44} ta="right">
                              {num(r.readinessPct, 0)} %
                            </Text>
                          </Group>
                        </Table.Td>
                        {canEdit && (
                          <Table.Td>
                            <Group gap={4} wrap="nowrap">
                              <Button
                                size="compact-sm" variant="subtle"
                                onClick={() => {
                                  setEditing(r); setArticleId(r.articleId);
                                  setTarget(r.targetQty); setOpen(true);
                                }}
                              >
                                Изменить
                              </Button>
                              <Button
                                size="compact-sm" variant="subtle" color="gray"
                                aria-label="Снять норматив"
                                loading={remove.isPending && remove.variables === r.articleId}
                                onClick={() => remove.mutate(r.articleId)}
                              >
                                <IconTrash size={15} />
                              </Button>
                            </Group>
                          </Table.Td>
                        )}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </TableScroll>
            )}
          </Card>
        </FadeSwap>
      )}

      {rows.length > 0 && (
        <PaginationBar
          page={paged.page}
          total={paged.total}
          pageSize={pageSize}
          onPageChange={paged.setPage}
          onPageSizeChange={setPageSize}
          noun="нормативов"
          sticky
        />
      )}

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
