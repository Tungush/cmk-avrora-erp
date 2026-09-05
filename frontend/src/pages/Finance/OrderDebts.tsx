import React, { useMemo, useState } from 'react';
import { Card, Group, Text, TextInput, Skeleton } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useOrders } from '../../hooks/useOrders';
import { useOrderCard } from '../../components/OrderCard/OrderCardProvider';
import { StatusBadge } from '../../components/StatusBadge';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { useFitRows } from '../../components/FitScreen';
import { EmptyState } from '../../components/EmptyState';
import { formatCompactMoney, formatCurrency, formatDate } from '../../utils/formatters';
import type { Order } from '../../types';

/**
 * «Нам должны — по заказам» (05.09.2026, просьба владельца: «в разделе
 * Деньги мы должны видеть, сколько должны нам по заказам, и статусы
 * заказов — что уже отгружено, что уже изготовлено»).
 *
 * Долг считается по данным 1С: сумма заказа минус оплачено. Заказы, по
 * которым 1С не прислала оплату, не считаются оплаченными на ноль — они
 * показаны отдельно как «оплата неизвестна», чтобы долг был занижен
 * честно, а не завышен молча (тот же принцип, что в сводке по заказчикам).
 *
 * Плитка сверху — и цифра, и фильтр: отгруженные (деньги должны были
 * прийти), изготовленные (ждут вывоза), в производстве (аванс).
 */
type Slice = 'all' | 'shipped' | 'ready' | 'production';

const sliceOf = (status: string): Slice =>
  status === 'SHIPPED' || status === 'CLOSED' ? 'shipped' : status === 'READY_TO_SHIP' ? 'ready' : 'production';

interface Row { o: Order; total: number; paid: number | null; debt: number | null; slice: Slice }

/** Заказчик приходит объектом из реестра и строкой из 1С — берём что есть */
const customerOf = (o: Order) => ((o as any).customer?.name as string | undefined) ?? o.customerName ?? '—';

export function OrderDebts() {
  const { open } = useOrderCard();
  const [slice, setSlice] = useState<Slice>('all');
  const [search, setSearch] = useState('');
  // Все активные заказы разом: долг надо отсортировать по всему реестру, а не по странице
  const { data, isLoading } = useOrders({ page: 1, pageSize: 500 });
  const orders: Order[] = (data as any)?.data ?? [];

  const rows = useMemo<Row[]>(() => orders
    .filter((o) => o.status !== 'CANCELLED')
    .map((o) => {
      const total = Number(o.onecTotalAmount ?? 0);
      const paid = o.onecPaidAmount == null ? null : Number(o.onecPaidAmount);
      const debt = paid == null ? null : Math.max(0, total - paid);
      return { o, total, paid, debt, slice: sliceOf(o.status) };
    })
    .filter((r) => r.total > 0 && (r.debt == null || r.debt > 0))
    .sort((a, b) => (b.debt ?? 0) - (a.debt ?? 0)), [orders]);

  const groups = useMemo(() => ({
    all: rows,
    shipped: rows.filter((r) => r.slice === 'shipped'),
    ready: rows.filter((r) => r.slice === 'ready'),
    production: rows.filter((r) => r.slice === 'production'),
  }), [rows]);
  const sumDebt = (rs: Row[]) => rs.reduce((s, r) => s + (r.debt ?? 0), 0);
  const unknown = rows.filter((r) => r.debt == null);

  const q = search.trim().toLowerCase();
  const visible = groups[slice].filter((r) => !q
    || r.o.orderNumber.toLowerCase().includes(q)
    || customerOf(r.o).toLowerCase().includes(q));

  const fit = useFitRows(40, 5, 60, 40);
  const paged = usePagedList(visible, fit.rows, `${slice}|${q}|${fit.rows}`);

  const tiles: Array<{ key: Slice; hue: 'rose' | 'emerald' | 'indigo' | 'amber'; label: string; hint: string }> = [
    { key: 'all', hue: 'rose', label: 'Нам должны', hint: `${groups.all.length} заказов с долгом` },
    { key: 'shipped', hue: 'emerald', label: 'По отгруженным', hint: `${groups.shipped.length} заказов · деньги должны были прийти` },
    { key: 'ready', hue: 'indigo', label: 'По изготовленным', hint: `${groups.ready.length} заказов · ждут вывоза` },
    { key: 'production', hue: 'amber', label: 'В производстве', hint: `${groups.production.length} заказов · аванс` },
  ];

  return (
    <div className="fin">
      <div className="stat-row" role="tablist" aria-label="Долг по состоянию заказа">
        {tiles.map((t) => (
          <button
            key={t.key} type="button" role="tab" className="stat" data-hue={t.hue}
            aria-selected={slice === t.key} data-active={slice === t.key ? 'true' : undefined}
            onClick={() => { setSlice(t.key); paged.setPage(1); }}
          >
            <div className="stat__label">{t.label}</div>
            <div className="stat__value">{isLoading ? '…' : formatCompactMoney(sumDebt(groups[t.key]))}</div>
            <div className="stat__hint">{t.hint}</div>
          </button>
        ))}
      </div>

      <Group gap="sm" wrap="nowrap" justify="space-between" className="fin__bar">
        <TextInput
          placeholder="№ заказа или заказчик…" leftSection={<IconSearch aria-hidden size={16} />}
          value={search} onChange={(e) => { setSearch(e.target.value); paged.setPage(1); }}
          size="sm" style={{ flex: '0 1 320px' }}
        />
        {unknown.length > 0 && (
          <Text size="sm" c="dimmed">
            Оплата неизвестна по {unknown.length} заказам на {formatCompactMoney(unknown.reduce((s, r) => s + r.total, 0))} — 1С не прислала платежи
          </Text>
        )}
      </Group>

      <Card withBorder radius="lg" padding={0} className="fin__card">
        <div ref={fit.ref} className="fin__wrap">
          <table className="dense fin__table">
            <thead>
              <tr>
                <th style={{ width: 118 }}>Заказ</th>
                <th>Заказчик</th>
                <th style={{ width: 160 }}>Статус</th>
                <th style={{ width: 132 }}>Отгрузка</th>
                <th className="num" style={{ width: 132 }}>Сумма</th>
                <th className="num" style={{ width: 132 }}>Оплачено</th>
                <th className="num" style={{ width: 140 }}>Долг</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(Math.max(4, fit.rows))].map((_, i) => <tr key={i}><td colSpan={7}><Skeleton height={16} radius="sm" /></td></tr>)
              ) : paged.total === 0 ? (
                <tr><td colSpan={7}><EmptyState title={q ? 'Ничего не найдено' : 'Долгов нет — всё оплачено'} /></td></tr>
              ) : paged.slice.map(({ o, total, paid, debt }) => (
                <tr key={o.id} className="dense__link" onClick={() => open(o.id, 'money')}>
                  <td className="num" style={{ textAlign: 'left', fontWeight: 700 }}>{o.orderNumber}</td>
                  <td title={customerOf(o)}>{customerOf(o)}</td>
                  <td><StatusBadge status={o.status} /></td>
                  <td className="num" style={{ textAlign: 'left' }}>
                    {o.actualShipmentDate ? formatDate(o.actualShipmentDate) : o.plannedShipmentDate ? `план ${formatDate(o.plannedShipmentDate)}` : '—'}
                  </td>
                  <td className="num">{formatCurrency(total)}</td>
                  <td className="num">{paid == null ? <span className="fin__unknown">неизвестно</span> : formatCurrency(paid)}</td>
                  <td className="num fin__debt">{debt == null ? '—' : formatCurrency(debt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <PaginationBar page={paged.page} total={paged.total} pageSize={Math.max(1, fit.rows)} onPageChange={paged.setPage} noun="заказов" />
    </div>
  );
}
