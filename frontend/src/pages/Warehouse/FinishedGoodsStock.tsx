import React, { useState } from 'react';
import {
  Card, Stack, Text, Table, Badge, Skeleton, Box, Group, Button, Modal,
  Select, NumberInput, TextInput, SegmentedControl, Tabs, Pagination,
} from '@mantine/core';
import { IconPlus, IconTruck, IconCheck, IconAdjustments } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { useAuthStore } from '../../store/auth';
import { useArticles } from '../../hooks/useCatalog';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { formatDate, formatMoney } from '../../utils/formatters';

const num = (n: number, d = 2) => n.toLocaleString('ru-RU', { maximumFractionDigits: d });

const MOVEMENT_LABELS: Record<string, string> = {
  RECEIPT: 'приход',
  FROM_PRODUCTION: 'с производства',
  RETURN: 'возврат',
  SHIPMENT: 'отгрузка',
  EXPENSE: 'расход',
  TO_PRODUCTION: 'в производство',
  CORRECTION: 'коррекция',
};
const MOVEMENT_COLORS: Record<string, string> = {
  RECEIPT: 'teal', FROM_PRODUCTION: 'teal', RETURN: 'cyan',
  SHIPMENT: 'blue', EXPENSE: 'orange', TO_PRODUCTION: 'orange', CORRECTION: 'gray',
};

/**
 * Форма движения ГП (28.08.2026). До неё экран был только на просмотр:
 * кладовщик не мог нажать «сдал на склад 10 штук» — некуда. Три жеста:
 * принять выпуск, отгрузить заказчику, поправить коррекцией.
 */
function MovementModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'приход' | 'отгрузка' | 'коррекция'>('приход');
  const [articleId, setArticleId] = useState<string | null>(null);
  const [qty, setQty] = useState<number | string>('');
  const [orderNumber, setOrderNumber] = useState('');
  const [search, setSearch] = useState('');

  const { data: articles } = useArticles({ search, pageSize: 30 });
  const options = (articles?.data ?? []).map((a: any) => ({
    value: a.id,
    label: `${a.articleCode} · ${a.name}`,
  }));

  const save = useMutation({
    mutationFn: async () => {
      if (!articleId) throw new Error('Выберите изделие');
      const q = Number(qty);
      if (!Number.isFinite(q) || q === 0) throw new Error('Укажите количество');
      if (kind !== 'коррекция' && q < 0) throw new Error('Количество должно быть больше нуля');

      // Заказ ищем по номеру: кладовщик знает «Т7АА-002412», а не uuid
      let orderId: string | null = null;
      if (orderNumber.trim()) {
        const res = await api.get('/orders', { params: { search: orderNumber.trim(), pageSize: 5 } });
        const hit = (res.data?.data ?? []).find(
          (o: any) => o.orderNumber.toLowerCase() === orderNumber.trim().toLowerCase(),
        ) ?? (res.data?.data ?? [])[0];
        if (!hit) throw new Error(`Заказ «${orderNumber}» не найден`);
        orderId = hit.id;
      }
      if (kind === 'отгрузка' && !orderId) {
        throw new Error('Для отгрузки укажите заказ — без него state machine не увидит «отгружено»');
      }

      return api.post('/warehouse/finished-goods/movements', {
        articleId,
        movementType: kind,
        qty: q,
        orderId,
      }).then((r) => r.data);
    },
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['fg-stock'] });
      qc.invalidateQueries({ queryKey: ['fg-balance'] });
      notifications.show({
        title: kind === 'приход' ? 'Принято на склад' : kind === 'отгрузка' ? 'Отгружено' : 'Коррекция записана',
        message: `${res.article?.articleCode ?? ''} — ${num(Number(res.qty), 3)}`
          + (res.order?.orderNumber ? ` · заказ ${res.order.orderNumber}` : ''),
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      onClose();
      setQty(''); setOrderNumber('');
    },
    onError: (e: any) => notifications.show({
      title: 'Не записано',
      message: e?.response?.data?.error?.message ?? e?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={700}>Движение готовой продукции</Text>} radius="md" centered>
      <Stack gap="md">
        <SegmentedControl
          fullWidth
          value={kind}
          onChange={(v) => setKind(v as any)}
          data={[
            { value: 'приход', label: 'Принять' },
            { value: 'отгрузка', label: 'Отгрузить' },
            { value: 'коррекция', label: 'Коррекция' },
          ]}
        />
        <Select
          label="Изделие"
          placeholder="код или название…"
          searchable
          data={options}
          value={articleId}
          onChange={setArticleId}
          onSearchChange={setSearch}
          nothingFoundMessage="Не найдено — проверьте код"
        />
        <NumberInput
          label={kind === 'коррекция' ? 'Поправка (можно с минусом)' : 'Количество'}
          description={kind === 'коррекция'
            ? '«на складе оказалось меньше» — вводите отрицательное число'
            : undefined}
          value={qty}
          onChange={setQty}
          decimalScale={3}
          {...(kind !== 'коррекция' ? { min: 0 } : {})}
        />
        <TextInput
          label={kind === 'отгрузка' ? 'Заказ (обязательно)' : 'Заказ (необязательно)'}
          placeholder="Т7АА-002412"
          value={orderNumber}
          onChange={(e) => setOrderNumber(e.target.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Отмена</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>Записать</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * Склад готовой продукции (28.08.2026): живые остатки из движений + журнал.
 * Раньше остаток был захардкоженным нулём, а экран — только на просмотр.
 */
export function FinishedGoodsStock() {
  const hasRole = useAuthStore((s) => s.hasRole);
  const canEdit = hasRole(['warehouse_fg', 'shop_foreman', 'admin']);
  const [modalOpen, setModalOpen] = useState(false);
  const [tab, setTab] = useState<string>('balance');
  const [balancePage, setBalancePage] = useState(1);
  const [movesPage, setMovesPage] = useState(1);
  const pageSize = 100;

  const { data: balance, isLoading: loadingBalance } = useQuery({
    queryKey: ['fg-balance', balancePage],
    queryFn: () => api.get('/warehouse/finished-goods/balance', { params: { page: balancePage, pageSize } }).then((r) => r.data),
  });
  const { data: movements, isLoading: loadingMoves } = useQuery({
    queryKey: ['fg-stock', movesPage],
    queryFn: () => api.get('/warehouse/finished-goods', { params: { page: movesPage, pageSize } }).then((r) => r.data),
  });

  const balanceRows: any[] = balance?.data ?? [];
  const moveRows: any[] = movements?.data ?? [];
  const balanceTotalPages = Math.max(1, Math.ceil((balance?.meta?.total ?? 0) / pageSize));
  const movesTotalPages = Math.max(1, Math.ceil((movements?.meta?.total ?? 0) / pageSize));

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="sm" c="dimmed">
          Стоимость склада (по утв. ценам):{' '}
          <Text span fw={700} ff="monospace">{formatMoney(balance?.totalValue ?? 0)}</Text>
        </Text>
        {canEdit && (
          <Button leftSection={<IconPlus size={16} />} size="sm" onClick={() => setModalOpen(true)}>
            Принять / отгрузить
          </Button>
        )}
      </Group>

      <Tabs value={tab} onChange={(v) => setTab(v ?? 'balance')} radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="balance">Остатки</Tabs.Tab>
          <Tabs.Tab value="journal">Журнал движений</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="balance">
          <Card withBorder radius="md" padding={0}>
            {loadingBalance ? (
              <Stack gap={4} p="md">{[...Array(6)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}</Stack>
            ) : (
              <Box style={{ overflowX: 'auto' }}>
                <Table highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Изделие</Table.Th>
                      <Table.Th ta="right">Остаток</Table.Th>
                      <Table.Th ta="right">Оценка</Table.Th>
                      <Table.Th>Последнее движение</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {balanceRows.map((r) => (
                      <Table.Tr key={r.articleId}>
                        <Table.Td>
                          <Text size="sm" ff="monospace" fw={600} c="brand.7">{r.articleCode}</Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>{r.name}</Text>
                        </Table.Td>
                        <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                          <Text span fw={700} c={r.stockQty < 0 ? 'danger' : undefined}>
                            {num(r.stockQty, 3)}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                          {r.valueEstimate ? formatMoney(r.valueEstimate) : '—'}
                        </Table.Td>
                        <Table.Td ff="monospace" fz="xs">{formatDate(r.lastMovementAt)}</Table.Td>
                      </Table.Tr>
                    ))}
                    {balanceRows.length === 0 && (
                      <Table.Tr>
                        <Table.Td colSpan={4}>
                          <Text size="sm" c="dimmed" ta="center" py="lg">
                            Движений ещё нет — примите первый выпуск кнопкой сверху
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Table.Tbody>
                </Table>
              </Box>
            )}
          </Card>
          {balanceTotalPages > 1 && (
            <Group justify="center" mt="md">
              <Pagination value={balancePage} onChange={setBalancePage} total={balanceTotalPages} size="sm" radius="md" />
            </Group>
          )}
          {balanceRows.some((r) => r.stockQty < 0) && (
            <Text size="xs" c="dimmed" mt="xs">
              Отрицательный остаток — отгрузок записано больше, чем приходов.
              Обычно это значит, что цех не сдавал выпуск: поправьте коррекцией
              или дозапишите приходы.
            </Text>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="journal">
          <Card withBorder radius="md" padding={0}>
            {loadingMoves ? (
              <Stack gap={4} p="md">{[...Array(6)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}</Stack>
            ) : (
              <Box style={{ overflowX: 'auto' }}>
                <Table highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Дата</Table.Th>
                      <Table.Th>Изделие</Table.Th>
                      <Table.Th>Заказ</Table.Th>
                      <Table.Th ta="right">Количество</Table.Th>
                      <Table.Th>Движение</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {moveRows.map((r) => (
                      <Table.Tr key={r.id}>
                        <Table.Td ff="monospace" style={{ whiteSpace: 'nowrap' }}>{formatDate(r.movementDate)}</Table.Td>
                        <Table.Td>
                          <Text size="sm" ff="monospace" fw={600} c="brand.7">{r.article?.articleCode ?? '—'}</Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>{r.article?.name ?? '—'}</Text>
                        </Table.Td>
                        <Table.Td ff="monospace" fz="xs">{r.order?.orderNumber ?? '—'}</Table.Td>
                        <Table.Td ta="right" ff="monospace">{num(Number(r.qty), 3)}</Table.Td>
                        <Table.Td>
                          <Badge size="xs" variant="light" color={MOVEMENT_COLORS[r.movementType] ?? 'gray'}>
                            {MOVEMENT_LABELS[r.movementType] ?? r.movementType}
                          </Badge>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                    {moveRows.length === 0 && (
                      <Table.Tr>
                        <Table.Td colSpan={5}>
                          <Text size="sm" c="dimmed" ta="center" py="lg">Движений нет</Text>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Table.Tbody>
                </Table>
              </Box>
            )}
          </Card>
          {movesTotalPages > 1 && (
            <Group justify="center" mt="md">
              <Pagination value={movesPage} onChange={setMovesPage} total={movesTotalPages} size="sm" radius="md" />
            </Group>
          )}
        </Tabs.Panel>
      </Tabs>

      <MovementModal opened={modalOpen} onClose={() => setModalOpen(false)} />
    </Stack>
  );
}
