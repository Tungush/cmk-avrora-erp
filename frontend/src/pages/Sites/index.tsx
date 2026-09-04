import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Group, Text, TextInput, Skeleton, Tooltip } from '@mantine/core';
import { IconSearch, IconAntenna, IconClockExclamation, IconCircleCheck, IconCurrencyTenge } from '@tabler/icons-react';
import api from '../../api/client';
import { EmptyState } from '../../components/EmptyState';
import { PulseRow } from '../../components/SectionHeader';
import { FitScreen, useFitGrid, usePageKeys } from '../../components/FitScreen';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { FadeSwap } from '../../components/motion';
import { formatDate, formatCompactMoney } from '../../utils/formatters';
import { TextReveal } from '../../components/motion';
import { Ref, useEntity } from '../../components/EntityRef';

/**
 * Проекты — площадки заказчика (было «Объекты», переименовано 04.09.2026) (02.09.2026, просьба владельца: «объекты как
 * мачты для базовых станций»).
 *
 * Телеком считает не заказами, а площадками: на одну БС идут разные заказы
 * и разные изделия, а спрашивают всегда про объект — «мачта на Dudar
 * готова?». Такого среза в системе не было вовсе.
 *
 * Каждый объект нарисован своей мачтой: секции загораются по мере того,
 * как цех отмечает изделия. Это не украшение — готовность площадки видна
 * раньше, чем прочитаешь цифру.
 *
 * Площадка приходит из 1С (orders.project_site). Заказы, где её не
 * заполнили, сюда не попадают — так и написано в пустом состоянии.
 */

interface SiteRow {
  site: string;
  projectGroup: string;
  customerName: string;
  ordersCount: number;
  overdueOrders: number;
  linesCount: number;
  doneLines: number;
  amount: string;
  nearestDate: string | null;
  maxOverdueDays: number;
}

const money = (v: string | number) =>
  Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 });

/** Человеческое имя площадки: KZ-ALM_Dudar → ALM · Dudar */
const siteTitle = (code: string) => code.replace(/^KZ-/, '').replace(/_/g, ' · ');

type Slice = 'all' | 'overdue' | 'ready';

/** Размер карточки, по нему и считается, сколько их влезло */
const CARD_MIN_W = 250;
const CARD_H = 150;

export function Sites() {
  const [search, setSearch] = useState('');
  const [slice, setSlice] = useState<Slice>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['order-sites'],
    queryFn: () => api.get<{ data: SiteRow[] }>('/orders/sites').then((r) => r.data),
    refetchInterval: 120_000,
  });

  const rows = data?.data ?? [];

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? rows.filter((r) => r.site.toLowerCase().includes(q) || r.customerName.toLowerCase().includes(q))
      : rows;
    return {
      all: base,
      overdue: base.filter((r) => r.overdueOrders > 0),
      ready: base.filter((r) => r.linesCount > 0 && r.doneLines >= r.linesCount),
    };
  }, [rows, search]);

  const visible = groups[slice];
  // Карточек ровно столько, сколько поместилось: ни одна не свисает за край
  const fit = useFitGrid(CARD_MIN_W, CARD_H, 12, 2, 40);
  const paged = usePagedList(visible, fit.count, `${search}|${slice}|${fit.count}`);
  usePageKeys(paged.page, Math.max(1, Math.ceil(paged.total / Math.max(1, fit.count))), paged.setPage);

  const totalAmount = rows.reduce((s, r) => s + Number(r.amount || 0), 0);

  const header = (
    <div>
      <Group justify="space-between" align="center" wrap="nowrap" gap="md" mb="sm">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text component="h1" fw={800} style={{ fontSize: 22, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
            <TextReveal text="Проекты" />
          </Text>
          <Text size="sm" c="dimmed" lineClamp={1}>
            площадки заказчика: что уже сдано, а что ещё в работе
          </Text>
        </Group>
        <TextInput
          placeholder="Площадка или заказчик..."
          leftSection={<IconSearch aria-hidden size={16} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          size="sm"
          w={280}
        />
      </Group>
      <PulseRow
        loading={isLoading && !data}
        items={[
          {
            key: 'all', label: 'Площадок', value: groups.all.length.toLocaleString('ru-RU'),
            hint: 'объект указан в заказе из 1С', icon: <IconAntenna aria-hidden size={16} />,
            onClick: () => setSlice('all'), active: slice === 'all',
          },
          {
            key: 'overdue', label: 'С просрочкой', value: groups.overdue.length.toLocaleString('ru-RU'),
            hint: 'срок вывоза прошёл', tone: 'danger', icon: <IconClockExclamation aria-hidden size={16} />,
            onClick: () => setSlice('overdue'), active: slice === 'overdue',
          },
          {
            key: 'ready', label: 'Собраны полностью', value: groups.ready.length.toLocaleString('ru-RU'),
            hint: 'все изделия изготовлены', tone: 'ok', icon: <IconCircleCheck aria-hidden size={16} />,
            onClick: () => setSlice('ready'), active: slice === 'ready',
          },
          {
            key: 'money', label: 'Сумма по объектам', value: formatCompactMoney(totalAmount),
            hint: '₸ по позициям заказов', tone: 'brand', icon: <IconCurrencyTenge aria-hidden size={16} />,
          },
        ]}
      />
    </div>
  );

  const footer = (
    <PaginationBar
      page={paged.page}
      total={paged.total}
      pageSize={Math.max(1, fit.count)}
      onPageChange={paged.setPage}
      noun="объектов"
    />
  );

  return (
    <FitScreen header={header} footer={footer}>
      <div className="site-grid" ref={fit.ref}>
      {isLoading && !data ? (
        [...Array(Math.max(4, fit.count))].map((_, i) => <Skeleton key={i} height={CARD_H} radius="lg" />)
      ) : paged.total === 0 ? (
        <div className="site-grid__empty">
          <EmptyState
            height={200}
            title={search ? 'Такой площадки нет' : 'Проекты пока не заполнены'}
            hint={search ? undefined
              : 'Площадка приходит из 1С полем «проект/объект». Пока оно пустое, заказ виден только в реестре.'}
          />
        </div>
      ) : (
        paged.slice.map((s) => <SiteCard key={s.site} row={s} />)
      )}
      </div>
    </FitScreen>
  );
}

/** Одна площадка: мачта растёт по готовности, цифры — рядом */
function SiteCard({ row }: { row: SiteRow }) {
  const progress = row.linesCount > 0 ? row.doneLines / row.linesCount : 0;
  const done = row.linesCount > 0 && row.doneLines >= row.linesCount;
  const overdue = row.overdueOrders > 0;
  const { open } = useEntity();

  /**
   * Раньше карточка уводила в реестр заказов с поиском по коду площадки —
   * человек терял сетку объектов и возвращался «назад». Теперь открывается
   * карточка объекта шторкой поверх (03.09.2026). Не <button>: внутри есть
   * своя ссылка на заказчика, а кнопку в кнопку вкладывать нельзя.
   */
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => open({ kind: 'site', id: row.site, label: siteTitle(row.site) })}
      onKeyDown={(e) => {
        // Только со самой карточки: Enter на вложенной ссылке заказчика —
        // её дело, иначе откроются сразу две шторки
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open({ kind: 'site', id: row.site, label: siteTitle(row.site) });
        }
      }}
      className="site-card glass-lit"
      style={{ cursor: 'pointer' }}
      data-state={done ? 'done' : overdue ? 'overdue' : undefined}
    >
      {/* Готовность полосой, а не силуэтом мачты (04.09.2026): доля
          читается числом, а не на глаз по высоте заливки. */}
      <div className="site-card__ready" aria-hidden>
        <div className="site-card__ready-bar">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="site-card__ready-num">{Math.round(progress * 100)}%</div>
      </div>

      <div className="site-card__body">
        <Tooltip label={row.site} openDelay={500}>
          <div className="site-card__title">{siteTitle(row.site)}</div>
        </Tooltip>
        <div className="site-card__sub">
          <Ref
            kind="customer"
            id={row.customerName || null}
            label={row.customerName}
            tone="text"
            size="xs"
          >
            {row.customerName || '—'}
          </Ref>
        </div>

        <div className="site-card__stat">
          <b>{row.doneLines}</b><span>/{row.linesCount} изделий</span>
        </div>

        <div className="site-card__meta">
          <span>{row.ordersCount} зак.</span>
          <span>{money(row.amount)} ₸</span>
        </div>

        {overdue ? (
          <span className="worklist__chip" data-tone="danger">просрочка {row.maxOverdueDays} дн</span>
        ) : row.nearestDate ? (
          <span className="worklist__chip">вывоз {formatDate(row.nearestDate)}</span>
        ) : done ? (
          <span className="worklist__chip" data-tone="info">собрано</span>
        ) : (
          <span className="worklist__chip">срок не задан</span>
        )}
      </div>
    </div>
  );
}
