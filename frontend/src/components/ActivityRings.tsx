import React, { useMemo } from 'react';
import { arc as d3arc } from 'd3-shape';
import { motion } from 'framer-motion';
import { useMotionOff } from './motion';

export interface Ring {
  key: string;
  /** Подпись в легенде и для читалки: «Маржа», «Оплачено поставщикам» */
  label: string;
  value: number;
  max: number;
  /** Как показать пару value/max словами: «27,8 % из 35 %» */
  caption: string;
}

/**
 * Кольца активности (05.09.2026, просьба владельца «круги в пустые места»).
 *
 * Три вложенных кольца — три доли, каждая со своим полным кругом:
 * маржа к цели, оплачено поставщикам от законтрактованного, оплачено
 * заказчиками от законтрактованного. В центре — метрика дня: сколько
 * ждёт решения директора.
 *
 * ЦВЕТ. Все кольца одного цвета — акцентного из палитры владельца.
 * Не три оттенка, как в часах Apple: указатель в системе один, а
 * кольцо опознаётся положением (внешнее / среднее / внутреннее) и
 * подписью в легенде, не тоном. Выбранное кольцо переходит в цвет
 * структуры — это второй тёмный тон палитры, и он читается при любом
 * цветовосприятии, потому что отличается светлотой.
 *
 * ВЗАИМОДЕЙСТВИЕ. Кольцо и строка легенды — кнопки. Нажатие выбирает
 * срез и переключает тело экрана (тот же рычаг, что у плиток сверху).
 * Наведение только ПОДСВЕЧИВАЕТ связанное — плитку и строку — и ничего
 * не переключает: в цеху планшет, наведения там нет, а перескакивающее
 * от движения мыши содержимое дезориентирует и на столе.
 *
 * ДВИЖЕНИЕ. Дуги рисуются один раз при появлении и дальше стоят.
 * При выключенном движении — сразу в конечном состоянии.
 *
 * ГЕОМЕТРИЯ. d3-shape уже стоит в проекте — новых зависимостей нет.
 */
export function ActivityRings({
  rings, center, active, peek, onSelect, onPeek, size = 236,
}: {
  rings: Ring[];
  center: { value: string; label: string };
  active?: string | null;
  peek?: string | null;
  onSelect: (key: string) => void;
  onPeek: (key: string | null) => void;
  size?: number;
}) {
  const reduced = useMotionOff();
  const c = size / 2;
  const stroke = Math.round(size * 0.068);   // 16 при 236
  const gap = Math.round(size * 0.028);      // 6-7 при 236

  const geo = useMemo(() => rings.map((r, i) => {
    const outer = c - i * (stroke + gap);
    const inner = outer - stroke;
    const share = r.max > 0 ? Math.max(0, Math.min(1, r.value / r.max)) : 0;
    const gen = d3arc<{ a: number }>()
      .innerRadius(inner)
      .outerRadius(outer)
      .cornerRadius(stroke / 2)
      .startAngle(0)
      .endAngle((d) => d.a);
    return {
      ring: r,
      share,
      track: gen({ a: Math.PI * 2 }) ?? '',
      fill: share > 0 ? (gen({ a: Math.PI * 2 * share }) ?? '') : '',
      mid: (outer + inner) / 2,
    };
  }), [rings, c, stroke, gap]);

  return (
    <div className="rings" style={{ '--rings-size': `${size}px` } as React.CSSProperties}>
      {/* Диск: svg и число в центре — один блок, чтобы центр стоял по
          центру КОЛЕЦ, а легенда под ними могла быть любой ширины */}
      <div className="rings__disc">
      <svg
        className="rings__svg"
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label={`Кольца: ${rings.map((r) => `${r.label} — ${r.caption}`).join('; ')}. В центре: ${center.value} ${center.label}`}
      >
        <g transform={`translate(${c} ${c})`}>
          {geo.map(({ ring, share, track, fill }, i) => {
            const isActive = active === ring.key;
            const isPeek = peek === ring.key;
            return (
              <g
                key={ring.key}
                className="rings__ring"
                data-active={isActive ? 'true' : undefined}
                data-peek={isPeek ? 'true' : undefined}
                role="button"
                tabIndex={0}
                aria-label={`${ring.label}: ${ring.caption}`}
                aria-pressed={isActive}
                onClick={() => onSelect(ring.key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(ring.key); } }}
                onPointerEnter={() => onPeek(ring.key)}
                onPointerLeave={() => onPeek(null)}
                onFocus={() => onPeek(ring.key)}
                onBlur={() => onPeek(null)}
              >
                <path className="rings__track" d={track} />
                {fill && (
                  <motion.path
                    className="rings__fill"
                    d={fill}
                    initial={reduced ? false : { pathLength: 0, opacity: 0.4 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 60, damping: 18, delay: i * 0.08 }}
                    style={{ transformOrigin: 'center' }}
                  />
                )}
                {/* Невидимая широкая мишень: кольцо в 16 px планшетом не поймать */}
                <path className="rings__hit" d={track} />
                <title>{`${ring.label}: ${ring.caption}`}</title>
                {share >= 1 && <circle className="rings__full" r={2.5} cx={0} cy={-(c - i * (stroke + gap)) + stroke / 2} />}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="rings__center" aria-hidden>
        <div className="rings__center-value">{center.value}</div>
        <div className="rings__center-label">{center.label}</div>
      </div>
      </div>

      <ul className="rings__legend" aria-label="Что показывают кольца">
        {geo.map(({ ring, share }) => (
          <li key={ring.key}>
            <button
              type="button"
              className="rings__legend-row"
              data-active={active === ring.key ? 'true' : undefined}
              data-peek={peek === ring.key ? 'true' : undefined}
              aria-pressed={active === ring.key}
              onClick={() => onSelect(ring.key)}
              onPointerEnter={() => onPeek(ring.key)}
              onPointerLeave={() => onPeek(null)}
              onFocus={() => onPeek(ring.key)}
              onBlur={() => onPeek(null)}
            >
              <span className="rings__legend-dot" aria-hidden />
              <span className="rings__legend-label">{ring.label}</span>
              <span className="rings__legend-pct">{Math.round(share * 100)}%</span>
              <span className="rings__legend-cap">{ring.caption}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
