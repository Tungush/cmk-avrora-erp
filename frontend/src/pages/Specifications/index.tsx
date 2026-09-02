import React, { useMemo, useState } from 'react';
import {
  Stack, Group, Text, Card, NumberInput, Select, Button, Badge,
  Skeleton, Box, Progress, Divider, ActionIcon, Tooltip, Modal, Table, Tabs,
  Popover, UnstyledButton,
} from '@mantine/core';
import {
  IconLock, IconRefresh, IconCheck, IconAlertTriangle,
  IconArrowUp, IconScissors, IconFlame, IconBrush, IconHelpCircle,
  IconHistory, IconChevronDown, IconChevronUp,
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
import { NomenclatureRequestsButton } from './NomenclaturePanel';
import { ArticleListPane, ARTICLE_ROW_H } from './ArticleList';
import { FitScreen, useFitRows } from '../../components/FitScreen';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { FadeSwap, Collapse } from '../../components/motion';
import type { CostingPreviewResponse, RoutingStageCode, RoutingStageRow } from '../../api/routing';
import type { Article } from '../../types';
import { formatCurrency, formatDate } from '../../utils/formatters';

const STAGE_ICONS: Record<RoutingStageCode, React.ComponentType<{ size?: number }>> = {
  CUTTING: IconScissors,
  ASSEMBLY: IconFlame,
  PAINTING: IconBrush,
};

const num = (n: number, digits = 2) =>
  n.toLocaleString('ru-RU', { maximumFractionDigits: digits });

/** Строк в таблицах истории на одной странице */
const HISTORY_PAGE_SIZE = 25;

/** Бейдж вне таблицы: lg — 13 px, единственный размер не мельче 12 px; высота под строку текста */
const tagProps = { size: 'lg', h: 22, px: 8, variant: 'light' } as const;

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
                    {...tagProps}
                    radius="xl"
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
                <Text key={o.orderNumber} size="sm" c="danger.7" ff="monospace">
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

/** Расчётное поле: выглядит как поле ввода md, но только для чтения — замок без замка */
function CalcField({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Box style={{ minWidth: 0 }}>
      <Text size="sm" fw={500} c="dimmed" mb={4}>{label}</Text>
      <Box
        px={12}
        fz="md"
        ff="monospace"
        fw={strong ? 700 : 500}
        style={{
          height: 42,
          lineHeight: '40px',
          borderRadius: 8,
          background: 'var(--mantine-color-default-hover)',
          border: '1px solid var(--mantine-color-default-border)',
          textAlign: 'right',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </Box>
    </Box>
  );
}

/**
 * Нормы по видам работ — ОДНА таблица, строка на передел (02.09.2026).
 *
 * Было три карточки по 220 px в столбик: чтобы увидеть покраску, надо было
 * прокрутить мимо резки и сборки, а сравнить их между собой — вовсе никак.
 * Теперь резка, сборка и покраска стоят рядом, как в исходном листе
 * «Спецификации 2022», и весь редактор виден целиком.
 *
 * Факт цеха убран в поповер: его вводит мастер и редко, а норму правит
 * инженер и часто — на главном пути должно быть то, что делают каждый день.
 */
function StageRow({
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
  const [factOpen, setFactOpen] = useState(false);

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
      setFactOpen(false);
      notifications.show({ title: 'Факт зафиксирован', message: row.label, color: 'success', icon: <IconCheck size={16} /> });
    } catch {
      notifications.show({ title: 'Ошибка', message: 'Не удалось сохранить факт', color: 'danger' });
    }
  };

  const dev = row.actualDeviationPct;

  return (
    <div className="stage-cell">
      <div className="stage-cell__head">
        <Icon size={17} />
        <Text size="sm" fw={700} lh={1.2} style={{ flex: 1, minWidth: 0 }} lineClamp={1}>{row.label}</Text>
        {!row.exists && (
          <Tooltip label="Норма не задана — себестоимость труда встанет в ноль">
            <IconAlertTriangle size={15} style={{ color: 'var(--ref-amber-ink)', flexShrink: 0 }} />
          </Tooltip>
        )}
      </div>

      <Group gap={8} grow wrap="nowrap">
        <NumberInput size="xs" label="Человек" value={workers} onChange={setWorkers} min={0} step={1}
          disabled={!canNorm} hideControls placeholder="чел" />
        <NumberInput size="xs" label="Часов на ед." value={hours} onChange={setHours} min={0} step={0.01}
          decimalScale={3} disabled={!canNorm} hideControls placeholder="часов" />
      </Group>

      <Select size="xs" label="Участок" placeholder="Общая ставка" clearable disabled={!canNorm}
        data={stageCenters.map((wc) => ({ value: wc.id, label: `${wc.name} · ${num(wc.hourlyRate, 0)} ₸` }))}
        value={workCenterId} onChange={setWorkCenterId} />

      {/* Живой пересчёт: цифры меняются, пока набирают норму */}
      <div className="stage-cell__calc">
        <span>{num(manHours, 3)} чел/час</span>
        <b>{num(stageCost)} ₸</b>
      </div>

      <div className="stage-cell__foot">
        <Popover opened={factOpen} onChange={setFactOpen} position="top-start" withArrow shadow="md" width={250}>
          <Popover.Target>
            <UnstyledButton
              onClick={() => setFactOpen((o) => !o)}
              disabled={!canActual && row.actualWorkers == null}
              className="stage-cell__fact"
            >
              {row.actualWorkers != null ? (
                <>
                  <span>факт {num(row.actualWorkers, 1)}×{num(row.actualHours ?? 0, 2)}</span>
                  {dev != null && (
                    <span className="worklist__chip" data-tone={Math.abs(dev) <= 5 ? undefined : 'warn'}>
                      {dev > 0 ? '+' : ''}{num(dev, 0)} %
                    </span>
                  )}
                </>
              ) : <span>внести факт</span>}
            </UnstyledButton>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="xs">
              <Text size="sm" fw={700}>Факт цеха · {row.label}</Text>
              {canActual ? (
                <>
                  <Group gap="xs" grow>
                    <NumberInput size="xs" label="Человек" value={actualWorkers} onChange={setActualWorkers} min={0} hideControls />
                    <NumberInput size="xs" label="Часов на ед." value={actualHours} onChange={setActualHours} min={0} step={0.01} decimalScale={3} hideControls />
                  </Group>
                  <Button size="xs" onClick={handleSaveActual}
                    disabled={!Number(actualWorkers) || !Number(actualHours)} loading={saveActual.isPending}>
                    Зафиксировать
                  </Button>
                </>
              ) : (
                <Text size="xs" c="dimmed">Вносит цех — у вашей роли только просмотр</Text>
              )}
              {canNorm && row.actualWorkers != null && dev !== 0 && (
                <Button size="xs" variant="subtle" leftSection={<IconArrowUp size={14} />}
                  onClick={() => promote.mutate(row.stage)} loading={promote.isPending}>
                  Принять как норму
                </Button>
              )}
            </Stack>
          </Popover.Dropdown>
        </Popover>

        {canNorm && (
          <Button size="compact-sm" h={28} onClick={handleSaveNorm}
            disabled={!dirty || w <= 0}
            loading={previewNorm.isPending || saveNorm.isPending}>
            Сохранить
          </Button>
        )}
      </div>

      <ImpactPreviewModal
        preview={preview}
        stageLabel={row.label}
        opened={preview !== null}
        onCancel={() => setPreview(null)}
        onApply={applyNorm}
        applying={saveNorm.isPending}
      />
    </div>
  );
}

/**
 * Три передела рядом (02.09.2026). Ни таблицы, ни прокрутки: колонки
 * складываются сами (auto-fit), поэтому и на ноутбуке, и на широком
 * мониторе резка, сборка и покраска видны целиком и сразу.
 */
function StageTable({
  stages, articleId, workCenters,
}: {
  stages: RoutingStageRow[];
  articleId: string;
  workCenters: Array<{ id: string; code: string; name: string; stage: RoutingStageCode; hourlyRate: number }>;
}) {
  return (
    <div className="stage-grid">
      {stages.map((row) => (
        <StageRow key={`${articleId}-${row.stage}`} row={row} articleId={articleId} workCenters={workCenters} />
      ))}
    </div>
  );
}

/**
 * Полоса итогов под нормами: себестоимость, цена и трудоёмкость одной
 * строкой (02.09.2026). Полный разбор формулы занимал 280 px и на
 * ноутбуке возвращал прокрутку — он переехал в свою вкладку, а здесь
 * осталось то, ради чего инженер и правит норму.
 */
function CostStrip({ articleId }: { articleId: string }) {
  const { data, isLoading } = useCosting(articleId);
  const can = useAuthStore((s) => s.can);
  if (!can('read', 'routing.cost')) return null;
  if (isLoading || !data) return <Skeleton height={52} radius="lg" />;

  const { result, explain } = data;
  const items = [
    { label: 'Материалы', value: `${num(result.materialCost)} ₸` },
    { label: 'Трудозатраты', value: `${num(result.laborCost)} ₸` },
    { label: 'Себестоимость', value: `${num(result.totalCost)} ₸`, strong: true },
    { label: 'Трудоёмкость', value: `${num(explain.totalManHours, 3)} ч` },
  ];

  return (
    <Card withBorder radius="lg" padding="xs">
      <div className="cost-strip">
        {items.map((it) => (
          <div className="cost-strip__item" key={it.label} data-strong={it.strong ? 'true' : undefined}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700} style={{ letterSpacing: '0.06em' }}>
              {it.label}
            </Text>
            <Text fw={800} ff="var(--ff-num)" style={{ fontSize: it.strong ? 19 : 16, whiteSpace: 'nowrap' }}>
              {it.value}
            </Text>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Строки-итоги: их показываем крупно и отдельно от слагаемых */
const TOTAL_LINES = new Set(['Себестоимость', 'Расчётная цена']);

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
    <Card withBorder radius="lg" padding="sm">
      <Group justify="space-between" mb={6}>
        <Text fw={700} size="sm">Влияние на себестоимость</Text>
        <Tooltip label="Формулы листа «Спецификации 2022»: труд = Σ(чел × часы × ставка); логистика 3 % и энергия 1 % от материалов; маржа 10 %" multiline w={320}>
          <ActionIcon variant="subtle" color="gray" size="md"><IconHelpCircle size={18} /></ActionIcon>
        </Tooltip>
      </Group>

      <Progress.Root size={14} radius="md" mb={10}>
        {parts.filter((p) => p.value > 0).map((p) => (
          <Progress.Section key={p.label} value={(p.value / total) * 100} color={p.color}>
            {p.value / total > 0.2 && (
              <Progress.Label style={{ fontSize: 10 }}>{Math.round((p.value / total) * 100)}%</Progress.Label>
            )}
          </Progress.Section>
        ))}
      </Progress.Root>

      {/* Слагаемые — в две колонки, итоги — отдельной строкой снизу.
          В столбик они занимали пол-экрана и выталкивали панель за край */}
      <div className="cost-lines">
        {explain.lines.filter((l) => !TOTAL_LINES.has(l.label)).map((line) => (
          <div className="cost-lines__row" key={line.label}>
            <div style={{ minWidth: 0 }}>
              <Text size="sm" truncate>{line.label}</Text>
              {line.formula && <Text size="xs" c="dimmed" truncate>{line.formula}</Text>}
            </div>
            <Text size="sm" fw={500} ff="var(--ff-num)" style={{ whiteSpace: 'nowrap' }}>
              {num(line.value)} ₸
            </Text>
          </div>
        ))}
      </div>

      <div className="cost-totals">
        {explain.lines.filter((l) => TOTAL_LINES.has(l.label)).map((line) => (
          <div className="cost-totals__item" key={line.label}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700} style={{ letterSpacing: '0.06em' }}>
              {line.label}
            </Text>
            <Text size="lg" fw={800} ff="var(--ff-num)" style={{ whiteSpace: 'nowrap' }}>
              {num(line.value)} ₸
            </Text>
          </div>
        ))}
        <div className="cost-totals__item">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700} style={{ letterSpacing: '0.06em' }}>
            Трудоёмкость
          </Text>
          <Text size="lg" fw={800} ff="var(--ff-num)">{num(explain.totalManHours, 3)} ч</Text>
        </div>
      </div>

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
  // Первые 6 заказов видны сразу, остальные раскрываются — не растягиваем панель
  const [expanded, setExpanded] = useState(false);

  if (isLoading || !data) return <Skeleton height={120} radius="md" />;

  const first = data.orders.slice(0, 6);
  const rest = data.orders.slice(6);
  const hiddenCount = data.ordersCount - first.length;

  const renderOrder = (o: (typeof data.orders)[number]) => (
    <Group key={o.orderId} justify="space-between" wrap="nowrap" gap="xs">
      <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
        <Text size="sm" ff="monospace" c="brand.7" fw={600} style={{ whiteSpace: 'nowrap' }}>
          {o.orderNumber}
        </Text>
        <Text size="sm" c="dimmed" truncate>{o.customer ?? '—'}</Text>
      </Group>
      <Group gap={8} wrap="nowrap">
        <Text size="sm" ff="monospace">× {num(o.qty, 0)} шт</Text>
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {o.plannedShipmentDate ? formatDate(o.plannedShipmentDate) : '—'}
        </Text>
      </Group>
    </Group>
  );

  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="xs" wrap="wrap" gap="xs">
        <Text fw={700} size="md">Где применяется</Text>
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
          <Stack gap={6}>
            {first.map(renderOrder)}
          </Stack>
          {rest.length > 0 && (
            <>
              <Collapse opened={expanded}>
                <Stack gap={6} pt={6}>
                  {rest.map(renderOrder)}
                  {data.ordersCount > data.orders.length && (
                    <Text size="xs" c="dimmed">… и ещё {data.ordersCount - data.orders.length}</Text>
                  )}
                </Stack>
              </Collapse>
              <Button
                variant="subtle"
                size="sm"
                mt={6}
                px={6}
                leftSection={expanded ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? 'Свернуть' : `… и ещё ${hiddenCount}`}
              </Button>
            </>
          )}
          {rest.length === 0 && data.ordersCount > data.orders.length && (
            <Text size="xs" c="dimmed" mt={4}>… и ещё {data.ordersCount - data.orders.length}</Text>
          )}
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
  const normsPaged = usePagedList(norms ?? [], HISTORY_PAGE_SIZE, articleId);
  const costingsPaged = usePagedList(costings ?? [], HISTORY_PAGE_SIZE, articleId);

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
            <Stack gap="xs">
              <FadeSwap swapKey={normsPaged.page}>
                <TableScroll minWidth={640} maxHeight={440}>
                  <Table highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Когда</Table.Th>
                        <Table.Th>Вид работ</Table.Th>
                        <Table.Th style={{ textAlign: 'right' }}>Человек</Table.Th>
                        <Table.Th style={{ textAlign: 'right' }}>Часов/ед.</Table.Th>
                        <Table.Th>Причина</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {normsPaged.slice.map((h) => (
                        <Table.Tr key={h.id}>
                          <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDate(h.changedAt)}</Table.Td>
                          <Table.Td>{STAGE_SHORT[h.operation.stage] ?? h.operation.stage}</Table.Td>
                          <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(Number(h.workers), 1)}</Table.Td>
                          <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{num(Number(h.hoursPerUnit), 3)}</Table.Td>
                          <Table.Td><Text size="sm" c="dimmed">{h.reason ?? '—'}</Text></Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </TableScroll>
              </FadeSwap>
              <PaginationBar
                page={normsPaged.page}
                total={normsPaged.total}
                pageSize={HISTORY_PAGE_SIZE}
                onPageChange={normsPaged.setPage}
                variant="compact"
                noun="записей"
              />
            </Stack>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="costings">
          {costingsLoading ? (
            <Skeleton height={160} radius="md" />
          ) : !costings || costings.length === 0 ? (
            <Text size="sm" c="dimmed" py="md">Снимков калькуляции ещё нет — они создаются при каждом пересчёте.</Text>
          ) : (
            <Stack gap="xs">
              <FadeSwap swapKey={costingsPaged.page}>
                <TableScroll minWidth={760} maxHeight={440}>
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
                      {costingsPaged.slice.map((s) => (
                        <Table.Tr key={s.id}>
                          <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDate(s.calculatedAt)}</Table.Td>
                          <Table.Td>
                            <Badge size="sm" variant="light" color="gray" radius="xl">{s.trigger ?? '—'}</Badge>
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
                </TableScroll>
              </FadeSwap>
              <PaginationBar
                page={costingsPaged.page}
                total={costingsPaged.total}
                pageSize={HISTORY_PAGE_SIZE}
                onPageChange={costingsPaged.setPage}
                variant="compact"
                noun="снимков"
              />
            </Stack>
          )}
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

export function Specifications() {
  // Пересчёт из другого окна (мастер зафиксировал факт) виден сразу (§3.4)
  useLiveCostUpdates();
  // Две панели рядом держатся до 1024 px: список 320 + редактор 660 — три
  // передела в ряд помещаются. Раньше порог был 1200, и на ноутбуке экран
  // раскладывался в столбик, отчего возвращалась вертикальная прокрутка
  const stacked = useMediaQuery('(max-width: 1023px)', false, { getInitialValueInEffect: false });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Карточка выбранного изделия хранится отдельно: после перехода на другую
  // страницу списка её там уже нет, а шапка редактора должна остаться
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [historyOpened, setHistoryOpened] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('routing');

  // Список изделий занимает ровно ту высоту, что осталась от окна: сколько
  // строк влезло — столько и запрашиваем с сервера (02.09.2026)
  // 4 px — зазор между строками; своей шапки у списка нет, отсюда chrome = 0
  const fit = useFitRows(ARTICLE_ROW_H + 4, 5, 40, 0);

  // «Изделия» — каталог ТОЛЬКО продукции. Сырьё, услуги и прочее, что завод
  // не изготавливает, сюда не попадает вовсе: переключателя нет намеренно
  // (26.08.2026 — «удали тут всё что сырьё и убери кнопку показать сырьё»).
  // Сырьё живёт в разделе «Материалы».
  const { data: articlesData, isLoading: articlesLoading } = useArticles({
    search, page, pageSize: fit.rows,
  });
  const articles = articlesData?.data ?? [];
  const articlesTotal = articlesData?.meta?.total;
  const activeId = selectedId ?? articles[0]?.id ?? null;
  const activeArticle = useMemo(
    () => articles.find((a) => a.id === activeId)
      ?? (selectedArticle && selectedArticle.id === activeId ? selectedArticle : undefined),
    [articles, activeId, selectedArticle],
  );

  const { data: routing, isLoading: routingLoading, refetch } = useRouting(activeId);
  const { data: workCenters } = useWorkCenters();

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
    setSelectedId(null);
    setSelectedArticle(null);
  };

  const handleSelect = (a: Article) => {
    setSelectedId(a.id);
    setSelectedArticle(a);
  };

  const noBom = activeArticle && !activeArticle.isMaterialResale && !activeArticle.bomItems?.length;

  const header = (
    <Group justify="space-between" align="center" wrap="nowrap" gap="md">
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
        <Text fw={800} style={{ fontSize: 22, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
          Изделия
        </Text>
        <Text size="sm" c="dimmed" lineClamp={1}>
          нормы труда и себестоимость по каждому артикулу
        </Text>
      </Group>
      <Group gap="xs" wrap="nowrap">
        <NomenclatureRequestsButton />
        <Button variant="default" size="sm" leftSection={<IconHistory size={16} />}
          onClick={() => setHistoryOpened(true)} disabled={!activeId}>
          История
        </Button>
        <Button variant="light" size="sm" leftSection={<IconRefresh size={16} />} onClick={() => refetch()}>
          Пересчитать
        </Button>
      </Group>
    </Group>
  );

  return (
    <FitScreen header={header}>
      {activeId && (
        <HistoryModal articleId={activeId} opened={historyOpened} onClose={() => setHistoryOpened(false)} />
      )}

      <div className="specs-split" data-stacked={stacked ? 'true' : undefined}>
        {/* Список артикулов — ровно по высоте окна */}
        <ArticleListPane
          articles={articles}
          loading={articlesLoading}
          total={articlesTotal}
          page={page}
          pageSize={fit.rows}
          onPageChange={setPage}
          search={search}
          onSearchChange={handleSearch}
          activeId={activeId}
          onSelect={handleSelect}
          stacked={stacked}
          listRef={fit.ref}
        />

        {/* Редактор: всё об изделии на одном экране, разделами-вкладками.
            Раньше нормы, себестоимость и «где применяется» лежали в столбик
            на полторы тысячи пикселей — до покраски надо было прокрутить */}
        <div className="specs-editor">
          {activeArticle ? (
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }} mb="xs">
              <Badge variant="filled" color="dark" radius="md" size="lg" ff="var(--ff-num)" style={{ flexShrink: 0 }}>
                {activeArticle.articleCode}
              </Badge>
              <Text fw={700} size="md" style={{ minWidth: 0 }} lineClamp={1}>
                {activeArticle.name}
              </Text>
              {noBom && (
                <span className="worklist__chip" data-tone="danger" style={{ flexShrink: 0 }}>нет состава</span>
              )}
            </Group>
          ) : <Skeleton height={28} width={320} radius="sm" mb="xs" />}

          <Tabs value={activeTab} onChange={(v) => setActiveTab(v ?? 'routing')} radius="md" keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="routing">Трудозатраты</Tabs.Tab>
              <Tabs.Tab value="bom">Материалы (состав)</Tabs.Tab>
              <Tabs.Tab value="cost">Разбор цены</Tabs.Tab>
              <Tabs.Tab value="usage">Где применяется</Tabs.Tab>
            </Tabs.List>
          </Tabs>

          <div className="specs-editor__body">
            <FadeSwap swapKey={`${activeId ?? 'none'}-${activeTab}`}>
              {!activeId ? null
                : activeTab === 'bom' ? <BomPanel articleId={activeId} />
                  : activeTab === 'cost' ? <CostingPanel articleId={activeId} />
                    : activeTab === 'usage' ? <UsagePanel articleId={activeId} />
                      : (
                        /* Нормы и итог цены — на одном экране: инженер правит
                           часы и сразу видит, во что это вылилось. Полный
                           разбор формулы — во вкладке «Разбор цены» */
                        <Stack gap="sm">
                          {routingLoading || !routing
                            ? <Skeleton height={220} radius="lg" />
                            : (
                              <StageTable
                                stages={routing.stages}
                                articleId={activeId}
                                workCenters={workCenters ?? []}
                              />
                            )}
                          <CostStrip articleId={activeId} />
                        </Stack>
                      )}
            </FadeSwap>
          </div>
        </div>
      </div>
    </FitScreen>
  );
}
