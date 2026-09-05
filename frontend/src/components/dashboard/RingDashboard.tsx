import React, { useMemo, useState } from 'react';
import { arc as d3arc } from 'd3-shape';
import { motion } from 'framer-motion';
import { useElementSize } from '@mantine/hooks';
import { useMotionOff } from '../motion';

export interface RingSpec {
  key: string;
  label: string;
  value: number;
  max: number;
  /** «27,8 % из 35 %» — читается человеком и читалкой */
  caption: string;
  /** Короткое имя для центра колец: там ≈ 49 % диаметра, полное имя не влезает */
  short?: string;
  /** Категорийный цвет из четырёх акцентов */
  hue: 'indigo' | 'amber' | 'emerald' | 'rose';
}

/**
 * Ядро экрана — кольца активности (05.09.2026, переписано с нуля).
 *
 * РАЗМЕР НЕ ФИКСИРОВАН. Диаметр считается от свободной высоты панели
 * за вычетом легенды (ResizeObserver через useElementSize) и зажат в
 * [minSize, maxSize]. На ноутбуке 1280×720 кольцо само уменьшается,
 * а не упирается в край панели — замечание владельца 05.09.
 *
 * Геометрия — как у Apple Fitness, но тоньше: 6 % диаметра на кольцо,
 * 2,5 % зазор, чтобы в центре оставалось ≈ 49 % диаметра под цифру.
 * Скруглённые концы, заполнение от 12 часов по часовой; кольцо на
 * 100 % получает точку в вершине, чтобы полный круг не читался как
 * пустой.
 *
 * ЦЕНТР ЖИВОЙ. В покое — метрика дня. При наведении, фокусе или
 * нажатии на кольцо или строку легенды центр показывает ЭТО кольцо.
 *
 * ЦВЕТ ПО КАТЕГОРИИ. Оттенок — украшение смысла, не носитель: кольцо
 * опознаётся положением и подписью, при дальтонизме ничего не
 * теряется.
 *
 * ДВИЖЕНИЕ. Дуги рисуются один раз при появлении и дальше стоят.
 * При выключенном движении — сразу. Наведение меняет только цвет и
 * центр, ничего не дёргает.
 */
export function RingDashboard({
  rings, center, active, onSelect, maxSize = 236, minSize = 150,
}: {
  rings: RingSpec[];
  /** Метрика дня в покое */
  center: { value: string; label: string; hue?: RingSpec['hue'] };
  active?: string | null;
  onSelect: (key: string) => void;
  maxSize?: number;
  minSize?: number;
}) {
  const reduced = useMotionOff();
  const [peek, setPeek] = useState<string | null>(null);
  const { ref: wrapRef, width: ww, height: wh } = useElementSize();
  const { ref: legendRef, height: lh } = useElementSize();

  const fit = ww > 0 && wh > 0 ? Math.min(ww, wh - lh - 18) : maxSize;
  const size = Math.round(Math.max(minSize, Math.min(maxSize, fit)));
  const c = size / 2;
  const stroke = Math.round(size * 0.06);
  const gap = Math.round(size * 0.025);

  const geo = useMemo(() => rings.map((r, i) => {
    const outer = c - i * (stroke + gap);
    const inner = outer - stroke;
    const share = r.max > 0 ? Math.max(0, Math.min(1, r.value / r.max)) : 0;
    const gen = d3arc<{ a: number }>().innerRadius(inner).outerRadius(outer).cornerRadius(stroke / 2).startAngle(0).endAngle((d) => d.a);
    return { r, share, outer, track: gen({ a: Math.PI * 2 }) ?? '', fill: share > 0 ? gen({ a: Math.PI * 2 * share }) ?? '' : '' };
  }), [rings, c, stroke, gap]);

  const shown = peek ? geo.find((g) => g.r.key === peek) : null;
  const vars = {
    '--ring-size': `${size}px`,
    '--ring-pad': `${3 * (stroke + gap) + 8}px`,
    '--ring-value': `${Math.round(size * 0.135)}px`,
  } as React.CSSProperties;

  return (
    <div className="ringdash" ref={wrapRef} style={vars}>
      <div className="ringdash__disc">
        <svg
          viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img"
          aria-label={`Кольца: ${rings.map((r) => `${r.label} — ${r.caption}`).join('; ')}. В центре: ${center.value} ${center.label}`}
        >
          <g transform={`translate(${c} ${c})`}>
            {geo.map(({ r, share, outer, track, fill }, i) => (
              <g
                key={r.key}
                className="ringdash__ring"
                data-hue={r.hue}
                data-active={active === r.key ? 'true' : undefined}
                data-peek={peek === r.key ? 'true' : undefined}
                role="button" tabIndex={0}
                aria-label={`${r.label}: ${r.caption}`} aria-pressed={active === r.key}
                onClick={() => onSelect(r.key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r.key); } }}
                onPointerEnter={() => setPeek(r.key)} onPointerLeave={() => setPeek(null)}
                onFocus={() => setPeek(r.key)} onBlur={() => setPeek(null)}
              >
                <path className="ringdash__track" d={track} />
                {fill && (
                  <motion.path
                    className="ringdash__fill" d={fill}
                    initial={reduced ? false : { pathLength: 0, opacity: 0.5 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 60, damping: 18, delay: i * 0.08 }}
                  />
                )}
                <path className="ringdash__hit" d={track} />
                <title>{`${r.label}: ${r.caption}`}</title>
                {share >= 1 && <circle className="ringdash__full" r={2.5} cx={0} cy={-outer + stroke / 2} />}
              </g>
            ))}
          </g>
        </svg>

        {/* Живой центр: в покое — метрика дня, под курсором — кольцо */}
        <div className="ringdash__center" data-hue={shown ? shown.r.hue : (center.hue ?? 'rose')} aria-hidden>
          {shown ? (
            <>
              <div className="ringdash__center-value">{Math.round(shown.share * 100)}%</div>
              <div className="ringdash__center-label">{shown.r.short ?? shown.r.label}</div>
            </>
          ) : (
            <>
              <div className="ringdash__center-value">{center.value}</div>
              <div className="ringdash__center-label">{center.label}</div>
            </>
          )}
        </div>
      </div>

      <ul className="ringdash__legend" ref={legendRef} aria-label="Что показывают кольца">
        {geo.map(({ r, share }) => (
          <li key={r.key}>
            <button
              type="button" className="ringdash__row" data-hue={r.hue}
              data-active={active === r.key ? 'true' : undefined}
              data-peek={peek === r.key ? 'true' : undefined}
              aria-pressed={active === r.key}
              onClick={() => onSelect(r.key)}
              onPointerEnter={() => setPeek(r.key)} onPointerLeave={() => setPeek(null)}
              onFocus={() => setPeek(r.key)} onBlur={() => setPeek(null)}
            >
              <span className="ringdash__dot" aria-hidden />
              <span className="ringdash__lbl">{r.label}</span>
              <span className="ringdash__pct">{Math.round(share * 100)}%</span>
              <span className="ringdash__cap">{r.caption}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
