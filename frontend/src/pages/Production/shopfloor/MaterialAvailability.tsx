import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Stack, Group, Text, Badge, Skeleton, Button, Modal, Table,
} from '@mantine/core';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import api from '../../../api/client';
import { TableScroll } from '../../../components/TableScroll';

/**
 * Обеспеченность заказа сырьём (26.08.2026). Считается по живым партиям
 * минус чужие резервы; если не хватает — кнопка кладёт дефицит в очередь
 * заявок, откуда снабженец отправляет накопленное в Б24 одной сделкой.
 *
 * Один GET на карточку — поэтому на экране одновременно живёт только
 * текущая страница карточек, а не все 190 заказов разом.
 */
export function MaterialAvailability({ orderId, orderNumber }: { orderId: string; orderNumber: string }) {
  const qc = useQueryClient();
  // Кнопка не шлёт вслепую: сначала карточка «что и сколько закупать»,
  // и только подтверждение кладёт дефицит в очередь (уточнение 26.08.2026)
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['order-availability', orderId],
    queryFn: () => api.get(`/orders/${orderId}/material-availability`).then((r) => r.data),
    staleTime: 60_000,
  });
  const toQueue = useMutation({
    mutationFn: () => api.post(`/purchase-requests/from-order/${orderId}`).then((r) => r.data),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['purchase-requests'] });
      setConfirmOpen(false);
      notifications.show({
        title: 'В очереди на закуп',
        message: res.message ?? `Добавлено позиций: ${res.created}, дополнено: ${res.updated}.`
          + ' Снабженец отправит накопленное в Б24 одной заявкой',
        color: 'success',
      });
    },
    onError: (e: any) => notifications.show({
      title: 'Не удалось', message: e?.response?.data?.error?.message ?? 'Ошибка', color: 'danger',
    }),
  });

  if (isLoading) return <Skeleton height={26} width={180} radius="xl" />;
  if (!data || data.checkedMaterials === 0) {
    return <Text size="sm" c="dimmed">состав изделий не заведён</Text>;
  }
  if (data.ok) {
    return (
      <Badge size="lg" color="teal" variant="light" radius="xl" leftSection={<IconCheck size={13} />}>
        сырья хватает
      </Badge>
    );
  }

  const shortages: Array<{
    materialId: string; materialCode: string; name: string; unit: string;
    need: number; available: number; shortage: number; estimatedPrice: number;
  }> = data.shortages;
  const totalEstimate = shortages.reduce((s, sh) => s + sh.shortage * sh.estimatedPrice, 0);
  const noPriceCount = shortages.filter((sh) => !(sh.estimatedPrice > 0)).length;

  return (
    <>
      <Group gap="sm" wrap="wrap">
        <Badge size="lg" color="danger" variant="light" radius="xl" leftSection={<IconAlertTriangle size={13} />}>
          не хватает {shortages.length} позиций
        </Badge>
        <Button
          size="sm"
          variant="light"
          color="orange"
          onClick={() => setConfirmOpen(true)}
        >
          В заявку на закуп
        </Button>
      </Group>

      {/* Карточка дефицита: пользователь видит, что и сколько закупать,
          ДО того как это уйдёт в очередь */}
      <Modal
        opened={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={<Text fw={700} size="lg">Что закупить для заказа {orderNumber}</Text>}
        radius="md"
        size="lg"
        centered
      >
        <Stack gap="md">
          <TableScroll minWidth={560}>
            <Table withTableBorder verticalSpacing={8}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Материал</Table.Th>
                  <Table.Th ta="right">Закупить</Table.Th>
                  <Table.Th ta="right" data-priority="2">Нужно</Table.Th>
                  <Table.Th ta="right" data-priority="2">На складе</Table.Th>
                  <Table.Th ta="right">Оценка</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shortages.map((sh) => (
                  <Table.Tr key={sh.materialId}>
                    <Table.Td>
                      <Text size="sm" ff="monospace" fw={600} c="brand.7">{sh.materialCode}</Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>{sh.name}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={700} style={{ whiteSpace: 'nowrap' }}>
                      {sh.shortage.toLocaleString('ru-RU')} {sh.unit}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }} data-priority="2">
                      {sh.need.toLocaleString('ru-RU')} {sh.unit}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" c="dimmed" style={{ whiteSpace: 'nowrap' }} data-priority="2">
                      {sh.available.toLocaleString('ru-RU')}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                      {sh.estimatedPrice > 0
                        ? Math.round(sh.shortage * sh.estimatedPrice).toLocaleString('ru-RU') + ' ₸'
                        : '—'}
                    </Table.Td>
                  </Table.Tr>
                ))}
                <Table.Tr>
                  <Table.Td colSpan={2}><Text size="sm" fw={700}>Итого, оценка</Text></Table.Td>
                  <Table.Td colSpan={2} data-priority="2" />
                  <Table.Td ta="right" ff="monospace" fw={700} style={{ whiteSpace: 'nowrap' }}>
                    {Math.round(totalEstimate).toLocaleString('ru-RU')} ₸
                  </Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </TableScroll>

          {noPriceCount > 0 && (
            <Text size="xs" c="dimmed">
              У {noPriceCount} позиций нет закупочной цены — оценка занижена
            </Text>
          )}
          <Text size="xs" c="dimmed">
            Позиции лягут в очередь «Закупки → На закуп». Одинаковый дефицит
            по нескольким заказам склеится в одну строку, снабженец отправит
            накопленное в Б24 одной заявкой.
          </Text>

          <Group justify="flex-end">
            <Button size="md" variant="default" onClick={() => setConfirmOpen(false)}>Отмена</Button>
            <Button
              size="md"
              color="orange"
              loading={toQueue.isPending}
              onClick={() => toQueue.mutate()}
            >
              В заявку на закуп ({shortages.length} позиций)
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
