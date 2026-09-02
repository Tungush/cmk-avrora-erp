import React from 'react';
import { Group, Pagination, Select, Text } from '@mantine/core';

export const PAGE_SIZES = [25, 50, 100] as const;

interface PaginationBarProps {
  page: number;
  /** Всего записей — из meta.total (сервер) или длины списка (клиент) */
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** Если не передан — размер страницы фиксирован, селектор не показывается */
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: readonly number[];
  /** «заказов», «позиций» — существительное в родительном падеже мн. ч. */
  noun?: string;
  /** compact — только счётчик и стрелки, для панелей и шторок */
  variant?: 'full' | 'compact';
  /** sticky — прилипает к низу области прокрутки (списки на весь экран) */
  sticky?: boolean;
}

/**
 * Единая пагинация (решение 02.09.2026): счётчик «показано X–Y из N»,
 * страницы, размер страницы. Одна и та же во всех реестрах, чтобы
 * пользователь не искал её заново на каждом экране.
 */
export function PaginationBar({
  page, total, pageSize, onPageChange, onPageSizeChange,
  pageSizeOptions = PAGE_SIZES, noun = 'записей', variant = 'full', sticky = false,
}: PaginationBarProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const fmt = (n: number) => n.toLocaleString('ru-RU');

  if (total <= pageSize && !onPageSizeChange) {
    return (
      <Text size="sm" c="dimmed" py={4}>
        {total === 0 ? `Нет ${noun}` : `${fmt(total)} ${noun}`}
      </Text>
    );
  }

  return (
    <Group
      justify="space-between"
      align="center"
      wrap="wrap"
      gap="sm"
      py={variant === 'compact' ? 4 : 8}
      className={sticky ? 'pagination-sticky' : undefined}
    >
      <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
        {total === 0
          ? `Нет ${noun}`
          : <>Показано <Text span fw={600} ff="monospace" c="var(--gray-9)">{fmt(from)}–{fmt(to)}</Text> из <Text span fw={600} ff="monospace" c="var(--gray-9)">{fmt(total)}</Text> {noun}</>}
      </Text>
      <Group gap="md" wrap="nowrap">
        {onPageSizeChange && variant === 'full' && (
          <Select
            aria-label="Строк на странице"
            size="sm"
            w={130}
            value={String(pageSize)}
            onChange={(v) => v && onPageSizeChange(Number(v))}
            data={pageSizeOptions.map((s) => ({ value: String(s), label: `${s} на стр.` }))}
            allowDeselect={false}
            comboboxProps={{ transitionProps: { transition: 'pop', duration: 140 } }}
          />
        )}
        {totalPages > 1 && (
          <Pagination
            value={page}
            onChange={onPageChange}
            total={totalPages}
            size={variant === 'compact' ? 'sm' : 'md'}
            radius="md"
            siblings={variant === 'compact' ? 0 : 1}
            boundaries={1}
            withEdges={variant === 'full' && totalPages > 5}
          />
        )}
      </Group>
    </Group>
  );
}

/** Клиентская пагинация массива: страница сбрасывается при смене фильтра */
export function usePagedList<T>(items: T[], pageSize: number, resetKey: unknown = null) {
  const [page, setPage] = React.useState(1);
  React.useEffect(() => { setPage(1); }, [resetKey, pageSize]);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const slice = React.useMemo(
    () => items.slice((safePage - 1) * pageSize, safePage * pageSize),
    [items, safePage, pageSize],
  );
  return { page: safePage, setPage, slice, total: items.length, totalPages };
}

/** Размер страницы, который помнится между визитами — на экран, не глобально */
export function usePageSize(storageKey: string, fallback: number = 25) {
  const [size, setSize] = React.useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(`ui-page-size:${storageKey}`));
      return PAGE_SIZES.includes(v as (typeof PAGE_SIZES)[number]) ? v : fallback;
    } catch {
      return fallback;
    }
  });
  const update = React.useCallback((v: number) => {
    setSize(v);
    try { localStorage.setItem(`ui-page-size:${storageKey}`, String(v)); } catch { /* приватный режим */ }
  }, [storageKey]);
  return [size, update] as const;
}
