import React from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../../api/client';
import { DigestCard, type DigestCardProps } from '../../components/Digest';
import { useEntity } from '../../components/EntityRef';
import { useFitGrid, usePageKeys } from '../../components/FitScreen';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { IconGauge, IconGavel, IconClockExclamation, IconScissors } from '@tabler/icons-react';
import { formatMoney, formatDate } from '../../utils/formatters';
import './Warehouse.css';

/**
 * Сводка склада (02.09.2026) — то, чем раздел открывается вместо шести
 * вкладок со списками.
 *
 * Кладовщику не нужен реестр из 3 147 материалов: ему нужно знать, чего
 * не хватает, где цена в карантине, какой резерв сгорит на этой неделе и
 * что лежит в обрезках. Всё это уже считалось на бэкенде, но было
 * размазано по вкладкам — сюда сведены только цифры, требующие действия,
 * и каждая ведёт в свою вкладку.
 *
 * 03.09.2026. Карточек стало пять, и пятая — «Перехваты резерва» —
 * уезжала под нижний край: страница не прокручивалась, но панель
 * прокручивалась на 224 px, и решение директора никто не видел.
 * Теперь работают два правила:
 *   1) перехваты идут ПЕРВОЙ карточкой, когда они есть, — это самое
 *      дорогое решение на экране, а не примечание в конце;
 *   2) показываем ровно столько карточек, сколько поместилось
 *      (useFitGrid), остальные — следующей страницей и стрелками ← →.
 * Ничего не выкинуто: на узком экране «Обрезки в дело» уезжают на
 * вторую страницу, а не исчезают.
 */

const num = (n: number, d = 0) => Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: d });

/** Размер карточки-ответа: по нему считается, сколько их влезло */
const CARD_MIN_W = 268;
/** Высота берётся с запасом: у карточки с четырьмя строками она ~490 px */
const CARD_H = 500;

export function WarehouseDigest({ onGoTab }: { onGoTab: (tab: string) => void }) {
  // Строка сводки — это изделие или материал: по клику открывается его
  // карточка, вкладка со списком осталась под кнопкой действия (03.09.2026)
  const { open: openEntity } = useEntity();
  // Сколько карточек влезло в свободную высоту панели
  const fit = useFitGrid(CARD_MIN_W, CARD_H, 12, 1, 12);
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

  const cards: Array<DigestCardProps & { key: string }> = [];

  // Перехваты — первыми: решение директора, а не сноска в конце сетки.
  // 03.09.2026: им же отдана графитовая плитка. В системе тёмная плитка
  // на экране одна и означает «вот ответ»; раньше она стояла на
  // «Обрезках в дело» — полезной, но не требующей решения карточке, да
  // ещё и пятой, то есть на второй странице сетки. Экран Склада
  // открывался вообще без опоры.
  if (overrideRows.length > 0) {
    cards.push({
      key: 'overrides',
      title: 'Перехваты резерва',
      tone: 'brand',
      icon: <IconGavel size={19} aria-hidden />,
      value: overrideRows.length,
      caption: 'ждут решения директора: чей заказ получит партию',
      items: overrideRows.slice(0, 4).map((r: any) => ({
        id: r.id,
        label: r.material?.materialCode ?? r.materialCode ?? 'партия',
        value: r.requestedQty != null ? `${num(Number(r.requestedQty), 2)}` : '—',
        sub: r.reason ?? undefined,
        // /batch-reservations/overrides отдаёт материал без id — ведём на
        // заказ, который просит партию
        onClick: r.requestedByOrder?.id
          ? () => openEntity({
            kind: 'order',
            id: r.requestedByOrder.id,
            label: r.requestedByOrder.orderNumber,
          })
          : undefined,
      })),
      action: { label: 'Разобрать', onClick: () => onGoTab('batches') },
    });
  }

  cards.push({
    key: 'min',
    title: 'Ниже норматива',
    tone: deficits.length > 0 ? 'danger' : 'ok',
    icon: <IconGauge size={19} aria-hidden />,
    value: deficits.length,
    caption: deficits.length > 0
      ? `изделий не хватает на складе ГП · ${formatMoney(deficitValue)}`
      : 'все нормативы выполнены',
    loading: minStock.isLoading,
    items: deficits.slice(0, 4).map((r) => ({
      id: r.id,
      label: `${r.article?.articleCode ?? '—'} · ${r.article?.name ?? ''}`,
      value: `${num(r.deficitQty, 2)} шт`,
      sub: `есть ${num(r.actualQty, 2)} из ${num(r.targetQty, 2)} · готовность ${num(r.readinessPct)} %`,
      share: Number(r.deficitValue ?? 0) / maxDeficit,
      onClick: r.articleId
        ? () => openEntity({ kind: 'article', id: r.articleId, label: r.article?.name })
        : undefined,
    })),
    emptyText: 'Нормативы выполнены — доделывать нечего',
    action: { label: 'Мин. остатки', onClick: () => onGoTab('minstock') },
  });

  cards.push({
    key: 'quarantine',
    title: 'Цена в карантине',
    tone: anomalyRows.length > 0 ? 'warn' : 'ok',
    icon: <IconGavel size={19} aria-hidden />,
    value: anomalyRows.length,
    caption: anomalyRows.length > 0
      ? 'партий с подозрительной ценой — себестоимость по ним под вопросом'
      : 'подозрительных цен нет',
    loading: anomalies.isLoading,
    items: anomalyRows.slice(0, 4).map((r) => ({
      id: r.batchId,
      label: `${r.material?.materialCode ?? '—'} · ${r.material?.name ?? ''}`,
      value: `${formatMoney(r.unitPrice)}`,
      sub: r.anomalyFactor ? `×${Number(r.anomalyFactor).toFixed(1)} к обычной цене · ${r.supplierName ?? 'поставщик не указан'}` : r.hint,
      onClick: r.material?.id
        ? () => openEntity({ kind: 'material', id: r.material.id, label: r.material.name })
        : undefined,
    })),
    emptyText: 'Все цены партий в норме',
    action: { label: 'Партии и резервы', onClick: () => onGoTab('batches') },
  });

  cards.push({
    key: 'expiring',
    title: 'Резервы сгорают',
    tone: expiringRows.length > 0 ? 'warn' : 'ok',
    icon: <IconClockExclamation size={19} aria-hidden />,
    value: expiringRows.length,
    caption: expiringRows.length > 0
      ? `резервов истекают в 3 дня · ${formatMoney(expiringValue)} вернётся в общий остаток`
      : 'ничего не истекает',
    loading: expiring.isLoading,
    items: expiringRows.slice(0, 4).map((r) => ({
      id: r.id,
      label: `${r.material?.materialCode ?? '—'} · заказ ${r.order?.orderNumber ?? '—'}`,
      value: `${r.daysLeft} дн`,
      sub: `${num(r.qty, 2)} ${r.material?.unit ?? ''} · до ${formatDate(r.expiresAt)}`,
      share: (Number(r.qty ?? 0) * Number(r.unitPrice ?? 0)) / maxExpiring,
      // Материал в этом ответе без id — ведём на заказ, он в строке есть
      onClick: r.order?.id
        ? () => openEntity({ kind: 'order', id: r.order.id, label: r.order.orderNumber })
        : undefined,
    })),
    emptyText: 'Резервы держатся',
    action: { label: 'Партии и резервы', onClick: () => onGoTab('batches') },
  });

  cards.push({
    key: 'offcuts',
    title: 'Обрезки в дело',
    // Не «ответ» экрана: обрезки — возможность сэкономить, а не решение
    tone: 'ok',
    icon: <IconScissors size={19} aria-hidden />,
    value: offcutRows.length,
    caption: 'деловой отход: длины, которые можно не резать заново',
    loading: offcuts.isLoading,
    items: offcutRows.slice(0, 4).map((r) => ({
      id: r.id,
      label: `${r.material?.materialCode ?? '—'} · ${r.material?.name ?? ''}`,
      value: `${num(Number(r.qty), 0)} шт`,
      sub: `${num(Number(r.lengthMm), 0)} мм${r.widthMm ? ` × ${num(Number(r.widthMm), 0)} мм` : ''}`,
      onClick: r.material?.id
        ? () => openEntity({ kind: 'material', id: r.material.id, label: r.material.name })
        : undefined,
    })),
    emptyText: 'Обрезков не заведено',
    action: { label: 'Обрезки', onClick: () => onGoTab('offcuts') },
  });

  const paged = usePagedList(cards, Math.max(1, fit.count), `${cards.length}|${fit.count}`);
  usePageKeys(paged.page, paged.totalPages, paged.setPage);

  return (
    <div className="wh-digest">
      {/* Своя сетка вместо DigestGrid: контейнер должен занимать остаток
          высоты, чтобы по нему померить, сколько карточек влезло */}
      <div className="digest-grid wh-digest__grid" ref={fit.ref}>
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
