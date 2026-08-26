import React from 'react';
import { Card, Stack, Text, Alert, Table, Badge, Skeleton, Box, Group } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import api from '../../api/client';
import { formatDate } from '../../utils/formatters';

const num = (n: number, d = 2) => n.toLocaleString('ru-RU', { maximumFractionDigits: d });

/**
 * Склад готовой продукции. Движения ГП приходят из 1С отдельной выгрузкой,
 * которой у нас пока нет — поэтому экран честно говорит, что пусто, а не
 * рисует нули как факт. Как только выгрузка появится, таблица наполнится
 * сама: эндпоинт уже читает finished_goods_movements.
 */
export function FinishedGoodsStock() {
  const { data, isLoading } = useQuery({
    queryKey: ['fg-stock'],
    queryFn: () => api.get('/warehouse/finished-goods').then((r) => r.data),
  });

  const rows: any[] = data?.data ?? [];

  return (
    <Stack gap="md">
      {!isLoading && rows.length === 0 && (
        <Alert icon={<IconInfoCircle size={17} />} color="gray" variant="light" radius="md">
          <Text size="sm" fw={600} mb={4}>Движений готовой продукции пока нет</Text>
          <Text size="sm">
            Приход и отгрузка ГП ведутся в 1С. В выгрузках, которые загружены сейчас
            (заказы, оплаты, остатки сырья, закуп), движений готовой продукции нет —
            поэтому показывать нечего. Экран наполнится сам, как только появится
            соответствующая выгрузка.
          </Text>
        </Alert>
      )}

      <Card withBorder radius="md" padding={0}>
        <Group justify="space-between" p="md" pb="sm">
          <Text fw={700} size="sm">Готовая продукция на складе</Text>
          {rows.length > 0 && (
            <Badge variant="light" color="gray" size="sm">{rows.length.toLocaleString('ru-RU')}</Badge>
          )}
        </Group>
        {isLoading ? (
          <Stack gap={4} p="md">
            {[...Array(6)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}
          </Stack>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Дата</Table.Th>
                  <Table.Th>Изделие</Table.Th>
                  <Table.Th>Заказ</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Количество</Table.Th>
                  <Table.Th>Движение</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td ff="monospace" style={{ whiteSpace: 'nowrap' }}>{formatDate(r.movementDate)}</Table.Td>
                    <Table.Td>
                      <Text size="sm" ff="monospace" fw={600} c="brand.7">{r.article?.articleCode ?? '—'}</Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>{r.article?.name ?? '—'}</Text>
                    </Table.Td>
                    <Table.Td ff="monospace" fz="xs">{r.order?.orderNumber ?? '—'}</Table.Td>
                    <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(Number(r.qty), 3)}</Table.Td>
                    <Table.Td>{r.movementType ?? '—'}</Table.Td>
                  </Table.Tr>
                ))}
                {rows.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <Text size="sm" c="dimmed" ta="center" py="lg">Нет данных</Text>
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
