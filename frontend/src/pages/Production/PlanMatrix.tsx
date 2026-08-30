import React, { useState } from 'react';
import {
  Card, Stack, Text, Table, Skeleton, Box, Group, Button, Modal,
  Select, NumberInput, SegmentedControl, Tooltip, Alert,
} from '@mantine/core';
import { IconPlus, IconCheck, IconInfoCircle } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { useAuthStore } from '../../store/auth';
import { useArticles } from '../../hooks/useCatalog';

const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const num = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

interface Cell { plan: number; fact: number; demand: number }
interface Row { article: { id: string; articleCode: string; name: string }; cells: Record<string, Cell> }

/**
 * План производства «изделие × месяц» (28.08.2026). В Excel этот разрез
 * держал 59 137 формул — у нас его не было вовсе, только свод по неделям.
 *
 * Три числа в ячейке: план (решение плановика — единственное, что
 * хранится), факт выпуска (живой, из движений ГП) и потребность заказов
 * (по плану вывоза). Кликом по ячейке плановик правит план.
 */
export function PlanMatrix() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canEdit = hasRole(['planner', 'admin']);

  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(String(currentYear));
  const [editCell, setEditCell] = useState<{ row: Row; month: string } | null>(null);
  const [qty, setQty] = useState<number | string>('');
  const [addOpen, setAddOpen] = useState(false);
  const [newArticle, setNewArticle] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['plan-matrix', year],
    queryFn: () => api.get('/production-plan/matrix', { params: { year } }).then((r) => r.data),
  });
  const { data: articles } = useArticles({ search, pageSize: 30 });

  const save = useMutation({
    mutationFn: (input: { articleId: string; periodKey: string; qty: number }) =>
      api.patch('/production-plan/matrix', input).then((r) => r.data),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['plan-matrix'] });
      notifications.show({
        title: res.cleared ? 'План снят' : 'План сохранён',
        message: `${res.articleCode} · ${res.periodKey}${res.cleared ? '' : ` — ${num(res.qty)}`}`,
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      setEditCell(null); setAddOpen(false); setNewArticle(null); setQty('');
    },
    onError: (e: any) => notifications.show({
      title: 'Не сохранено',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  const rows: Row[] = data?.data ?? [];
  const months: string[] = data?.months ?? [];

  const totals = months.map((m) => rows.reduce(
    (acc, r) => ({
      plan: acc.plan + (r.cells[m]?.plan ?? 0),
      fact: acc.fact + (r.cells[m]?.fact ?? 0),
      demand: acc.demand + (r.cells[m]?.demand ?? 0),
    }),
    { plan: 0, fact: 0, demand: 0 },
  ));

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <SegmentedControl
          value={year}
          onChange={setYear}
          data={[String(currentYear - 1), String(currentYear), String(currentYear + 1)]}
          size="sm"
        />
        {canEdit && (
          <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => setAddOpen(true)}>
            Добавить изделие в план
          </Button>
        )}
      </Group>

      {rows.length === 0 && !isLoading && (
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />} radius="md">
          <Text size="sm">
            План на {year} год пока пуст. Добавьте изделие и проставьте месяцы —
            факт выпуска и потребность заказов подтянутся сами.
          </Text>
        </Alert>
      )}

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">{[...Array(6)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}</Stack>
        ) : rows.length > 0 && (
          <Box style={{ overflowX: 'auto' }}>
            <Table withColumnBorders fz="xs" verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th style={{ minWidth: 180, position: 'sticky', left: 0, background: 'var(--mantine-color-body)', zIndex: 1 }}>
                    Изделие
                  </Table.Th>
                  {months.map((m, i) => (
                    <Table.Th key={m} ta="center" style={{ minWidth: 72 }}>
                      {MONTH_SHORT[i]}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => (
                  <Table.Tr key={r.article.id}>
                    <Table.Td style={{ position: 'sticky', left: 0, background: 'var(--mantine-color-body)', zIndex: 1 }}>
                      <Text size="xs" ff="monospace" fw={700} c="brand.7">{r.article.articleCode}</Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>{r.article.name}</Text>
                    </Table.Td>
                    {months.map((m) => {
                      const c = r.cells[m] ?? { plan: 0, fact: 0, demand: 0 };
                      const empty = !c.plan && !c.fact && !c.demand;
                      const behind = c.plan > 0 && c.fact < c.plan;
                      return (
                        <Table.Td
                          key={m}
                          ta="center"
                          onClick={canEdit ? () => { setEditCell({ row: r, month: m }); setQty(c.plan || ''); } : undefined}
                          style={{
                            cursor: canEdit ? 'pointer' : undefined,
                            background: empty ? undefined
                              : c.plan > 0 && c.fact >= c.plan
                                ? 'light-dark(var(--mantine-color-teal-0), rgba(32,201,151,0.08))'
                                : behind ? 'light-dark(var(--mantine-color-yellow-0), rgba(250,176,5,0.08))'
                                  : undefined,
                          }}
                        >
                          {empty ? (
                            <Text size="xs" c="dimmed">·</Text>
                          ) : (
                            <Tooltip label={`план ${num(c.plan)} · факт ${num(c.fact)} · заказы ${num(c.demand)}`}>
                              <Stack gap={0}>
                                <Text size="xs" ff="monospace" fw={700}>{c.plan ? num(c.plan) : '—'}</Text>
                                <Text size="xs" ff="monospace" c={behind ? 'yellow.8' : 'teal.7'}>
                                  {c.fact ? num(c.fact) : ''}
                                </Text>
                                {c.demand > 0 && (
                                  <Text size="xs" ff="monospace" c="dimmed">з:{num(c.demand)}</Text>
                                )}
                              </Stack>
                            </Tooltip>
                          )}
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                ))}
                <Table.Tr style={{ borderTop: '2px solid var(--mantine-color-default-border)' }}>
                  <Table.Td style={{ position: 'sticky', left: 0, background: 'var(--mantine-color-body)', zIndex: 1 }}>
                    <Text size="xs" fw={700}>Итого</Text>
                  </Table.Td>
                  {totals.map((t, i) => (
                    <Table.Td key={months[i]} ta="center">
                      <Stack gap={0}>
                        <Text size="xs" ff="monospace" fw={700}>{t.plan ? num(t.plan) : '—'}</Text>
                        <Text size="xs" ff="monospace" c="teal.7">{t.fact ? num(t.fact) : ''}</Text>
                      </Stack>
                    </Table.Td>
                  ))}
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Card>
      <Text size="xs" c="dimmed">
        В ячейке: <Text span fw={700}>план</Text> / <Text span c="teal.7">факт выпуска</Text> /
        <Text span c="dimmed"> з: потребность заказов</Text>. Жёлтая заливка — факт отстаёт от плана.
      </Text>

      {/* Правка ячейки */}
      <Modal
        opened={editCell !== null}
        onClose={() => setEditCell(null)}
        title={<Text fw={700}>{editCell?.row.article.articleCode} · {editCell?.month}</Text>}
        radius="md" centered size="sm"
      >
        {editCell && (
          <Stack gap="md">
            <Text size="sm" c="dimmed" lineClamp={2}>{editCell.row.article.name}</Text>
            <NumberInput
              label="План на месяц, шт"
              description="ноль стирает план — пустая клетка честнее нуля"
              value={qty}
              onChange={setQty}
              min={0}
              autoFocus
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setEditCell(null)}>Отмена</Button>
              <Button
                loading={save.isPending}
                onClick={() => save.mutate({
                  articleId: editCell.row.article.id,
                  periodKey: editCell.month,
                  qty: Number(qty) || 0,
                })}
              >
                Сохранить
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      {/* Новое изделие в плане */}
      <Modal opened={addOpen} onClose={() => setAddOpen(false)}
        title={<Text fw={700}>Изделие в план {year}</Text>} radius="md" centered>
        <Stack gap="md">
          <Select
            label="Изделие"
            placeholder="код или название…"
            searchable
            data={(articles?.data ?? []).map((a: any) => ({ value: a.id, label: `${a.articleCode} · ${a.name}` }))}
            value={newArticle}
            onChange={setNewArticle}
            onSearchChange={setSearch}
          />
          <NumberInput label={`План на ${MONTH_SHORT[new Date().getMonth()]}, шт`} value={qty} onChange={setQty} min={0} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setAddOpen(false)}>Отмена</Button>
            <Button
              loading={save.isPending}
              disabled={!newArticle || !(Number(qty) > 0)}
              onClick={() => save.mutate({
                articleId: newArticle!,
                periodKey: `${year}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
                qty: Number(qty),
              })}
            >
              Добавить
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
