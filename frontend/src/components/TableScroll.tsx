import React, { useEffect, useRef, useState } from 'react';
import { Box } from '@mantine/core';

interface TableScrollProps {
  children: React.ReactNode;
  /** Первая колонка остаётся на месте при горизонтальной прокрутке */
  stickyFirstColumn?: boolean;
  /** Ограничить высоту и прокручивать строки внутри (шапка прилипает) */
  maxHeight?: number | string;
  /** minWidth таблицы: ниже этой ширины появляется внутренняя прокрутка */
  minWidth?: number;
  style?: React.CSSProperties;
}

/**
 * Обёртка широкой таблицы (решение 02.09.2026): страница никогда не
 * прокручивается вбок — тянется только сама таблица, и это видно по
 * теням на краях. Первая колонка (номер, код) закреплена, чтобы при
 * прокрутке было понятно, к какой строке относятся числа.
 */
export function TableScroll({
  children, stickyFirstColumn = true, maxHeight, minWidth, style,
}: TableScrollProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 2;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, []);

  return (
    <Box
      ref={ref}
      className="table-scroll"
      data-sticky-first={stickyFirstColumn ? 'true' : undefined}
      data-shadow-left={edges.left ? 'true' : undefined}
      data-shadow-right={edges.right ? 'true' : undefined}
      style={{
        maxHeight,
        ['--table-min-width' as string]: minWidth ? `${minWidth}px` : undefined,
        ...style,
      }}
    >
      {children}
    </Box>
  );
}
