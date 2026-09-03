import React, { useState } from 'react';
import {
  Card, Stack, Group, Text, Table, Badge, TextInput, Select, Skeleton,
  SimpleGrid, Drawer, Divider, Button, Modal, NumberInput,
} from '@mantine/core';
import { IconSearch, IconHistory, IconArrowBarToDown, IconCheck } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { useAuthStore } from '../../store/auth';
import { useMaterials } from '../../hooks/useCatalog';
import { useMaterialMovements } from '../../hooks/useWarehouse';
import { formatDate } from '../../utils/formatters';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePagedList, usePageSize } from '../../components/PaginationBar';
import { FadeSwap } from '../../components/motion';
import { MastLoader } from '../../components/Mast';
import { Ref } from '../../components/EntityRef';

const num = (n: number, d = 2) => n.toLocaleString('ru-RU', { maximumFractionDigits: d });

const CATEGORIES = [
  { value: 'METAL', label: 'Металл' },
  { value: 'HARDWARE', label: 'Метизы' },
  { value: 'COMPONENTS', label: 'Комплектующие' },
  { value: 'CONSUMABLES', label: 'Расходники' },
  { value: 'INSTRUMENTS', label: 'Инструменты' },
];
const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));

/**
 * Списание сырья в производство (28.08.2026). Формы не существовало —
 * API был с первого дня, но вызвать его было неоткуда. Приход по-прежнему
 * не заводится руками: он приезжает из «Заказа поставщику» 1С с ценой.
 * Склад — из справочника 1С: две площадки перестают сливаться в одну цифру.
 */
function IssueModal({ opened, onClose, material }: { opened: boolean; onClose: () => void; material: any | null }) {
  const qc = useQueryClient();
  const [qty, setQty] = useState<number | string>('');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [orderNumber, setOrderNumber] = useState('');

  const { data: warehouses } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => api.get('/warehouse/warehouses').then((r) => r.data),
    enabled: opened,
    staleTime: 300_000,
  });

  const issue = useMutation({
    mutationFn: async () => {
      const q = Number(qty);
      if (!(q > 0)) throw new Error('Укажите количество');
      let orderId: string | null = null;
      if (orderNumber.trim()) {
        const res = await api.get('/orders', { params: { search: orderNumber.trim(), pageSize: 5 } });
        const hit = (res.data?.data ?? []).find(
          (o: any) => o.orderNumber.toLowerCase() === orderNumber.trim().toLowerCase(),
        ) ?? (res.data?.data ?? [])[0];
        if (!hit) throw new Error(`Заказ «${orderNumber}» не найден`);
        orderId = hit.id;
      }
      return api.post('/warehouse/materials/movements', {
        materialId: material.id,
        movementType: 'TO_PRODUCTION',
        qty: q,
        warehouseId,
        orderId,
      }).then((r) => r.data);
    },
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['materials'] });
      qc.invalidateQueries({ queryKey: ['material-movements'] });
      notifications.show({
        title: 'Списано в производство',
        message: `${res.material?.materialCode ?? ''} — ${Number(res.qty)}`
          + (res.warehouse?.name ? ` · ${res.warehouse.name}` : ''),
        color: 'success',
        icon: <IconCheck aria-hidden size={16} />,
      });
      onClose(); setQty(''); setOrderNumber('');
    },
    onError: (e: any) => notifications.show({
      title: 'Не списано',
      message: e?.response?.data?.error?.message ?? e?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  if (!material) return null;
  return (
    <Modal opened={opened} onClose={onClose} radius="md" centered
      title={<Text fw={700}>Списать: {material.materialCode}</Text>}>
      <Stack gap="md">
        <Text size="sm" c="dimmed" lineClamp={2}>{material.name}</Text>
        <NumberInput
          label={`Количество, ${material.unit ?? ''}`}
          description={`на складе ${Number(material.stockQty).toLocaleString('ru-RU')}`}
          value={qty} onChange={setQty} min={0} decimalScale={3} autoFocus
        />
        <Select
          label="С какого склада"
          placeholder="не указан"
          data={(warehouses ?? []).map((w: any) => ({ value: w.id, label: w.name }))}
          value={warehouseId}
          onChange={setWarehouseId}
          searchable clearable
        />
        <TextInput
          label="Под заказ (необязательно)"
          placeholder="Т7АА-002412"
          value={orderNumber}
          onChange={(e) => setOrderNumber(e.target.value)}
        />
        <Text size="xs" c="dimmed">
          Приход руками не заводится — он приезжает из «Заказа поставщику» 1С
          с фактической ценой. Здесь только выдача в цех.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Отмена</Button>
          <Button loading={issue.isPending} onClick={() => issue.mutate()}>Списать</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * История закупок одного материала — «когда и почём брали».
 * Здесь же всё, что на узком экране спрятано из таблицы: категория,
 * учётная цена, последний закуп — карточка полнее строки.
 */
function MovementHistory({ materialId, material }: { materialId: string; material: any }) {
  const { data, isLoading } = useMaterialMovements(materialId);
  const movements = data ?? [];
  const paged = usePagedList(movements, 25, materialId);
  if (isLoading) return <Skeleton height={200} radius="md" />;

  const stock = Number(material.stockQty);
  const price = Number(material.purchasePrice);

  return (
    <Stack gap="md">
      <Group gap="sm" wrap="wrap">
        <Badge variant="light" color="gray" size="md">
          {CATEGORY_LABELS[material.category] ?? material.category}
        </Badge>
        <Text size="sm" c="dimmed">
          Остаток <Text span fw={700} ff="monospace" c="var(--gray-9)">{num(stock, 3)} {material.unit}</Text>
        </Text>
        <Text size="sm" c="dimmed">
          Стоимость запаса <Text span fw={700} ff="monospace" c="var(--gray-9)">{num(stock * price, 0)} ₸</Text>
        </Text>
      </Group>

      <SimpleGrid cols={2} spacing="sm">
        <Card withBorder radius="md" padding="sm">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={2}>Учётная цена</Text>
          <Text size="lg" fw={700} ff="monospace">{num(price)} ₸</Text>
          <Text size="xs" c="dimmed">средневзвешенная по приходам</Text>
        </Card>
        <Card withBorder radius="md" padding="sm">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={2}>Последний закуп</Text>
          <Text size="lg" fw={700} ff="monospace">
            {Number(material.lastPurchasePrice) > 0 ? `${num(Number(material.lastPurchasePrice))} ₸` : '—'}
          </Text>
          <Text size="xs" c="dimmed">
            {material.lastPurchaseDate ? formatDate(material.lastPurchaseDate) : 'приходов не было'}
          </Text>
        </Card>
      </SimpleGrid>

      <Divider label="История движений" labelPosition="center" />

      {movements.length === 0 ? (
        <Text size="sm" c="dimmed" ta="center" py="md">Движений нет</Text>
      ) : (
        <>
          <FadeSwap swapKey={paged.page}>
            <TableScroll minWidth={520}>
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Дата</Table.Th>
                    <Table.Th ta="right">Кол-во</Table.Th>
                    <Table.Th ta="right">Цена</Table.Th>
                    <Table.Th>Документ</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {paged.slice.map((m) => (
                    <Table.Tr key={m.id}>
                      <Table.Td ff="monospace">{formatDate(m.movementDate)}</Table.Td>
                      <Table.Td ff="monospace" ta="right">{num(Number(m.qty), 3)}</Table.Td>
                      <Table.Td ff="monospace" ta="right">
                        <Group gap={6} justify="flex-end" wrap="nowrap">
                          {m.priceAnomaly && (
                            <Badge color="danger" variant="light" size="sm" radius="xl">карантин</Badge>
                          )}
                          {Number(m.unitPrice) > 0 ? `${num(Number(m.unitPrice))} ₸` : '—'}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace">{m.documentNumber ?? '—'}</Text>
                        {m.comment && <Text size="xs" c="dimmed" lineClamp={1}>{m.comment}</Text>}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </TableScroll>
          </FadeSwap>
          <PaginationBar
            page={paged.page}
            total={paged.total}
            pageSize={25}
            onPageChange={paged.setPage}
            noun="движений"
            variant="compact"
          />
        </>
      )}
    </Stack>
  );
}

/**
 * База сырья: что есть на складе и по какой цене закуплено.
 * Данные живые (не Excel-архив): учётная цена отсюда идёт в себестоимость
 * при сборке спецификации.
 */
/**
 * @param only — какие категории показывать. «Склад сырья» — то, из чего
 * делают изделия; «Кладовая» — расходники и инструмент. Разделения по
 * настоящим складам 1С («74п_Склад Сырья», «74п_Кладовая_ЦМК») в остатках
 * нет: колонка склада в выгрузке пустая, поэтому делим по категории.
 * @param pageKey — под каким ключом помнить размер страницы (у сырья
 * и кладовой — свой).
 */
export function MaterialsStock({ only, pageKey }: { only?: string[]; pageKey?: string } = {}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(pageKey ?? 'warehouse-stock', 50);
  const [selected, setSelected] = useState<any>(null);
  const [issueFor, setIssueFor] = useState<any>(null);
  const hasRole = useAuthStore((s) => s.hasRole);
  const canIssue = hasRole(['warehouse_material', 'admin']);

  const visibleCategories = only
    ? CATEGORIES.filter((c) => only.includes(c.value))
    : CATEGORIES;

  const { data, isLoading } = useMaterials({
    search,
    ...(category ? { category } : only ? { categories: only.join(',') } : {}),
    page,
    pageSize,
  });
  const materials: any[] = (data as any)?.data ?? [];
  const total = (data as any)?.meta?.total ?? materials.length;

  const stockValue = materials.reduce(
    (s, m) => s + Number(m.stockQty) * Number(m.purchasePrice),
    0,
  );

  return (
    <Stack gap="md">
      <div className="toolbar-sticky">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="sm" wrap="wrap">
            <TextInput
              placeholder="Код или наименование…"
              leftSection={<IconSearch aria-hidden size={16} />}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              w={300}
            />
            <Select
              placeholder="Все категории"
              data={visibleCategories}
              value={category}
              onChange={(v) => { setCategory(v); setPage(1); }}
              clearable
              w={210}
            />
          </Group>
          <Group gap="lg" wrap="wrap">
            <Text size="sm" c="dimmed">
              Номенклатуры:{' '}
              <Text span fw={700} ff="monospace" c="var(--gray-9)">{total.toLocaleString('ru-RU')}</Text>
            </Text>
            <Text size="sm" c="dimmed">
              Запас на странице:{' '}
              <Text span fw={700} ff="monospace" c="var(--gray-9)">{num(stockValue, 0)} ₸</Text>
            </Text>
          </Group>
        </Group>
      </div>

      <FadeSwap swapKey={`${page}-${pageSize}`}>
        <Card withBorder radius="md" padding={0}>
          {isLoading ? (
            <Stack gap={6} p="md">
              {[...Array(10)].map((_, i) => <Skeleton key={i} height={40} radius="sm" />)}
            </Stack>
          ) : (
            <TableScroll minWidth={canIssue ? 1000 : 900}>
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Код</Table.Th>
                    <Table.Th>Наименование</Table.Th>
                    <Table.Th data-priority="3">Категория</Table.Th>
                    <Table.Th ta="right">Остаток</Table.Th>
                    <Table.Th ta="right" data-priority="2">Учётная цена</Table.Th>
                    <Table.Th ta="right" data-priority="3">Последний закуп</Table.Th>
                    <Table.Th ta="right">Стоимость запаса</Table.Th>
                    {canIssue && <Table.Th w={120} />}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {materials.map((m) => {
                    const stock = Number(m.stockQty);
                    const price = Number(m.purchasePrice);
                    const last = Number(m.lastPurchasePrice);
                    return (
                      <Table.Tr
                        key={m.id}
                        onClick={() => setSelected(m)}
                        data-clickable
                      >
                        <Table.Td>
                          {/* Код ведёт в общую карточку материала (движения,
                              цены, где применяется); клик по строке остаётся
                              историей закупок этого экрана — Ref гасит всплытие */}
                          <Ref kind="material" id={m.id} label={m.name} tone="code" size="sm">
                            {m.materialCode}
                          </Ref>
                        </Table.Td>
                        <Table.Td><Text size="sm" lineClamp={1}>{m.name}</Text></Table.Td>
                        <Table.Td data-priority="3">
                          <Badge variant="light" color="gray" size="sm">
                            {CATEGORY_LABELS[m.category] ?? m.category}
                          </Badge>
                        </Table.Td>
                        <Table.Td ff="monospace" ta="right">
                          {num(stock, 3)} {m.unit}
                        </Table.Td>
                        <Table.Td ff="monospace" ta="right" data-priority="2">
                          {price > 0 ? `${num(price)} ₸` : '—'}
                        </Table.Td>
                        <Table.Td ta="right" data-priority="3">
                          {last > 0 ? (
                            <Stack gap={0}>
                              <Text size="sm" ff="monospace">{num(last)} ₸</Text>
                              {m.lastPurchaseDate && (
                                <Text size="xs" c="dimmed">{formatDate(m.lastPurchaseDate)}</Text>
                              )}
                            </Stack>
                          ) : <Text size="sm" c="dimmed">—</Text>}
                        </Table.Td>
                        <Table.Td ff="monospace" fw={600} ta="right">
                          {num(stock * price, 0)} ₸
                        </Table.Td>
                        {canIssue && (
                          <Table.Td>
                            <Button
                              size="compact-sm"
                              variant="light"
                              leftSection={<IconArrowBarToDown aria-hidden size={16} />}
                              onClick={(e) => { e.stopPropagation(); setIssueFor(m); }}
                            >
                              Списать
                            </Button>
                          </Table.Td>
                        )}
                      </Table.Tr>
                    );
                  })}
                  {materials.length === 0 && (
                    <Table.Tr>
                      <Table.Td colSpan={canIssue ? 8 : 7}>
                        <MastLoader height={132} sections={5} title="Материалов по такому запросу нет" />
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Table.Tbody>
              </Table>
            </TableScroll>
          )}
        </Card>
      </FadeSwap>

      <PaginationBar
        page={page}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        noun="позиций"
        sticky
      />

      <Drawer
        opened={selected !== null}
        onClose={() => setSelected(null)}
        position="right"
        size="lg"
        padding="md"
        title={
          <Group gap="xs">
            <IconHistory aria-hidden size={16} />
            <Text fw={700}>{selected?.materialCode} · {selected?.name}</Text>
          </Group>
        }
      >
        {selected && <MovementHistory materialId={selected.id} material={selected} />}
      </Drawer>
      <IssueModal opened={issueFor !== null} onClose={() => setIssueFor(null)} material={issueFor} />
    </Stack>
  );
}
