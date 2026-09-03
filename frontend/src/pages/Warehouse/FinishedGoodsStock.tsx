import React, { useState } from 'react';
import {
  Card, Stack, Text, Table, Badge, Skeleton, Group, Button, Modal,
  Select, NumberInput, TextInput, SegmentedControl, Tabs,
} from '@mantine/core';
import { IconPlus, IconCheck } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { useAuthStore } from '../../store/auth';
import { useArticles } from '../../hooks/useCatalog';
import { formatDate, formatMoney } from '../../utils/formatters';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePageSize } from '../../components/PaginationBar';
import { FadeSwap } from '../../components/motion';

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
/**
 * Пять чужих оттенков (teal / cyan / blue / orange) свелись к знаку
 * движения (03.09.2026): в теме их нет, Mantine рисовала дефолтные.
 * Приход — зелёным, расход — чернилами, коррекция — тихо.
 */
const MOVEMENT_COLORS: Record<string, string> = {
  RECEIPT: 'success', FROM_PRODUCTION: 'success', RETURN: 'success',
  SHIPMENT: 'ink', EXPENSE: 'ink', TO_PRODUCTION: 'ink', CORRECTION: 'gray',
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
        icon: <IconCheck aria-hidden size={16} />,
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

function TableSkeleton() {
  return (
    <Stack gap={6} p="md">
      {[...Array(6)].map((_, i) => <Skeleton key={i} height={40} radius="sm" />)}
    </Stack>
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
  const [pageSize, setPageSize] = usePageSize('warehouse-fg', 50);
  const changePageSize = (s: number) => { setPageSize(s); setBalancePage(1); setMovesPage(1); };

  const { data: balance, isLoading: loadingBalance } = useQuery({
    queryKey: ['fg-balance', balancePage, pageSize],
    queryFn: () => api.get('/warehouse/finished-goods/balance', { params: { page: balancePage, pageSize } }).then((r) => r.data),
  });
  const { data: movements, isLoading: loadingMoves } = useQuery({
    queryKey: ['fg-stock', movesPage, pageSize],
    queryFn: () => api.get('/warehouse/finished-goods', { params: { page: movesPage, pageSize } }).then((r) => r.data),
  });

  const balanceRows: any[] = balance?.data ?? [];
  const moveRows: any[] = movements?.data ?? [];
  const balanceTotal: number = balance?.meta?.total ?? balanceRows.length;
  const movesTotal: number = movements?.meta?.total ?? moveRows.length;

  const balanceTable = (
    <Card withBorder radius="md" padding={0}>
      {loadingBalance ? <TableSkeleton /> : (
        <TableScroll minWidth={680}>
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
                    <Text size="sm" ff="monospace" fw={600}>{r.articleCode}</Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>{r.name}</Text>
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    <Text span fw={700} c={r.stockQty < 0 ? 'danger' : undefined}>
                      {num(r.stockQty, 3)}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {r.valueEstimate ? formatMoney(r.valueEstimate) : '—'}
                  </Table.Td>
                  <Table.Td ff="monospace">{formatDate(r.lastMovementAt)}</Table.Td>
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
        </TableScroll>
      )}
    </Card>
  );

  const journalTable = (
    <Card withBorder radius="md" padding={0}>
      {loadingMoves ? <TableSkeleton /> : (
        <TableScroll minWidth={780}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Изделие</Table.Th>
                <Table.Th>Дата</Table.Th>
                <Table.Th>Движение</Table.Th>
                <Table.Th ta="right">Количество</Table.Th>
                <Table.Th>Заказ</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {moveRows.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>
                    <Text size="sm" ff="monospace" fw={600}>{r.article?.articleCode ?? '—'}</Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>{r.article?.name ?? '—'}</Text>
                  </Table.Td>
                  <Table.Td ff="monospace">{formatDate(r.movementDate)}</Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" color={MOVEMENT_COLORS[r.movementType] ?? 'gray'}>
                      {MOVEMENT_LABELS[r.movementType] ?? r.movementType}
                    </Badge>
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" fw={600}>{num(Number(r.qty), 3)}</Table.Td>
                  <Table.Td ff="monospace">{r.order?.orderNumber ?? '—'}</Table.Td>
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
        </TableScroll>
      )}
    </Card>
  );

  return (
    <Stack gap="md">
      <div className="toolbar-sticky">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="lg" wrap="wrap">
            <Text size="sm" c="dimmed">
              Стоимость склада (по утв. ценам):{' '}
              <Text span fw={700} ff="monospace" c="var(--gray-9)">{formatMoney(balance?.totalValue ?? 0)}</Text>
            </Text>
            <Text size="sm" c="dimmed">
              Изделий на складе:{' '}
              <Text span fw={700} ff="monospace" c="var(--gray-9)">{balanceTotal.toLocaleString('ru-RU')}</Text>
            </Text>
          </Group>
          {canEdit && (
            <Button leftSection={<IconPlus aria-hidden size={16} />} onClick={() => setModalOpen(true)}>
              Принять / отгрузить
            </Button>
          )}
        </Group>
      </div>

      <Tabs value={tab} onChange={(v) => setTab(v ?? 'balance')} radius="md">
        <Tabs.List>
          <Tabs.Tab value="balance">Остатки</Tabs.Tab>
          <Tabs.Tab value="journal">Журнал движений</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      <FadeSwap swapKey={tab === 'balance' ? `balance-${balancePage}-${pageSize}` : `journal-${movesPage}-${pageSize}`}>
        {tab === 'balance' ? balanceTable : journalTable}
      </FadeSwap>

      {tab === 'balance' ? (
        <>
          <PaginationBar
            page={balancePage}
            total={balanceTotal}
            pageSize={pageSize}
            onPageChange={setBalancePage}
            onPageSizeChange={changePageSize}
            noun="изделий"
            sticky
          />
          {balanceRows.some((r) => r.stockQty < 0) && (
            <Text size="xs" c="dimmed">
              Отрицательный остаток — отгрузок записано больше, чем приходов.
              Обычно это значит, что цех не сдавал выпуск: поправьте коррекцией
              или дозапишите приходы.
            </Text>
          )}
        </>
      ) : (
        <PaginationBar
          page={movesPage}
          total={movesTotal}
          pageSize={pageSize}
          onPageChange={setMovesPage}
          onPageSizeChange={changePageSize}
          noun="движений"
          sticky
        />
      )}

      <MovementModal opened={modalOpen} onClose={() => setModalOpen(false)} />
    </Stack>
  );
}
