import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Table, Skeleton, Button, TextInput,
  NumberInput, Checkbox, ActionIcon, Modal,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconTrash, IconTarget, IconPlus } from '@tabler/icons-react';
import { dealsApi, Deal } from '../../api/deals';
import { FadeSwap, TextReveal } from '../../components/motion';
import { PaginationBar } from '../../components/PaginationBar';
import { FitScreen, useFitRows, usePageKeys } from '../../components/FitScreen';
import { formatCurrency, formatNumber } from '../../utils/formatters';
import './Sales.css';

const emptyForm = {
  customerName: '', articleName: '', qtyOrdered: '' as number | '',
  amountOrdered: '' as number | '', siteCode: '', region: '',
  managerName: '', plannedDispatchMonth: '', hasFormalRequest: false,
};

/** Высота строки прогноза: две строки текста в ячейке «объект / регион» */
const ROW_H = 61;
/** Шапка таблицы */
const HEAD_H = 44;

/**
 * Прогноз спроса до формального заказа (24.08.2026) — то, что раньше жило
 * только в листе «Планируемое (без заявок)» Excel-плана: объект/сайт,
 * заказчик, кто ведёт направление, планируемый месяц вывоза. В 1С это
 * не появляется, пока заказ не подтверждён, а в Б24 не дублируем.
 *
 * 03.09.2026: страница не прокручивается. Форма «новая строка» занимала
 * 212 px первого экрана — её открывают раз в неделю, а таблицу читают
 * каждый день, поэтому форма уехала в окно по кнопке «Добавить строку».
 * Строк показываем ровно столько, сколько поместилось; остальные —
 * страницами и стрелками ← →. Ни одна строка не потеряна.
 */
export function Pipeline() {
  const qc = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [page, setPage] = useState(1);

  // Размер страницы = высота экрана, а не число 25 из настроек
  const fit = useFitRows(ROW_H, 3, 40, HEAD_H);
  const pageSize = Math.max(1, fit.rows);
  useEffect(() => { setPage(1); }, [pageSize]);

  const { data: deals, isLoading } = useQuery({
    queryKey: ['deals', 'pipeline', page, pageSize],
    queryFn: () => dealsApi.list({ page, pageSize }).then((r) => r.data),
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
      setFormOpen(false);
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

  const rows = deals?.data ?? [];
  const total = deals?.meta?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  usePageKeys(page, totalPages, setPage);
  const canSubmit = form.customerName.trim().length > 0;

  const header = (
    <Group justify="space-between" align="center" wrap="nowrap" gap="md">
      <Group gap="sm" wrap="nowrap" align="baseline" style={{ minWidth: 0 }}>
        <Text component="h1" className="page-title" style={{ fontSize: 26, lineHeight: 1.1, whiteSpace: 'nowrap', margin: 0 }}>
          <TextReveal text="Прогноз спроса" />
        </Text>
        <Text size="sm" c="dimmed" lineClamp={1}>
          объекты и сделки до формального заказа — в 1С их ещё нет
        </Text>
        <Badge variant="light" color="gray" radius="xl" size="lg">{total}</Badge>
      </Group>
      <Button leftSection={<IconPlus size={16} aria-hidden />} onClick={() => setFormOpen(true)}>
        Добавить строку
      </Button>
    </Group>
  );

  const footer = (
    <PaginationBar
      page={page}
      total={total}
      pageSize={pageSize}
      onPageChange={setPage}
      noun="строк"
    />
  );

  return (
    <FitScreen header={header} footer={footer}>
      <Card withBorder radius="md" padding={0} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
        <div className="pipeline-table" ref={fit.ref}>
          {isLoading ? (
            <Stack gap={4} p="md">
              {[...Array(Math.max(3, pageSize))].map((_, i) => <Skeleton key={i} height={44} radius="sm" />)}
            </Stack>
          ) : rows.length === 0 ? (
            <Text size="sm" c="dimmed" p="md">Пока пусто — добавьте строку кнопкой сверху</Text>
          ) : (
            <FadeSwap swapKey={page}>
              {/* Ширина колонок задана жёстко: девять колонок по контенту
                  давали таблицу в 1413 px, и «Ведёт / План вывоза / Заявка»
                  просто обрезало справа (03.09.2026). Длинные имена теперь
                  сжимаются многоточием, а не выталкивают колонки за край */}
              <Table highlightOnHover layout="fixed">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Заказчик</Table.Th>
                    <Table.Th>Изделие</Table.Th>
                    <Table.Th>Объект / регион</Table.Th>
                    <Table.Th ta="right" w={78}>Кол-во</Table.Th>
                    <Table.Th ta="right" w={132}>Сумма</Table.Th>
                    <Table.Th w={104}>Ведёт</Table.Th>
                    <Table.Th w={116}>План вывоза</Table.Th>
                    <Table.Th w={78}>Заявка</Table.Th>
                    <Table.Th w={68} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((d: Deal) => (
                    <Table.Tr key={d.id}>
                      <Table.Td><Text size="sm" fw={600} lineClamp={2}>{d.customer?.name ?? 'нет данных'}</Text></Table.Td>
                      <Table.Td><Text size="sm" lineClamp={2}>{d.article?.name ?? 'нет данных'}</Text></Table.Td>
                      <Table.Td>
                        <Text size="sm" lineClamp={1}>{d.siteCode || '—'}</Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>{d.region || ''}</Text>
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace">{formatNumber(d.qtyOrdered, 0)}</Table.Td>
                      <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>{formatCurrency(d.amountOrdered)}</Table.Td>
                      <Table.Td>{d.managerName || '—'}</Table.Td>
                      <Table.Td>{d.plannedDispatchMonth || 'нет плана'}</Table.Td>
                      <Table.Td>
                        <Checkbox size="md" aria-label="Заявка подана" checked={d.hasFormalRequest}
                          onChange={(e) => toggleFormal.mutate({ id: d.id, value: e.target.checked })} />
                      </Table.Td>
                      <Table.Td>
                        <ActionIcon variant="subtle" color="danger" size="lg" aria-label="Удалить" onClick={() => remove.mutate(d.id)}>
                          <IconTrash size={16} aria-hidden />
                        </ActionIcon>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </FadeSwap>
          )}
        </div>
      </Card>

      {/* Форма заводится раз в неделю, а таблицу читают каждый день —
          поэтому форма в окне, а не над списком (03.09.2026) */}
      <Modal
        opened={formOpen}
        onClose={() => setFormOpen(false)}
        title={<Group gap="xs"><IconTarget size={16} aria-hidden /><Text fw={700}>Новая строка прогноза</Text></Group>}
        radius="md" size="lg" centered
      >
        <Group gap="sm" wrap="wrap" align="flex-end">
          <TextInput label="Заказчик" placeholder="КарТел" value={form.customerName}
            onChange={(e) => setForm({ ...form, customerName: e.target.value })} w={200} required />
          <TextInput label="Изделие" placeholder="Мачта М18м..." value={form.articleName}
            onChange={(e) => setForm({ ...form, articleName: e.target.value })} w={220} />
          <NumberInput label="Кол-во" placeholder="1" value={form.qtyOrdered}
            onChange={(v) => setForm({ ...form, qtyOrdered: v as number })} w={100} min={0} />
          <NumberInput label="Сумма с НДС" placeholder="0" value={form.amountOrdered}
            onChange={(v) => setForm({ ...form, amountOrdered: v as number })} w={160} min={0}
            thousandSeparator=" " />
          <TextInput label="Объект / сайт" placeholder="ALM_Dala" value={form.siteCode}
            onChange={(e) => setForm({ ...form, siteCode: e.target.value })} w={150} />
          <TextInput label="Регион" placeholder="Алматинская область" value={form.region}
            onChange={(e) => setForm({ ...form, region: e.target.value })} w={190} />
          <TextInput label="Ведёт" placeholder="Имя" value={form.managerName}
            onChange={(e) => setForm({ ...form, managerName: e.target.value })} w={130} />
          <TextInput label="План вывоза" placeholder="август" value={form.plannedDispatchMonth}
            onChange={(e) => setForm({ ...form, plannedDispatchMonth: e.target.value })} w={130} />
          <Checkbox size="md" label="Заявка уже подана" checked={form.hasFormalRequest}
            onChange={(e) => setForm({ ...form, hasFormalRequest: e.target.checked })} mb={10} />
          <Button leftSection={<IconPlus size={16} aria-hidden />} onClick={() => create.mutate()}
            loading={create.isPending} disabled={!canSubmit} mb={2}>
            Добавить
          </Button>
        </Group>
      </Modal>
    </FitScreen>
  );
}
