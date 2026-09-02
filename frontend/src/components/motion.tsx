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

/**
 * Движение можно выключить целиком: системная настройка prefers-reduced-motion
 * ИЛИ localStorage `ui-motion=off` (кнопка в шапке; так же снимаются
 * скриншоты в скрытой вкладке, где rAF не тикает и вход зависает на 0).
 */
export function useMotionOff(): boolean {
  const reduced = useReducedMotion();
  const [off, setOff] = React.useState(() => {
    // Вкладка открыта в фоне: rAF не тикает, анимация входа не проигрывается,
    // и блок навсегда остаётся с opacity 0 — пользователь видит пустоту.
    // В таком случае показываем всё сразу, без анимации.
    if (typeof document !== 'undefined' && document.hidden) return true;
    try { return localStorage.getItem('ui-motion') === 'off'; } catch { return false; }
  });
  useEffect(() => {
    const onChange = () => {
      try { setOff(localStorage.getItem('ui-motion') === 'off'); } catch { /* приватный режим */ }
    };
    window.addEventListener('ui-motion-change', onChange);
    window.addEventListener('storage', onChange);
    return () => { window.removeEventListener('ui-motion-change', onChange); window.removeEventListener('storage', onChange); };
  }, []);
  return !!reduced || off;
}

/** Появление снизу с растворением — вход любого блока */
export function FadeRise({
  children, delay = 0, y = 10, style,
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  style?: React.CSSProperties;
}) {
  const reduced = useMotionOff();
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
  const reduced = useMotionOff();
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
  const reduced = useMotionOff();
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
  const reduced = useMotionOff();
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

/**
 * Смена содержимого по ключу (страница пагинации, вкладка, фильтр):
 * старое растворяется, новое поднимается — пользователь видит, что
 * данные обновились, а не «мигнули».
 */
export function FadeSwap({
  swapKey, children, style,
}: { swapKey: React.Key; children: React.ReactNode; style?: React.CSSProperties }) {
  const reduced = useMotionOff();
  if (reduced) return <div style={style}>{children}</div>;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={String(swapKey)}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
        transition={{ ...SPRING, duration: 0.22 }}
        style={style}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

export { motion, AnimatePresence };

/**
 * Заголовок, который появляется словами (02.09.2026).
 *
 * Слова поднимаются с лёгким наклоном и разной задержкой — взгляд читает
 * заголовок в том же порядке, в каком он собирается. Анимация одна,
 * при первом появлении: на каждом переходе она бы раздражала.
 */
export function TextReveal({
  text, className, style, step = 0.055,
}: {
  text: string;
  className?: string;
  style?: React.CSSProperties;
  step?: number;
}) {
  const reduced = useMotionOff();
  if (reduced) return <span className={className} style={style}>{text}</span>;
  return (
    <span className={className} style={style}>
      {text.split(' ').map((word, i) => (
        <React.Fragment key={`${word}-${i}`}>
          <span className="reveal-word" style={{ animationDelay: `${i * step}s` }}>{word}</span>
          {i < text.split(' ').length - 1 ? ' ' : null}
        </React.Fragment>
      ))}
    </span>
  );
}
