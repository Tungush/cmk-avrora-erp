import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useMotionOff } from './motion';

/**
 * Мачта базовой станции — фирменный знак системы (02.09.2026, просьба
 * владельца: «чтобы у нас была своя изюминка»).
 *
 * Завод делает решётчатые мачты под базовые станции, поэтому знак взят не
 * из стока: секции поднимаются снизу вверх, как их и монтируют, сверху
 * встают антенные панели и загорается авиационный огонь.
 *
 * Геометрия считается, а не нарисована руками: любое число секций, любая
 * высота, и по progress видно, сколько уже собрано, — так один и тот же
 * знак работает и заставкой, и индикатором готовности.
 */

export interface MastProps {
  /** Высота рисунка, px */
  height?: number;
  /** Сколько секций в решётке */
  sections?: number;
  /** 0…1 — какая часть уже собрана. undefined = собрана целиком */
  progress?: number;
  /** Строить по секциям при появлении */
  animate?: boolean;
  /** Толщина линий */
  stroke?: number;
  className?: string;
  /** Мигающий огонь на верхушке */
  beacon?: boolean;
}

export function Mast({
  height = 220, sections = 6, progress, animate = true, stroke = 1.5, className, beacon = true,
}: MastProps) {
  const reduced = useMotionOff();
  const H = 300;                 // расчётная высота в системе координат
  const W_BOTTOM = 130;          // ширина у основания
  const W_TOP = 34;              // ширина под антеннами
  const cx = 90;
  const viewW = 180;

  const geom = useMemo(() => {
    const halfAt = (y: number) => {
      // y = H у земли, y = 0 у верхушки
      const t = y / H;
      return (W_TOP + (W_BOTTOM - W_TOP) * t) / 2;
    };
    const step = H / sections;
    return Array.from({ length: sections }, (_, i) => {
      const yBottom = H - i * step;
      const yTop = H - (i + 1) * step;
      const hb = halfAt(yBottom);
      const ht = halfAt(yTop);
      return {
        i,
        left: `M ${cx - hb} ${yBottom} L ${cx - ht} ${yTop}`,
        right: `M ${cx + hb} ${yBottom} L ${cx + ht} ${yTop}`,
        beam: `M ${cx - ht} ${yTop} L ${cx + ht} ${yTop}`,
        braceA: `M ${cx - hb} ${yBottom} L ${cx + ht} ${yTop}`,
        braceB: `M ${cx + hb} ${yBottom} L ${cx - ht} ${yTop}`,
      };
    });
  }, [sections]);

  // Готовность: собранные секции горят, остальные — призрачные
  const built = progress == null ? sections : Math.round(progress * sections);
  const width = Math.round((height * viewW) / (H + 60));

  const line = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: stroke,
    strokeLinecap: 'round' as const,
  };

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 -46 ${viewW} ${H + 60}`}
      aria-hidden
      style={{ overflow: 'visible' }}
    >
      {/* Земля */}
      <path d={`M ${cx - W_BOTTOM / 2 - 12} ${H} L ${cx + W_BOTTOM / 2 + 12} ${H}`}
        {...line} strokeWidth={stroke * 1.4} opacity={0.45} />

      {geom.map((g) => {
        const done = g.i < built;
        const content = (
          <>
            <path d={g.left} {...line} />
            <path d={g.right} {...line} />
            <path d={g.beam} {...line} opacity={0.8} />
            <path d={g.braceA} {...line} opacity={0.45} />
            <path d={g.braceB} {...line} opacity={0.45} />
          </>
        );
        if (!animate || reduced) {
          return <g key={g.i} opacity={done ? 1 : 0.22}>{content}</g>;
        }
        return (
          <motion.g
            key={g.i}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: done ? 1 : 0.22, y: 0 }}
            transition={{ duration: 0.5, delay: 0.09 * g.i, ease: [0.25, 1, 0.5, 1] }}
          >
            {content}
          </motion.g>
        );
      })}

      {/* Антенные панели — то, ради чего мачту и ставят */}
      {[-1, 0, 1].map((k, idx) => {
        const x = cx + k * 21 - 4.5;
        const rect = <rect x={x} y={-12} width={9} height={26} rx={3.5}
          fill="currentColor" opacity={0.85} />;
        if (!animate || reduced) return <g key={k} opacity={built >= sections ? 1 : 0.22}>{rect}</g>;
        return (
          <motion.g
            key={k}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: built >= sections ? 1 : 0.22, scale: 1 }}
            transition={{ duration: 0.4, delay: 0.09 * sections + 0.08 * idx, ease: [0.25, 1, 0.5, 1] }}
            style={{ transformOrigin: `${x + 4.5}px 1px` }}
          >
            {rect}
          </motion.g>
        );
      })}

      {/* Авиационный огонь: горит, когда мачта собрана */}
      {beacon && (
        <g className={built >= sections && !reduced ? 'mast-beacon' : undefined}>
          <circle cx={cx} cy={-30} r={4.5} className="mast-beacon__dot" />
          <circle cx={cx} cy={-30} r={11} className="mast-beacon__halo" />
        </g>
      )}
      <path d={`M ${cx} -26 L ${cx} -12`} {...line} opacity={0.6} />
    </svg>
  );
}

/**
 * Пустое состояние и ожидание: вместо крутящегося кружка — мачта,
 * которая собирается. Ждать приходится одинаково, а смотреть — приятнее.
 */
export function MastLoader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mast-empty">
      <Mast height={148} sections={5} />
      <div className="mast-empty__title">{title}</div>
      {hint && <div className="mast-empty__hint">{hint}</div>}
    </div>
  );
}
