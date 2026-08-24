import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Card, Stack, Group, Text, Badge, Title, Button, Skeleton, Alert,
  Table, ThemeIcon, Anchor, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconInbox, IconCircleCheck, IconAlertTriangle, IconArrowRight, IconRefresh,
} from '@tabler/icons-react';
import { ordersApi } from '../../api/orders';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { Stagger } from '../../components/motion';
import { formatDate } from '../../utils/formatters';

/**
 * Инбокс «Новые заказы» (решение 22.08.2026): сделка Б24 → документ 1С →
 * сюда. Производство принимает заказ явно, кнопкой; пока висят блокеры
 * (позиция без артикула, нет БИН) — принять нельзя, и это видно.
 */
export function OrdersInbox() {
  const qc = useQueryClient();
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['orders', 'inbox'],
    queryFn: () => ordersApi.inbox().then((r) => r.data),
    refetchInterval: 30_000,
  });

  const accept = useMutation({
    mutationFn: (id: string) => ordersApi.accept(id),
    onMutate: (id) => setAcceptingId(id),
    onSettled: () => setAcceptingId(null),
    onSuccess: (_r, id) => {
      const order = data?.data.find((o) => o.id === id);
      notifications.show({
        title: 'Заказ принят в производство',
        message: `${order?.orderNumber ?? ''} — статус «Подтверждён», можно планировать этапы`,
        color: 'teal',
      });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e: any) => {
      notifications.show({
        title: 'Не принят',
        message: e?.response?.data?.message ?? 'Ошибка при приёме заказа',
        color: 'red',
      });
    },
  });

  if (isLoading) {
    return (
      <Stack gap="lg">
        <Skeleton height={60} radius="lg" />
        {[...Array(3)].map((_, i) => <Skeleton key={i} height={120} radius="lg" />)}
      </Stack>
    );
  }

  const orders = data?.data ?? [];

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <Stack gap={4}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
            Заказы · Инбокс
          </Text>
          <Group gap="sm">
            <Title order={2} fw={700} style={{ letterSpacing: '-0.01em' }}>
              Новые заказы из 1С
            </Title>
            {orders.length > 0 && (
              <Badge size="lg" variant="filled" color="brand" radius="xl">{orders.length}</Badge>
            )}
          </Group>
        </Stack>
        <Button
          variant="light" leftSection={<IconRefresh size={16} />}
          loading={isFetching} onClick={() => refetch()}
        >
          Обновить
        </Button>
      </Group>

      {orders.length === 0 ? (
        <Card withBorder padding="xl" radius="lg">
          <Stack align="center" gap="sm" py="xl">
            <ThemeIcon size={56} radius="xl" variant="light" color="teal">
              <IconInbox size={28} />
            </ThemeIcon>
            <Text fw={700}>Инбокс пуст</Text>
            <Text size="sm" c="dimmed" ta="center">
              Новые заказы появятся здесь после синхронизации с 1С —
              сделка Б24 создаёт «Заказ клиента», мы его забираем.
            </Text>
          </Stack>
        </Card>
      ) : (
        <Stagger>{orders.map((o) => (
          <Card key={o.id} withBorder padding="lg" radius="lg">
            <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
              <Stack gap={6} style={{ flex: 1, minWidth: 260 }}>
                <Group gap="sm">
                  <OrderRef id={o.id} number={o.orderNumber} size="lg" />
                  {o.onecNum && (
                    <Badge variant="outline" color="gray" radius="xl">1С: {o.onecNum}</Badge>
                  )}
                  {o.onecStatus && (
                    <Badge variant="light" color="cyan" radius="xl">{o.onecStatus}</Badge>
                  )}
                </Group>
                <Text size="sm" c="dimmed">
                  {(o as any).customer?.name}
                  {o.plannedShipmentDate ? ` · отгрузка ${formatDate(o.plannedShipmentDate)}` : ''}
                  {` · позиций: ${(o as any).orderLines?.length ?? 0}`}
                </Text>

                {o.blockers.length > 0 && (
                  <Stack gap={6} mt={4}>
                    {o.blockers.map((b) => (
                      <Alert
                        key={b.code}
                        color={b.code === 'NO_BOM' ? 'yellow' : 'red'}
                        icon={<IconAlertTriangle size={16} />}
                        p="xs" radius="md"
                      >
                        <Text size="sm">{b.message}</Text>
                      </Alert>
                    ))}
                  </Stack>
                )}
              </Stack>

              <Stack gap="xs" align="flex-end">
                <Tooltip
                  label={o.canAccept
                    ? 'NEW → Подтверждён: заказ уйдёт в планирование'
                    : 'Сначала разрешите блокеры — сопоставьте артикулы или подайте заявку на номенклатуру'}
                >
                  <Button
                    leftSection={o.canAccept ? <IconCircleCheck size={18} /> : <IconAlertTriangle size={18} />}
                    rightSection={<IconArrowRight size={16} />}
                    disabled={!o.canAccept}
                    loading={acceptingId === o.id}
                    onClick={() => accept.mutate(o.id)}
                  >
                    Принять в производство
                  </Button>
                </Tooltip>
                <Text size="xs" c="dimmed">
                  получен {formatDate(o.createdAt as unknown as string)}
                </Text>
              </Stack>
            </Group>
          </Card>
        ))}</Stagger>
      )}
    </Stack>
  );
}
