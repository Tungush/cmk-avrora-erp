import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Collapse } from '@mantine/core';
import { IconChevronDown, IconArrowsMaximize, IconArrowsMinimize } from '@tabler/icons-react';

/**
 * Свёртываемая секция с итогом в заголовке и фокус-режимом (05.09.2026).
 *
 * Второй слой раскрытия (Smashing 09.2025, NN/g «Accordions on Desktop»):
 * второстепенное свёрнуто по умолчанию, но ИТОГ виден в заголовке —
 * директор не открывает секцию, чтобы узнать, есть ли там что-то.
 * Правила NN/g соблюдены буквально: соседние секции при открытии не
 * закрываются, состояние помнится на пользователя, есть «развернуть
 * всё».
 *
 * Фокус-режим — ЯВНЫЙ: кнопка в заголовке, двойной клик по нему или
 * клавиша [ (Linear, Datadog). Секция занимает всё тело экрана,
 * остальные уходят в тень. Авто-сворачивания «когда пользователь
 * сосредоточен» нет намеренно: содержимое, которое само двигается от
 * движения мыши, дезориентирует и нарушает «ничего не движется в покое».
 */

interface Ctx {
  focused: string | null;
  setFocused: (k: string | null) => void;
  open: Record<string, boolean>;
  toggle: (k: string, v?: boolean) => void;
}
const C = createContext<Ctx | null>(null);

const KEY = 'ui-sections';

export function AnalyticsStack({
  children, defaults, focusKey, onFocusChange,
}: {
  children: React.ReactNode;
  defaults: Record<string, boolean>;
  /** Управление снаружи: клик по кольцу или карточке раскрывает секцию */
  focusKey?: string | null;
  onFocusChange?: (k: string | null) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return defaults; }
  });
  const [focusedInner, setFocusedInner] = useState<string | null>(null);
  const focused = focusKey !== undefined ? focusKey : focusedInner;
  const setFocused = useCallback((k: string | null) => { setFocusedInner(k); onFocusChange?.(k); }, [onFocusChange]);

  const toggle = useCallback((k: string, v?: boolean) => {
    setOpen((o) => {
      const next = { ...o, [k]: v ?? !o[k] };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* приватный режим */ }
      return next;
    });
  }, []);

  // [ — фокус на секции под курсором/с фокусом; Esc или [ снова — выход
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      if (e.key === 'Escape' && focused) { setFocused(null); return; }
      if (e.key === '[') {
        if (focused) { setFocused(null); return; }
        const hovered = document.querySelector<HTMLElement>('.section:hover, .section:focus-within');
        const k = hovered?.dataset.section;
        if (k) { e.preventDefault(); setFocused(k); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  useEffect(() => { if (focused) toggle(focused, true); }, [focused, toggle]);

  const value = useMemo(() => ({ focused, setFocused, open, toggle }), [focused, setFocused, open, toggle]);

  return (
    <C.Provider value={value}>
      <div className="sections" data-focused={focused ? 'true' : undefined}>{children}</div>
    </C.Provider>
  );
}

export function CollapsibleAnalytics({
  id, title, summary, children, primary,
}: {
  id: string;
  title: string;
  /** Итог в заголовке: «6 позиций», «462,2 млн ₸» — виден и в свёрнутом виде */
  summary?: React.ReactNode;
  children: React.ReactNode;
  /** Смысловое ядро: открыто всегда, кнопки «свернуть» нет */
  primary?: boolean;
}) {
  const ctx = useContext(C);
  if (!ctx) throw new Error('CollapsibleAnalytics вне AnalyticsStack');
  const { focused, setFocused, open, toggle } = ctx;
  const isOpen = primary || open[id] !== false;
  const isFocused = focused === id;
  const dimmed = focused !== null && !isFocused;

  return (
    <section
      className="section"
      data-section={id}
      data-open={isOpen ? 'true' : undefined}
      data-focused={isFocused ? 'true' : undefined}
      data-dimmed={dimmed ? 'true' : undefined}
    >
      <header
        className="section__head"
        onDoubleClick={() => setFocused(isFocused ? null : id)}
      >
        {primary ? (
          <h2 className="section__title">{title}</h2>
        ) : (
          <button
            type="button"
            className="section__toggle"
            aria-expanded={isOpen}
            aria-controls={`section-${id}`}
            onClick={() => toggle(id)}
          >
            <IconChevronDown size={16} aria-hidden className="section__chev" />
            <h2 className="section__title">{title}</h2>
          </button>
        )}
        {summary && <div className="section__summary">{summary}</div>}
        <button
          type="button"
          className="section__focus"
          onClick={() => setFocused(isFocused ? null : id)}
          aria-label={isFocused ? 'Выйти из фокуса (Esc)' : 'Раскрыть на весь экран ([)'}
          title={isFocused ? 'Выйти из фокуса — Esc' : 'На весь экран — клавиша ['}
        >
          {isFocused ? <IconArrowsMinimize size={15} aria-hidden /> : <IconArrowsMaximize size={15} aria-hidden />}
        </button>
      </header>
      <Collapse expanded={isOpen} transitionDuration={180}>
        <div id={`section-${id}`} className="section__body">{children}</div>
      </Collapse>
    </section>
  );
}
