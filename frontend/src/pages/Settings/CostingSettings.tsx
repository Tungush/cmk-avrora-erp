import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Stack, Group, Text, Card, NumberInput, Button, Skeleton, Alert,
} from '@mantine/core';
import { IconInfoCircle, IconDeviceFloppy } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { costingConfigApi, CostingConfig } from '../../api/costings';
import { useAuthStore } from '../../store/auth';

/**
 * Маржа, логистика, себестоимость — редактируемые коэффициенты калькуляции
 * (запрос 25.08.2026). Раньше их можно было поменять только скриптом в базе.
 * Каждое сохранение — новая версия (старая закрывается по дате, не
 * стирается): расчёты прошлых заказов не задним числом не меняются.
 */
export function CostingSettings() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canEdit = hasRole(['admin', 'director']);

  const { data, isLoading } = useQuery({
    queryKey: ['costing-config'],
    queryFn: () => costingConfigApi.get().then((r) => r.data),
  });

  const [form, setForm] = useState<CostingConfig | null>(null);
  useEffect(() => { if (data && !form) setForm(data); }, [data, form]);

  const save = useMutation({
    mutationFn: (body: CostingConfig) => costingConfigApi.update(body),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['costing-config'] });
      setForm(r.data);
      notifications.show({
        title: 'Сохранено',
        message: 'Новая версия коэффициентов действует с этого момента — прежние расчёты не меняются',
        color: 'success',
      });
    },
    onError: (e: any) => notifications.show({
      title: 'Не сохранено',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  if (isLoading || !form) {
    return <Stack gap="md">{[...Array(2)].map((_, i) => <Skeleton key={i} height={90} radius="md" />)}</Stack>;
  }

  const set = (field: keyof CostingConfig) => (v: number | string) =>
    setForm({ ...form, [field]: Number(v) || 0 });
  const dirty = data && JSON.stringify(data) !== JSON.stringify(form);

  return (
    <Stack gap="lg" maw={640}>
      <Alert icon={<IconInfoCircle size={16} />} color="brand" variant="light">
        Действует на ВСЕ новые расчёты себестоимости сразу после сохранения. Уже согласованные калькуляции
        прошлых заказов не пересчитываются — новая версия коэффициентов только добавляется в историю.
      </Alert>

      <Card withBorder radius="md" padding="lg">
        <Text fw={700} size="sm" mb="md">Маржа и логистика</Text>
        <Stack gap="md">
          <Group grow>
            <NumberInput
              label="Маржа от цены" description="price = себестоимость / (1 − маржа)"
              value={Math.round(form.marginPct * 1000) / 10} onChange={(v) => set('marginPct')(Number(v) / 100)}
              suffix=" %" min={0} max={90} decimalScale={1} disabled={!canEdit}
            />
            <NumberInput
              label="Логистика" description="от стоимости материалов"
              value={Math.round(form.logisticsPct * 1000) / 10} onChange={(v) => set('logisticsPct')(Number(v) / 100)}
              suffix=" %" min={0} max={50} decimalScale={1} disabled={!canEdit}
            />
          </Group>
          <Group grow>
            <NumberInput
              label="Коммунальные" description="вода, газ, электричество — от материалов"
              value={Math.round(form.utilitiesPct * 1000) / 10} onChange={(v) => set('utilitiesPct')(Number(v) / 100)}
              suffix=" %" min={0} max={20} decimalScale={1} disabled={!canEdit}
            />
            <NumberInput
              label="НДС" description="ставка налога"
              value={Math.round(form.vatPct * 1000) / 10} onChange={(v) => set('vatPct')(Number(v) / 100)}
              suffix=" %" min={0} max={30} decimalScale={1} disabled={!canEdit}
            />
          </Group>
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Text fw={700} size="sm" mb="md">Труд и оплата</Text>
        <Group grow>
          <NumberInput
            label="Ставка часа труда" description="штатный рабочий, ₸/час"
            value={form.hourlyRate} onChange={set('hourlyRate')}
            suffix=" ₸" min={0} thousandSeparator=" " disabled={!canEdit}
          />
          <NumberInput
            label="Отсрочка оплаты" description="дней от отгрузки"
            value={form.paymentTermDays} onChange={set('paymentTermDays')}
            min={0} max={180} disabled={!canEdit}
          />
        </Group>
      </Card>

      {canEdit ? (
        <Group justify="flex-end">
          <Button
            leftSection={<IconDeviceFloppy size={16} />}
            onClick={() => save.mutate(form)}
            loading={save.isPending}
            disabled={!dirty}
          >
            Сохранить новую версию
          </Button>
        </Group>
      ) : (
        <Text size="xs" c="dimmed">Менять коэффициенты может только директор или администратор.</Text>
      )}
    </Stack>
  );
}
