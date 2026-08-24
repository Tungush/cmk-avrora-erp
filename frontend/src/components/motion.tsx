import React, { useEffect, useRef } from 'react';
import {
  motion, useReducedMotion, useSpring, useTransform, AnimatePresence,
} from 'framer-motion';

/**
 * Слой движения (решение 23.08.2026).
 *
 * Правила — как в хорошем железе Apple:
 *  - движение объясняет, откуда взялся элемент, а не украшает;
 *  - всё быстрое: вход 320 мс, отклик на нажатие 120 мс;
 *  - одна кривая на всю систему — пружина без дребезга;
 *  - уважение к prefers-reduced-motion: всё выключается одним флагом.
 */

/** Пружина системы: быстрая, плотная, без перелёта */
export const SPRING = { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 } as const;

/** Появление снизу с растворением — вход любого блока */
export function FadeRise({
  children, delay = 0, y = 10, style,
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  style?: React.CSSProperties;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div style={style}>{children}</div>;
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...SPRING, delay }}
      style={style}
    >
      {children}
    </motion.div>
  );
}

/**
 * Каскад для списков: карточки приходят одна за другой с шагом 35 мс.
 * Больше 12 элементов не каскадим — дальше это уже ожидание, а не эффект.
 */
export function Stagger({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const items = React.Children.toArray(children);
  if (reduced) return <>{children}</>;
  return (
    <>
      {items.map((child, i) => (
        <motion.div
          key={(child as any)?.key ?? i}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SPRING, delay: Math.min(i, 12) * 0.035 }}
        >
          {child}
        </motion.div>
      ))}
    </>
  );
}

/**
 * Число, которое доезжает до значения пружиной — для KPI.
 * Форматирование снаружи: компонент оперирует только числом.
 */
export function AnimatedNumber({
  value, format,
}: { value: number; format?: (n: number) => string }) {
  const reduced = useReducedMotion();
  const spring = useSpring(reduced ? value : 0, { stiffness: 90, damping: 24 });
  const display = useTransform(spring, (v) =>
    (format ?? ((n: number) => Math.round(n).toLocaleString('ru-RU')))(v),
  );
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => { spring.set(value); }, [value, spring]);
  useEffect(() => display.on('change', (v) => {
    if (ref.current) ref.current.textContent = v;
  }), [display]);

  return <span ref={ref}>{(format ?? String)(reduced ? value : 0)}</span>;
}

/** Раскрытие по высоте — для разворачивающихся карточек */
export function Collapse({ opened, children }: { opened: boolean; children: React.ReactNode }) {
  const reduced = useReducedMotion();
  if (reduced) return opened ? <>{children}</> : null;
  return (
    <AnimatePresence initial={false}>
      {opened && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ ...SPRING, opacity: { duration: 0.15 } }}
          style={{ overflow: 'hidden' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export { motion, AnimatePresence };
