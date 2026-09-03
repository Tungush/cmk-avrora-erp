import React, { useMemo, useState } from 'react';
import {
  Card, Stack, Group, Text, Badge, Button, Select, NumberInput,
  ActionIcon, Skeleton, Tooltip,
} from '@mantine/core';
import { IconPlus, IconTrash, IconCheck, IconLock, IconInfoCircle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useBom, useMaterials, useAddBomItem, useUpdateBomItem, useRemoveBomItem } from '../../hooks/useCatalog';
import { useAuthStore } from '../../store/auth';
import { formatDate } from '../../utils/formatters';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { FadeSwap } from '../../components/motion';
import { Ref } from '../../components/EntityRef';

const num = (n: number, d = 2) => n.toLocaleString('ru-RU', { maximumFractionDigits: d });

/** Строк состава на странице: больше — уже не «состав», а простыня */
const BOM_PAGE_SIZE = 25;

/**
 * Строка состава: расход правится на месте, удаление — крестиком.
 *
 * Таблицы здесь больше нет (02.09.2026): шесть колонок не влезали в
 * панель, появлялась боковая прокрутка, а поле расхода наезжало на
 * прилипшую первую колонку — состав читался как поломанный. Строка
 * тянется по ширине контейнера и не уезжает вбок никогда.
 */
function BomRow({
  item, articleId, canEdit,
}: {
  item: any;
  articleId: string;
  canEdit: boolean;
}) {
  const [qty, setQty] = useState<number | string>(Number(item.qtyPerUnit));
  const update = useUpdateBomItem(articleId);
  const remove = useRemoveBomItem(articleId);

  const price = Number(item.material?.purchasePrice ?? 0);
  const lastPrice = Number(item.material?.lastPurchasePrice ?? 0);
  const q = Number(qty) || 0;
  const dirty = q !== Number(item.qtyPerUnit);

  const save = async () => {
    if (!dirty || q <= 0) return;
    try {
      await update.mutateAsync({ id: item.id, qtyPerUnit: q });
    } catch {
      notifications.show({ title: 'Ошибка', message: 'Не удалось изменить расход', color: 'danger' });
    }
  };

  const priceHint = lastPrice > 0
    ? `Последний закуп ${num(lastPrice)} ₸`
      + (item.material?.lastPurchaseDate ? ` от ${formatDate(item.material.lastPurchaseDate)}` : '')
    : 'Закупок ещё не было';

  return (
    <div className="bom-row">
      {/* Название материала переносится на две строки, а не обрывается:
          «Кран мостовой однобалочный подвесной электрический г/п 3,2 тн» в
          одну строку не влезает, и по обрубку материал не узнать
          (03.09.2026, отклик владельца «материалы не полностью прочитать»).
          Код ведёт в карточку материала — остаток, цена, движения */}
      <div className="bom-row__mat">
        <Ref
          kind="material"
          id={item.materialId ?? item.material?.id}
          label={item.material?.name}
          tone="code"
          size="sm"
        >
          {item.material?.materialCode ?? '—'}
        </Ref>
        <span className="bom-row__name">{item.material?.name ?? '—'}</span>
      </div>

      {canEdit ? (
        <NumberInput
          size="xs"
          value={qty}
          onChange={setQty}
          onBlur={save}
          min={0}
          step={0.01}
          decimalScale={4}
          hideControls
          w={92}
          aria-label="Расход на единицу"
          styles={{ input: { textAlign: 'right', fontFamily: 'var(--ff-num)' } }}
          rightSection={dirty ? <IconCheck size={14} style={{ color: 'var(--ok-6)' }} /> : undefined}
        />
      ) : (
        <span className="bom-row__num">{num(Number(item.qtyPerUnit), 4)}</span>
      )}

      <span className="bom-row__unit">{item.material?.unit ?? '—'}</span>

      <Tooltip label={priceHint} openDelay={300}>
        <span className="bom-row__num bom-row__price">{num(price)} ₸</span>
      </Tooltip>

      <span className="bom-row__num bom-row__sum">{num(q * price)} ₸</span>

      {canEdit && (
        <Tooltip label="Убрать из состава">
          <ActionIcon variant="subtle" color="danger" size={28}
            onClick={() => remove.mutate(item.id)} loading={remove.isPending}>
            <IconTrash size={15} />
          </ActionIcon>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * Состав изделия (BOM): из чего собирается ГП и что уйдёт на единицу.
 * Вкладка «Материалы» из макета §3.3 — при выборе изделия видно состав,
 * инженер добавляет позиции и указывает расход; каскад пересчитывает
 * себестоимость точечно.
 */
export function BomPanel({ articleId }: { articleId: string }) {
  const can = useAuthStore((s) => s.can);
  const canEdit = can('write', 'bom.core');

  const { data: bom, isLoading } = useBom(articleId);
  const [materialSearch, setMaterialSearch] = useState('');
  const { data: materialsData } = useMaterials({ search: materialSearch, pageSize: 40 });
  const addItem = useAddBomItem(articleId);

  const [newMaterialId, setNewMaterialId] = useState<string | null>(null);
  const [newQty, setNewQty] = useState<number | string>('');
  const [newOp, setNewOp] = useState<string>('WELDING_ASSEMBLY');

  const materials: any[] = (materialsData as any)?.data ?? [];
  const materialOptions = useMemo(
    () => materials.map((m) => ({ value: m.id, label: `${m.materialCode} · ${m.name}` })),
    [materials],
  );

  const items: any[] = bom ?? [];
  const paged = usePagedList(items, BOM_PAGE_SIZE, articleId);
  const total = items.reduce(
    (s, i) => s + Number(i.qtyPerUnit) * Number(i.material?.purchasePrice ?? 0),
    0,
  );

  const handleAdd = async () => {
    if (!newMaterialId || !(Number(newQty) > 0)) return;
    try {
      await addItem.mutateAsync({ materialId: newMaterialId, qtyPerUnit: Number(newQty), operationType: newOp });
      setNewMaterialId(null);
      setNewQty('');
      notifications.show({ title: 'Позиция добавлена', message: 'Себестоимость пересчитана', color: 'success', icon: <IconCheck size={16} /> });
    } catch (e: any) {
      notifications.show({
        title: 'Ошибка',
        message: e?.response?.data?.error?.message ?? 'Не удалось добавить позицию',
        color: 'danger',
      });
    }
  };

  if (isLoading) return <Skeleton height={280} radius="md" />;

  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
        <Group gap="xs">
          <Text fw={700} size="md">Состав изделия</Text>
          <Badge variant="light" color="gray" size="lg" h={22} px={8}>{items.length} позиций</Badge>
        </Group>
        <Group gap={6} wrap="nowrap">
          <Text size="md" ff="monospace" fw={700}>Материалы: {num(total)} ₸/ед.</Text>
          <Tooltip label="Учётная цена — средневзвешенная по приходам со склада. Приходы приезжают из заказов поставщику в 1С" multiline w={260}>
            <ActionIcon variant="subtle" color="gray" size="md" aria-label="Что такое учётная цена">
              <IconInfoCircle size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {items.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          Состав не заполнен — себестоимость материалов считается нулевой.
          {canEdit ? ' Добавьте позиции ниже.' : ''}
        </Text>
      ) : (
        <Stack gap="xs">
          <FadeSwap swapKey={paged.page}>
            <div className="bom-list" data-editable={canEdit ? 'true' : undefined}>
              <div className="bom-row bom-row--head">
                <span>Материал</span>
                <span>Расход</span>
                <span>Ед.</span>
                <span className="bom-row__price">Цена</span>
                <span>Стоимость</span>
                {canEdit && <span />}
              </div>
              {paged.slice.map((item) => (
                <BomRow key={item.id} item={item} articleId={articleId} canEdit={canEdit} />
              ))}
            </div>
          </FadeSwap>
          {paged.total > BOM_PAGE_SIZE && (
            <PaginationBar
              page={paged.page}
              total={paged.total}
              pageSize={BOM_PAGE_SIZE}
              onPageChange={paged.setPage}
              variant="compact"
              noun="позиций"
            />
          )}
        </Stack>
      )}

      {canEdit ? (
        <Group align="flex-end" gap="sm" mt="md" wrap="wrap">
          <Select
            label="Материал"
            placeholder="Код или название..."
            data={materialOptions}
            value={newMaterialId}
            onChange={setNewMaterialId}
            searchable
            onSearchChange={setMaterialSearch}
            clearable
            style={{ flex: '1 1 280px', minWidth: 0 }}
            nothingFoundMessage="Материал не найден в «Базе сырья»"
          />
          <NumberInput
            label="Расход на ед."
            value={newQty}
            onChange={setNewQty}
            min={0}
            step={0.01}
            decimalScale={4}
            style={{ flex: '0 1 180px', minWidth: 140 }}
          />
          <Button
            size="md"
            leftSection={<IconPlus size={16} />}
            onClick={handleAdd}
            disabled={!newMaterialId || !(Number(newQty) > 0)}
            loading={addItem.isPending}
          >
            Добавить
          </Button>
        </Group>
      ) : (
        <Group gap="xs" mt="sm">
          <IconLock size={14} style={{ color: 'var(--gray-5)' }} />
          <Text size="xs" c="dimmed">Состав меняет инженер (право bom:write)</Text>
        </Group>
      )}
    </Card>
  );
}
