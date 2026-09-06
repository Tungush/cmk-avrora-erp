import React, { useState } from 'react';
import {
  Stack, Group, Text, Button, Modal, NumberInput, TextInput, Table,
  ActionIcon, Tooltip, Badge, Divider, Checkbox,
} from '@mantine/core';
import { IconPlus, IconTrash, IconFileInvoice, IconCheck } from '@tabler/icons-react';
import { Icon } from '../Icon';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { useAuthStore } from '../../store/auth';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { TableScroll } from '../TableScroll';
import { PaginationBar, usePagedList } from '../PaginationBar';
import { FadeSwap } from '../motion';

const EMPTY: any[] = [];
/** Списки в шторке режем по 25 — обычно их меньше, и пагинация не показывается */
const DRAWER_PAGE = 25;

/**
 * Оплаты заказчика в карточке заказа (28.08.2026). До этого деньги клиента
 * были одним числом «из 1С» — записать «клиент заплатил» было некуда.
 * Строки различают источник: 1С-выгрузка или ручной ввод; ручной дубль
 * бухгалтер видит и удаляет сам — автоматической склейки нет намеренно.
 */
export function CustomerPaymentsBlock({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canAdd = hasRole(['accountant', 'sales_manager', 'admin']);
  const canDelete = hasRole(['accountant', 'admin']);

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState<number | string>('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  const { data } = useQuery({
    queryKey: ['customer-payments', orderId],
    queryFn: () => api.get(`/orders/${orderId}/customer-payments`).then((r) => r.data),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['customer-payments', orderId] });
    qc.invalidateQueries({ queryKey: ['order', orderId] });
    qc.invalidateQueries({ queryKey: ['orders'] });
  };

  const add = useMutation({
    mutationFn: () => api.post(`/orders/${orderId}/customer-payments`, {
      amount: Number(amount),
      reference: reference.trim() || undefined,
      note: note.trim() || undefined,
    }).then((r) => r.data),
    onSuccess: (res: any) => {
      invalidate();
      notifications.show({
        title: 'Оплата записана',
        message: `${formatCurrency(res.amount)} · всего оплачено ${formatCurrency(res.orderPaidTotal)}`,
        color: 'success',
        icon: <Icon icon={IconCheck} size={16} />,
      });
      setOpen(false); setAmount(''); setReference(''); setNote('');
    },
    onError: (e: any) => notifications.show({
      title: 'Не записано',
      message: e?.response?.data?.error?.message ?? e?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/customer-payments/${id}`).then((r) => r.data),
    onSuccess: () => {
      invalidate();
      notifications.show({ title: 'Платёж удалён', message: '', color: 'warning' });
    },
    onError: (e: any) => notifications.show({
      title: 'Нельзя удалить',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  const rows: any[] = data?.data ?? EMPTY;
  const paged = usePagedList(rows, DRAWER_PAGE, orderId);

  return (
    <Stack gap={6} mt="sm">
      <Group justify="space-between">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">Платежи</Text>
        {canAdd && (
          <Button size="compact-sm" variant="light" leftSection={<Icon icon={IconPlus} size={16} />} onClick={() => setOpen(true)}>
            Внести оплату
          </Button>
        )}
      </Group>

      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">Платежей пока нет</Text>
      ) : (
        <>
          <FadeSwap swapKey={paged.page}>
            <Stack gap={4}>
              {paged.slice.map((p) => (
                <Group key={p.id} justify="space-between" wrap="nowrap" gap="sm">
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <Text size="sm" ff="monospace" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{formatDate(p.paymentDate)}</Text>
                    {/* 'orange' в теме не объявлен — Mantine брала свой оранжевый (03.09.2026) */}
                    <Badge size="md" fz={12} variant="light" color={p.source === 'MANUAL' ? 'warning' : 'gray'}>
                      {p.source === 'MANUAL' ? 'вручную' : '1С'}
                    </Badge>
                    {p.reference && <Text size="xs" c="dimmed" lineClamp={1}>п/п {p.reference}</Text>}
                  </Group>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={600} ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                      {formatCurrency(p.amount)}
                    </Text>
                    {canDelete && p.source === 'MANUAL' && (
                      <Tooltip label="Удалить (например, дубль с 1С)">
                        <ActionIcon
                          size="md" variant="subtle" color="gray"
                          loading={remove.isPending && remove.variables === p.id}
                          onClick={() => remove.mutate(p.id)}
                          aria-label="Удалить платёж"
                        >
                          <Icon icon={IconTrash} size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                </Group>
              ))}
            </Stack>
          </FadeSwap>
          {paged.total > DRAWER_PAGE && (
            <PaginationBar
              page={paged.page}
              total={paged.total}
              pageSize={DRAWER_PAGE}
              onPageChange={paged.setPage}
              noun="платежей"
              variant="compact"
            />
          )}
        </>
      )}

      <Modal opened={open} onClose={() => setOpen(false)} title={<Text fw={700}>Оплата от заказчика</Text>} radius="md" centered>
        <Stack gap="md">
          <NumberInput
            label="Сумма, ₸"
            value={amount}
            onChange={setAmount}
            min={0}
            thousandSeparator=" "
            autoFocus
          />
          <TextInput label="№ платёжного поручения" placeholder="необязательно" value={reference} onChange={(e) => setReference(e.target.value)} />
          <TextInput label="Примечание" placeholder="необязательно" value={note} onChange={(e) => setNote(e.target.value)} />
          <Text size="xs" c="dimmed">
            Если та же оплата позже придёт из выгрузки 1С, строки будет две —
            удалите ручную, она помечена «вручную».
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>Отмена</Button>
            <Button loading={add.isPending} disabled={!(Number(amount) > 0)} onClick={() => add.mutate()}>
              Записать
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

/**
 * Акты приёмки-передачи по заказу (28.08.2026). Акт собирается из позиций
 * заказа — состав можно порезать (частичная отгрузка). Оформленный акт
 * двигает «отгружено» по позициям, отдельно дублировать не надо.
 */
export function AcceptanceActsBlock({ orderId, lines }: {
  orderId: string;
  lines: Array<{ id: string; qty: number; unitPrice: number; article?: { name: string } | null; description?: string }>;
}) {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const canCreate = hasRole(['accountant', 'sales_manager', 'warehouse_fg', 'admin']);

  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Record<string, { on: boolean; qty: number | string }>>({});

  const { data } = useQuery({
    queryKey: ['acceptance-acts', orderId],
    queryFn: () => api.get('/acceptance-acts', { params: { orderId } }).then((r) => r.data),
  });

  const openModal = () => {
    // По умолчанию — весь заказ: то, что продали, то и передаём
    const init: Record<string, { on: boolean; qty: number | string }> = {};
    for (const l of lines) init[l.id] = { on: true, qty: Number(l.qty) };
    setPicked(init);
    setOpen(true);
  };

  const chosen = lines.filter((l) => picked[l.id]?.on && Number(picked[l.id]?.qty) > 0);
  const total = chosen.reduce(
    (s, l) => s + Number(picked[l.id].qty) * Number(l.unitPrice ?? 0), 0,
  );

  const create = useMutation({
    mutationFn: () => api.post('/acceptance-acts', {
      orderId,
      lines: chosen.map((l) => ({
        orderLineId: l.id,
        qty: Number(picked[l.id].qty),
        unitPrice: Number(l.unitPrice ?? 0),
      })),
    }).then((r) => r.data),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['acceptance-acts', orderId] });
      qc.invalidateQueries({ queryKey: ['order', orderId] });
      notifications.show({
        title: `Акт ${res.appNumber} оформлен`,
        message: `${res.lines.length} позиций на ${formatCurrency(res.totalAmount)} — «отгружено» по позициям обновлено`,
        color: 'success',
        icon: <Icon icon={IconCheck} size={16} />,
        autoClose: 7000,
      });
      setOpen(false);
    },
    onError: (e: any) => notifications.show({
      title: 'Акт не оформлен',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  const acts: any[] = data?.data ?? EMPTY;
  const actsPaged = usePagedList(acts, DRAWER_PAGE, orderId);
  // Состав акта: выбор хранится по id позиции, поэтому страницы ничего не теряют
  const linesPaged = usePagedList(lines, DRAWER_PAGE, open);

  return (
    <Stack gap={6} mt="sm">
      <Divider />
      <Group justify="space-between">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">Акты приёмки-передачи</Text>
        {canCreate && lines.length > 0 && (
          <Button size="compact-sm" variant="light" leftSection={<Icon icon={IconFileInvoice} size={16} />} onClick={openModal}>
            Оформить акт
          </Button>
        )}
      </Group>

      {acts.length === 0 ? (
        <Text size="sm" c="dimmed">Актов по заказу нет</Text>
      ) : (
        <>
          <FadeSwap swapKey={actsPaged.page}>
            <Stack gap={4}>
              {actsPaged.slice.map((a) => (
                <Group key={a.id} justify="space-between" wrap="nowrap">
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" ff="monospace" fw={600}>{a.appNumber}</Text>
                    <Text size="sm" ff="monospace" c="dimmed">{formatDate(a.actDate)}</Text>
                    {a.status && <Badge size="md" fz={12} variant="light" color="gray">{a.status}</Badge>}
                  </Group>
                  <Text size="sm" fw={600} ff="monospace">{formatCurrency(a.totalAmount)}</Text>
                </Group>
              ))}
            </Stack>
          </FadeSwap>
          {actsPaged.total > DRAWER_PAGE && (
            <PaginationBar
              page={actsPaged.page}
              total={actsPaged.total}
              pageSize={DRAWER_PAGE}
              onPageChange={actsPaged.setPage}
              noun="актов"
              variant="compact"
            />
          )}
        </>
      )}

      <Modal opened={open} onClose={() => setOpen(false)} title={<Text fw={700}>Оформить акт приёмки-передачи</Text>} radius="md" size="lg" centered>
        <Stack gap="md">
          <FadeSwap swapKey={linesPaged.page}>
            <TableScroll minWidth={480}>
              <Table verticalSpacing={6}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={44} />
                    <Table.Th>Позиция</Table.Th>
                    <Table.Th ta="right" w={140}>Кол-во</Table.Th>
                    <Table.Th ta="right">Цена</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {linesPaged.slice.map((l) => (
                    <Table.Tr key={l.id}>
                      <Table.Td>
                        <Checkbox
                          checked={picked[l.id]?.on ?? false}
                          onChange={(e) => setPicked((p) => ({ ...p, [l.id]: { ...p[l.id], on: e.currentTarget.checked } }))}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" lineClamp={1}>{l.article?.name ?? l.description ?? '—'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <NumberInput
                          size="sm"
                          value={picked[l.id]?.qty ?? Number(l.qty)}
                          onChange={(v) => setPicked((p) => ({ ...p, [l.id]: { ...p[l.id], qty: v } }))}
                          min={0}
                          max={Number(l.qty)}
                          decimalScale={3}
                          disabled={!picked[l.id]?.on}
                        />
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                        {formatCurrency(Number(l.unitPrice ?? 0))}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </TableScroll>
          </FadeSwap>
          {linesPaged.total > DRAWER_PAGE && (
            <PaginationBar
              page={linesPaged.page}
              total={linesPaged.total}
              pageSize={DRAWER_PAGE}
              onPageChange={linesPaged.setPage}
              noun="позиций"
              variant="compact"
            />
          )}
          <Group justify="space-between">
            <Text size="sm">
              Итого: <Text span fw={700} ff="monospace">{formatCurrency(total)}</Text>
            </Text>
            <Group>
              <Button variant="default" onClick={() => setOpen(false)}>Отмена</Button>
              <Button loading={create.isPending} disabled={chosen.length === 0} onClick={() => create.mutate()}>
                Оформить ({chosen.length} поз.)
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
