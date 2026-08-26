import React, { useState } from 'react';
import {
  Stack, Group, Text, Card, Table, Badge, Skeleton, Button, Checkbox, Alert,
  ActionIcon, ThemeIcon, Divider,
} from '@mantine/core';
import {
  IconSend, IconInfoCircle, IconChevronDown, IconChevronRight, IconPackage,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { Collapse } from '../../components/motion';
import { formatMoney, formatDate } from '../../utils/formatters';

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'накоплено', APPROVED: 'отправлено в Б24', ORDERED: 'заказ создан', REJECTED: 'отклонено',
};
const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'orange', APPROVED: 'blue', ORDERED: 'teal', REJECTED: 'gray',
};

/** Разворачиваем маленькие группы сразу; 43 строки — только по клику */
const AUTO_EXPAND_LIMIT = 8;

interface QueueGroup {
  key: string;
  order: {
    id: string; orderNumber: string;
    plannedShipmentDate: string | null;
    customer?: { name: string } | null;
  } | null;
  note: string | null;
  items: any[];
}

/**
 * Очередь на закуп (26.08.2026). Дефициты из цеха копятся здесь; снабженец
 * выбирает накопленное и отправляет ОДНОЙ сделкой в воронку снабжения Б24 —
 * «сразу большие объёмы, а не из-за одного болта» (решение пользователя).
 *
 * Каждый заказ — своя карточка: выбирают всё равно заказом целиком, поэтому
 * чекбокс стоит в шапке, а состав раскрывается только когда нужен.
 */
export function PurchaseQueue() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Пока пользователь не трогал — маленькие группы открыты сами
  const [expanded, setExpanded] = useState<Map<string, boolean>>(new Map());

  const { data, isLoading } = useQuery({
    queryKey: ['purchase-requests'],
    queryFn: () => api.get('/purchase-requests?pageSize=200').then((r) => r.data),
    refetchInterval: 60_000,
  });

  const send = useMutation({
    mutationFn: (ids: string[]) => api.post('/purchase-requests/send-to-bitrix', { ids }).then((r) => r.data),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['purchase-requests'] });
      setSelected(new Set());
      notifications.show({
        title: 'Заявка ушла в Б24',
        message: `Сделка №${res.dealId}: ${res.sent} позиций на ${formatMoney(res.totalEstimate)}`,
        color: 'success',
      });
    },
    onError: (e: any) => notifications.show({
      title: 'Не отправлено',
      message: e?.response?.data?.error?.message ?? 'Ошибка отправки в Б24',
      color: 'danger',
    }),
  });

  const rows: any[] = data?.data ?? [];
  const drafts = rows.filter((r) => r.status === 'DRAFT');
  const selectedRows = drafts.filter((r) => selected.has(r.id));
  const selectedTotal = selectedRows.reduce(
    (s, r) => s + Number(r.requestedQty) * Number(r.estimatedPrice ?? 0), 0,
  );

  // Группировка по заказу-источнику: 43 строки одного заказа плоским
  // списком нечитаемы, а выбирают их всё равно заказом целиком
  const groups: QueueGroup[] = [];
  const groupIdx = new Map<string, number>();
  for (const r of rows) {
    const key = r.order?.id ?? `note:${r.note ?? '—'}`;
    let i = groupIdx.get(key);
    if (i === undefined) {
      i = groups.length;
      groupIdx.set(key, i);
      groups.push({ key, order: r.order ?? null, note: r.order ? null : (r.note ?? null), items: [] });
    }
    groups[i].items.push(r);
  }

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected((prev) =>
    prev.size === drafts.length ? new Set() : new Set(drafts.map((r) => r.id)));
  const toggleGroup = (items: any[]) => setSelected((prev) => {
    const ids = items.filter((r) => r.status === 'DRAFT').map((r) => r.id);
    const allIn = ids.length > 0 && ids.every((id) => prev.has(id));
    const next = new Set(prev);
    for (const id of ids) { if (allIn) next.delete(id); else next.add(id); }
    return next;
  });
  const isOpen = (g: QueueGroup) =>
    expanded.get(g.key) ?? g.items.length <= AUTO_EXPAND_LIMIT;
  const flip = (g: QueueGroup) => setExpanded((prev) => {
    const next = new Map(prev);
    next.set(g.key, !isOpen(g));
    return next;
  });

  if (isLoading) {
    return (
      <Stack gap="md">
        <Skeleton height={60} radius="md" />
        {[...Array(3)].map((_, i) => <Skeleton key={i} height={72} radius="md" />)}
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      {drafts.length === 0 && (
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
          <Text size="sm">
            Накопленных заявок нет. Дефицит попадает сюда из цеха: на карточке заказа
            «не хватает N позиций» → «В заявку на закуп».
          </Text>
        </Alert>
      )}

      {drafts.length > 0 && (
        <Card withBorder radius="md" padding="md">
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Checkbox
              checked={selected.size === drafts.length && drafts.length > 0}
              indeterminate={selected.size > 0 && selected.size < drafts.length}
              onChange={toggleAll}
              label={
                <Text size="sm">
                  Выбрано <Text span fw={700} ff="monospace">{selected.size}</Text> из {drafts.length} позиций
                  {selected.size > 0 && (
                    <> на <Text span fw={700} ff="monospace">{formatMoney(selectedTotal)}</Text> (оценка)</>
                  )}
                </Text>
              }
            />
            <Button
              leftSection={<IconSend size={16} />}
              disabled={selected.size === 0}
              loading={send.isPending}
              onClick={() => send.mutate([...selected])}
            >
              Отправить в Б24 одной заявкой
            </Button>
          </Group>
        </Card>
      )}

      {groups.map((g) => {
        const gDrafts = g.items.filter((r) => r.status === 'DRAFT');
        const gSelected = gDrafts.filter((r) => selected.has(r.id)).length;
        const gEstimate = g.items.reduce(
          (s, r) => s + Number(r.requestedQty) * Number(r.estimatedPrice ?? 0), 0,
        );
        const noPrice = g.items.filter((r) => !(Number(r.estimatedPrice) > 0)).length;
        const open = isOpen(g);
        const created = g.items[0]?.createdAt;

        return (
          <Card key={g.key} withBorder radius="md" padding={0}>
            {/* Шапка заказа: чекбокс берёт заказ целиком, состав — по клику */}
            <Group
              justify="space-between"
              wrap="nowrap"
              gap="sm"
              px="md"
              py="sm"
              onClick={() => flip(g)}
              style={{ cursor: 'pointer' }}
            >
              <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                {gDrafts.length > 0 ? (
                  <Checkbox
                    checked={gSelected === gDrafts.length && gDrafts.length > 0}
                    indeterminate={gSelected > 0 && gSelected < gDrafts.length}
                    onChange={() => toggleGroup(g.items)}
                    onClick={(e) => e.stopPropagation()}
                    size="md"
                  />
                ) : (
                  <ThemeIcon variant="light" color="gray" radius="xl" size="md">
                    <IconPackage size={14} />
                  </ThemeIcon>
                )}
                <div style={{ minWidth: 0 }} onClick={(e) => e.stopPropagation()}>
                  {g.order
                    ? <OrderRef id={g.order.id} number={g.order.orderNumber} size="sm" />
                    : <Text size="sm" fw={700}>{g.note ?? 'Без заказа'}</Text>}
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {g.order?.customer?.name ?? (g.order ? '—' : 'ручные заявки')}
                    {g.order?.plannedShipmentDate && ` · вывоз ${formatDate(g.order.plannedShipmentDate)}`}
                  </Text>
                </div>
              </Group>

              <Group gap="md" wrap="nowrap">
                {gSelected > 0 && (
                  <Badge variant="filled" radius="xl" size="sm">
                    выбрано {gSelected}
                  </Badge>
                )}
                <div style={{ textAlign: 'right' }}>
                  <Text size="sm" fw={700} ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                    {gEstimate > 0 ? formatMoney(gEstimate) : '—'}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                    {g.items.length} поз.
                    {gDrafts.length > 0 && gDrafts.length < g.items.length
                      ? ` · накоплено ${gDrafts.length}` : ''}
                    {created ? ` · ${formatDate(created)}` : ''}
                  </Text>
                </div>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  component="div"
                  aria-label={open ? 'Свернуть' : 'Развернуть'}
                >
                  {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
                </ActionIcon>
              </Group>
            </Group>

            <Collapse opened={open}>
              <Divider />
              <Table highlightOnHover verticalSpacing={6} fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={40} />
                    <Table.Th>Материал</Table.Th>
                    <Table.Th ta="right">Нужно</Table.Th>
                    <Table.Th ta="right">Оценка</Table.Th>
                    <Table.Th w={140}>Статус</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {g.items.map((r) => (
                    <Table.Tr key={r.id}>
                      <Table.Td>
                        {r.status === 'DRAFT' && (
                          <Checkbox checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace" fw={600} c="brand.7">{r.material?.materialCode}</Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>{r.material?.name}</Text>
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                        {Number(r.requestedQty).toLocaleString('ru-RU')} {r.unit ?? r.material?.unit ?? ''}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                        {r.estimatedPrice
                          ? formatMoney(Number(r.requestedQty) * Number(r.estimatedPrice))
                          : '—'}
                      </Table.Td>
                      <Table.Td>
                        <Badge size="xs" variant="light" color={STATUS_COLORS[r.status] ?? 'gray'}>
                          {STATUS_LABELS[r.status] ?? r.status}
                        </Badge>
                        {r.bitrixDealId && (
                          <Text size="xs" c="dimmed" ff="monospace">Б24 №{r.bitrixDealId}</Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              {noPrice > 0 && (
                <Group gap={6} px="md" py={8} wrap="nowrap">
                  <IconAlertTriangle size={13} style={{ color: 'var(--mantine-color-orange-6)', flexShrink: 0 }} />
                  <Text size="xs" c="dimmed">
                    У {noPrice} позиций нет закупочной цены — оценка заказа занижена
                  </Text>
                </Group>
              )}
            </Collapse>
          </Card>
        );
      })}
    </Stack>
  );
}
