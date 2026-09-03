import { Button } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { apiErrorMessage, apiErrorTitle } from '../api/errors';
import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useMotionOff } from './motion';

/**
 * Мачта базовой станции — фирменный знак системы (02.09.2026, просьба
 * владельца: «чтобы у нас была своя изюминка», подробнее — 02.09.2026).
 *
 * Завод делает решётчатые мачты под базовые станции, поэтому знак взят не
 * из стока, а нарисован как настоящая опора: четыре ноги (задние видно
 * сквозь решётку), раскосы по панелям, лестница с площадкой обслуживания,
 * три секторные антенны, радиорелейка и авиационный огонь.
 *
 * Секции поднимаются снизу вверх — так её и монтируют. По progress видно,
 * сколько уже собрано, поэтому один и тот же знак работает и заставкой,
 * и индикатором готовности площадки.
 *
 * Геометрия считается, а не нарисована руками: любое число секций и любая
 * высота. Мелкие детали (лестница, тарелка, задние раскосы) появляются
 * только на крупном размере — на 100 px они превратились бы в кашу.
 */

export interface MastProps {
  /** Высота рисунка, px */
  height?: number;
  /** Секций в решётке */
  sections?: number;
  /** 0…1 — какая часть собрана. undefined = собрана целиком */
  progress?: number;
  /** Строить по секциям при появлении */
  animate?: boolean;
  /** Толщина линий решётки (ноги толще автоматически) */
  stroke?: number;
  className?: string;
  /** Мигающий огонь на верхушке */
  beacon?: boolean;
  /** Волны сигнала от антенн — мачта «работает», а не просто стоит */
  signal?: boolean;
  /** Принудительно включить/выключить мелкую проработку */
  detailed?: boolean;
}

const H = 300;          // высота ствола в системе координат
const CX = 90;          // ось мачты
const VIEW_W = 180;
const VIEW_TOP = -78;   // место под антенны и огонь
const VIEW_H = H - VIEW_TOP + 16;
const W_BOTTOM = 128;   // размах ног у земли
const W_TOP = 30;       // размах под площадкой

/** Полуширина опоры на высоте y (y = H у земли, 0 — верх ствола) */
const halfAt = (y: number) => (W_TOP + (W_BOTTOM - W_TOP) * (y / H)) / 2;
/** Задние ноги ближе к оси — так читается объём */
const backAt = (y: number) => halfAt(y) * 0.44;

export function Mast({
  height = 220, sections = 6, progress, animate = true, stroke = 2,
  className, beacon = true, detailed, signal = false,
}: MastProps) {
  const reduced = useMotionOff();
  const fine = detailed ?? height >= 150;
  const perSection = fine ? 2 : 1;

  const rig = useMemo(() => {
    const step = H / sections;
    return Array.from({ length: sections }, (_, i) => {
      const yBottom = H - i * step;
      const panels = Array.from({ length: perSection }, (__, p) => {
        const y0 = yBottom - (p * step) / perSection;
        const y1 = yBottom - ((p + 1) * step) / perSection;
        const h0 = halfAt(y0);
        const h1 = halfAt(y1);
        const b0 = backAt(y0);
        const b1 = backAt(y1);
        return {
          legL: `M ${CX - h0} ${y0} L ${CX - h1} ${y1}`,
          legR: `M ${CX + h0} ${y0} L ${CX + h1} ${y1}`,
          backL: `M ${CX - b0} ${y0} L ${CX - b1} ${y1}`,
          backR: `M ${CX + b0} ${y0} L ${CX + b1} ${y1}`,
          beam: `M ${CX - h1} ${y1} L ${CX + h1} ${y1}`,
          braceA: `M ${CX - h0} ${y0} L ${CX + h1} ${y1}`,
          braceB: `M ${CX + h0} ${y0} L ${CX - h1} ${y1}`,
          backBraceA: `M ${CX - b0} ${y0} L ${CX + b1} ${y1}`,
          backBraceB: `M ${CX + b0} ${y0} L ${CX - b1} ${y1}`,
          y0,
          y1,
        };
      });
      return { i, panels };
    });
  }, [sections, perSection]);

  // Лестница с ограждением — по ней и поднимаются к антеннам
  const ladder = useMemo(() => {
    if (!fine) return null;
    const rungs: string[] = [];
    for (let y = H - 14; y > 6; y -= 13) rungs.push(`M ${CX - 5} ${y} L ${CX + 5} ${y}`);
    return {
      rails: [`M ${CX - 5} ${H} L ${CX - 5} 2`, `M ${CX + 5} ${H} L ${CX + 5} 2`],
      rungs,
    };
  }, [fine]);

  const built = progress == null ? sections : Math.round(progress * sections);
  const complete = built >= sections;
  const width = Math.round((height * VIEW_W) / VIEW_H);

  const line = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  const legW = stroke * 1.5;

  /** Обёртка секции: либо просто прозрачность, либо подъём снизу */
  const wrap = (key: React.Key, done: boolean, delay: number, children: React.ReactNode) => {
    const target = done ? 1 : 0.2;
    if (!animate || reduced) return <g key={key} opacity={target}>{children}</g>;
    return (
      <motion.g
        key={key}
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: target, y: 0 }}
        transition={{ duration: 0.5, delay, ease: [0.25, 1, 0.5, 1] }}
      >
        {children}
      </motion.g>
    );
  };

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 ${VIEW_TOP} ${VIEW_W} ${VIEW_H}`}
      aria-hidden
      style={{ overflow: 'visible' }}
    >
      {/* Фундамент: подошвы под ноги, а не просто линия земли */}
      <g opacity={0.55}>
        <path d={`M ${CX - W_BOTTOM / 2 - 14} ${H} L ${CX + W_BOTTOM / 2 + 14} ${H}`}
          {...line} strokeWidth={stroke * 1.2} />
        <rect x={CX - W_BOTTOM / 2 - 9} y={H} width={18} height={7} rx={2} fill="currentColor" />
        <rect x={CX + W_BOTTOM / 2 - 9} y={H} width={18} height={7} rx={2} fill="currentColor" />
        {fine && (
          <>
            <rect x={CX - backAt(H) - 6} y={H - 2} width={12} height={5} rx={2} fill="currentColor" opacity={0.5} />
            <rect x={CX + backAt(H) - 6} y={H - 2} width={12} height={5} rx={2} fill="currentColor" opacity={0.5} />
          </>
        )}
      </g>

      {rig.map((sec) => {
        const done = sec.i < built;
        const delay = 0.085 * sec.i;
        return wrap(sec.i, done, delay, (
          <>
            {/* Задние ноги и их раскосы — читаются как объём, поэтому бледнее */}
            <g opacity={0.32}>
              {sec.panels.map((p, k) => (
                <React.Fragment key={`b${k}`}>
                  <path d={p.backL} {...line} strokeWidth={stroke} />
                  <path d={p.backR} {...line} strokeWidth={stroke} />
                  {fine && <path d={p.backBraceA} {...line} strokeWidth={stroke * 0.7} />}
                  {fine && <path d={p.backBraceB} {...line} strokeWidth={stroke * 0.7} />}
                </React.Fragment>
              ))}
            </g>
            {/* Передние ноги — самый толстый элемент опоры */}
            {sec.panels.map((p, k) => (
              <React.Fragment key={`f${k}`}>
                <path d={p.legL} {...line} strokeWidth={legW} />
                <path d={p.legR} {...line} strokeWidth={legW} />
                <path d={p.beam} {...line} strokeWidth={stroke} opacity={0.85} />
                <path d={p.braceA} {...line} strokeWidth={stroke * 0.85} opacity={0.6} />
                <path d={p.braceB} {...line} strokeWidth={stroke * 0.85} opacity={0.6} />
              </React.Fragment>
            ))}
          </>
        ));
      })}

      {/* Лестница на всю высоту */}
      {ladder && wrap('ladder', complete, 0.085 * sections, (
        <g opacity={0.5}>
          {ladder.rails.map((d, k) => <path key={k} d={d} {...line} strokeWidth={stroke * 0.7} />)}
          {ladder.rungs.map((d, k) => <path key={k} d={d} {...line} strokeWidth={stroke * 0.55} />)}
        </g>
      ))}

      {/* Площадка обслуживания с ограждением */}
      {wrap('deck', complete, 0.085 * sections + 0.05, (
        <g>
          <path d={`M ${CX - 32} 0 L ${CX + 32} 0`} {...line} strokeWidth={legW} />
          <path d={`M ${CX - 32} -9 L ${CX + 32} -9`} {...line} strokeWidth={stroke * 0.6} opacity={0.7} />
          {[-32, -16, 0, 16, 32].map((dx) => (
            <path key={dx} d={`M ${CX + dx} 0 L ${CX + dx} -9`} {...line} strokeWidth={stroke * 0.6} opacity={0.7} />
          ))}
        </g>
      ))}

      {/* Три секторные антенны на траверсе */}
      {wrap('ant', complete, 0.085 * sections + 0.12, (
        <g>
          <path d={`M ${CX - 26} -22 L ${CX + 26} -22`} {...line} strokeWidth={stroke * 0.8} opacity={0.75} />
          {[-24, 0, 24].map((dx) => (
            <rect key={dx} x={CX + dx - 4.5} y={-40} width={9} height={30} rx={3.5}
              fill="currentColor" opacity={0.9} />
          ))}
          {fine && (
            <g opacity={0.75}>
              {/* Радиорелейная тарелка — её ставят почти на каждую БС */}
              <path d={`M ${CX + 26} -22 L ${CX + 36} -28`} {...line} strokeWidth={stroke * 0.7} />
              <circle cx={CX + 42} cy={-31} r={10} fill="currentColor" opacity={0.55} />
              <circle cx={CX + 42} cy={-31} r={10} {...line} strokeWidth={stroke * 0.6} />
            </g>
          )}
        </g>
      ))}

      {/* Блик по решётке: раз в несколько секунд по мачте проходит отсвет,
          как солнце по оцинковке. Только на крупных — на 100 px его не видно */}
      {fine && complete && !reduced && (
        <g className="mast-sweep" style={{ mixBlendMode: 'screen' }}>
          <rect x={CX - W_BOTTOM / 2 - 10} y={0} width={W_BOTTOM + 20} height={H}
            fill="url(#mast-sweep-grad)" />
        </g>
      )}
      <defs>
        <linearGradient id="mast-sweep-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
          <stop offset="50%" stopColor="currentColor" stopOpacity="0.9" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Сигнал: от антенн расходятся волны — базовая станция работает.
          Это и есть смысл мачты, поэтому знак системы должен «передавать»,
          а не просто стоять (02.09.2026) */}
      {signal && complete && !reduced && [0, 1, 2].map((k) => (
        <circle
          key={k}
          className="mast-signal"
          cx={CX} cy={-22} r={26}
          fill="none" stroke="currentColor" strokeWidth={stroke * 0.8}
          style={{ animationDelay: `${k * 1.4}s` }}
        />
      ))}

      {/* Авиационный огонь: загорается, когда мачта собрана */}
      {beacon && (
        <g className={complete && !reduced ? 'mast-beacon' : undefined}>
          <path d={`M ${CX} -40 L ${CX} -58`} {...line} strokeWidth={stroke * 0.7} opacity={0.6} />
          <circle cx={CX} cy={-63} r={5} className="mast-beacon__dot" />
          <circle cx={CX} cy={-63} r={13} className="mast-beacon__halo" />
        </g>
      )}
    </svg>
  );
}

/**
 * Пустое состояние и ожидание: вместо крутящегося кружка — мачта, которая
 * собирается. Ждать приходится одинаково, а смотреть — приятнее.
 */
/**
 * Пустое состояние списка — и ОТДЕЛЬНО состояние отказа (04.09.2026).
 *
 * До этого отказ был неотличим от «всё хорошо». При падении запроса
 * isLoading становится false, data — undefined, total — ноль, и мастеру
 * в цеху показывалось «Всё изготовлено». Он решал, что работа кончилась,
 * и уходил. Пустой список и упавший запрос — разные вещи, и человек
 * обязан их различать: в первом случае делать нечего, во втором нужно
 * повторить или позвать администратора.
 *
 * Мачта в состоянии отказа не рисуется: знак завода — про порядок, а не
 * про поломку.
 */
export function MastLoader({
  title, hint, height = 168, sections = 6, error, onRetry,
}: {
  title: string;
  hint?: string;
  height?: number;
  sections?: number;
  /** Запрос упал: показываем отказ вместо пустого состояния */
  error?: unknown;
  /** Повторить запрос — кнопка появляется, только если есть чем повторять */
  onRetry?: () => void;
}) {
  if (error) {
    return (
      <div className="mast-empty" role="alert">
        <IconAlertTriangle size={32} aria-hidden className="mast-empty__icon" />
        <div className="mast-empty__title">{apiErrorTitle(error)}</div>
        <div className="mast-empty__hint">{apiErrorMessage(error)}</div>
        {onRetry && (
          <Button variant="default" size="sm" mt="sm"
            leftSection={<IconRefresh size={16} aria-hidden />} onClick={onRetry}>
            Повторить
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="mast-empty">
      <Mast height={height} sections={sections} />
      <div className="mast-empty__title">{title}</div>
      {hint && <div className="mast-empty__hint">{hint}</div>}
    </div>
  );
}
