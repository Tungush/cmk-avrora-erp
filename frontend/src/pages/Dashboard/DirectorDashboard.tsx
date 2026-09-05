import React, { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Text } from '@mantine/core';
import {
  IconAlertTriangle, IconScale, IconReceipt, IconBuildingBank, IconTruckDelivery,
  IconGavel, IconClockExclamation, IconFlask, IconInbox, IconArrowRight,
} from '@tabler/icons-react';
import api from '../../api/client';
import { dashboardApi } from '../../api/dashboard';
import { FitScreen } from '../../components/FitScreen';
import { RingDashboard } from '../../components/dashboard/RingDashboard';
import { Sparkline } from '../../components/dashboard/Sparkline';
import { SmartPeekCard, PeekRow, PeekWarmProvider } from '../../components/dashboard/SmartPeekCard';
import { OrderRef, useOrderCard } from '../../components/OrderCard/OrderCardProvider';
import { formatCompactMoney, formatCurrency } from '../../utils/formatters';
import './Dashboard.css';

/**
 * Экран директора, переписан с чистого листа (05.09.2026).
 *
 * Три слоя раскрытия (Smashing 09.2025, NN/g):
 *   1. ПЯТЬ карточек-показателей — и ни одной больше. Число крупно,
 *      микрографик подложкой (модель Grafana Stat), а не соседом.
 *   2. Кольца и свёрнутые секции с итогом в заголовке.
 *   3. Таблицы — внутри секций, по требованию.
 *
 * Все четыре вопроса директора («зарабатываем?», «что ждёт решения?»,
 * «где деньги?», «что отгрузили?») связаны в одну систему: карточка,
 * кольцо и вкладка одного вопроса — один ключ. Нажатие на любое из них
 * переключает вкладку справа; наведение только подсвечивает и меняет
 * центр колец. Справа — четыре простые вкладки, а не гармошка секций:
 * владелец 05.09 назвал секции справа от кольца неудобными, а список
 * «требует решения» на весь столбец — неуместным. Маржа по заказам
 * открыта по умолчанию — это главный вопрос директора.
 *
 * Микрографики только там, где есть настоящий ряд: помесячная отгрузка
 * из /dashboards/monthly-series. У маржи и денег истории в API нет —
 * там графика нет, а не выдуманная линия.
 */

type Key = 'decisions' | 'margin' | 'supplier' | 'customer' | 'shipping';
type Tab = 'margin' | 'money' | 'overdue' | 'decisions';
/* Карточка и кольцо одного вопроса ведут на одну вкладку справа */
const TAB_OF: Record<Key, Tab> = { decisions: 'decisions', margin: 'margin', supplier: 'money', customer: 'money', shipping: 'overdue' };

const HEALTH: Record<string, { label: string; tone?: 'ok' | 'warn' | 'danger' }> = {
  OK: { label: 'в норме', tone: 'ok' }, WARN: { label: 'ниже цели', tone: 'warn' },
  CRITICAL: { label: 'критично', tone: 'danger' }, NO_COSTING: { label: 'нет калькуляции' },
};

export function DirectorDashboard() {
  const [active, setActive] = useState<Key>('decisions');
  const [peek, setPeek] = useState<Key | null>(null);
  const [tab, setTab] = useState<Tab>('margin');
  const card = useOrderCard();

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', 'director'],
    queryFn: () => dashboardApi.getDirector().then((r) => r.data),
    refetchInterval: 60_000,
  });
  const { data: cash } = useQuery({
    queryKey: ['dashboard', 'cash-forecast'],
    queryFn: () => dashboardApi.getCashForecast().then((r) => r.data),
    refetchInterval: 60_000,
  });
  const { data: series } = useQuery({
    queryKey: ['dashboard', 'monthly-series'],
    queryFn: () => api.get<{ months: Array<{ label: string; ordersIn: number; planned: number; shipped: number }> }>('/dashboards/monthly-series').then((r) => r.data),
  });

  const margin = data?.margin;
  const money = data?.money ?? { totalContracted: 0, totalPaid: 0, totalUnpaid: 0 };
  const nd = data?.needsDecision;
  const months = series?.months ?? [];
  const shipped = months.map((m) => m.shipped);
  const lastMonth = months[months.length - 1];

  const decisions = useMemo(() => (nd ? [
    { icon: <IconGavel size={18} aria-hidden />, label: 'Перехваты партий ждут решения', short: 'перехваты', count: nd.batchOverrides, to: '/warehouse?tab=batches', hue: 'rose' },
    { icon: <IconReceipt size={18} aria-hidden />, label: 'Заявки на пересмотр цены', short: 'цены', count: nd.priceReviews, to: '/prices', hue: 'amber' },
    { icon: <IconClockExclamation size={18} aria-hidden />, label: 'Заявки на номенклатуру просрочили SLA', short: 'номенклатура', count: nd.nomenclatureStuck, to: '/settings', hue: 'amber' },
    { icon: <IconFlask size={18} aria-hidden />, label: 'Партии в карантине цен', short: 'карантин', count: nd.quarantineBatches, to: '/warehouse?tab=batches', hue: 'amber' },
    { icon: <IconClockExclamation size={18} aria-hidden />, label: 'Резервы истекают в 3 дня', short: 'резервы', count: nd.expiringReservations, to: '/warehouse?tab=batches', hue: 'amber' },
    { icon: <IconInbox size={18} aria-hidden />, label: 'Новые заказы из 1С ждут приёма', short: 'из 1С', count: nd.inboxOrders, to: '/orders/inbox', hue: 'indigo' },
  ].filter((d) => d.count > 0) : []), [nd]);
  const decisionsTotal = decisions.reduce((s, d) => s + d.count, 0);

  const tabs: Array<{ key: Tab; label: string; summary?: string }> = [
    { key: 'margin', label: 'Маржа по заказам', summary: margin ? `${margin.ordersShown} из ${margin.ordersTotal} · ${margin.actualPct ?? '—'}%` : undefined },
    { key: 'money', label: 'Деньги', summary: `должны ${formatCompactMoney(money.totalUnpaid)} · нам ${cash ? formatCompactMoney(cash.receivables.owed) : '…'}` },
    { key: 'overdue', label: 'Просрочено', summary: data ? String(data.overdue.length) : undefined },
    { key: 'decisions', label: 'Решения', summary: decisions.length ? `${decisions.length} видов · ${decisionsTotal}` : 'всё разобрано' },
  ];

  /* Нажатие на карточку или кольцо: выбрать вопрос и раскрыть его секцию */
  const select = useCallback((k: Key) => {
    setActive(k);
    setTab(TAB_OF[k]);
  }, []);

  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const paidPct = pct(money.totalPaid, money.totalContracted);
  const custPct = cash ? pct(cash.receivables.paid, cash.receivables.contracted) : 0;

  /* Первый слой: ровно пять карточек */
  const stats: Array<{
    key: Key; hue: 'rose' | 'indigo' | 'amber' | 'emerald'; label: string; value: string; hint: string;
    spark?: number[]; neutral?: boolean; peek: React.ReactNode; to: string;
  }> = [
    {
      key: 'decisions', hue: 'rose', label: 'Требует решения', value: decisionsTotal.toLocaleString('ru-RU'),
      hint: decisions.length ? decisions.slice(0, 3).map((d) => d.short).join(' · ') : 'всё разобрано', to: '/warehouse?tab=batches',
      peek: <>{decisions.map((d) => <PeekRow key={d.label} label={d.label} value={d.count} />)}{decisions.length === 0 && <Text size="sm" c="dimmed">Решений не ждёт ничего</Text>}</>,
    },
    {
      key: 'margin', hue: 'indigo', label: 'Маржа портфеля',
      value: margin?.actualPct != null ? `${margin.actualPct}%` : '—',
      hint: margin ? `цель ${margin.targetPct}% · ${formatCompactMoney(margin.totalMargin)}` : '…', to: '/orders',
      peek: margin ? <>
        <PeekRow label="Цена портфеля" value={formatCurrency(margin.totalPrice)} />
        <PeekRow label="Себестоимость" value={formatCurrency(margin.totalCost)} />
        <PeekRow label="Маржа" value={formatCurrency(margin.totalMargin)} tone={margin.actualPct != null && margin.actualPct >= margin.targetPct ? 'ok' : 'warn'} />
        <PeekRow label="Цель" value={`${margin.targetPct}% от цены`} />
        <PeekRow label="Заказов с калькуляцией" value={`${margin.ordersShown} из ${margin.ordersTotal}`} />
      </> : null,
    },
    {
      key: 'supplier', hue: 'amber', label: 'Долг поставщикам', value: formatCompactMoney(money.totalUnpaid),
      hint: `оплачено ${paidPct}% из ${formatCompactMoney(money.totalContracted)}`, to: '/purchases',
      peek: <>
        <PeekRow label="Законтрактовано" value={formatCurrency(money.totalContracted)} />
        <PeekRow label="Оплачено" value={formatCurrency(money.totalPaid)} tone="ok" />
        <PeekRow label="Остаток к оплате" value={formatCurrency(money.totalUnpaid)} tone="warn" />
      </>,
    },
    {
      key: 'customer', hue: 'emerald', label: 'Нам должны заказчики', value: cash ? formatCompactMoney(cash.receivables.owed) : '…',
      hint: cash ? `оплачено ${custPct}% · ${cash.receivables.activeOrders} заказов` : 'данные 1С', to: '/finance',
      peek: cash ? <>
        <PeekRow label="Законтрактовано" value={formatCurrency(cash.receivables.contracted)} />
        <PeekRow label="Оплачено" value={formatCurrency(cash.receivables.paid)} tone="ok" />
        <PeekRow label="Долг" value={formatCurrency(cash.receivables.owed)} tone="danger" />
        <PeekRow label="Без данных об оплате" value={`${cash.receivables.ordersWithoutPaymentData} заказов`} />
      </> : null,
    },
    {
      key: 'shipping', hue: 'indigo', neutral: true, label: 'Отгрузка за месяц', value: lastMonth ? `${lastMonth.shipped}` : '—',
      hint: lastMonth ? `${lastMonth.label} · план ${lastMonth.planned} · заказов ${lastMonth.ordersIn}` : 'нет истории', spark: shipped, to: '/production',
      peek: <>
        {months.slice(-4).reverse().map((m) => <PeekRow key={m.label} label={m.label} value={`${m.shipped} / план ${m.planned}`} tone={m.shipped >= m.planned ? 'ok' : 'warn'} />)}
        {shipped.length > 1 && <div className="peek__spark"><Sparkline values={shipped} width={260} height={44} label="Отгрузка по месяцам" /></div>}
      </>,
    },
  ];

  const header = (
    <div className="dd2__head">
      <div>
        <Text component="h1" className="page-title" style={{ fontSize: 22, lineHeight: 1.1, margin: 0 }}>Маржа · Решения · Деньги</Text>
      </div>
      <Text size="sm" c="dimmed" ff="monospace">
        {new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
      </Text>
    </div>
  );

  return (
    <FitScreen header={header}>
      <PeekWarmProvider>
        {/* Слой 1 */}
        <div className="stat-row" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
          {stats.map((s) => (
            <SmartPeekCard
              key={s.key}
              width={300}
              pinnable={false}
              peek={<><div className="peek__title">{s.label}</div>{s.peek}</>}
              target={
                <div
                  className="stat"
                  data-hue={s.hue}
                  data-active={active === s.key ? 'true' : undefined}
                  data-peek={peek === s.key ? 'true' : undefined}
                  role="button" tabIndex={0}
                  aria-pressed={active === s.key}
                  onClick={() => select(s.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter') select(s.key); }}
                  onPointerEnter={() => setPeek(s.key)} onPointerLeave={() => setPeek(null)}
                >
                  {s.spark && s.spark.length > 1 && <Sparkline values={s.spark} backdrop color={`var(--p-${s.hue})`} />}
                  <div className="stat__label">{s.label}</div>
                  <div className="stat__value" data-neutral={s.neutral ? 'true' : undefined}>{isLoading ? '…' : s.value}</div>
                  <div className="stat__hint">{s.hint}</div>
                </div>
              }
            />
          ))}
        </div>

        {/* Слой 2 */}
        <div className="dd2">
          <div className="dd2__rings">
            <RingDashboard
              active={active}
              onSelect={(k) => select(k as Key)}
              center={{ value: decisionsTotal.toLocaleString('ru-RU'), label: 'ждут решения', hue: 'rose' }}
              rings={[
                { key: 'margin', hue: 'indigo', label: 'Маржа к цели', short: 'маржа', value: margin?.actualPct ?? 0, max: margin?.targetPct ?? 35, caption: margin?.actualPct != null ? `${margin.actualPct} % из ${margin.targetPct} %` : 'нет калькуляции' },
                { key: 'supplier', hue: 'amber', label: 'Оплачено поставщикам', short: 'поставщики', value: money.totalPaid, max: money.totalContracted, caption: `${formatCompactMoney(money.totalPaid)} из ${formatCompactMoney(money.totalContracted)}` },
                { key: 'customer', hue: 'emerald', label: 'Оплачено заказчиками', short: 'заказчики', value: cash?.receivables.paid ?? 0, max: cash?.receivables.contracted ?? 0, caption: cash ? `${formatCompactMoney(cash.receivables.paid)} из ${formatCompactMoney(cash.receivables.contracted)}` : '…' },
              ]}
            />
          </div>

          <div className="panel">
            <div className="panel__tabs" role="tablist" aria-label="Разделы экрана директора">
              {tabs.map((t) => (
                <button
                  key={t.key} type="button" role="tab" id={`tab-${t.key}`}
                  aria-selected={tab === t.key} aria-controls={`panel-${t.key}`}
                  className="panel__tab" onClick={() => setTab(t.key)}
                >
                  {t.label}{t.summary && <small>{t.summary}</small>}
                </button>
              ))}
            </div>
            <div className="panel__body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
              {tab === 'margin' && (
                <table className="dense">
                  <thead><tr><th style={{ width: 118 }}>Заказ</th><th>Заказчик</th><th className="num" style={{ width: 108 }}>Цена</th><th className="num" style={{ width: 132 }}>Себестоимость</th><th className="num" style={{ width: 96 }}>Маржа</th><th style={{ width: 110 }}>К цели</th></tr></thead>
                  <tbody>
                    {(margin?.orders ?? []).map((o) => {
                      const h = HEALTH[o.marginHealth] ?? { label: o.marginHealth };
                      const share = o.marginPct != null && margin ? Math.max(0, Math.min(1, o.marginPct / margin.targetPct)) : 0;
                      return (
                        <tr key={o.id} className="dense__link" onClick={() => card.open(o.id, 'cost')}>
                          <td><OrderRef id={o.id} number={o.orderNumber} focus="cost" /></td>
                          <td>{o.customer.name}</td>
                          <td className="num">{o.totalPrice != null ? formatCompactMoney(o.totalPrice) : '—'}</td>
                          <td className="num">{o.totalCost != null ? formatCompactMoney(o.totalCost) : '—'}</td>
                          <td className="num">
                            <SmartPeekCard
                              width={240}
                              actions={<Button size="xs" radius="xl" variant="light" onClick={() => card.open(o.id, 'cost')} rightSection={<IconArrowRight size={14} aria-hidden />}>Открыть заказ</Button>}
                              target={<span className="peek__inline" data-tone={h.tone}>{o.marginPct != null ? `${o.marginPct}%` : h.label}</span>}
                              peek={<>
                                <div className="peek__title">{o.orderNumber}</div>
                                <PeekRow label="Состояние" value={h.label} tone={h.tone} />
                                <PeekRow label="Маржа" value={o.margin != null ? formatCurrency(o.margin) : '—'} />
                                <PeekRow label="Просрочка" value={o.overdueDays > 0 ? `${o.overdueDays} дн` : 'нет'} tone={o.overdueDays > 0 ? 'danger' : undefined} />
                              </>}
                            />
                          </td>
                          <td><div className="bar" data-tone={h.tone}><span style={{ width: `${Math.round(share * 100)}%` }} /></div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {tab === 'money' && (
                <div className="dd-money">
                  <div>
                    <Text fw={700} size="sm" mb={6}>Поставщикам (закуп по ДО)</Text>
                    <PeekRow label="Законтрактовано" value={formatCurrency(money.totalContracted)} />
                    <PeekRow label="Оплачено" value={`${formatCurrency(money.totalPaid)} · ${paidPct}%`} tone="ok" />
                    <PeekRow label="Остаток" value={formatCurrency(money.totalUnpaid)} tone="warn" />
                    <div className="bar" style={{ marginTop: 8 }}><span style={{ width: `${paidPct}%` }} /></div>
                  </div>
                  <div>
                    <Text fw={700} size="sm" mb={6}>Заказчики (нам должны)</Text>
                    {cash ? <>
                      <PeekRow label="Законтрактовано" value={formatCurrency(cash.receivables.contracted)} />
                      <PeekRow label="Оплачено" value={`${formatCurrency(cash.receivables.paid)} · ${custPct}%`} tone="ok" />
                      <PeekRow label="Долг" value={formatCurrency(cash.receivables.owed)} tone="danger" />
                      <div className="bar" data-tone="ok" style={{ marginTop: 8 }}><span style={{ width: `${custPct}%` }} /></div>
                    </> : <Text size="sm" c="dimmed">…</Text>}
                  </div>
                </div>
              )}

              {tab === 'overdue' && (
                data && data.overdue.length === 0 ? (
                  <Text size="sm" c="dimmed">Просроченных заказов нет.</Text>
                ) : (
                  <table className="dense">
                    <thead><tr><th>Заказ</th><th>Заказчик</th><th className="num">Просрочка</th></tr></thead>
                    <tbody>
                      {(data?.overdue ?? []).map((o) => (
                        <tr key={o.id}>
                          <td><OrderRef id={o.id} number={o.orderNumber} /></td>
                          <td>{o.customer.name}</td>
                          <td className="num"><span className="peek__inline" data-tone="danger">{o.overdueDays} дн</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {tab === 'decisions' && (
                decisions.length === 0 ? (
                  <Text c="dimmed" size="sm">Всё разобрано — решений не ждёт ничего.</Text>
                ) : (
                  <div className="dd-decisions dd-decisions--grid">
                    {decisions.map((d) => (
                      <Link to={d.to} key={d.label} className="dd-decision" data-hue={d.hue}>
                        <span className="dd-decision__icon">{d.icon}</span>
                        <Text size="md" fw={600} lineClamp={1}>{d.label}</Text>
                        <span className="dd-decision__count">{d.count}</span>
                      </Link>
                    ))}
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      </PeekWarmProvider>
    </FitScreen>
  );
}
