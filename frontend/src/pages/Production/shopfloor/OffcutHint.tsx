import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, Stack, Group, Text, Button, NumberInput } from '@mantine/core';
import { IconCheck, IconRuler2 } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import api from '../../../api/client';

/**
 * Обрезки под заказ (01.09.2026, запрос бизнеса): спецификация говорит,
 * что спишется, а на складе обрезков может лежать тот же материал кусками.
 * Подсказка показывает совпадение по материалу — раскрой не советуем,
 * решает человек, глядя на длины. Себестоимость и списание не трогает:
 * числятся ли обрезки в остатке 1С, бизнес ещё не ответил — пишем факт.
 */
export function OffcutHint({ orderId, orderNumber }: { orderId: string; orderNumber: string }) {
  const qc = useQueryClient();
  const [taken, setTaken] = useState<Record<string, number | string>>({});

  const { data } = useQuery({
    queryKey: ['offcuts-for-order', orderId],
    queryFn: () => api.get(`/warehouse/offcuts/for-order/${orderId}`).then((r) => r.data),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: () => api.post(`/warehouse/offcuts/for-order/${orderId}`, {
      usages: Object.entries(taken)
        .filter(([, q]) => Number(q) > 0)
        .map(([offcutId, q]) => ({ offcutId, qty: Number(q) })),
    }).then((r) => r.data),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['offcuts-for-order', orderId] });
      qc.invalidateQueries({ queryKey: ['offcuts'] });
      setTaken({});
      notifications.show({
        title: 'Обрезки записаны на заказ',
        message: `${orderNumber}: ${res.recorded} строк. Склад обрезков уменьшен, факт уйдёт в 1С вместе с изготовлением`,
        color: 'success',
        icon: <IconCheck size={16} />,
      });
    },
    onError: (e: any) => notifications.show({
      title: 'Не записано',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  const materials: Array<{
    materialId: string; materialCode: string; name: string; needQty: number; unit: string;
    offcuts: Array<{ id: string; lengthMm: number; widthMm: number | null; qty: number; note: string | null }>;
  }> = data?.materials ?? [];
  const usedBefore: Array<{ materialCode: string; lengthMm: number; qty: number }> = data?.usedBefore ?? [];
  const anyTaken = Object.values(taken).some((q) => Number(q) > 0);

  if (materials.length === 0 && usedBefore.length === 0) return null;

  return (
    <Card withBorder radius="md" padding="md"
      style={{ borderColor: 'var(--mantine-color-yellow-4)' }}>
      <Stack gap="sm">
        {materials.length > 0 && (
          <>
            <Group gap={8} wrap="nowrap">
              <IconRuler2 size={18} style={{ color: 'var(--mantine-color-yellow-7)' }} />
              <Text size="md" fw={700}>Есть обрезки материалов этого заказа</Text>
            </Group>
            {materials.map((m) => (
              <Stack key={m.materialId} gap={6}>
                <Text size="sm" c="dimmed">
                  <Text span ff="monospace" fw={600}>{m.materialCode}</Text> {m.name} —
                  по спецификации нужно {m.needQty.toLocaleString('ru-RU')} {m.unit}
                </Text>
                {m.offcuts.map((c) => (
                  <Group key={c.id} gap="sm" wrap="nowrap" justify="space-between">
                    <Text size="md" style={{ minWidth: 0 }}>
                      {c.lengthMm.toLocaleString('ru-RU')} мм
                      {c.widthMm ? ` × ${c.widthMm.toLocaleString('ru-RU')} мм` : ''} —
                      на складе <Text span fw={700} ff="monospace">{c.qty}</Text> шт
                      {c.note ? <Text span c="dimmed"> · {c.note}</Text> : null}
                    </Text>
                    {/* Поле под палец: мастер вводит с планшета */}
                    <NumberInput
                      size="md" w={150} min={0} max={c.qty}
                      placeholder="взяли, шт"
                      style={{ flexShrink: 0 }}
                      value={taken[c.id] ?? ''}
                      onChange={(v) => setTaken((t) => ({ ...t, [c.id]: v as number }))}
                    />
                  </Group>
                ))}
              </Stack>
            ))}
            {anyTaken && (
              <Button size="md" variant="light" color="yellow"
                loading={save.isPending} onClick={() => save.mutate()}>
                Записать обрезки на заказ
              </Button>
            )}
          </>
        )}
        {usedBefore.length > 0 && (
          <Text size="sm" c="dimmed">
            Уже записано на заказ:{' '}
            {usedBefore.map((u) => `${u.materialCode} ${u.lengthMm.toLocaleString('ru-RU')} мм × ${u.qty}`).join(', ')}
          </Text>
        )}
      </Stack>
    </Card>
  );
}
