import React, { useMemo, useState } from 'react';
import {
  Stack, Group, Text, Card, TextInput, NumberInput, Select, Button, Badge,
  Skeleton, Box, Progress, Divider, ActionIcon, Tooltip, ScrollArea, Modal, Table, Tabs,
} from '@mantine/core';
import {
  IconSearch, IconLock, IconRefresh, IconCheck, IconAlertTriangle,
  IconArrowUp, IconScissors, IconFlame, IconBrush, IconHelpCircle,
  IconHistory,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useMediaQuery } from '@mantine/hooks';
import { useArticles } from '../../hooks/useCatalog';
import {
  useRouting, useCosting, useWorkCenters, useSaveNorm, useSaveActual, usePromoteActual,
  usePreviewNorm, useUsage, useNormHistory, useCostingHistory, useRequestPriceReview,
} from '../../hooks/useRouting';
import { useAuthStore } from '../../store/auth';
import { useLiveCostUpdates } from '../../hooks/useLiveEvents';
import { BomPanel } from './BomPanel';
import { RequestNomenclatureModal, NomenclatureRequestsButton } from './NomenclaturePanel';
import type { CostingPreviewResponse, RoutingStageCode, RoutingStageRow } from '../../api/routing';
import { formatCurrency, formatDate } from '../../utils/formatters';

const STAGE_ICONS: Record<RoutingStageCode, React.ComponentType<{ size?: number }>> = {
  CUTTING: IconScissors,
  ASSEMBLY: IconFlame,
  PAINTING: IconBrush,
};

const num = (n: number, digits = 2) =>
  n.toLocaleString('ru-RU', { maximumFractionDigits: digits });

/**
 * Предпросмотр влияния (§2.3 ④): последствия правки нормы до сохранения —
 * ровно то, чего не даёт Google Sheets, где правка молча меняет 12 заказов.
 */
function ImpactPreviewModal({
  preview, stageLabel, opened, onCancel, onApply, applying,
}: {
  preview: CostingPreviewResponse | null;
  stageLabel: string;
  opened: boolean;
  onCancel: () => void;
  onApply: () => void;
  applying: boolean;
}) {
  if (!preview) return null;
  const changed = preview.impact.filter((l) => l.delta !== 0);
  const { affected } = preview;

  return (
    <Modal
      opened={opened}
      onClose={onCancel}
      title={
        <Group gap="xs">
          <IconAlertTriangle size={18} style={{ color: 'var(--mantine-color-warning-6)' }} />
          <Text fw={700}>Изменение затронет связанные данные</Text>
        </Group>
      }
      size="lg"
      radius="md"
      centered
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">Правка нормы «{stageLabel}» — пересчитается сразу:</Text>

        <Stack gap={6}>
          {(changed.length > 0 ? changed : preview.impact).map((l) => (
            <Group key={l.label} justify="space-between" wrap="nowrap">
              <Text size="sm">{l.label}</Text>
              <Group gap={8} wrap="nowrap">
                <Text size="sm" ff="monospace" c="dimmed">
                  {num(l.before, l.unit === '₸' ? 2 : 3)} {l.unit}
                </Text>
                <Text size="sm" c="dimmed">→</Text>
                <Text size="sm" ff="monospace" fw={700}>
                  {num(l.after, l.unit === '₸' ? 2 : 3)} {l.unit}
                </Text>
                {l.deltaPct != null && l.deltaPct !== 0 && (
                  <Badge
                    size="sm"
                    radius="xl"
                    variant="light"
                    color={l.delta > 0 ? 'warning' : 'success'}
                  >
                    {l.delta > 0 ? '+' : ''}{num(l.deltaPct, 1)} %
                  </Badge>
                )}
              </Group>
            </Group>
          ))}
        </Stack>

        <Divider />

        <Group gap="xs">
          <Text size="sm" fw={600}>Затронет:</Text>
          <Text size="sm">
            {affected.linesCount} позиций в {affected.ordersCount} активных заказах
            {affected.totalQty > 0 && ` · ${num(affected.totalQty, 0)} шт`}
          </Text>
        </Group>

        {affected.negativeMarginCount > 0 && (
          <Card padding="sm" radius="md" bg="light-dark(var(--mantine-color-danger-0), rgba(229, 72, 77, 0.12))" withBorder
            style={{ border: '1px solid var(--mantine-color-danger-3)' }}>
            <Group gap="xs" mb={6}>
              <IconAlertTriangle size={15} style={{ color: 'var(--mantine-color-danger-6)' }} />
              <Text size="sm" fw={600} c="danger.7">
                У {affected.negativeMarginCount} заказ(ов) цена продажи станет ниже себестоимости
              </Text>
            </Group>
            <Stack gap={2}>
              {affected.negativeMarginOrders.slice(0, 5).map((o) => (
                <Text key={o.orderNumber} size="xs" c="danger.7" ff="monospace">
                  {o.orderNumber} · {o.customer ?? '—'} · цена {num(o.unitPrice)} ₸ &lt; себест. {num(o.newCost)} ₸
                </Text>
              ))}
            </Stack>
          </Card>
        )}

        {preview.approvedPrice != null && preview.approvedPrice > 0 && (
          <Text size="xs" c="dimmed">
            Утверждённая цена в прайсе ({formatCurrency(preview.approvedPrice)}) не изменится —
            требуется отдельное согласование директора.
          </Text>
        )}

        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>Отмена</Button>
          <Button onClick={onApply} loading={applying}>Применить и пересчитать</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Карточка одного передела: норма (engineer) + факт (shop_foreman) */
function StageCard({
  row, articleId, workCenters,
}: {
  row: RoutingStageRow;
  articleId: string;
  workCenters: Array<{ id: string; code: string; name: string; stage: RoutingStageCode; hourlyRate: number }>;
}) {
  const can = useAuthStore((s) => s.can);
  const canNorm = can('write', 'routing.norm');
  const canActual = can('write', 'routing.actual');

  const [workers, setWorkers] = useState<number | string>(row.workers || '');
  const [hours, setHours] = useState<number | string>(row.hoursPerUnit || '');
  const [workCenterId, setWorkCenterId] = useState<string | null>(row.workCenter?.id ?? null);
  const [actualWorkers, setActualWorkers] = useState<number | string>(row.actualWorkers ?? '');
  const [actualHours, setActualHours] = useState<number | string>(row.actualHours ?? '');

  const saveNorm = useSaveNorm(articleId);
  const saveActual = useSaveActual(articleId);
  const promote = usePromoteActual(articleId);
  const previewNorm = usePreviewNorm(articleId);
  const [preview, setPreview] = useState<CostingPreviewResponse | null>(null);

  const stageCenters = workCenters.filter((wc) => wc.stage === row.stage);
  const rate = stageCenters.find((wc) => wc.id === workCenterId)?.hourlyRate ?? row.hourlyRate;
  const w = Number(workers) || 0;
  const h = Number(hours) || 0;
  const manHours = Math.round(w * h * 1000) / 1000;
  const stageCost = Math.round(manHours * rate * 100) / 100;

  const dirty = w !== row.workers || h !== row.hoursPerUnit || (workCenterId ?? null) !== (row.workCenter?.id ?? null);
  const Icon = STAGE_ICONS[row.stage];

  const applyNorm = async () => {
    try {
      await saveNorm.mutateAsync({ stage: row.stage, workers: w, hoursPerUnit: h, workCenterId: workCenterId ?? undefined });
      setPreview(null);
      notifications.show({ title: 'Норма сохранена', message: `${row.label}: ${w} чел × ${h} ч`, color: 'success', icon: <IconCheck size={16} /> });
    } catch {
      notifications.show({ title: 'Ошибка', message: 'Не удалось сохранить норму', color: 'danger' });
    }
  };

  // Сначала предпросмотр влияния (§2.3 ④); сохранение — после подтверждения в модале
  const handleSaveNorm = async () => {
    try {
      const p = await previewNorm.mutateAsync({
        stage: row.stage, workers: w, hoursPerUnit: h, workCenterId: workCenterId ?? undefined,
      });
      setPreview(p);
    } catch {
      // предпросмотр недоступен (нет сети/прав) — сохраняем напрямую, как раньше
      await applyNorm();
    }
  };

  const handleSaveActual = async () => {
    try {
      await saveActual.mutateAsync({ stage: row.stage, actualWorkers: Number(actualWorkers), actualHours: Number(actualHours) });
      notifications.show({ title: 'Факт зафиксирован', message: row.label, color: 'success', icon: <IconCheck size={16} /> });
    } catch {
      notifications.show({ title: 'Ошибка', message: 'Не удалось сохранить факт', color: 'danger' });
    }
  };

  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" wrap="nowrap" mb="sm">
        <Group gap="xs" wrap="nowrap">
          <Icon size={18} />
          <Text fw={700} size="sm">{row.label}</Text>
          {!row.exists && (
            <Badge color="warning" variant="light" size="sm" radius="xl">норма не задана</Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed" ff="monospace">{num(rate, 0)} ₸/час</Text>
      </Group>

      <Group align="flex-end" gap="sm" wrap="wrap">
        <NumberInput
          label="Человек"
          value={workers}
          onChange={setWorkers}
          min={0}
          step={1}
          w={110}
          size="sm"
          disabled={!canNorm}
          rightSection={!canNorm ? <IconLock size={13} /> : undefined}
        />
        <NumberInput
          label="Часов на ед."
          value={hours}
          onChange={setHours}
          min={0}
          step={0.01}
          decimalScale={3}
          w={130}
          size="sm"
          disabled={!canNorm}
          rightSection={!canNorm ? <IconLock size={13} /> : undefined}
        />
        <Select
          label="Участок"
          data={stageCenters.map((wc) => ({ value: wc.id, label: `${wc.name} · ${num(wc.hourlyRate, 0)} ₸` }))}
          value={workCenterId}
          onChange={setWorkCenterId}
          w={200}
          size="sm"
          clearable
          disabled={!canNorm}
          placeholder="Общая ставка"
        />

        {/* Расчётные поля — серый фон, замок, живой пересчёт при вводе */}
        <Box>
          <Text size="xs" fw={500} c="dimmed" mb={4}>Чел/час</Text>
          <Box px={12} py={7} fz="sm" ff="monospace" style={{
            minWidth: 90, borderRadius: 8, background: 'var(--mantine-color-default-hover)',
            border: '1px solid var(--mantine-color-default-border)', textAlign: 'right',
          }}>
            {num(manHours, 3)}
          </Box>
        </Box>
        <Box>
          <Text size="xs" fw={500} c="dimmed" mb={4}>Стоимость</Text>
          <Box px={12} py={7} fz="sm" ff="monospace" fw={700} style={{
            minWidth: 110, borderRadius: 8, background: 'var(--mantine-color-default-hover)',
            border: '1px solid var(--mantine-color-default-border)', textAlign: 'right',
          }}>
            {num(stageCost)} ₸
          </Box>
        </Box>

        {canNorm && (
          <Button
            size="sm"
            onClick={handleSaveNorm}
            disabled={!dirty || w <= 0}
            loading={previewNorm.isPending || saveNorm.isPending}
          >
            Сохранить
          </Button>
        )}
      </Group>

      <ImpactPreviewModal
        preview={preview}
        stageLabel={row.label}
        opened={preview !== null}
        onCancel={() => setPreview(null)}
        onApply={applyNorm}
        applying={saveNorm.isPending}
      />

      <Divider my="sm" />

      {/* Факт из цеха: в Excel этих данных не было вовсе */}
      <Group gap="sm" align="flex-end" wrap="wrap">
        <Text size="xs" c="dimmed" fw={600} w={90} pb={8}>Факт (цех)</Text>
        {canActual ? (
          <>
            <NumberInput value={actualWorkers} onChange={setActualWorkers} min={0} w={90} size="xs" placeholder="чел" />
            <NumberInput value={actualHours} onChange={setActualHours} min={0} step={0.01} decimalScale={3} w={100} size="xs" placeholder="часов" />
            <Button size="xs" variant="light" onClick={handleSaveActual}
              disabled={!Number(actualWorkers) || !Number(actualHours)} loading={saveActual.isPending}>
              Зафиксировать
            </Button>
          </>
        ) : row.actualWorkers != null ? (
          <Text size="sm" ff="monospace" pb={6}>
            {num(row.actualWorkers, 1)} чел × {num(row.actualHours ?? 0, 3)} ч
          </Text>
        ) : (
          <Text size="sm" c="dimmed" pb={6}>— не фиксировался</Text>
        )}

        {row.actualDeviationPct != null && (
          <Badge
            variant="light"
            radius="xl"
            color={Math.abs(row.actualDeviationPct) <= 5 ? 'success' : 'warning'}
            leftSection={Math.abs(row.actualDeviationPct) <= 5 ? <IconCheck size={12} /> : <IconAlertTriangle size={12} />}
          >
            {row.actualDeviationPct > 0 ? '+' : ''}{num(row.actualDeviationPct, 1)} % к норме
          </Badge>
        )}

        {canNorm && row.actualWorkers != null && row.actualDeviationPct !== 0 && (
          <Tooltip label="Перенести факт в норму (с записью в историю)">
            <Button
              size="xs"
              variant="subtle"
              leftSection={<IconArrowUp size={14} />}
              onClick={() => promote.mutate(row.stage)}
              loading={promote.isPending}
            >
              Принять как норму
            </Button>
          </Tooltip>
        )}
      </Group>
    </Card>
  );
}

/** Панель «Влияние на себестоимость» — разбор формулы вместо =VLOOKUP(...) */
function CostingPanel({ articleId }: { articleId: string }) {
  const { data, isLoading } = useCosting(articleId);
  const can = useAuthStore((s) => s.can);
  const requestReview = useRequestPriceReview(articleId);

  const handleRequestReview = async () => {
    try {
      const review = await requestReview.mutateAsync(undefined);
      notifications.show({
        title: 'Заявка создана',
        message: `Пересмотр цены ${review.article.articleCode} отправлен директору`,
        color: 'success',
        icon: <IconCheck size={16} />,
      });
    } catch (e: any) {
      const err = e?.response?.data?.error;
      notifications.show({
        title: err?.code === 'REVIEW_ALREADY_PENDING' ? 'Уже на рассмотрении' : 'Ошибка',
        message: err?.message ?? 'Не удалось создать заявку',
        color: err?.code === 'REVIEW_ALREADY_PENDING' ? 'warning' : 'danger',
      });
    }
  };

  if (!can('read', 'routing.cost')) {
    return (
      <Card withBorder radius="md" padding="md">
        <Group gap="xs">
          <IconLock size={16} style={{ color: 'var(--mantine-color-gray-5)' }} />
          <Text size="sm" c="dimmed">Калькуляция недоступна для вашей роли</Text>
        </Group>
      </Card>
    );
  }

  if (isLoading || !data) return <Skeleton height={280} radius="md" />;

  const { result, explain } = data;
  const parts = [
    { label: 'Материалы', value: result.materialCost, color: 'var(--mantine-color-brand-4)' },
    { label: 'Трудозатраты', value: result.laborCost, color: 'var(--mantine-color-brand-7)' },
    { label: 'Логистика', value: result.logisticsCost, color: 'var(--mantine-color-gray-5)' },
    { label: 'Вода/газ/эл.', value: result.utilitiesCost, color: 'var(--mantine-color-gray-4)' },
  ];
  const total = result.totalCost || 1;

  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="sm">
        <Text fw={700} size="sm">Влияние на себестоимость</Text>
        <Tooltip label="Формулы листа «Спецификации 2022»: труд = Σ(чел × часы × ставка); логистика 3 % и энергия 1 % от материалов; маржа 10 %" multiline w={320}>
          <ActionIcon variant="subtle" color="gray" size="sm"><IconHelpCircle size={16} /></ActionIcon>
        </Tooltip>
      </Group>

      <Progress.Root size={18} radius="md" mb="md">
        {parts.filter((p) => p.value > 0).map((p) => (
          <Progress.Section key={p.label} value={(p.value / total) * 100} color={p.color}>
            {p.value / total > 0.15 && (
              <Progress.Label style={{ fontSize: 10 }}>{Math.round((p.value / total) * 100)}%</Progress.Label>
            )}
          </Progress.Section>
        ))}
      </Progress.Root>

      <Stack gap={6}>
        {explain.lines.map((line) => {
          const isTotal = line.label === 'Себестоимость' || line.label === 'Расчётная цена';
          return (
            <React.Fragment key={line.label}>
              {isTotal && <Divider my={2} />}
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Box style={{ minWidth: 0 }}>
                  <Text size="sm" fw={isTotal ? 700 : 400} truncate>{line.label}</Text>
                  {line.formula && <Text size="xs" c="dimmed">{line.formula}</Text>}
                </Box>
                <Text size="sm" fw={isTotal ? 700 : 500} ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                  {num(line.value)} ₸
                </Text>
              </Group>
            </React.Fragment>
          );
        })}
      </Stack>

      <Group gap="xs" mt="sm">
        <Badge variant="light" color="gray" radius="xl">
          Трудоёмкость: {num(explain.totalManHours, 3)} чел/час
        </Badge>
      </Group>

      {explain.priceCheck && (
        <Card mt="md" padding="sm" radius="md" bg={explain.priceCheck.belowCost ? 'danger.0' : 'gray.0'} withBorder
          style={{ border: explain.priceCheck.belowCost ? '1px solid var(--mantine-color-danger-3)' : undefined }}>
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Stack gap={2}>
              <Text size="sm" fw={600}>
                Прайс: {formatCurrency(explain.priceCheck.approvedPrice)}
              </Text>
              <Text size="xs" c={explain.priceCheck.belowCost ? 'danger.7' : 'dimmed'}>
                {explain.priceCheck.belowCost
                  ? `⚠ Утверждённая цена ниже себестоимости (${num(explain.priceCheck.deviationPct, 1)} % к расчётной)`
                  : `Отклонение от расчётной цены: ${num(explain.priceCheck.deviationPct, 1)} %`}
              </Text>
            </Stack>
            {explain.priceCheck.belowCost && (
              <Button
                size="xs"
                variant="light"
                color="danger"
                onClick={handleRequestReview}
                loading={requestReview.isPending}
              >
                Запросить пересмотр цены
              </Button>
            )}
          </Group>
        </Card>
      )}
    </Card>
  );
}

/** «Где применяется» (§3.3): до правки видно, сколько заказов она зацепит */
function UsagePanel({ articleId }: { articleId: string }) {
  const { data, isLoading } = useUsage(articleId);

  if (isLoading || !data) return <Skeleton height={120} radius="md" />;

  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="xs">
        <Text fw={700} size="sm">Где применяется</Text>
        {data.nearestShipment && (
          <Text size="xs" c="dimmed">
            Ближайшая отгрузка {formatDate(data.nearestShipment.date)} · заказ{' '}
            <Text span size="xs" ff="monospace" fw={600}>{data.nearestShipment.orderNumber}</Text>
          </Text>
        )}
      </Group>

      {data.ordersCount === 0 ? (
        <Text size="sm" c="dimmed">В активных заказах не используется — правка норм безопасна.</Text>
      ) : (
        <>
          <Text size="sm" mb="sm">
            {data.linesCount} позиций в {data.ordersCount} активных заказах · всего {num(data.totalQty, 0)} шт
          </Text>
          <Stack gap={4}>
            {data.orders.slice(0, 6).map((o) => (
              <Group key={o.orderId} justify="space-between" wrap="nowrap" gap="xs">
                <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                  <Text size="xs" ff="monospace" c="brand.7" fw={600} style={{ whiteSpace: 'nowrap' }}>
                    {o.orderNumber}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>{o.customer ?? '—'}</Text>
                </Group>
                <Group gap={8} wrap="nowrap">
                  <Text size="xs" ff="monospace">× {num(o.qty, 0)} шт</Text>
                  <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                    {o.plannedShipmentDate ? formatDate(o.plannedShipmentDate) : '—'}
                  </Text>
                </Group>
              </Group>
            ))}
            {data.orders.length > 6 && (
              <Text size="xs" c="dimmed">… и ещё {data.ordersCount - 6}</Text>
            )}
          </Stack>
        </>
      )}
    </Card>
  );
}

const STAGE_SHORT: Record<RoutingStageCode, string> = {
  CUTTING: 'Резка',
  ASSEMBLY: 'Сборка/сварка',
  PAINTING: 'Зачистка/покраска',
};

/** История: нормы (кто, когда, почему) + снимки калькуляции — в Excel её не было вообще */
function HistoryModal({
  articleId, opened, onClose,
}: {
  articleId: string;
  opened: boolean;
  onClose: () => void;
}) {
  const { data: norms, isLoading: normsLoading } = useNormHistory(articleId, opened);
  const { data: costings, isLoading: costingsLoading } = useCostingHistory(articleId, opened);

  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={700}>История изменений</Text>} size="xl" radius="md" centered>
      <Tabs defaultValue="norms" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="norms">Нормы труда</Tabs.Tab>
          <Tabs.Tab value="costings">Снимки калькуляции</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="norms">
          {normsLoading ? (
            <Skeleton height={160} radius="md" />
          ) : !norms || norms.length === 0 ? (
            <Text size="sm" c="dimmed" py="md">Нормы ещё не менялись.</Text>
          ) : (
            <ScrollArea.Autosize mah={420}>
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Когда</Table.Th>
                    <Table.Th>Передел</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Человек</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Часов/ед.</Table.Th>
                    <Table.Th>Причина</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {norms.map((h) => (
                    <Table.Tr key={h.id}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDate(h.changedAt)}</Table.Td>
                      <Table.Td>{STAGE_SHORT[h.operation.stage] ?? h.operation.stage}</Table.Td>
                      <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(Number(h.workers), 1)}</Table.Td>
                      <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(Number(h.hoursPerUnit), 3)}</Table.Td>
                      <Table.Td><Text size="xs" c="dimmed">{h.reason ?? '—'}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="costings">
          {costingsLoading ? (
            <Skeleton height={160} radius="md" />
          ) : !costings || costings.length === 0 ? (
            <Text size="sm" c="dimmed" py="md">Снимков калькуляции ещё нет — они создаются при каждом пересчёте.</Text>
          ) : (
            <ScrollArea.Autosize mah={420}>
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Когда</Table.Th>
                    <Table.Th>Триггер</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Материалы</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Труд</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Чел/час</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Себест.</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Цена</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {costings.map((s) => (
                    <Table.Tr key={s.id}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDate(s.calculatedAt)}</Table.Td>
                      <Table.Td>
                        <Badge size="xs" variant="light" color="gray" radius="xl">{s.trigger ?? '—'}</Badge>
                      </Table.Td>
                      <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(Number(s.materialCost))}</Table.Td>
                      <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(Number(s.laborCost))}</Table.Td>
                      <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(Number(s.totalManHours), 3)}</Table.Td>
                      <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(Number(s.totalCost))}</Table.Td>
                      <Table.Td ff="monospace" fw={700} style={{ textAlign: 'right' }}>{num(Number(s.price))}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          )}
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

export function Specifications() {
  // Пересчёт из другого окна (мастер зафиксировал факт) виден сразу (§3.4)
  useLiveCostUpdates();
  // < 768px: список артикулов и калькулятор в столбик (§4.6)
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyOpened, setHistoryOpened] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('routing');
  const [requestOpened, setRequestOpened] = useState(false);

  // Раньше жёсткий pageSize:30 без способа увидеть остальное — из 2315
  // артикулов было видно 30 (1,3%), и поиск это не спасало (найденное
  // тоже обрезалось). Теперь список растёт по кнопке, честно показывая,
  // сколько всего и сколько ещё скрыто.
  const [visibleCount, setVisibleCount] = useState(30);
  const { data: articlesData, isLoading: articlesLoading } = useArticles({ search, pageSize: visibleCount });
  const articles = articlesData?.data ?? [];
  const articlesTotal = articlesData?.meta?.total ?? articles.length;
  const activeId = selectedId ?? articles[0]?.id ?? null;
  const activeArticle = useMemo(() => articles.find((a) => a.id === activeId), [articles, activeId]);

  const { data: routing, isLoading: routingLoading, refetch } = useRouting(activeId);
  const { data: workCenters } = useWorkCenters();

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Stack gap={4}>
          <Text fw={900} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.02em', lineHeight: 1.15 }}>
            Спецификации · трудочасы
          </Text>
          <Text size="sm" c="dimmed">
            Нормы по переделам и калькуляция себестоимости — модуль листа «Спецификации 2022»
          </Text>
        </Stack>
        <Group gap="sm">
          <NomenclatureRequestsButton />
          <Button
            variant="default"
            leftSection={<IconHistory size={16} />}
            onClick={() => setHistoryOpened(true)}
            disabled={!activeId}
          >
            История
          </Button>
          <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => refetch()}>
            Пересчитать
          </Button>
        </Group>
      </Group>

      {activeId && (
        <HistoryModal articleId={activeId} opened={historyOpened} onClose={() => setHistoryOpened(false)} />
      )}

      <RequestNomenclatureModal
        opened={requestOpened}
        onClose={() => setRequestOpened(false)}
        initialName={search}
      />

      <Group align="flex-start" gap="md" wrap={isMobile ? 'wrap' : 'nowrap'} style={{ minWidth: 0 }}>
        {/* Список артикулов */}
        <Card withBorder radius="md" padding="sm" w={isMobile ? '100%' : 280} style={{ flexShrink: 0 }}>
          <TextInput
            placeholder="Поиск артикула..."
            leftSection={<IconSearch size={15} />}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelectedId(null); setVisibleCount(30); }}
            size="sm"
            mb={4}
          />
          <Text size="xs" c="dimmed" mb="sm">
            {articlesLoading ? ' ' : `Показано ${articles.length} из ${articlesTotal}`}
          </Text>
          <ScrollArea h={isMobile ? 220 : 560} scrollbarSize={6}>
            <Stack gap={4}>
              {articlesLoading
                ? [...Array(8)].map((_, i) => <Skeleton key={i} height={44} radius="sm" />)
                : articles.map((a) => (
                    <Box
                      key={a.id}
                      onClick={() => setSelectedId(a.id)}
                      px="sm"
                      py={8}
                      style={{
                        borderRadius: 8,
                        cursor: 'pointer',
                        background: a.id === activeId ? 'light-dark(var(--mantine-color-brand-0), rgba(90, 124, 255, 0.12))' : undefined,
                        border: a.id === activeId ? '1px solid light-dark(var(--mantine-color-brand-2), rgba(90, 124, 255, 0.35))' : '1px solid transparent',
                      }}
                    >
                      <Group gap={6} wrap="nowrap">
                        <Text size="xs" ff="monospace" c="brand.7" fw={700}>{a.articleCode}</Text>
                        {!a.bomItems?.length && (
                          <Badge size="xs" variant="light" color="yellow" radius="xl">нет состава</Badge>
                        )}
                      </Group>
                      <Text size="xs" lineClamp={1}>{a.name}</Text>
                    </Box>
                  ))}
              {!articlesLoading && articles.length === 0 && (
                <Stack gap="xs" py="md" align="center">
                  <Text size="sm" c="dimmed" ta="center">Артикула нет в справочнике</Text>
                  <Button size="xs" variant="light" onClick={() => setRequestOpened(true)}>
                    Запросить номенклатуру
                  </Button>
                </Stack>
              )}
              {!articlesLoading && articles.length < articlesTotal && (
                <Button
                  size="xs"
                  variant="subtle"
                  fullWidth
                  onClick={() => setVisibleCount((n) => n + 100)}
                >
                  Показать ещё {Math.min(100, articlesTotal - articles.length)}
                </Button>
              )}
            </Stack>
          </ScrollArea>
        </Card>

        {/* Калькулятор */}
        <Stack gap="md" style={{ flex: 1, minWidth: 0 }}>
          {activeArticle && (
            <Group gap="sm">
              <Badge variant="filled" color="dark" radius="md" size="lg" ff="monospace">
                {activeArticle.articleCode}
              </Badge>
              <Text fw={700} size="md" style={{ minWidth: 0 }} lineClamp={1}>
                {activeArticle.name}
              </Text>
            </Group>
          )}

          {/* Вкладки из макета §3.3: Материалы (состав) и Трудозатраты */}
          <Tabs value={activeTab} onChange={(v) => setActiveTab(v ?? 'routing')} radius="md" keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="routing">Трудозатраты</Tabs.Tab>
              <Tabs.Tab value="bom">Материалы (состав)</Tabs.Tab>
            </Tabs.List>
          </Tabs>

          {activeTab === 'bom' ? (
            activeId && <BomPanel articleId={activeId} />
          ) : routingLoading || !routing ? (
            <Stack gap="md">
              {[...Array(3)].map((_, i) => <Skeleton key={i} height={150} radius="md" />)}
            </Stack>
          ) : (
            <>
              {routing.stages.map((row) => (
                <StageCard
                  key={`${activeId}-${row.stage}`}
                  row={row}
                  articleId={activeId!}
                  workCenters={workCenters ?? []}
                />
              ))}
            </>
          )}

          {activeId && (
            <>
              <CostingPanel articleId={activeId} />
              <UsagePanel articleId={activeId} />
            </>
          )}
        </Stack>
      </Group>
    </Stack>
  );
}
