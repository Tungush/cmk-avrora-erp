import React from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../../api/client';
import { DigestCard, DigestGrid } from '../../components/Digest';
import { IconGauge, IconGavel, IconClockExclamation, IconScissors } from '@tabler/icons-react';
import { formatMoney, formatDate } from '../../utils/formatters';

/**
 * Сводка склада (02.09.2026) — то, чем раздел открывается вместо шести
 * вкладок со списками.
 *
 * Кладовщику не нужен реестр из 3 147 материалов: ему нужно знать, чего
 * не хватает, где цена в карантине, какой резерв сгорит на этой неделе и
 * что лежит в обрезках. Всё это уже считалось на бэкенде, но было
 * размазано по вкладкам — сюда сведены только цифры, требующие действия,
 * и каждая ведёт в свою вкладку.
 */

const num = (n: number, d = 0) => Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: d });

export function WarehouseDigest({ onGoTab }: { onGoTab: (tab: string) => void }) {
  const minStock = useQuery({
    queryKey: ['min-stock'],
    queryFn: () => api.get('/min-stock-levels').then((r) => r.data),
  });
  const anomalies = useQuery({
    queryKey: ['batch-anomalies'],
    queryFn: () => api.get<{ data: any[] }>('/material-batches/anomalies').then((r) => r.data.data),
  });
  const expiring = useQuery({
    queryKey: ['reservations-expiring'],
    queryFn: () => api.get<{ data: any[] }>('/batch-reservations/expiring?days=3').then((r) => r.data),
  });
  const overrides = useQuery({
    queryKey: ['batch-overrides'],
    queryFn: () => api.get<{ data: any[] }>('/batch-reservations/overrides').then((r) => r.data),
  });
  const offcuts = useQuery({
    queryKey: ['offcuts', ''],
    queryFn: () => api.get('/warehouse/offcuts', { params: { search: '' } }).then((r) => r.data),
  });

  const minRows: any[] = Array.isArray(minStock.data) ? minStock.data : [];
  const deficits = minRows.filter((r) => r.deficitQty > 0).sort((a, b) => b.deficitValue - a.deficitValue);
  const deficitValue = deficits.reduce((s, r) => s + Number(r.deficitValue ?? 0), 0);
  const maxDeficit = deficits[0]?.deficitValue ?? 1;

  const anomalyRows: any[] = anomalies.data ?? [];
  const expiringRows: any[] = (expiring.data as any)?.data ?? [];
  const overrideRows: any[] = (overrides.data as any)?.data ?? [];
  const offcutRows: any[] = (offcuts.data as any)?.data ?? (Array.isArray(offcuts.data) ? offcuts.data : []);

  const expiringValue = expiringRows.reduce((s, r) => s + Number(r.qty ?? 0) * Number(r.unitPrice ?? 0), 0);
  const maxExpiring = Math.max(1, ...expiringRows.map((r) => Number(r.qty ?? 0) * Number(r.unitPrice ?? 0)));

  return (
    <DigestGrid>
      <DigestCard
        title="Ниже норматива"
        tone={deficits.length > 0 ? 'danger' : 'ok'}
        icon={<IconGauge size={19} />}
        value={num(deficits.length)}
        caption={deficits.length > 0
          ? `изделий не хватает на складе ГП · ${formatMoney(deficitValue)} ₸`
          : 'все нормативы выполнены'}
        loading={minStock.isLoading}
        items={deficits.slice(0, 4).map((r) => ({
          id: r.id,
          label: `${r.article?.articleCode ?? '—'} · ${r.article?.name ?? ''}`,
          value: `${num(r.deficitQty, 2)} шт`,
          sub: `есть ${num(r.actualQty, 2)} из ${num(r.targetQty, 2)} · готовность ${num(r.readinessPct)} %`,
          share: Number(r.deficitValue ?? 0) / maxDeficit,
        }))}
        emptyText="Нормативы выполнены — доделывать нечего"
        action={{ label: 'Мин. остатки', onClick: () => onGoTab('minstock') }}
      />

      <DigestCard
        title="Цена в карантине"
        tone={anomalyRows.length > 0 ? 'warn' : 'ok'}
        icon={<IconGavel size={19} />}
        value={num(anomalyRows.length)}
        caption={anomalyRows.length > 0
          ? 'партий с подозрительной ценой — себестоимость по ним под вопросом'
          : 'подозрительных цен нет'}
        loading={anomalies.isLoading}
        items={anomalyRows.slice(0, 4).map((r) => ({
          id: r.batchId,
          label: `${r.material?.materialCode ?? '—'} · ${r.material?.name ?? ''}`,
          value: `${formatMoney(r.unitPrice)} ₸`,
          sub: r.anomalyFactor ? `×${Number(r.anomalyFactor).toFixed(1)} к обычной цене · ${r.supplierName ?? 'поставщик не указан'}` : r.hint,
        }))}
        emptyText="Все цены партий в норме"
        action={{ label: 'Партии и резервы', onClick: () => onGoTab('batches') }}
      />

      <DigestCard
        title="Резервы сгорают"
        tone={expiringRows.length > 0 ? 'warn' : 'ok'}
        icon={<IconClockExclamation size={19} />}
        value={num(expiringRows.length)}
        caption={expiringRows.length > 0
          ? `резервов истекают в 3 дня · ${formatMoney(expiringValue)} ₸ вернётся в общий остаток`
          : 'ничего не истекает'}
        loading={expiring.isLoading}
        items={expiringRows.slice(0, 4).map((r) => ({
          id: r.id,
          label: `${r.material?.materialCode ?? '—'} · заказ ${r.order?.orderNumber ?? '—'}`,
          value: `${r.daysLeft} дн`,
          sub: `${num(r.qty, 2)} ${r.material?.unit ?? ''} · до ${formatDate(r.expiresAt)}`,
          share: (Number(r.qty ?? 0) * Number(r.unitPrice ?? 0)) / maxExpiring,
        }))}
        emptyText="Резервы держатся"
        action={{ label: 'Партии и резервы', onClick: () => onGoTab('batches') }}
      />

      <DigestCard
        title="Обрезки в дело"
        tone="brand"
        icon={<IconScissors size={19} />}
        value={num(offcutRows.length)}
        caption="деловой отход: длины, которые можно не резать заново"
        loading={offcuts.isLoading}
        items={offcutRows.slice(0, 4).map((r) => ({
          id: r.id,
          label: `${r.material?.materialCode ?? '—'} · ${r.material?.name ?? ''}`,
          value: `${num(Number(r.qty), 0)} шт`,
          sub: `${num(Number(r.lengthMm), 0)} мм${r.widthMm ? ` × ${num(Number(r.widthMm), 0)} мм` : ''}`,
        }))}
        emptyText="Обрезков не заведено"
        action={{ label: 'Обрезки', onClick: () => onGoTab('offcuts') }}
      />

      {overrideRows.length > 0 && (
        <DigestCard
          title="Перехваты резерва"
          tone="danger"
          icon={<IconGavel size={19} />}
          value={num(overrideRows.length)}
          caption="ждут решения директора: чей заказ получит партию"
          items={overrideRows.slice(0, 4).map((r: any) => ({
            id: r.id,
            label: r.material?.materialCode ?? r.materialCode ?? 'партия',
            value: r.requestedQty != null ? `${num(Number(r.requestedQty), 2)}` : '—',
            sub: r.reason ?? undefined,
          }))}
          action={{ label: 'Разобрать', onClick: () => onGoTab('batches') }}
        />
      )}
    </DigestGrid>
  );
}
