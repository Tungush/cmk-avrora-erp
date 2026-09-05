import React, { useId, useMemo } from 'react';
import { area as d3area, line as d3line, curveMonotoneX } from 'd3-shape';

/**
 * Микрографик (05.09.2026). Одна линия и мягкая подложка под ней.
 *
 * По модели Grafana Stat: график не сосед числа, а его фон — поэтому
 * есть режим `backdrop`, в котором он растягивается на всю карточку с
 * альфой 0,18 и не мешает читать цифру поверх.
 *
 * Библиотек графиков не тянем: d3-shape уже в проекте, а SVG в 30
 * строк даёт ровно то, что нужно, и красится токенами.
 *
 * Пустой ряд (< 2 точек) не рисуется вовсе — вместо выдуманной линии
 * честный прочерк у вызывающего.
 */
export function Sparkline({
  values, width = 160, height = 40, color = 'var(--s-accent, #818CF8)', backdrop = false, label,
}: {
  values: number[];
  width?: number;
  height?: number;
  /** Цвет линии; заливка — тот же цвет с альфой */
  color?: string;
  /** Подложка карточки: растянуть на 100 % и притушить */
  backdrop?: boolean;
  /** Для читалки: что это за ряд */
  label?: string;
}) {
  const id = useId();
  const d = useMemo(() => {
    if (values.length < 2) return null;
    const max = Math.max(...values), min = Math.min(...values);
    const span = max - min || 1;
    const pad = 3;
    const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
    const pts = values.map((v, i) => [x(i), y(v)] as [number, number]);
    const lineGen = d3line<[number, number]>().x((p) => p[0]).y((p) => p[1]).curve(curveMonotoneX);
    const areaGen = d3area<[number, number]>().x((p) => p[0]).y0(height).y1((p) => p[1]).curve(curveMonotoneX);
    return { line: lineGen(pts) ?? '', area: areaGen(pts) ?? '', last: pts[pts.length - 1] };
  }, [values, width, height]);

  if (!d) return null;

  return (
    <svg
      className={backdrop ? 'spark spark--backdrop' : 'spark'}
      viewBox={`0 0 ${width} ${height}`}
      width={backdrop ? '100%' : width}
      height={backdrop ? '100%' : height}
      preserveAspectRatio={backdrop ? 'none' : 'xMidYMid meet'}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity={backdrop ? 0.22 : 0.28} />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={d.area} fill={`url(#${id}-g)`} />
      <path d={d.line} fill="none" stroke={color} strokeWidth={backdrop ? 1.5 : 2} strokeLinecap="round" strokeLinejoin="round" />
      {!backdrop && <circle cx={d.last[0]} cy={d.last[1]} r={3} fill={color} />}
    </svg>
  );
}
