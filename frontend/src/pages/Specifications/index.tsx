import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Stack, Group, Text, Card, NumberInput, Select, Button, Badge, TextInput,
  Skeleton, Box, Divider, ActionIcon, Tooltip, Modal, Table, Tabs,
  Popover, UnstyledButton,
} from '@mantine/core';
import {
  IconLock, IconRefresh, IconCheck, IconAlertTriangle,
  IconArrowUp, IconScissors, IconFlame, IconBrush, IconHelpCircle,
  IconHistory, IconChevronDown, IconChevronUp, IconArrowLeft, IconSearch,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useArticles, useArticleGaps, useArticle } from '../../hooks/useCatalog';
import {
  useRouting, useCosting, useSaveNorm, useSaveActual, usePromoteActual,
  usePreviewNorm, useUsage, useNormHistory, useCostingHistory, useRequestPriceReview,
} from '../../hooks/useRouting';
import { useAuthStore } from '../../store/auth';
import { useLiveCostUpdates } from '../../hooks/useLiveEvents';
import { BomPanel } from './BomPanel';
import { NomenclatureRequestsButton } from './NomenclaturePanel';
import { FitScreen, useFitRows } from '../../components/FitScreen';
import { SectionHead } from '../../components/SectionHeader';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { FadeSwap, Collapse } from '../../components/motion';
import type { CostingPreviewResponse, RoutingStageCode, RoutingStageRow } from '../../api/routing';
import type { Article } from '../../types';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { TextReveal } from '../../components/motion';

const STAGE_ICONS: Record<RoutingStageCode, React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = {
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
          <IconAlertTriangle aria-hidden size={20} style={{ color: 'var(--mantine-color-warning-6)' }} />
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

        {/* Тёмная ветка фона была сырым rgba(229,72,77) из старой темы (03.09.2026) */}
        {affected.negativeMarginCount > 0 && (
          <Card padding="sm" radius="md" bg="var(--s-attention-wash)" withBorder
            style={{ border: '1px solid var(--mantine-color-danger-3)' }}>
            <Group gap="xs" mb={6}>
              <IconAlertTriangle aria-hidden size={16} style={{ color: 'var(--mantine-color-danger-6)' }} />
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
  row, articleId,
}: {
  row: RoutingStageRow;
  articleId: string;
}) {
  const can = useAuthStore((s) => s.can);
  const canNorm = can('write', 'routing.norm');
  const canActual = can('write', 'routing.actual');

  const [workers, setWorkers] = useState<number | string>(row.workers || '');
  const [hours, setHours] = useState<number | string>(row.hoursPerUnit || '');
  const [actualWorkers, setActualWorkers] = useState<number | string>(row.actualWorkers ?? '');
  const [actualHours, setActualHours] = useState<number | string>(row.actualHours ?? '');
  const [factOpen, setFactOpen] = useState(false);

  const saveNorm = useSaveNorm(articleId);
  const saveActual = useSaveActual(articleId);
  const promote = usePromoteActual(articleId);
  const previewNorm = usePreviewNorm(articleId);
  const [preview, setPreview] = useState<CostingPreviewResponse | null>(null);

  /* Участок убран 04.09.2026 по решению владельца: «вообще не вижу
     смысла в нём». Ставка теперь одна — та, что пришла с передела. */
  const rate = row.hourlyRate;
  const w = Number(workers) || 0;
  const h = Number(hours) || 0;
  const manHours = Math.round(w * h * 1000) / 1000;
  const stageCost = Math.round(manHours * rate * 100) / 100;

  const dirty = w !== row.workers || h !== row.hoursPerUnit;
  // Имя StageIcon, а не Icon: общий <Icon> из components/Icon.tsx
  // теперь занят системной обёрткой (03.09.2026)
  const StageIcon = STAGE_ICONS[row.stage];

  const applyNorm = async () => {
    try {
      await saveNorm.mutateAsync({ stage: row.stage, workers: w, hoursPerUnit: h });
      setPreview(null);
      notifications.show({ title: 'Норма сохранена', message: `${row.label}: ${w} чел × ${h} ч`, color: 'success', icon: <IconCheck aria-hidden size={16} /> });
    } catch {
      notifications.show({ title: 'Ошибка', message: 'Не удалось сохранить норму', color: 'danger' });
    }
  };

  // Сначала предпросмотр влияния (§2.3 ④); сохранение — после подтверждения в модале
  const handleSaveNorm = async () => {
    try {
      const p = await previewNorm.mutateAsync({
        stage: row.stage, workers: w, hoursPerUnit: h,
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
      notifications.show({ title: 'Факт зафиксирован', message: row.label, color: 'success', icon: <IconCheck aria-hidden size={16} /> });
    } catch {
      notifications.show({ title: 'Ошибка', message: 'Не удалось сохранить факт', color: 'danger' });
    }
  };

  const dev = row.actualDeviationPct;

  return (
    <div className="stage-cell">
      <div className="stage-cell__head">
        <StageIcon size={16} aria-hidden />
        {/* h2, а не просто текст (04.09.2026, аудит design-review): на всей
            странице был один заголовок — h1 «Изделия», — и структуры для
            скринридера не существовало вовсе. Уровень именно второй:
            передел и «Состав изделия» — соседние разделы, а h3 после h1
            дал бы пропуск уровня. Вид не меняется. */}
        <Text component="h2" size="sm" fw={700} lh={1.2} m={0}
          style={{ flex: 1, minWidth: 0 }} lineClamp={1}>{row.label}</Text>
        {!row.exists && (
          <Tooltip label="Норма не задана — себестоимость труда встанет в ноль">
            <IconAlertTriangle aria-hidden size={16} style={{ color: 'var(--ref-amber-ink)', flexShrink: 0 }} />
          </Tooltip>
        )}
      </div>

      <Group gap={8} grow wrap="nowrap">
        <NumberInput size="xs" label="Человек" value={workers} onChange={setWorkers} min={0} step={1}
          disabled={!canNorm} hideControls placeholder="чел" />
        <NumberInput size="xs" label="Часов на ед." value={hours} onChange={setHours} min={0} step={0.01}
          decimalScale={3} disabled={!canNorm} hideControls placeholder="часов" />
      </Group>

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
                <Button size="xs" variant="subtle" leftSection={<IconArrowUp aria-hidden size={16} />}
                  onClick={() => promote.mutate(row.stage)} loading={promote.isPending}>
                  Принять как норму
                </Button>
              )}
            </Stack>
          </Popover.Dropdown>
        </Popover>

        {canNorm && (
          /* 36 px, а не 28 (04.09.2026, аудит design-review): «Сохранить» —
             главное действие экрана норм, а стояло мельче второстепенного
             окружения. Пилюли очереди 34 px, клетки фактов 62 — выходило,
             что чем действие важнее, тем оно мельче. Иерархия наоборот. */
          <Button size="compact-sm" h={36} onClick={handleSaveNorm}
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
  stages, articleId,
}: {
  stages: RoutingStageRow[];
  articleId: string;
}) {
  return (
    <div className="stage-grid">
      {stages.map((row) => (
        <StageRow key={`${articleId}-${row.stage}`} row={row} articleId={articleId} />
      ))}
    </div>
  );
}

/** Строки-итоги: их показываем крупно и отдельно от слагаемых */
const TOTAL_LINES = new Set(['Себестоимость', 'Расчётная цена']);

/** Не слагаемые себестоимости: маржа берётся от ЦЕНЫ, доля ей не считается */
const NON_COST_LINES = new Set(['Маржа']);

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
        icon: <IconCheck aria-hidden size={16} />,
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
          <IconLock aria-hidden size={16} style={{ color: 'var(--mantine-color-gray-5)' }} />
          <Text size="sm" c="dimmed">Калькуляция недоступна для вашей роли</Text>
        </Group>
      </Card>
    );
  }

  if (isLoading || !data) return <Skeleton height={280} radius="md" />;

  const { result, explain } = data;
  // Разбор себестоимости — палитра графиков из index.css, по убыванию
  // заметности: материалы и труд решают, логистика и энергия — остаток.
  const parts = [
    { label: 'Материалы', value: result.materialCost, color: 'var(--chart-cat1)' },
    { label: 'Трудозатраты', value: result.laborCost, color: 'var(--chart-cat2)' },
    { label: 'Логистика', value: result.logisticsCost, color: 'var(--chart-cat3)' },
    { label: 'Вода/газ/эл.', value: result.utilitiesCost, color: 'var(--chart-cat5)' },
  ];
  const total = result.totalCost || 1;

  return (
    <Card withBorder radius="lg" padding="sm">
      <Group justify="space-between" mb={6}>
        {/* h2: заголовок раскрытой панели */}
        <Text component="h2" fw={700} size="sm" m={0}>Влияние на себестоимость</Text>
        <Tooltip label="Формулы листа «Спецификации 2022»: труд = Σ(чел × часы × ставка); логистика 3 % и энергия 1 % от материалов; маржа 10 %" multiline w={320}>
          <ActionIcon variant="subtle" color="gray" size="md" aria-label="Как считается себестоимость"><IconHelpCircle aria-hidden size={20} /></ActionIcon>
        </Tooltip>
      </Group>

      {/* Сложенной полосы здесь больше нет (04.09.2026).
          Она делила ширину между четырьмя слагаемыми, но материалы дают
          95 % — и три остальных сегмента выходили 15, 27 и 9 px, то есть
          нечитаемыми щепками. Процент был напечатан ПОВЕРХ полосы шрифтом
          10 px, а те же самые числа стоят строкой ниже. Полоса не
          добавляла ничего, кроме шума, поэтому доля переехала к каждой
          строке — там она точна и читается. */}

      {/* Слагаемые — в две колонки, итоги — отдельной строкой снизу.
          В столбик они занимали пол-экрана и выталкивали панель за край */}
      <div className="cost-lines">
        {explain.lines.filter((l) => !TOTAL_LINES.has(l.label)).map((line) => {
          /* Доля считается ОТ СЕБЕСТОИМОСТИ, поэтому маржа сюда не входит:
             она берётся от цены, и рядом с «Материалы 95 %» её «54 %»
             читались бы как часть той же сотни. Сумма долей должна
             сходиться к 100, иначе цифра врёт. */
          const share = total > 0 && !NON_COST_LINES.has(line.label)
            ? (line.value / total) * 100
            : 0;
          return (
            <div className="cost-lines__row" key={line.label}>
              <div style={{ minWidth: 0 }}>
                <Text size="sm" truncate>{line.label}</Text>
                {line.formula && <Text size="xs" c="dimmed" truncate>{line.formula}</Text>}
              </div>
              <Text size="sm" fw={500} ff="var(--ff-num)" style={{ whiteSpace: 'nowrap' }}>
                {num(line.value)} ₸
                {/* Доля — рядом с числом, а не поверх полосы. Меньше 0,5 %
                    не пишем: «0 %» рядом с суммой сбивает с толку. */}
                {share >= 0.5 && (
                  <Text span size="xs" c="dimmed" ml={8}>{Math.round(share)} %</Text>
                )}
              </Text>
            </div>
          );
        })}
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
              {/* 03.09.2026: здесь стоял символ ⚠ прямо в тексте — он рисуется
                  шрифтом ОС, лезет в поток чтения экранного диктора и в
                  системе, где всё остальное — tabler, выглядит чужим */}
              <Text size="xs" c={explain.priceCheck.belowCost ? 'danger.7' : 'dimmed'}>
                {explain.priceCheck.belowCost ? (
                  <Group component="span" gap={4} wrap="nowrap" display="inline-flex" style={{ verticalAlign: 'middle' }}>
                    <IconAlertTriangle size={16} aria-hidden style={{ flexShrink: 0 }} />
                    <span>
                      Утверждённая цена ниже себестоимости ({num(explain.priceCheck.deviationPct, 1)} % к расчётной)
                    </span>
                  </Group>
                ) : (
                  `Отклонение от расчётной цены: ${num(explain.priceCheck.deviationPct, 1)} %`
                )}
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
        <Text size="sm" ff="monospace" fw={600} style={{ whiteSpace: 'nowrap' }}>
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
                leftSection={expanded ? <IconChevronUp aria-hidden size={16} /> : <IconChevronDown aria-hidden size={16} />}
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

/** Высота строки таблицы изделий */
const ROW_H = 40;

const QUEUES = [
  { v: '', label: 'Все', key: 'total' },
  { v: 'empty', label: 'Пустые', key: 'empty' },
  { v: 'nobom', label: 'Без состава', key: 'nobom' },
  { v: 'nonorms', label: 'Без норм', key: 'nonorms' },
  { v: 'noprice', label: 'Без цены', key: 'noprice' },
] as const;

const devTone = (dev: number | null | undefined) =>
  dev == null ? undefined : Math.abs(dev) <= 5 ? 'var(--p-emerald-ink)' : Math.abs(dev) <= 15 ? 'var(--p-amber-ink)' : 'var(--p-rose-ink)';

/**
 * Изделия (переписано 05.09.2026 по просьбе владельца: «полностью
 * переделать — неудобно, очень перегружено»).
 *
 * Было: список слева, справа сразу редактор — три карточки норм с
 * полями, полоса фактов, раскрывающиеся панели; всё на одном экране
 * независимо от того, нужно ли оно сейчас. Стало: два слоя, как в Цехе
 * и Заказах.
 *   1. Таблица изделий во всю ширину: артикул, название, состав, цены,
 *      отклонение, вес. Очередь работы (пустые / без состава / без норм /
 *      без цены) — пилюли над таблицей, они же фильтры.
 *   2. Нажатие на строку — карточка изделия во весь экран: нормы труда
 *      тремя СТРОКАМИ (не тремя карточками), справа три числа итога и то,
 *      что раскрыто по клику: состав, разбор формулы, применение.
 * Ссылка /specs?article=… открывает карточку сразу (так ведёт Цех).
 */
export function Specifications() {
  useLiveCostUpdates();
  const [params, setParams] = useSearchParams();
  const openedId = params.get('article');
  const setOpened = (id: string | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id) next.set('article', id); else next.delete('article');
    return next;
  }, { replace: true });

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [gap, setGap] = useState<string>('');
  const [historyOpened, setHistoryOpened] = useState(false);
  type View = 'norms' | 'bom' | 'cost' | 'usage';
  const [view, setView] = useState<View>('norms');
  const can = useAuthStore((s) => s.can);

  // Сколько строк влезло: 40 px строка, 40 px шапка таблицы
  const fit = useFitRows(ROW_H, 5, 60, 40);
  const { data: articlesData, isLoading: articlesLoading } = useArticles({
    search, page, pageSize: fit.rows, ...(gap ? { gap } : {}),
  });
  const { data: gaps } = useArticleGaps();
  const articles = articlesData?.data ?? [];
  const total = articlesData?.meta?.total;

  const fromList = articles.find((a) => a.id === openedId);
  const { data: fetched } = useArticle(openedId && !fromList ? openedId : null);
  const article = fromList ?? (fetched && fetched.id === openedId ? fetched : undefined);
  const { data: routing, isLoading: routingLoading, refetch } = useRouting(openedId);
  const { data: costing } = useCosting(openedId);
  const canCost = can('read', 'routing.cost');

  /* ---- карточка изделия во весь экран ---- */
  if (openedId) {
    const noBom = article && !article.isMaterialResale && !article.bomItems?.length;
    return (
      <FitScreen>
        <HistoryModal articleId={openedId} opened={historyOpened} onClose={() => setHistoryOpened(false)} />
        <Card withBorder radius="lg" padding={0} className="specs-card">
          <div className="specs-card__head">
            <Button
              variant="default" size="sm" radius="xl" leftSection={<IconArrowLeft aria-hidden size={16} />}
              onClick={() => { setOpened(null); setView('norms'); }}
            >
              Все изделия
            </Button>
            {article ? (
              <>
                <Badge variant="filled" color="dark" radius="md" size="lg" ff="var(--ff-num)" style={{ flexShrink: 0 }}>
                  {article.articleCode}
                </Badge>
                <Text fw={700} size="md" className="specs-card__name" lineClamp={1}>{article.name}</Text>
                {noBom && <span className="worklist__chip" data-tone="danger">нет состава</span>}
              </>
            ) : <Skeleton height={28} width={320} radius="sm" />}
            <div className="specs-card__actions">
              <Button variant="default" size="sm" leftSection={<IconHistory aria-hidden size={16} />} onClick={() => setHistoryOpened(true)}>
                История
              </Button>
              <Button variant="light" size="sm" leftSection={<IconRefresh aria-hidden size={16} />} onClick={() => refetch()}>
                Пересчитать
              </Button>
            </div>
          </div>

          {/* Вкладки на весь экран карточки (05.09, владелец: «при выборе
              менялся весь экран, потому что места мало»). Цифры итога —
              в подписях вкладок, а не отдельной полосой */}
          <div className="panel__tabs specs-card__tabs" role="tablist" aria-label="Разделы изделия">
            {([
              { key: 'norms', label: 'Нормы труда', summary: canCost && costing ? `${num(costing.result.laborCost, 0)} ₸ · ${num(costing.explain.totalManHours, 1)} ч` : undefined },
              { key: 'bom', label: 'Состав', summary: canCost && costing ? `${num(costing.result.materialCost, 0)} ₸` : (article?.bomItems?.length ? `${article.bomItems.length} поз.` : undefined) },
              ...(canCost ? [{ key: 'cost', label: 'Себестоимость', summary: costing ? `${num(costing.result.totalCost, 0)} ₸` : undefined }] : []),
              { key: 'usage', label: 'Где применяется', summary: undefined },
            ] as Array<{ key: View; label: string; summary?: string }>).map((t) => (
              <button
                key={t.key} type="button" role="tab" id={`specs-tab-${t.key}`}
                aria-selected={view === t.key} aria-controls="specs-view"
                className="panel__tab" onClick={() => setView(t.key)}
              >
                {t.label}{t.summary && <small>{t.summary}</small>}
              </button>
            ))}
          </div>
          <div className="specs-card__view" id="specs-view" role="tabpanel" aria-labelledby={`specs-tab-${view}`}>
            <FadeSwap swapKey={`${openedId}-${view}`} style={{ height: '100%' }}>
              {view === 'norms' ? (
                <section className="specs-card__norms" aria-label="Нормы труда">
                  {routingLoading || !routing
                    ? <Skeleton height={180} radius="lg" />
                    : <StageTable stages={routing.stages} articleId={openedId} />}
                </section>
              ) : view === 'bom' ? <BomPanel articleId={openedId} />
                : view === 'cost' ? <CostingPanel articleId={openedId} />
                  : <UsagePanel articleId={openedId} />}
            </FadeSwap>
          </div>
        </Card>
      </FitScreen>
    );
  }

  /* ---- таблица изделий ---- */
  const header = (
    <Stack gap="sm">
      <SectionHead title="Изделия" subtitle="нормы труда и себестоимость по каждому артикулу" actions={<NomenclatureRequestsButton />} />
      <Group gap="sm" wrap="nowrap" justify="space-between">
        <div className="specs-queue" role="tablist" aria-label="Очередь работы">
          {QUEUES.map((q) => (
            <button
              key={q.v || 'all'} type="button" role="tab"
              aria-selected={gap === q.v} data-active={gap === q.v ? 'true' : undefined}
              onClick={() => { setGap(q.v); setPage(1); }}
            >
              {q.label}
              {gaps && <span className="specs-queue__n">{gaps[q.key].toLocaleString('ru-RU')}</span>}
            </button>
          ))}
        </div>
        <TextInput
          placeholder="Артикул или название…" leftSection={<IconSearch aria-hidden size={16} />}
          value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          size="sm" style={{ flex: '0 1 320px' }}
        />
      </Group>
    </Stack>
  );
  const footer = (
    <PaginationBar page={page} total={total ?? 0} pageSize={Math.max(1, fit.rows)} onPageChange={setPage} noun="изделий" />
  );

  return (
    <FitScreen header={header} footer={footer}>
      <Card withBorder radius="lg" padding={0} className="specs-table-card">
        <div ref={fit.ref} className="specs-table-wrap">
          <table className="dense specs-table">
            <thead>
              <tr>
                <th style={{ width: 124 }}>Артикул</th>
                <th>Название</th>
                <th style={{ width: 112 }}>Состав</th>
                <th className="num" style={{ width: 136 }}>Утв. цена</th>
                <th className="num" style={{ width: 136 }}>Расч. цена</th>
                <th className="num" style={{ width: 84 }}>Откл.</th>
                <th className="num" style={{ width: 90 }}>Вес, кг</th>
              </tr>
            </thead>
            <tbody>
              {articlesLoading ? (
                [...Array(Math.max(4, fit.rows))].map((_, i) => (
                  <tr key={i}><td colSpan={7}><Skeleton height={16} radius="sm" /></td></tr>
                ))
              ) : articles.length === 0 ? (
                <tr><td colSpan={7}>
                  <Text size="sm" c="dimmed" py="md" ta="center">
                    {gap ? 'В этой очереди пусто — заполнять нечего' : 'Артикула нет в справочнике'}
                  </Text>
                </td></tr>
              ) : articles.map((a) => {
                const bom = a.isMaterialResale ? 'перепродажа' : a.bomItems?.length ? `${a.bomItems.length} поз.` : null;
                const dev = a.priceDeviationPct;
                return (
                  <tr key={a.id} className="dense__link" onClick={() => setOpened(a.id)}>
                    <td className="num" style={{ textAlign: 'left', fontWeight: 700 }}>{a.articleCode}</td>
                    <td title={a.name}>{a.name}</td>
                    <td>{bom ?? <span className="worklist__chip" data-tone="danger">нет</span>}</td>
                    <td className="num">{a.approvedPrice ? formatCurrency(a.approvedPrice) : '—'}</td>
                    <td className="num">{a.specPrice ? formatCurrency(a.specPrice) : '—'}</td>
                    <td className="num" style={{ color: devTone(dev) }}>{dev == null ? '—' : `${dev > 0 ? '+' : ''}${num(dev, 0)} %`}</td>
                    <td className="num">{a.weightKg ? num(a.weightKg, 1) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </FitScreen>
  );
}
