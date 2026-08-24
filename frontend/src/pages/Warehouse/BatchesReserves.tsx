import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Table, Skeleton, Button, Textarea,
  Modal, ThemeIcon, Alert, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconGavel, IconFlask, IconClockExclamation, IconCheck, IconX, IconShieldCheck,
} from '@tabler/icons-react';
import api from '../../api/client';
import { useAuthStore } from '../../store/auth';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { Stagger } from '../../components/motion';
import { formatCurrency, formatDate } from '../../utils/formatters';

interface OverrideRow {
  id: string;
  qtyRequested: number;
  reason: string;
  ageHours: number;
  requestedByOrder: { id: string; orderNumber: string; plannedShipmentDate: string | null } | null;
  holderOrder: { id: string; orderNumber: string; plannedShipmentDate: string | null } | null;
  material: { materialCode: string; name: string; unit: string };
  unitPrice: number;
  reservedQty: number;
}
interface AnomalyRow {
  batchId: string;
  material: { id: string; materialCode: string; name: string; unit: string };
  receiptDate: string;
  unitPrice: number;
  qtyRemaining: number;
  anomalyFactor: number | null;
  documentNumber: string | null;
  supplierName: string | null;
  hint: string;
}
interface ExpiringRow {
  id: string;
  order: { id: string; orderNumber: string; status: string };
  material: { materialCode: string; name: string; unit: string };
  qty: number;
  unitPrice: number;
  expiresAt: string;
  daysLeft: number;
}

/**
 * Партии и резервы (24.08.2026) — двери для того, что было построено
 * без экрана: перехваты резервов с решением директора, карантин цен
 * с подтверждением снабжения, истекающие резервы. Раньше ссылки
 * «Требует решения» с экрана директора вели сюда — в пустоту.
 */
export function BatchesReserves() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canDecide = hasRole(['director', 'admin']);
  const canClearAnomaly = hasRole(['procurement', 'admin']);

  const [deciding, setDeciding] = useState<OverrideRow | null>(null);
  const [comment, setComment] = useState('');

  const { data: overrides, isLoading: l1 } = useQuery({
    queryKey: ['batch-overrides'],
    queryFn: () => api.get<{ data: OverrideRow[] }>('/batch-reservations/overrides').then((r) => r.data),
    refetchInterval: 60_000,
  });
  const { data: anomalies, isLoading: l2 } = useQuery({
    queryKey: ['batch-anomalies'],
    queryFn: () => api.get<{ data: AnomalyRow[] }>('/material-batches/anomalies').then((r) => r.data.data),
    refetchInterval: 60_000,
  });
  const { data: expiring, isLoading: l3 } = useQuery({
    queryKey: ['reservations-expiring'],
    queryFn: () => api.get<{ data: ExpiringRow[] }>('/batch-reservations/expiring?days=3').then((r) => r.data),
    refetchInterval: 60_000,
  });

  const decide = useMutation({
    mutationFn: (input: { id: string; approve: boolean; comment?: string }) =>
      api.post(`/batch-reservations/overrides/${input.id}/decide`, {
        approve: input.approve, comment: input.comment,
      }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['batch-overrides'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'director'] });
      notifications.show({
        title: v.approve ? 'Перехват разрешён' : 'Перехват отклонён',
        message: v.approve
          ? 'Резерв переходит запросившему заказу'
          : 'Резерв остаётся за прежним заказом',
        color: v.approve ? 'success' : 'gray',
        icon: v.approve ? <IconCheck size={16} /> : <IconX size={16} />,
      });
      setDeciding(null);
      setComment('');
    },
    onError: (e: any) => notifications.show({
      title: 'Не сохранено',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  const clearAnomaly = useMutation({
    mutationFn: (batchId: string) => api.post(`/material-batches/anomalies/${batchId}/clear`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['batch-anomalies'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'director'] });
      notifications.show({
        title: 'Цена подтверждена',
        message: 'Партия возвращена в автоподбор',
        color: 'success',
        icon: <IconShieldCheck size={16} />,
      });
    },
    onError: (e: any) => notifications.show({
      title: 'Не сохранено',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  if (l1 || l2 || l3) {
    return (
      <Stack gap="md">
        {[...Array(3)].map((_, i) => <Skeleton key={i} height={140} radius="md" />)}
      </Stack>
    );
  }

  const ov = overrides?.data ?? [];
  const an = anomalies ?? [];
  const ex = expiring?.data ?? [];

  return (
    <Stack gap="lg">
      {/* ===== Перехваты: решает директор ===== */}
      <Card withBorder radius="md" padding="md" id="overrides">
        <Group gap="xs" mb="sm">
          <ThemeIcon variant="light" color="red" radius="md" size="sm"><IconGavel size={14} /></ThemeIcon>
          <Text fw={700} size="sm">Перехваты резервов</Text>
          {ov.length > 0 && <Badge color="red" variant="filled" radius="xl" size="sm">{ov.length}</Badge>}
        </Group>
        {ov.length === 0 ? (
          <Text size="sm" c="dimmed">Запросов нет — металл никто ни у кого не просит</Text>
        ) : (
          <Stagger>
            {ov.map((o) => (
              <Card key={o.id} withBorder radius="md" padding="sm" mb="xs" bg="var(--mantine-color-default-hover)">
                <Group justify="space-between" wrap="wrap" gap="sm">
                  <Stack gap={4} style={{ flex: 1, minWidth: 260 }}>
                    <Group gap={8} wrap="wrap">
                      {o.requestedByOrder && (
                        <OrderRef id={o.requestedByOrder.id} number={o.requestedByOrder.orderNumber} />
                      )}
                      <Text size="sm" c="dimmed">просит {o.qtyRequested} {o.material.unit} у</Text>
                      {o.holderOrder && (
                        <OrderRef id={o.holderOrder.id} number={o.holderOrder.orderNumber} />
                      )}
                      {o.ageHours > 24 && (
                        <Badge color="orange" variant="light" radius="xl" size="sm">
                          ждёт {Math.floor(o.ageHours / 24)} дн
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {o.material.name} · {formatCurrency(o.unitPrice)}/{o.material.unit} · в резерве {o.reservedQty} {o.material.unit}
                    </Text>
                    <Text size="sm" style={{ fontStyle: 'italic' }}>«{o.reason}»</Text>
                  </Stack>
                  {canDecide ? (
                    <Group gap="xs">
                      <Button size="sm" color="success"
                        onClick={() => decide.mutate({ id: o.id, approve: true })}
                        loading={decide.isPending}>
                        Разрешить
                      </Button>
                      <Button size="sm" variant="light" color="danger"
                        onClick={() => setDeciding(o)}>
                        Отказать
                      </Button>
                    </Group>
                  ) : (
                    <Badge color="gray" variant="light" radius="xl">решает директор</Badge>
                  )}
                </Group>
              </Card>
            ))}
          </Stagger>
        )}
      </Card>

      {/* ===== Карантин цен: подтверждает снабжение ===== */}
      <Card withBorder radius="md" padding="md" id="quarantine">
        <Group gap="xs" mb="sm">
          <ThemeIcon variant="light" color="yellow" radius="md" size="sm"><IconFlask size={14} /></ThemeIcon>
          <Text fw={700} size="sm">Карантин цен</Text>
          {an.length > 0 && <Badge color="yellow" variant="filled" radius="xl" size="sm">{an.length}</Badge>}
        </Group>
        <Text size="xs" c="dimmed" mb="sm">
          Цена партии разошлась с медианой по материалу — в расчёты она не попадёт,
          пока снабжение не подтвердит, что это не ошибка ввода
        </Text>
        {an.length === 0 ? (
          <Text size="sm" c="dimmed">Карантин пуст — подозрительных цен нет</Text>
        ) : (
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="xs" fz="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Материал</Table.Th>
                  <Table.Th ta="right">Цена партии</Table.Th>
                  <Table.Th ta="right">Отклонение</Table.Th>
                  <Table.Th>Приход</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {an.map((a) => (
                  <Table.Tr key={a.batchId}>
                    <Table.Td>
                      <Text size="sm">{a.material.name}</Text>
                      <Text size="xs" c="dimmed" ff="monospace">{a.material.materialCode}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={600}>{formatCurrency(a.unitPrice)}</Table.Td>
                    <Table.Td ta="right">
                      <Tooltip label={a.hint}>
                        <Badge color="red" variant="light" radius="xl">
                          ×{a.anomalyFactor ?? '—'}
                        </Badge>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {formatDate(a.receiptDate)}{a.supplierName ? ` · ${a.supplierName}` : ''}
                        {a.documentNumber ? ` · ${a.documentNumber}` : ''}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {canClearAnomaly ? (
                        <Button size="compact-sm" variant="light"
                          onClick={() => clearAnomaly.mutate(a.batchId)}
                          loading={clearAnomaly.isPending}>
                          Цена верна
                        </Button>
                      ) : (
                        <Badge color="gray" variant="light" radius="xl" size="sm">снабжение</Badge>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      {/* ===== Истекающие резервы ===== */}
      <Card withBorder radius="md" padding="md" id="expiring">
        <Group gap="xs" mb="sm">
          <ThemeIcon variant="light" color="orange" radius="md" size="sm"><IconClockExclamation size={14} /></ThemeIcon>
          <Text fw={700} size="sm">Резервы истекают</Text>
          {ex.length > 0 && <Badge color="orange" variant="filled" radius="xl" size="sm">{ex.length}</Badge>}
        </Group>
        <Text size="xs" c="dimmed" mb="sm">
          Резерв без движения снимается через 30 дней сам — металл вернётся
          в свободный остаток. Если заказ ещё жив, продлите резерв пересчётом калькуляции
        </Text>
        {ex.length === 0 ? (
          <Text size="sm" c="dimmed">В ближайшие 3 дня ничего не истекает</Text>
        ) : (
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="xs" fz="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Заказ</Table.Th>
                  <Table.Th>Материал</Table.Th>
                  <Table.Th ta="right">Кол-во</Table.Th>
                  <Table.Th ta="right">Истекает</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {ex.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td><OrderRef id={r.order.id} number={r.order.orderNumber} focus="supply" /></Table.Td>
                    <Table.Td>
                      <Text size="sm">{r.material.name}</Text>
                      <Text size="xs" c="dimmed" ff="monospace">{r.material.materialCode}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">{r.qty} {r.material.unit}</Table.Td>
                    <Table.Td ta="right">
                      <Badge color={r.daysLeft <= 1 ? 'red' : 'orange'} variant="light" radius="xl">
                        {r.daysLeft === 0 ? 'сегодня' : `${r.daysLeft} дн`}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      {/* Отказ — с причиной: запросивший должен понять, что делать дальше */}
      <Modal
        opened={deciding !== null}
        onClose={() => setDeciding(null)}
        title={<Text fw={700}>Отказать в перехвате</Text>}
        radius="md" centered
      >
        {deciding && (
          <Stack gap="md">
            <Alert color="gray" variant="light" radius="md">
              <Text size="sm">
                {deciding.requestedByOrder?.orderNumber} останется без {deciding.qtyRequested}{' '}
                {deciding.material.unit} «{deciding.material.name}» — резерв сохранится
                за {deciding.holderOrder?.orderNumber}
              </Text>
            </Alert>
            <Textarea
              placeholder="Почему отказано — увидит запросивший..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              autoFocus
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDeciding(null)}>Отмена</Button>
              <Button
                color="danger"
                loading={decide.isPending}
                onClick={() => decide.mutate({ id: deciding.id, approve: false, comment })}
              >
                Отказать
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
