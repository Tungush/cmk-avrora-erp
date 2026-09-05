import React, { useState } from 'react';
import { Card, Group, Skeleton, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useNktCards, useNktSummary } from '../../hooks/useNkt';
import { PaginationBar } from '../../components/PaginationBar';
import { useFitRows } from '../../components/FitScreen';
import { EmptyState } from '../../components/EmptyState';
import { formatDate } from '../../utils/formatters';
import { NKT_STATUS, type NktStatus } from '../../api/nkt';

/**
 * Реестр изделий в конвейере НКТ.
 *
 * Плитка — не украшение, а фильтр: «Нет данных 412» открывает эти 412.
 * Четыре среза выбраны по тому, чей сейчас ход: три первых требуют
 * человека, четвёртый показывает, сколько уже дошло до цели.
 */
type Slice = 'all' | 'DATA_INCOMPLETE' | 'MATCH_REVIEW' | 'REWORK' | 'HAS_NTIN';

const TILES: Array<{ key: Slice; hue: 'rose' | 'amber' | 'indigo' | 'emerald'; label: string; hint: string }> = [
  { key: 'DATA_INCOMPLETE', hue: 'rose', label: 'Нет данных', hint: 'паспорт заполняет инженер' },
  { key: 'MATCH_REVIEW', hue: 'amber', label: 'Проверка совпадений', hint: 'НКТ нашёл похожие карточки' },
  { key: 'REWORK', hue: 'indigo', label: 'На доработке', hint: 'модератор вернул с замечаниями' },
  { key: 'HAS_NTIN', hue: 'emerald', label: 'NTIN получен', hint: 'обработка завершена' },
];

export function NktRegistry({ onOpen }: { onOpen: (articleId: string) => void }) {
  const [slice, setSlice] = useState<Slice>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const { data: summary } = useNktSummary();
  const fit = useFitRows(40, 5, 60, 40);

  const { data, isLoading } = useNktCards({
    page,
    pageSize: fit.rows,
    ...(slice === 'all' ? {} : { status: slice }),
    ...(search.trim() ? { search: search.trim() } : {}),
  });
  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const count = (k: Slice) => (k === 'all' ? summary?.total ?? 0 : summary?.byStatus[k as NktStatus] ?? 0);
  const pick = (k: Slice) => { setSlice(slice === k ? 'all' : k); setPage(1); };

  return (
    <div className="nkt">
      <div className="stat-row" role="tablist" aria-label="Срез по положению в конвейере">
        {TILES.map((t) => (
          <button
            key={t.key} type="button" role="tab" className="stat" data-hue={t.hue}
            aria-selected={slice === t.key} data-active={slice === t.key ? 'true' : undefined}
            onClick={() => pick(t.key)}
          >
            <div className="stat__label">{t.label}</div>
            <div className="stat__value">{summary ? count(t.key).toLocaleString('ru-RU') : '…'}</div>
            <div className="stat__hint">{t.hint}</div>
          </button>
        ))}
      </div>

      <Group gap="sm" wrap="nowrap" justify="space-between" className="nkt__bar">
        <TextInput
          placeholder="Артикул, наименование или NTIN…"
          leftSection={<IconSearch aria-hidden size={16} />}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          size="sm" style={{ flex: '0 1 340px' }}
        />
        <Text size="sm" c="dimmed">
          {summary
            ? `${summary.withNtin.toLocaleString('ru-RU')} из ${summary.total.toLocaleString('ru-RU')} изделий с NTIN — ${summary.sharePct.toFixed(1)} %`
            : ' '}
          {summary && summary.problem > 0 && ` · ${summary.problem} заявок с тремя кругами доработки и больше`}
        </Text>
      </Group>

      <Card withBorder radius="lg" padding={0} className="nkt__card">
        <div ref={fit.ref} className="nkt__wrap">
          <table className="dense nkt__table">
            <thead>
              <tr>
                <th style={{ width: 120 }}>Артикул</th>
                <th>Наименование</th>
                <th style={{ width: 190 }}>Положение</th>
                <th style={{ width: 150 }}>ОКТРУ</th>
                <th style={{ width: 140 }}>NTIN</th>
                <th style={{ width: 120 }}>Обновлено</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(Math.max(4, fit.rows))].map((_, i) => (
                  <tr key={i}><td colSpan={6}><Skeleton height={16} radius="sm" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState title={search ? 'Ничего не найдено' : 'В этом срезе пусто'} />
                  </td>
                </tr>
              ) : rows.map((r) => {
                const st = NKT_STATUS[r.status];
                return (
                  <tr key={r.articleId} className="dense__link" onClick={() => onOpen(r.articleId)}>
                    <td className="num nkt__code">{r.articleCode}</td>
                    <td title={r.articleName}>{r.articleName}</td>
                    <td>
                      <span className="nkt__state" data-hue={st.hue}>{st.label}</span>
                      {r.attempts >= 3 && <span className="nkt__attempts" title="кругов доработки">{r.attempts}</span>}
                    </td>
                    <td>{r.oktru
                      ? <span className="nkt__mono">{r.oktru}</span>
                      : <span className="nkt__missing">не задан</span>}</td>
                    <td>{r.ntin ? <span className="nkt__mono">{r.ntin}</span> : '—'}</td>
                    <td>{r.updatedAt ? <span className="nkt__mono">{formatDate(r.updatedAt)}</span> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="nkt__foot">
          <PaginationBar
            page={page} total={total} pageSize={fit.rows}
            onPageChange={setPage} noun="изделий" variant="compact"
          />
        </div>
      </Card>
    </div>
  );
}
