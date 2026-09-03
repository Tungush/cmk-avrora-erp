import React, { useEffect, useState } from 'react';
import {
  Card, Stack, Text, Table, Skeleton, Group, Button, TextInput,
  Badge, Modal, Textarea, SegmentedControl,
} from '@mantine/core';
import { IconSearch, IconCoin, IconCheck } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { useArticles } from '../../hooks/useCatalog';
import { useAuthStore } from '../../store/auth';
import { PriceReviewsPanel } from '../../components/PriceReviewsPanel';
import { formatCurrency } from '../../utils/formatters';
import { TableScroll } from '../../components/TableScroll';
import { PaginationBar, usePageSize } from '../../components/PaginationBar';
import { FadeSwap } from '../../components/motion';
import { MastLoader } from '../../components/Mast';
import { DigestCard, DigestGrid } from '../../components/Digest';
import { ViewSwitch } from '../../components/ViewSwitch';
import { IconRuler2, IconScale, IconAlertTriangle } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';

/**
 * Прайс (28.08.2026). Данные о ценах жили в модели с самого начала, но
 * экрана не существовало: посмотреть прайс списком и запустить пересмотр
 * было негде — цены 2026 года жили в Excel и, как показал разбор файла,
 * из-за съехавших формул в заказы даже там не попадали.
 *
 * Механика пересмотра НЕ новая: заявка → директор утверждает (аудит и
 * история цен пишутся там же). Эта страница — вход в неё списком.
 */
export function Prices() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const hasRole = useAuthStore((s) => s.hasRole);
  const isDirector = hasRole(['director', 'admin']);
  const canRequest = hasRole(['engineer', 'accountant', 'sales_manager', 'admin']);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize('prices', 25);
  const [scope, setScope] = useState<'priced' | 'all'>('priced');
  // Раздел открывается сводкой: 2 152 строки каталога — не ответ на вопрос
  const [view, setView] = useState<'digest' | 'list'>('digest');
  const [reviewFor, setReviewFor] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { setPage(1); }, [pageSize]);

  const { data, isLoading } = useArticles({
    search, page, pageSize,
    ...(scope === 'priced' ? { onlyPriced: true } : {}),
  });

  const digest = useQuery({
    queryKey: ['price-digest'],
    queryFn: () => api.get<{
      total: number; priced: number; withSpec: number; comparable: number; belowCost: number;
      thinnest: Array<{ id: string; articleCode: string; name: string; approvedPrice: string; specPrice: string; deviationPct: string }>;
    }>('/articles/price-digest').then((r) => r.data),
  });

  const requestReview = useMutation({
    mutationFn: (articleId: string) =>
      api.post(`/articles/${articleId}/price-review`, { reason: reason.trim() || undefined }).then((r) => r.data),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['price-reviews'] });
      notifications.show({
        title: 'Заявка на пересмотр подана',
        message: `${res.article.articleCode} — решает директор`,
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      setReviewFor(null); setReason('');
    },
    onError: (e: any) => notifications.show({
      title: 'Не подано',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  const rows: any[] = data?.data ?? [];
  const total = data?.meta?.total ?? 0;

  const deviation = (a: any): number | null => {
    const appr = Number(a.approvedPrice);
    const calc = Number(a.specPrice);
    if (!(appr > 0) || !(calc > 0)) return null;
    return Math.round(((appr - calc) / calc) * 1000) / 10;
  };

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text component="h1" fw={700} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.01em', lineHeight: 1.15 }}>
          Прайс
        </Text>
        <Text size="sm" c="dimmed">
          Утверждённые цены изделий против расчёта по спецификации.
          Цена меняется только через пересмотр — утверждает директор
        </Text>
      </Stack>

      {/* Директор видит очередь заявок прямо здесь, не бегая на дашборд */}
      {isDirector && <PriceReviewsPanel />}

      <ViewSwitch
        value={view}
        onChange={setView}
        digestLabel="Что с ценами"
        listLabel="Весь прайс"
      />

      {view === 'digest' ? (
        <PriceDigest data={digest.data} loading={digest.isLoading} onList={() => setView('list')}
          onSpecs={() => navigate('/specs')} />
      ) : (
      <>
      <div className="toolbar-sticky">
        <Group gap="sm" wrap="wrap" justify="space-between">
          <Group gap="sm" wrap="wrap">
            <SegmentedControl
              value={scope}
              onChange={(v) => { setScope(v as 'priced' | 'all'); setPage(1); }}
              size="sm"
              w="fit-content"
              data={[
                { value: 'priced', label: 'Прайс-лист' },
                { value: 'all', label: 'Весь каталог' },
              ]}
            />
            <TextInput
              placeholder="Код, название или старый код…"
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              w={360}
              style={{ maxWidth: '100%' }}
            />
          </Group>
          <Text size="sm" c="dimmed">
            Найдено: <Text span fw={700} ff="monospace">{total.toLocaleString('ru-RU')}</Text>
          </Text>
        </Group>
      </div>

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">{[...Array(8)].map((_, i) => <Skeleton key={i} height={44} radius="sm" />)}</Stack>
        ) : (
          <FadeSwap swapKey={`${scope}:${page}`}>
            <TableScroll minWidth={780}>
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
                          <Text size="sm" ff="monospace" fw={600} c="brand.7">{a.articleCode}</Text>
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
                              color={dev < 0 ? 'danger' : Math.abs(dev) > 15 ? 'warning' : 'teal'}
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
                              leftSection={<IconCoin size={14} />}
                              onClick={() => setReviewFor(a)}
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
            </TableScroll>
          </FadeSwap>
        )}
      </Card>

      <PaginationBar
        page={page}
        total={total}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        noun="изделий"
        sticky
      />

      </>
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
    </Stack>
  );
}

/**
 * Сводка прайса: цена утверждена у 176 изделий из 2 152, а сравнить её
 * с себестоимостью не с чем — расчёт есть у двух. Это и есть ответ,
 * ради которого сюда заходят; список остаётся за переключателем.
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

  return (
    <DigestGrid>
      <DigestCard
        title="В прайсе"
        tone="brand"
        icon={<IconCoin size={19} />}
        value={priced}
        format={(v) => Math.round(v).toLocaleString('ru-RU')}
        caption={`изделий с утверждённой ценой из ${n(total)} · ${pricedPct} % каталога`}
        loading={loading}
        emptyText="Цена не утверждена ни у одного изделия"
        action={{ label: 'Открыть прайс', onClick: onList }}
      />

      <DigestCard
        title="Не с чем сравнить"
        tone={comparable === 0 ? 'warn' : 'ok'}
        icon={<IconScale size={19} />}
        value={comparable}
        format={(v) => Math.round(v).toLocaleString('ru-RU')}
        caption={comparable === 0
          ? 'ни у одного изделия нет одновременно цены и расчёта — проверить наценку невозможно'
          : 'изделий, где есть и цена, и расчёт себестоимости'}
        loading={loading}
        items={(data?.thinnest ?? []).slice(0, 4).map((a) => ({
          id: a.id,
          label: `${a.articleCode} · ${a.name}`,
          value: `${Number(a.deviationPct).toFixed(0)} %`,
          sub: `цена ${formatCurrency(Number(a.approvedPrice))} · расчёт ${formatCurrency(Number(a.specPrice))}`,
        }))}
        emptyText="Сравнить цену с себестоимостью пока не на чем"
      />

      <DigestCard
        title="Ниже себестоимости"
        tone={(data?.belowCost ?? 0) > 0 ? 'danger' : 'ok'}
        icon={<IconAlertTriangle size={19} />}
        value={data?.belowCost ?? 0}
        format={(v) => Math.round(v).toLocaleString('ru-RU')}
        caption={(data?.belowCost ?? 0) > 0
          ? 'изделий продаются дешевле, чем стоят заводу'
          : 'убыточных цен не найдено'}
        loading={loading}
        emptyText="Убыточных цен нет"
      />

      <DigestCard
        title="Нечего считать"
        tone={noCost > 0 ? 'warn' : 'ok'}
        icon={<IconRuler2 size={19} />}
        value={noCost}
        format={(v) => Math.round(v).toLocaleString('ru-RU')}
        caption="изделий без спецификации и норм — себестоимость по ним нулевая, цену обосновать нечем"
        loading={loading}
        emptyText="У всех изделий есть расчёт"
        action={{ label: 'Завести спецификации', onClick: onSpecs }}
      />
    </DigestGrid>
  );
}
