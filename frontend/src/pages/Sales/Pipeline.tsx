import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Table, Skeleton, Button, TextInput,
  NumberInput, Checkbox, ActionIcon, TableScrollContainer,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconTrash, IconTarget, IconPlus } from '@tabler/icons-react';
import { dealsApi, Deal } from '../../api/deals';
import { Stagger } from '../../components/motion';
import { formatCurrency, formatNumber } from '../../utils/formatters';

const emptyForm = {
  customerName: '', articleName: '', qtyOrdered: '' as number | '',
  amountOrdered: '' as number | '', siteCode: '', region: '',
  managerName: '', plannedDispatchMonth: '', hasFormalRequest: false,
};

/**
 * Прогноз спроса до формального заказа (24.08.2026) — то, что раньше жило
 * только в листе «Планируемое (без заявок)» Excel-плана: объект/сайт,
 * заказчик, кто ведёт направление, планируемый месяц вывоза. В 1С это
 * не появляется, пока заказ не подтверждён, а в Б24 не дублируем.
 */
export function Pipeline() {
  const qc = useQueryClient();
  const [form, setForm] = useState(emptyForm);

  const { data: deals, isLoading } = useQuery({
    queryKey: ['deals', 'pipeline'],
    queryFn: () => dealsApi.list().then((r) => r.data),
  });

  const create = useMutation({
    mutationFn: () => dealsApi.create({
      customerName: form.customerName,
      articleName: form.articleName || undefined,
      qtyOrdered: Number(form.qtyOrdered) || 0,
      amountOrdered: Number(form.amountOrdered) || 0,
      siteCode: form.siteCode || undefined,
      region: form.region || undefined,
      managerName: form.managerName || undefined,
      plannedDispatchMonth: form.plannedDispatchMonth || undefined,
      hasFormalRequest: form.hasFormalRequest,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deals', 'pipeline'] });
      setForm(emptyForm);
      notifications.show({ title: 'Добавлено', message: 'Строка в прогнозе спроса создана', color: 'success' });
    },
    onError: (e: any) => notifications.show({
      title: 'Не сохранено', message: e?.response?.data?.error?.message ?? 'Ошибка', color: 'danger',
    }),
  });

  const toggleFormal = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) => dealsApi.update(id, { hasFormalRequest: value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deals', 'pipeline'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => dealsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deals', 'pipeline'] });
      notifications.show({ title: 'Удалено', message: 'Строка убрана из прогноза', color: 'gray' });
    },
  });

  if (isLoading) {
    return <Stack gap="md">{[...Array(2)].map((_, i) => <Skeleton key={i} height={140} radius="md" />)}</Stack>;
  }

  const rows = deals ?? [];
  const canSubmit = form.customerName.trim().length > 0;

  return (
    <Stack gap="lg">
      <Card withBorder radius="md" padding="md">
        <Group gap="xs" mb="sm">
          <IconTarget size={16} />
          <Text fw={700} size="sm">Новая строка прогноза</Text>
        </Group>
        <Group gap="sm" wrap="wrap" align="flex-end">
          <TextInput label="Заказчик" placeholder="КарТел" value={form.customerName}
            onChange={(e) => setForm({ ...form, customerName: e.target.value })} w={180} required />
          <TextInput label="Изделие" placeholder="Мачта М18м..." value={form.articleName}
            onChange={(e) => setForm({ ...form, articleName: e.target.value })} w={200} />
          <NumberInput label="Кол-во" placeholder="1" value={form.qtyOrdered}
            onChange={(v) => setForm({ ...form, qtyOrdered: v as number })} w={90} min={0} />
          <NumberInput label="Сумма с НДС" placeholder="0" value={form.amountOrdered}
            onChange={(v) => setForm({ ...form, amountOrdered: v as number })} w={140} min={0}
            thousandSeparator=" " />
          <TextInput label="Объект / сайт" placeholder="ALM_Dala" value={form.siteCode}
            onChange={(e) => setForm({ ...form, siteCode: e.target.value })} w={140} />
          <TextInput label="Регион" placeholder="Алматинская область" value={form.region}
            onChange={(e) => setForm({ ...form, region: e.target.value })} w={170} />
          <TextInput label="Ведёт" placeholder="Имя" value={form.managerName}
            onChange={(e) => setForm({ ...form, managerName: e.target.value })} w={110} />
          <TextInput label="План вывоза" placeholder="август" value={form.plannedDispatchMonth}
            onChange={(e) => setForm({ ...form, plannedDispatchMonth: e.target.value })} w={110} />
          <Checkbox label="Заявка уже подана" checked={form.hasFormalRequest}
            onChange={(e) => setForm({ ...form, hasFormalRequest: e.target.checked })} mb={8} />
          <Button leftSection={<IconPlus size={16} />} onClick={() => create.mutate()}
            loading={create.isPending} disabled={!canSubmit} mb={2}>
            Добавить
          </Button>
        </Group>
      </Card>

      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="sm">
          <Text fw={700} size="sm">Прогноз спроса</Text>
          <Badge variant="light" color="gray" radius="xl">{rows.length}</Badge>
        </Group>
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed">Пока пусто — заполните строку выше</Text>
        ) : (
          <TableScrollContainer minWidth={900}>
            <Table verticalSpacing="xs" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Заказчик</Table.Th>
                  <Table.Th>Изделие</Table.Th>
                  <Table.Th>Объект / регион</Table.Th>
                  <Table.Th>Кол-во</Table.Th>
                  <Table.Th>Сумма</Table.Th>
                  <Table.Th>Ведёт</Table.Th>
                  <Table.Th>План вывоза</Table.Th>
                  <Table.Th>Заявка</Table.Th>
                  <Table.Th></Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <Stagger>
                  {rows.map((d: Deal) => (
                    <Table.Tr key={d.id}>
                      <Table.Td>{d.customer?.name ?? 'нет данных'}</Table.Td>
                      <Table.Td>{d.article?.name ?? 'нет данных'}</Table.Td>
                      <Table.Td>
                        <Text size="sm">{d.siteCode || '—'}</Text>
                        <Text size="xs" c="dimmed">{d.region || ''}</Text>
                      </Table.Td>
                      <Table.Td>{formatNumber(d.qtyOrdered, 0)}</Table.Td>
                      <Table.Td>{formatCurrency(d.amountOrdered)}</Table.Td>
                      <Table.Td>{d.managerName || '—'}</Table.Td>
                      <Table.Td>{d.plannedDispatchMonth || 'нет плана'}</Table.Td>
                      <Table.Td>
                        <Checkbox checked={d.hasFormalRequest}
                          onChange={(e) => toggleFormal.mutate({ id: d.id, value: e.target.checked })} />
                      </Table.Td>
                      <Table.Td>
                        <ActionIcon variant="subtle" color="danger" onClick={() => remove.mutate(d.id)}>
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Stagger>
              </Table.Tbody>
            </Table>
          </TableScrollContainer>
        )}
      </Card>
    </Stack>
  );
}
