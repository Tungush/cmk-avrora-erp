import React, { useEffect, useState } from 'react';
import {
  Card, Stack, Text, Table, Skeleton, Group, Button, TextInput,
  Badge, Modal, Textarea, SegmentedControl, Tabs,
} from '@mantine/core';
import { IconSearch, IconCoin, IconCheck } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { useArticles } from '../../hooks/useCatalog';
import { usePriceReviews } from '../../hooks/useRouting';
import { useAuthStore } from '../../store/auth';
import { PriceReviewsPanel } from '../../components/PriceReviewsPanel';
import { formatCurrency } from '../../utils/formatters';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { FitScreen, useFitGrid, useFitRows, usePageKeys } from '../../components/FitScreen';
import { FadeSwap, TextReveal } from '../../components/motion';
import { MastLoader } from '../../components/Mast';
import { DigestCard, type DigestCardProps } from '../../components/Digest';
import { IconRuler2, IconScale, IconAlertTriangle, IconLayoutGrid, IconList, IconGavel } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { SectionHead } from '../../components/SectionHeader';
import './Prices.css';

/** Карточка-ответ: по её размеру считается, сколько их влезло в экран */
const CARD_MIN_W = 268;
const CARD_H = 380;
/** Высота строки прайса: в неё помещается кнопка «Пересмотр цены» */
const ROW_H = 56;

type View = 'digest' | 'reviews' | 'list';

/**
 * Прайс (28.08.2026). Данные о ценах жили в модели с самого начала, но
 * экрана не существовало: посмотреть прайс списком и запустить пересмотр
 * было негде — цены 2026 года жили в Excel и, как показал разбор файла,
 * из-за съехавших формул в заказы даже там не попадали.
 *
 * Механика пересмотра НЕ новая: заявка → директор утверждает (аудит и
 * история цен пишутся там же). Эта страница — вход в неё списком.
 *
 * 03.09.2026: страница больше не прокручивается. Раньше очередь
 * «пересмотр цен» (402 px) стояла НАД сводкой и сдвигала все четыре
 * карточки-ответа за нижний край — директор видел заявки, но не видел
 * ответа «что вообще с ценами». Теперь это три равноправные вкладки:
 * сводка (по умолчанию), очередь решений и весь прайс. Ничего не
 * убрано, всё на расстоянии одного клика.
 */
export function Prices() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const hasRole = useAuthStore((s) => s.hasRole);
  const can = useAuthStore((s) => s.can);
  const canRequest = hasRole(['engineer', 'accountant', 'sales_manager', 'admin']);
  const canApprove = can('approve', 'article.price');

  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'priced' | 'all'>('priced');
  // Раздел открывается сводкой: 2 152 строки каталога — не ответ на вопрос
  const [view, setView] = useState<View>('digest');
  const [reviewFor, setReviewFor] = useState<any | null>(null);
  const [reason, setReason] = useState('');

  const digest = useQuery({
    queryKey: ['price-digest'],
    queryFn: () => api.get<{
      total: number; priced: number; withSpec: number; comparable: number; belowCost: number;
      thinnest: Array<{ id: string; articleCode: string; name: string; approvedPrice: string; specPrice: string; deviationPct: string }>;
    }>('/articles/price-digest').then((r) => r.data),
  });

  // Счётчик на вкладке: сколько заявок ждёт решения директора
  const reviews = usePriceReviews('PENDING');
  const pendingCount = canApprove ? (reviews.data?.data?.length ?? 0) : 0;

  const requestReview = useMutation({
    mutationFn: (articleId: string) =>
      api.post(`/articles/${articleId}/price-review`, { reason: reason.trim() || undefined }).then((r) => r.data),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['price-reviews'] });
      notifications.show({
        title: 'Заявка на пересмотр подана',
        message: `${res.article.articleCode} — решает директор`,
        color: 'success',
        icon: <IconCheck size={16} aria-hidden />,
      });
      setReviewFor(null); setReason('');
    },
    onError: (e: any) => notifications.show({
      title: 'Не подано',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  /* Название, вкладки и поиск — одной строкой (04.09.2026). Раньше это
     были три уровня: название, под ним вкладки, а поиск с переключателем
     охвата — сбоку от названия. Счётчик заявок на пересмотр остался: он
     говорит, что вкладка требует внимания. */
  const header = (
    <SectionHead
      title="Прайс"
      subtitle="утверждённые цены против расчёта по спецификации — цена меняется только через пересмотр"
      value={view}
      onChange={(v) => setView(v as View)}
      tabs={[
        { value: 'digest', label: 'Что с ценами', icon: <IconLayoutGrid size={16} aria-hidden /> },
        ...(canApprove ? [{
          value: 'reviews',
          label: pendingCount > 0 ? `Пересмотр цен · ${pendingCount}` : 'Пересмотр цен',
          icon: <IconGavel size={16} aria-hidden />,
        }] : []),
        { value: 'list', label: 'Весь прайс', icon: <IconList size={16} aria-hidden /> },
      ]}
      actions={view === 'list' ? (
        <>
          <SegmentedControl
            value={scope}
            onChange={(v) => setScope(v as 'priced' | 'all')}
            size="xs"
            w="fit-content"
            data={[
              { value: 'priced', label: 'Прайс-лист' },
              { value: 'all', label: 'Весь каталог' },
            ]}
          />
          <TextInput
            placeholder="Код, название или старый код…"
            leftSection={<IconSearch size={16} aria-hidden />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="sm"
            w={260}
          />
        </>
      ) : undefined}
    />
  );

  return (
    <FitScreen header={header}>
      {view === 'digest' && (
        <PriceDigest
          data={digest.data}
          loading={digest.isLoading}
          onList={() => setView('list')}
          onSpecs={() => navigate('/specs')}
        />
      )}

      {/* Очередь решений — длинная по природе: у неё своя прокрутка
          внутри панели, страница при этом стоит */}
      {view === 'reviews' && (
        <div className="section-body">
          {pendingCount > 0
            ? <PriceReviewsPanel />
            : <Text size="sm" c="dimmed">Заявок на пересмотр цены нет — решать нечего.</Text>}
        </div>
      )}

      {view === 'list' && (
        <PriceList
          search={search}
          scope={scope}
          canRequest={canRequest}
          onReview={setReviewFor}
        />
      )}

      <Modal
        opened={reviewFor !== null}
        onClose={() => setReviewFor(null)}
        title={<Text fw={700}>Пересмотр цены: {reviewFor?.articleCode}</Text>}
        radius="md" centered
      >
        {reviewFor && (
          <Stack gap="md">
            <Text size="sm" c="dimmed">{reviewFor.name}</Text>
            <Group gap="xl">
              <Stack gap={0}>
                <Text size="xs" c="dimmed">Сейчас в прайсе</Text>
                <Text fw={700} ff="monospace">
                  {Number(reviewFor.approvedPrice) > 0 ? formatCurrency(Number(reviewFor.approvedPrice)) : '—'}
                </Text>
              </Stack>
              <Stack gap={0}>
                <Text size="xs" c="dimmed">Расчёт по спецификации</Text>
                <Text fw={700} ff="monospace">
                  {Number(reviewFor.specPrice) > 0 ? formatCurrency(Number(reviewFor.specPrice)) : '—'}
                </Text>
              </Stack>
            </Group>
            <Textarea
              label="Почему цену надо пересмотреть"
              placeholder="подорожал металл, изменился состав…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autosize minRows={2}
            />
            <Text size="xs" c="dimmed">
              Новую цену называет директор при утверждении — заявка лишь запускает пересмотр.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setReviewFor(null)}>Отмена</Button>
              <Button loading={requestReview.isPending} onClick={() => requestReview.mutate(reviewFor.id)}>
                Подать заявку
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </FitScreen>
  );
}

/**
 * Сводка прайса: цена утверждена у 176 изделий из 2 152, а сравнить её
 * с себестоимостью не с чем — расчёт есть у двух. Это и есть ответ,
 * ради которого сюда заходят; список остаётся за вкладкой.
 *
 * Карточек показываем ровно столько, сколько поместилось: на 1280 px
 * в ряд встают три, четвёртая уходит на вторую страницу, а не под край.
 */
function PriceDigest({
  data, loading, onList, onSpecs,
}: {
  data?: {
    total: number; priced: number; withSpec: number; comparable: number; belowCost: number;
    thinnest: Array<{ id: string; articleCode: string; name: string; approvedPrice: string; specPrice: string; deviationPct: string }>;
  };
  loading: boolean;
  onList: () => void;
  onSpecs: () => void;
}) {
  const n = (v: number) => v.toLocaleString('ru-RU');
  const total = data?.total ?? 0;
  const priced = data?.priced ?? 0;
  const withSpec = data?.withSpec ?? 0;
  const comparable = data?.comparable ?? 0;
  const noCost = Math.max(0, total - withSpec);
  const pricedPct = total > 0 ? Math.round((priced / total) * 100) : 0;

  const fit = useFitGrid(CARD_MIN_W, CARD_H, 12, 1, 12);

  const cards: Array<DigestCardProps & { key: string }> = [
    {
      key: 'priced',
      title: 'В прайсе',
      tone: 'brand',
      icon: <IconCoin size={19} aria-hidden />,
      value: priced,
      format: (v) => Math.round(v).toLocaleString('ru-RU'),
      caption: `изделий с утверждённой ценой из ${n(total)} · ${pricedPct} % каталога`,
      loading,
      emptyText: 'Цена не утверждена ни у одного изделия',
      action: { label: 'Открыть прайс', onClick: onList },
    },
    {
      key: 'comparable',
      title: 'Не с чем сравнить',
      tone: comparable === 0 ? 'warn' : 'ok',
      icon: <IconScale size={19} aria-hidden />,
      value: comparable,
      format: (v) => Math.round(v).toLocaleString('ru-RU'),
      caption: comparable === 0
        ? 'ни у одного изделия нет одновременно цены и расчёта — проверить наценку невозможно'
        : 'изделий, где есть и цена, и расчёт себестоимости',
      loading,
      items: (data?.thinnest ?? []).slice(0, 4).map((a) => ({
        id: a.id,
        label: `${a.articleCode} · ${a.name}`,
        value: `${Number(a.deviationPct).toFixed(0)} %`,
        sub: `цена ${formatCurrency(Number(a.approvedPrice))} · расчёт ${formatCurrency(Number(a.specPrice))}`,
      })),
      emptyText: 'Сравнить цену с себестоимостью пока не на чем',
    },
    {
      key: 'below',
      title: 'Ниже себестоимости',
      tone: (data?.belowCost ?? 0) > 0 ? 'danger' : 'ok',
      icon: <IconAlertTriangle size={19} aria-hidden />,
      value: data?.belowCost ?? 0,
      format: (v) => Math.round(v).toLocaleString('ru-RU'),
      caption: (data?.belowCost ?? 0) > 0
        ? 'изделий продаются дешевле, чем стоят заводу'
        : 'убыточных цен не найдено',
      loading,
      emptyText: 'Убыточных цен нет',
    },
    {
      key: 'nocost',
      title: 'Нечего считать',
      tone: noCost > 0 ? 'warn' : 'ok',
      icon: <IconRuler2 size={19} aria-hidden />,
      value: noCost,
      format: (v) => Math.round(v).toLocaleString('ru-RU'),
      caption: 'изделий без спецификации и норм — себестоимость по ним нулевая, цену обосновать нечем',
      loading,
      emptyText: 'У всех изделий есть расчёт',
      action: { label: 'Завести спецификации', onClick: onSpecs },
    },
  ];

  const paged = usePagedList(cards, Math.max(1, fit.count), `${fit.count}`);
  usePageKeys(paged.page, paged.totalPages, paged.setPage);

  return (
    <div className="prices-pane">
      <div className="digest-grid prices-pane__grid" ref={fit.ref}>
        {paged.slice.map(({ key, ...card }) => <DigestCard key={key} {...card} />)}
      </div>
      {paged.totalPages > 1 && (
        <PaginationBar
          page={paged.page}
          total={paged.total}
          pageSize={Math.max(1, fit.count)}
          onPageChange={paged.setPage}
          noun="карточек"
          variant="compact"
        />
      )}
    </div>
  );
}

/**
 * Весь прайс списком. Отдельный компонент, потому что useFitRows вешает
 * наблюдатель за размером один раз — при монтировании. Пока таблица была
 * куском общего JSX, ref появлялся только при выборе вкладки, наблюдатель
 * к нему уже не приезжал, и вместо девяти строк оставалось четыре
 * (03.09.2026). Размер страницы = высота экрана, поэтому селектор
 * «25 / 50 / 100» здесь больше не нужен.
 */
function PriceList({
  search, scope, canRequest, onReview,
}: {
  search: string;
  scope: 'priced' | 'all';
  canRequest: boolean;
  onReview: (article: any) => void;
}) {
  const fit = useFitRows(ROW_H, 4, 40, 44);
  const pageSize = Math.max(1, fit.rows);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [pageSize, scope, search]);

  const { data, isLoading } = useArticles({
    search, page, pageSize,
    ...(scope === 'priced' ? { onlyPriced: true } : {}),
  });

  const rows: any[] = data?.data ?? [];
  const total = data?.meta?.total ?? 0;
  usePageKeys(page, Math.max(1, Math.ceil(total / pageSize)), setPage);

  const deviation = (a: any): number | null => {
    const appr = Number(a.approvedPrice);
    const calc = Number(a.specPrice);
    if (!(appr > 0) || !(calc > 0)) return null;
    return Math.round(((appr - calc) / calc) * 1000) / 10;
  };

  return (
    <div className="prices-pane">
      <Card withBorder radius="md" padding={0} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div className="prices-list" ref={fit.ref}>
          {isLoading ? (
            <Stack gap={4} p="md">
              {[...Array(Math.max(4, pageSize))].map((_, i) => <Skeleton key={i} height={44} radius="sm" />)}
            </Stack>
          ) : (
            <FadeSwap swapKey={`${scope}:${page}`}>
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Изделие</Table.Th>
                    <Table.Th ta="right">Утв. цена</Table.Th>
                    <Table.Th ta="right">Расчёт по спецификации</Table.Th>
                    <Table.Th ta="right">Отклонение</Table.Th>
                    {canRequest && <Table.Th w={170} />}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((a) => {
                    const dev = deviation(a);
                    return (
                      <Table.Tr key={a.id}>
                        <Table.Td>
                          <Text size="sm" ff="monospace" fw={600}>{a.articleCode}</Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>{a.name}</Text>
                        </Table.Td>
                        <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                          {Number(a.approvedPrice) > 0
                            ? <Text span fw={700}>{formatCurrency(Number(a.approvedPrice))}</Text>
                            : <Text span size="xs" c="dimmed">не утверждена</Text>}
                        </Table.Td>
                        <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                          {Number(a.specPrice) > 0
                            ? formatCurrency(Number(a.specPrice))
                            : <Text span size="xs" c="dimmed">—</Text>}
                        </Table.Td>
                        <Table.Td ta="right">
                          {dev == null ? (
                            <Text size="xs" c="dimmed">—</Text>
                          ) : (
                            // Цена ниже расчёта — продаём дешевле себестоимости с маржой
                            <Badge
                              variant="light" radius="xl"
                              color={dev < 0 ? 'danger' : Math.abs(dev) > 15 ? 'warning' : 'success'}
                            >
                              {dev > 0 ? '+' : ''}{dev.toLocaleString('ru-RU')} %
                            </Badge>
                          )}
                        </Table.Td>
                        {canRequest && (
                          <Table.Td>
                            <Button
                              size="compact-sm"
                              variant="light"
                              leftSection={<IconCoin size={14} aria-hidden />}
                              onClick={() => onReview(a)}
                            >
                              Пересмотр цены
                            </Button>
                          </Table.Td>
                        )}
                      </Table.Tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <Table.Tr>
                      <Table.Td colSpan={5}>
                        <MastLoader height={132} sections={5} title="Цен по такому запросу нет" />
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Table.Tbody>
              </Table>
            </FadeSwap>
          )}
        </div>
      </Card>
      <PaginationBar
        page={page}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        noun="изделий"
        variant="compact"
      />
    </div>
  );
}
