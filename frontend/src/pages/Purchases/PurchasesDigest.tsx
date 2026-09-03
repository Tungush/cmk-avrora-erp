import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconCoin, IconClockExclamation, IconTruckDelivery, IconPackageOff } from '@tabler/icons-react';
import { purchasesApi } from '../../api/purchases';
import { DigestCard, DigestGrid } from '../../components/Digest';
import { useEntity } from '../../components/EntityRef';
import { formatMoney, formatCompactMoney, formatDate } from '../../utils/formatters';

/**
 * Сводка закупа (03.09.2026) — раздел открывается ответом, а не тремя
 * таблицами подряд, из-за которых экран приходилось прокручивать.
 *
 * Снабженцу нужны четыре числа: сколько мы должны, что висит дольше
 * месяца, сколько потратили и по каким документам товар не пришёл на
 * склад. Всё это уже считалось на бэкенде одним запросом — просто было
 * размазано по разрезам и спискам.
 */
export function PurchasesDigest({
  onOpenRegistry, onGoTab,
}: {
  onOpenRegistry: (f: Record<string, string>) => void;
  onGoTab: (tab: string) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['purchases-dashboard'],
    queryFn: () => purchasesApi.dashboard().then((r) => r.data),
    refetchInterval: 60_000,
  });

  const kpi = data?.kpi;
  const unpaid = data?.unpaidDocs ?? [];
  const suppliers = data?.suppliers ?? [];
  const maxUnpaid = Math.max(1, ...unpaid.map((d) => d.unpaidAmount));
  const maxSupplier = Math.max(1, ...suppliers.map((s) => s.total));
  const noReceipt = suppliers.filter((s) => s.noReceipt > 0)
    .sort((a, b) => b.noReceipt - a.noReceipt);

  const trend = kpi?.spendMonth.prevAmount
    ? (kpi.spendMonth.amount - kpi.spendMonth.prevAmount) / kpi.spendMonth.prevAmount
    : null;

  return (
    <DigestGrid>
      <DigestCard
        title="Должны поставщикам"
        tone="danger"
        icon={<IconCoin size={19} />}
        value={kpi?.owed.amount ?? 0}
        format={(v) => formatCompactMoney(v)}
        caption={kpi ? `по ${kpi.owed.docs} документам из ${kpi.owed.totalDocs}` : undefined}
        loading={isLoading}
        items={unpaid.slice(0, 4).map((d) => ({
          id: d.id,
          label: d.supplier,
          value: formatMoney(d.unpaidAmount, d.currency),
          sub: `${d.doNumber} · ${d.ageDays} дн с ${formatDate(d.doDate)}`,
          share: d.unpaidAmount / maxUnpaid,
          onClick: () => onOpenRegistry({ unpaid: 'true' }),
        }))}
        emptyText="Долгов перед поставщиками нет"
        action={{ label: 'Все неоплаченные', onClick: () => onOpenRegistry({ unpaid: 'true' }) }}
      />

      <DigestCard
        title="Висит больше 30 дней"
        tone="warn"
        icon={<IconClockExclamation size={19} />}
        value={kpi?.overdue30.amount ?? 0}
        format={(v) => formatCompactMoney(v)}
        caption={kpi
          ? `${kpi.overdue30.docs} документов, из них 90+ дней: ${kpi.overdue30.over90}`
          : undefined}
        loading={isLoading}
        items={unpaid.filter((d) => d.ageDays > 30).slice(0, 4).map((d) => ({
          id: `old-${d.id}`,
          label: d.supplier,
          value: `${d.ageDays} дн`,
          sub: formatMoney(d.unpaidAmount, d.currency),
          share: Math.min(1, d.ageDays / 180),
        }))}
        emptyText="Старых долгов нет"
      />

      <DigestCard
        title="Закуп за 30 дней"
        tone="brand"
        icon={<IconTruckDelivery size={19} />}
        value={kpi?.spendMonth.amount ?? 0}
        format={(v) => formatCompactMoney(v)}
        caption={kpi
          ? `${kpi.spendMonth.docs} документов`
            + (trend != null ? ` · ${trend >= 0 ? '+' : ''}${(trend * 100).toFixed(0)} % к прошлым 30 дням` : '')
          : undefined}
        loading={isLoading}
        items={[...suppliers].sort((a, b) => b.total - a.total).slice(0, 4).map((s) => ({
          id: s.id,
          label: s.name,
          value: formatMoney(s.total),
          sub: `${s.docs} документов · последний ${formatDate(s.lastDate)}`,
          share: s.total / maxSupplier,
          onClick: () => onOpenRegistry({ supplierId: s.id }),
        }))}
        emptyText="Закупок за месяц не было"
        action={{ label: 'Разрезы и графики', onClick: () => onGoTab('dashboard') }}
      />

      <DigestCard
        title="Товар не пришёл"
        tone={kpi && kpi.noReceipt.docs > 0 ? 'warn' : 'ok'}
        icon={<IconPackageOff size={19} />}
        value={kpi?.noReceipt.docs ?? 0}
        format={(v) => Math.round(v).toLocaleString('ru-RU')}
        caption={kpi
          ? `из ${kpi.noReceipt.totalDocs} документов · ${kpi.noReceipt.paidDocs} уже оплачены на ${formatMoney(kpi.noReceipt.paidAmount)}`
          : undefined}
        loading={isLoading}
        items={noReceipt.slice(0, 4).map((s) => ({
          id: `nr-${s.id}`,
          label: s.name,
          value: `${s.noReceipt} док.`,
          sub: `оплачено ${formatMoney(s.paid)} из ${formatMoney(s.total)}`,
          onClick: () => onOpenRegistry({ supplierId: s.id }),
        }))}
        emptyText="Всё пришло на склад"
        action={{ label: 'Очередь закупок', onClick: () => onGoTab('queue') }}
      />
    </DigestGrid>
  );
}
