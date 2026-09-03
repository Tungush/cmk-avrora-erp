import React, { createContext, useContext, useEffect, useState } from 'react';

/**
 * Метрики доски (03.09.2026, DESIGN.md §2 «Геометрия», §3).
 *
 * Доска считается от ФАКТИЧЕСКОГО окна через ResizeObserver, а не
 * медиазапросами «на глаз»: плитки получают ширину колонки, высоту ряда
 * «ЛИД» и остаток под подвал из контекста, и сами решают, что убрать
 * (см. деградацию Лида через useFitRows).
 *
 * isCompact — по ширине окна (< 1300): на 1440 доска шириной 1288 —
 * это ещё «большой» экран, компактной становится сетка 1280 и планшет.
 */
export interface BoardMetrics {
  /** Ширина и высота самой доски, px */
  width: number;
  height: number;
  /** Колонок всегда 12 */
  cols: number;
  /** Ширина одной колонки без зазора */
  colWidth: number;
  /** Зазоры: по горизонтали 32 (compact: 24), по вертикали 24 */
  gapX: number;
  gapY: number;
  /** Ряд «ЛИД»: 396 (compact: 348) */
  leadHeight: number;
  /** Остаток под «ПОДВАЛ» */
  tail: number;
  /** Окно уже 1300 px — сетка 1280 и планшет цеха */
  isCompact: boolean;
  /** Планшет: hover: none — цели ≥ 44 px, строки 48 */
  isTouch: boolean;
}

export const BOARD_COLS = 12;
export const COMPACT_BELOW = 1300;

export const isTouchNow = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(hover: none)').matches;

export const isCompactNow = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.clientWidth < COMPACT_BELOW;

export function computeMetrics(width: number, height: number, lead?: number): BoardMetrics {
  const isCompact = isCompactNow();
  const gapX = isCompact ? 24 : 32;
  const gapY = 24;
  const leadHeight = lead ?? (isCompact ? 348 : 396);
  const colWidth = Math.max(0, (width - gapX * (BOARD_COLS - 1)) / BOARD_COLS);
  return {
    width,
    height,
    cols: BOARD_COLS,
    colWidth,
    gapX,
    gapY,
    leadHeight,
    tail: Math.max(0, height - leadHeight - gapY),
    isCompact,
    isTouch: isTouchNow(),
  };
}

export const EMPTY_METRICS: BoardMetrics = computeMetrics(0, 0);

/** Что доска раздаёт плиткам помимо метрик */
export interface BoardContextValue {
  metrics: BoardMetrics;
  /** id развёрнутой плитки (Лист по F) — остальные гаснут */
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  /** Открыт правый Лист — доска ужимается и темнеет, клавиши доски молчат */
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  /** Слой над доской, куда Sheet рисуется порталом */
  sheetHost: HTMLElement | null;
  /** Порядковый номер плитки для стаггера входа (порядок чтения = порядок монтирования) */
  nextTileIndex: () => number;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

/** Контекст доски; вне Board — безопасные значения по умолчанию */
export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext);
  return ctx ?? FALLBACK;
}

const FALLBACK: BoardContextValue = {
  metrics: computeMetrics(
    typeof window !== 'undefined' ? window.innerWidth - 136 : 1288,
    typeof window !== 'undefined' ? window.innerHeight - 156 : 744,
  ),
  expandedId: null,
  setExpandedId: () => {},
  sheetOpen: false,
  setSheetOpen: () => {},
  sheetHost: null,
  nextTileIndex: () => 0,
};

/**
 * useBoardMetrics(ref, lead) — измеряет элемент через ResizeObserver и
 * отдаёт метрики (так работает сама Board). useBoardMetrics() без ref —
 * читает метрики из контекста ближайшей доски (так работают плитки).
 */
export function useBoardMetrics(ref?: React.RefObject<HTMLElement | null>, lead?: number): BoardMetrics {
  const ctx = useContext(BoardContext);
  const [measured, setMeasured] = useState<BoardMetrics>(EMPTY_METRICS);

  useEffect(() => {
    if (!ref) return;
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = computeMetrics(el.clientWidth, el.clientHeight, lead);
      setMeasured((prev) => (
        prev.width === next.width && prev.height === next.height
          && prev.isCompact === next.isCompact && prev.isTouch === next.isTouch
          && prev.leadHeight === next.leadHeight
          ? prev : next
      ));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Ширина окна влияет на isCompact даже если доска не изменилась
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [ref, lead]);

  if (ref) return measured;
  return ctx?.metrics ?? FALLBACK.metrics;
}
