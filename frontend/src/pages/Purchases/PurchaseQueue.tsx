import React, { useState } from 'react';
import {
  Stack, Group, Text, Card, Table, Badge, Skeleton, Box, Button, Checkbox, Alert,
} from '@mantine/core';
import { IconSend, IconInfoCircle } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { formatMoney, formatDate } from '../../utils/formatters';

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'накоплено', APPROVED: 'отправлено в Б24', ORDERED: 'заказ создан', REJECTED: 'отклонено',
};
const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'orange', APPROVED: 'blue', ORDERED: 'teal', REJECTED: 'gray',
};

/**
 * Очередь на закуп (26.08.2026). Дефициты из цеха копятся здесь; снабженец
 * выбирает накопленное и отправляет ОДНОЙ сделкой в воронку снабжения Б24 —
 * «сразу большие объёмы, а не из-за одного болта» (решение пользователя).
 */
export function PurchaseQueue() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected((prev) =>
    prev.size === drafts.length ? new Set() : new Set(drafts.map((r) => r.id)));

  return (
    <Stack gap="md">
      {drafts.length === 0 && !isLoading && (
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
            <Text size="sm">
              Выбрано <Text span fw={700} ff="monospace">{selected.size}</Text> из {drafts.length} позиций
              {selected.size > 0 && (
                <> на <Text span fw={700} ff="monospace">{formatMoney(selectedTotal)}</Text> (оценка)</>
              )}
            </Text>
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

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">
            {[...Array(6)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}
          </Stack>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40}>
                    {drafts.length > 0 && (
                      <Checkbox
                        checked={selected.size === drafts.length && drafts.length > 0}
                        indeterminate={selected.size > 0 && selected.size < drafts.length}
                        onChange={toggleAll}
                      />
                    )}
                  </Table.Th>
                  <Table.Th>Материал</Table.Th>
                  <Table.Th ta="right">Нужно</Table.Th>
                  <Table.Th ta="right">Оценка</Table.Th>
                  <Table.Th>Источник</Table.Th>
                  <Table.Th>Статус</Table.Th>
                  <Table.Th>Создана</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => (
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
                    <Table.Td ta="right" ff="monospace">
                      {r.estimatedPrice
                        ? formatMoney(Number(r.requestedQty) * Number(r.estimatedPrice))
                        : '—'}
                    </Table.Td>
                    <Table.Td>
                      {r.order
                        ? <OrderRef id={r.order.id} number={r.order.orderNumber} size="xs" bold={false} />
                        : <Text size="xs" c="dimmed">{r.note ?? '—'}</Text>}
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light" color={STATUS_COLORS[r.status] ?? 'gray'}>
                        {STATUS_LABELS[r.status] ?? r.status}
                      </Badge>
                      {r.bitrixDealId && (
                        <Text size="xs" c="dimmed" ff="monospace">Б24 №{r.bitrixDealId}</Text>
                      )}
                    </Table.Td>
                    <Table.Td ff="monospace" fz="xs" style={{ whiteSpace: 'nowrap' }}>
                      {formatDate(r.createdAt)}
                    </Table.Td>
                  </Table.Tr>
                ))}
                {rows.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={7}>
                      <Text size="sm" c="dimmed" ta="center" py="lg">Заявок нет</Text>
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
