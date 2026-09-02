import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * «Экран = один экран» (02.09.2026, требование владельца: «чтобы мои
 * пользователи вообще ничего не скроллили»).
 *
 * Приложение фиксировано по высоте окна и не прокручивается нигде.
 * Список показывает РОВНО столько строк, сколько поместилось, — размер
 * страницы вычисляется из свободной высоты, а не задаётся числом 25/50.
 * Перемещение по данным — страницами и стрелками, а не колесом мыши.
 *
 * Так работают Linear и Superhuman: постоянная рамка, внутри неё меняется
 * только содержимое. Плата за это честная — на экран влезает меньше строк,
 * зато человек всегда видит и шапку с фильтрами, и пагинацию.
 */

/** Высота одной строки таблицы по плотности интерфейса, px */
export const ROW_H = 45;
/** Шапка таблицы + её рамка */
const HEAD_H = 42;

/**
 * Считает, сколько строк помещается в свободную высоту.
 * Возвращает ref на измеряемую область и количество строк.
 */
export function useFitRows(rowHeight: number = ROW_H, min = 5, max = 60, chrome: number = HEAD_H) {
  const ref = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState(min);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight - chrome;
      const n = Math.floor(h / rowHeight);
      setRows((prev) => {
        const next = Math.max(min, Math.min(max, n));
        return prev === next ? prev : next;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [rowHeight, min, max, chrome]);

  return { ref, rows };
}

/**
 * Рамка экрана: шапка и подвал не двигаются, середина занимает остаток
 * высоты. Внутри середины прокрутки нет — туда кладут ровно то,
 * что влезло (см. useFitRows).
 */
export function FitScreen({
  header, footer, children,
}: {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Режим «без прокрутки» включается только на экранах, которые к нему
  // готовы: остальные разделы продолжают прокручиваться как раньше,
  // иначе их содержимое просто обрезало бы снизу
  useEffect(() => {
    document.documentElement.dataset.fit = 'on';
    return () => { delete document.documentElement.dataset.fit; };
  }, []);

  return (
    <div className="fit-screen">
      {header && <div className="fit-screen__head">{header}</div>}
      <div className="fit-screen__body">{children}</div>
      {footer && <div className="fit-screen__foot">{footer}</div>}
    </div>
  );
}

/**
 * Листание с клавиатуры: ← → и PageUp/PageDown. Колесо мыши больше
 * ничего не прокручивает, поэтому движение по данным должно быть
 * очевидным и быстрым — иначе человек окажется заперт на первой странице.
 */
export function usePageKeys(page: number, totalPages: number, setPage: (p: number) => void) {
  const go = useCallback((delta: number) => {
    const next = Math.min(totalPages, Math.max(1, page + delta));
    if (next !== page) setPage(next);
  }, [page, totalPages, setPage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // В поле ввода стрелки принадлежат тексту, а не списку
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (t?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);
}

/**
 * То же для плиточной сетки: считает, сколько карточек влезло, — по ширине
 * контейнера (сколько колонок) и по высоте (сколько рядов). Без этого
 * «страница ровно в экран» ломается на карточках: строки-то мы считать
 * научились, а плитки продолжали вылезать за нижний край.
 */
export function useFitGrid(minCardWidth: number, cardHeight: number, gap = 12, min = 2, max = 60) {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(min);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cols = Math.max(1, Math.floor((el.clientWidth + gap) / (minCardWidth + gap)));
      const rows = Math.max(1, Math.floor((el.clientHeight + gap) / (cardHeight + gap)));
      const next = Math.max(min, Math.min(max, cols * rows));
      setCount((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [minCardWidth, cardHeight, gap, min, max]);

  return { ref, count };
}
