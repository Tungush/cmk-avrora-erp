import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Skeleton, Box, Tooltip, Menu, ActionIcon, TextInput,
} from '@mantine/core';
import { IconSearch, IconAlertTriangle, IconCheck, IconDots } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { ordersApi } from '../../api/orders';
import { useAuthStore } from '../../store/auth';
import { STAGE_LABELS, STAGE_SHORT, formatDate } from '../../utils/formatters';

interface StageState {
  code: string;
  routingStage: string | null;
  key: string;
  label: string;
  status: string;
  lineCount: number;
}
interface ShopFloorRow {
  id: string;
  orderNumber: string;
  customerName: string | null;
  status: string;
  plannedShipmentDate: string | null;
  overdueDays: number;
  qty: number;
  articles: string[];
  stages: StageState[];
  doneCount: number;
  totalStages: number;
  currentStage: string | null;
  stageTrackingMode: 'ORDER' | 'LINE';
}
interface ShopFloorResponse {
  orders: ShopFloorRow[];
  byStage: Array<{ key: string; code: string; routingStage: string | null; label: string; count: number }>;
  total: number;
}

const STAGE_COLORS: Record<string, { bg: string; fg: string }> = {
  DONE: { bg: 'var(--ok-6)', fg: '#fff' },
  IN_PROGRESS: { bg: 'var(--brand-6)', fg: '#fff' },
  NOT_STARTED: { bg: 'var(--gray-2)', fg: 'var(--gray-6)' },
};

/**
 * Полоса этапов: пять сегментов — КД, Снабжение и три передела (09 §2.1).
 * Заказ идёт по ним одновременно, поэтому его состояние — не «колонка»,
 * а картина готовности. Клик по сегменту — отметка мастера.
 *
 * В режиме LINE отметка одним кликом недоступна: там у шага несколько записей
 * по позициям, и бэкенд требует указать конкретную. Предлагать действие,
 * которое вернёт ошибку, нельзя.
 */
function StageStrip({
  stages, onToggle, canEdit,
}: {
  stages: StageState[];
  onToggle: (stage: StageState, next: string) => void;
  canEdit: boolean;
}) {
  return (
    <Group gap={2} wrap="nowrap">
      {stages.map((s) => {
        const c = STAGE_COLORS[s.status] ?? STAGE_COLORS.NOT_STARTED;
        const label = s.label ?? STAGE_LABELS[s.key] ?? s.key;
        const statusText = s.status === 'DONE' ? 'готово'
          : s.status === 'IN_PROGRESS' ? 'в работе' : 'не начат';
        const hint = s.lineCount > 1 ? ` · по позициям: ${s.lineCount}` : '';
        return (
          <Tooltip key={s.key} label={`${label} — ${statusText}${hint}`} withArrow>
            <Box
              onClick={canEdit
                ? () => onToggle(s, s.status === 'DONE' ? 'in_progress' : 'done')
                : undefined}
              style={{
                width: 30,
                height: 22,
                borderRadius: 4,
                background: c.bg,
                color: c.fg,
                fontSize: 10,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: canEdit ? 'pointer' : 'default',
                userSelect: 'none',
              }}
            >
              {STAGE_SHORT[s.key] ?? '?'}
            </Box>
          </Tooltip>
        );
      })}
    </Group>
  );
}

/**
 * Цех: список заказов в работе с прогрессом по этапам.
 * Заменил канбан-доску — она показывала заказы в колонках, хотя этапы
 * идут параллельно, и раскладка была фиктивной.
 */
export function ShopFloor() {
  const qc = useQueryClient();
  // Этапы отмечает мастер цеха — то же правило, что на бэкенде
  // (@Roles('shop_foreman', 'planner', 'admin') на PATCH production-stages)
  const hasRole = useAuthStore((s) => s.hasRole);
  const canEdit = hasRole(['shop_foreman', 'planner', 'admin']);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['shop-floor', stageFilter],
    queryFn: () => api
      .get<ShopFloorResponse>('/production-plan/shop-floor', { params: stageFilter ? { stage: stageFilter } : undefined })
      .then((r) => r.data),
    refetchInterval: 60_000,
  });

  const setStage = useMutation({
    mutationFn: (input: { orderId: string; stage: StageState; status: string }) =>
      ordersApi
        .updateStage(input.orderId, input.stage.code, {
          status: input.status,
          routingStage: input.stage.routingStage,
        })
        .then((r) => r.data),
    onSuccess: (_, v) => {
      qc.invalidateQueries({ queryKey: ['shop-floor'] });
      notifications.show({
        title: 'Этап обновлён',
        message: `${v.stage.label}: ${v.status === 'done' ? 'готово' : 'в работе'}`,
        color: 'success',
        icon: <IconCheck size={16} />,
      });
    },
    onError: (e: any) => notifications.show({
      title: 'Ошибка',
      message: e?.response?.data?.error?.message ?? 'Не удалось обновить этап',
      color: 'danger',
    }),
  });

  if (isLoading || !data) {
    return (
      <Stack gap="md">
        <Skeleton height={70} radius="md" />
        <Skeleton height={420} radius="md" />
      </Stack>
    );
  }

  const rows = search
    ? data.orders.filter((o) =>
        o.orderNumber.toLowerCase().includes(search.toLowerCase()) ||
        (o.customerName ?? '').toLowerCase().includes(search.toLowerCase()))
    : data.orders;

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      {/* Где стоит работа — узкие места цеха видны сразу */}
      <Card withBorder radius="md" padding="sm">
        <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb="xs">Где сейчас стоит работа</Text>
        <Group gap="xs" wrap="wrap">
          {data.byStage.map((s) => {
            const active = stageFilter === s.code;
            return (
              <Badge
                key={s.code}
                variant={active ? 'filled' : 'light'}
                color={s.count > 0 ? 'brand' : 'gray'}
                size="lg"
                style={{ cursor: 'pointer' }}
                onClick={() => setStageFilter(active ? null : s.code)}
              >
                {s.label}: {s.count}
              </Badge>
            );
          })}
          {stageFilter && (
            <Badge variant="outline" color="gray" size="lg" style={{ cursor: 'pointer' }} onClick={() => setStageFilter(null)}>
              Сбросить фильтр
            </Badge>
          )}
        </Group>
      </Card>

      <Group justify="space-between" wrap="wrap" gap="sm">
        <TextInput
          placeholder="№ заказа или заказчик..."
          leftSection={<IconSearch size={15} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          w={280}
          size="sm"
        />
        <Text size="sm" c="dimmed">
          В работе: <Text span fw={700} ff="monospace">{rows.length}</Text>
          {stageFilter ? ` из ${data.total}` : ''}
        </Text>
      </Group>

      <Card withBorder radius="md" padding={0}>
        <Box style={{ overflowX: 'auto' }}>
          <table className="shop-floor-table">
            <thead>
              <tr>
                <th>№ заказа</th>
                <th>Заказчик</th>
                <th style={{ textAlign: 'right' }}>Кол-во</th>
                <th>Этапы производства</th>
                <th style={{ textAlign: 'right' }}>Готово</th>
                <th>Текущий этап</th>
                <th style={{ textAlign: 'right' }}>План вывоза</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Text size="sm" ff="monospace" fw={600} c="brand.7">{o.orderNumber}</Text>
                  </td>
                  <td><Text size="sm" lineClamp={1}>{o.customerName ?? '—'}</Text></td>
                  <td style={{ textAlign: 'right' }}>
                    <Text size="sm" ff="monospace">{o.qty.toLocaleString('ru-RU')}</Text>
                  </td>
                  <td>
                    <StageStrip
                      stages={o.stages}
                      canEdit={canEdit && o.stageTrackingMode === 'ORDER'}
                      onToggle={(stage, status) => setStage.mutate({ orderId: o.id, stage, status })}
                    />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Text size="sm" ff="monospace" c={o.doneCount === o.totalStages ? 'success.7' : undefined}>
                      {o.doneCount}/{o.totalStages}
                    </Text>
                  </td>
                  <td>
                    {o.currentStage ? (
                      <Text size="sm">{STAGE_LABELS[o.currentStage] ?? o.currentStage}</Text>
                    ) : (
                      <Badge variant="light" color="success" size="sm">все этапы</Badge>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Group gap={6} justify="flex-end" wrap="nowrap">
                      <Text size="sm" ff="monospace">{formatDate(o.plannedShipmentDate)}</Text>
                      {o.overdueDays > 0 && (
                        <Badge color="danger" variant="light" size="sm" leftSection={<IconAlertTriangle size={10} />}>
                          {o.overdueDays}
                        </Badge>
                      )}
                    </Group>
                  </td>
                  <td>
                    {canEdit && (
                      <Menu position="bottom-end" shadow="md">
                        <Menu.Target>
                          <ActionIcon variant="subtle" color="gray" size="sm"><IconDots size={15} /></ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Label>Отметить этап</Menu.Label>
                          {o.stageTrackingMode === 'LINE' ? (
                            <Menu.Item disabled>
                              Заказ отмечается по позициям — откройте карточку заказа
                            </Menu.Item>
                          ) : o.stages.map((s) => (
                            <Menu.Item
                              key={s.key}
                              onClick={() => setStage.mutate({
                                orderId: o.id,
                                stage: s,
                                status: s.status === 'DONE' ? 'in_progress' : 'done',
                              })}
                            >
                              {s.label} — {s.status === 'DONE' ? 'снять готовность' : 'готово'}
                            </Menu.Item>
                          ))}
                        </Menu.Dropdown>
                      </Menu>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <Text size="sm" c="dimmed" ta="center" py="lg">
                      {stageFilter ? 'На этом этапе заказов нет' : 'Заказов в работе нет'}
                    </Text>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Card>

      <Group gap="lg">
        <Group gap={6}>
          <Box w={14} h={14} style={{ borderRadius: 3, background: 'var(--ok-6)' }} />
          <Text size="xs" c="dimmed">готово</Text>
        </Group>
        <Group gap={6}>
          <Box w={14} h={14} style={{ borderRadius: 3, background: 'var(--brand-6)' }} />
          <Text size="xs" c="dimmed">в работе</Text>
        </Group>
        <Group gap={6}>
          <Box w={14} h={14} style={{ borderRadius: 3, background: 'var(--gray-2)' }} />
          <Text size="xs" c="dimmed">не начат</Text>
        </Group>
        {canEdit && <Text size="xs" c="dimmed">· клик по сегменту переключает готовность</Text>}
      </Group>
    </Stack>
  );
}
