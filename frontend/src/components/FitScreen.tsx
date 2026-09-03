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
 * Сколько пикселей осталось от верха элемента до низа окна (03.09.2026).
 *
 * Нужен там, где строки НЕ одинаковой высоты и посчитать их числом
 * нельзя. Пример — производственный план: в ячейке живут план, факт и
 * потребность, поэтому строка занимает от 62 до 78 px в зависимости от
 * содержимого, а страница по выбору пользователя держит 25 строк.
 *
 * Раньше высота таблицы задавалась формулой `calc(100vh - 320px)`.
 * Число 320 было угадано: настоящая обвязка (шапка, заголовок, вкладки,
 * выбор года, пагинация, легенда) занимает 429 px, и страница уезжала
 * вниз на 109 px — ровно то, чего быть не должно.
 *
 * Здесь ничего не угадывается: берём собственный `top` элемента и
 * вычитаем запас под то, что стоит НИЖЕ него.
 *
 * Возвращает два ref: `ref` — на саму измеряемую область, `footerRef` —
 * на то, что стоит НИЖЕ неё (пагинация, легенда). Высота подвала тоже
 * измеряется, а не задаётся числом: стоит переписать легенду в две
 * строки — и любое зашитое число опять уводит страницу в прокрутку.
 *
 * @param reserve запас на отступы между блоками, px
 * @param min     не сжимать меньше этого — иначе таблица станет щелью
 */
export function useFitHeight(reserve = 0, min = 240) {
  const [h, setH] = useState(min);
  const nodeRef = useRef<HTMLElement | null>(null);
  const footRef = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    const top = node.getBoundingClientRect().top;
    const foot = footRef.current?.getBoundingClientRect().height ?? 0;
    setH(Math.max(min, Math.round(window.innerHeight - top - foot - reserve)));
  }, [reserve, min]);

  const measureRef = useRef(measure);
  measureRef.current = measure;

  const ref = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node;
    if (node) measureRef.current();
  }, []);

  const footerRef = useCallback((node: HTMLElement | null) => {
    footRef.current = node;
    if (node) measureRef.current();
  }, []);

  useEffect(() => {
    const run = () => measureRef.current();
    run();
    window.addEventListener('resize', run);
    // Обвязка над таблицей может менять высоту (перенос кнопок, алерт),
    // поэтому следим за всей главной областью, а не только за окном.
    const main = document.querySelector('.mantine-AppShell-main');
    const ro = main ? new ResizeObserver(run) : null;
    if (main && ro) ro.observe(main);
    return () => { window.removeEventListener('resize', run); ro?.disconnect(); };
  }, []);

  return { ref, footerRef, height: h };
}

/**
 * Считает, сколько строк помещается в свободную высоту.
 * Возвращает ref на измеряемую область и количество строк.
 */
export function useFitRows(rowHeight: number = ROW_H, min = 5, max = 60, chrome: number = HEAD_H) {
  const [rows, setRows] = useState(min);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  // Замер живёт в ref, чтобы callback-ref не пересоздавался при каждом
  // изменении параметров и не отцеплял наблюдателя
  const measureRef = useRef<() => void>(() => {});
  measureRef.current = () => {
    const el = nodeRef.current;
    if (!el) return;
    const n = Math.floor((el.clientHeight - chrome) / rowHeight);
    setRows((prev) => {
      const next = Math.max(min, Math.min(max, n));
      return prev === next ? prev : next;
    });
  };

  /**
   * Ref-функция вместо useRef-объекта (03.09.2026). Прежняя версия ставила
   * ResizeObserver один раз при монтировании ХУКА: если элемент появлялся
   * позже — вкладка, условный рендер, ленивая панель — наблюдатель к нему
   * не приезжал никогда, и список навсегда оставался на минимуме строк.
   * Ловилось дважды: таблица маржи показывала 3 строки вместо 9, список
   * прайса — столько же. Теперь наблюдатель цепляется в тот момент, когда
   * узел реально появился в дереве.
   */
  const ref = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    nodeRef.current = node;
    if (!node) { roRef.current = null; return; }
    const ro = new ResizeObserver(() => measureRef.current());
    ro.observe(node);
    roRef.current = ro;
    measureRef.current();
  }, []);

  useEffect(() => {
    measureRef.current();
    const onResize = () => measureRef.current();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [rowHeight, min, max, chrome]);

  useEffect(() => () => { roRef.current?.disconnect(); }, []);

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
      // Внутри вкладок, радиогрупп, списков и сегментов стрелки по ARIA
      // обязаны двигать выбор, а не листать страницу (03.09.2026)
      if (t?.closest?.(
        '[role="tablist"],[role="tab"],[role="radiogroup"],[role="radio"],'
        + '[role="listbox"],[role="option"],[role="menu"],[role="slider"],'
        + '.mantine-SegmentedControl-root,.mantine-Slider-root'
      )) return;
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
  const [count, setCount] = useState(min);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  const measureRef = useRef<() => void>(() => {});
  measureRef.current = () => {
    const el = nodeRef.current;
    if (!el) return;
    const cols = Math.max(1, Math.floor((el.clientWidth + gap) / (minCardWidth + gap)));
    const rows = Math.max(1, Math.floor((el.clientHeight + gap) / (cardHeight + gap)));
    const next = Math.max(min, Math.min(max, cols * rows));
    setCount((prev) => (prev === next ? prev : next));
  };

  /** Та же callback-ref, что и в useFitRows, и по той же причине */
  const ref = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    nodeRef.current = node;
    if (!node) { roRef.current = null; return; }
    const ro = new ResizeObserver(() => measureRef.current());
    ro.observe(node);
    roRef.current = ro;
    measureRef.current();
  }, []);

  useEffect(() => {
    measureRef.current();
    const onResize = () => measureRef.current();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [minCardWidth, cardHeight, gap, min, max]);

  useEffect(() => () => { roRef.current?.disconnect(); }, []);

  return { ref, count };
}
