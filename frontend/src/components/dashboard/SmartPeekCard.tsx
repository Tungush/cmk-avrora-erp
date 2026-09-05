import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Popover } from '@mantine/core';

/**
 * Peek-карточка (05.09.2026). Гибрид, а не «наведение».
 *
 * Два режима одной карточки:
 *   • наведение / фокус → всплывашка БЕЗ интерактива: 3–4 цифры и
 *     микрографик. Carbon DS прямо запрещает кнопки внутри тултипа —
 *     он не получает фокус и недоступен части людей;
 *   • клик / Enter / тап → та же всплывашка, но закреплённая и С
 *     действиями. Это единственный путь для планшета в цеху:
 *     наведения там нет. `pinnable={false}` выключает закрепление —
 *     для карточек-показателей, где нажатие делает другое (раскрывает
 *     секцию), а всплывашка только подсказывает.
 *
 * Тайминги — из Polaris (Shopify) и разбора Master.dev: открытие через
 * 200 мс удержания (ниже 150 срабатывает случайное прохождение, выше
 * 250 намеренное наведение кажется сломанным), закрытие через 150.
 * После закрытия любой карточки — «тёплое окно» 300 мс: следующая
 * открывается без задержки. Так директор пробегает ряд карточек, не
 * ожидая по 200 мс на каждой.
 *
 * Один Popover на оба режима, а не HoverCard внутри Popover: у
 * вложенных Target теряется ref (HoverCard не прокидывает его), и
 * всплывашка вставала в угол 0,0.
 */

const WarmCtx = createContext<{ warm: () => boolean; touch: () => void }>({ warm: () => false, touch: () => {} });

/** Обёртка ленты карточек: делит «тёплое окно» между всеми peek внутри */
export function PeekWarmProvider({ children }: { children: React.ReactNode }) {
  const until = useRef(0);
  const value = useRef({
    warm: () => Date.now() < until.current,
    touch: () => { until.current = Date.now() + 300; },
  }).current;
  return <WarmCtx.Provider value={value}>{children}</WarmCtx.Provider>;
}

export function SmartPeekCard({
  target, peek, actions, width = 300, disabled, pinnable = true,
}: {
  /** Элемент, на который наводят или нажимают */
  target: React.ReactElement;
  /** Содержимое карточки: цифры, микрографик — БЕЗ кнопок */
  peek: React.ReactNode;
  /** Быстрые действия — показываются только в закреплённом режиме */
  actions?: React.ReactNode;
  width?: number;
  disabled?: boolean;
  /** Клик закрепляет всплывашку. false — только подсказка по наведению */
  pinnable?: boolean;
}) {
  const { warm, touch } = useContext(WarmCtx);
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const openT = useRef<number | undefined>(undefined);
  const closeT = useRef<number | undefined>(undefined);

  const clear = useCallback(() => { window.clearTimeout(openT.current); window.clearTimeout(closeT.current); }, []);
  const enter = useCallback(() => {
    clear();
    openT.current = window.setTimeout(() => setHover(true), warm() ? 0 : 200);
  }, [clear, warm]);
  const leave = useCallback(() => {
    clear();
    closeT.current = window.setTimeout(() => { setHover(false); touch(); }, 150);
  }, [clear, touch]);
  useEffect(() => clear, [clear]);

  if (disabled) return target;

  const opened = pinned || hover;
  const togglePin = () => { clear(); setHover(false); setPinned((v) => !v); if (pinned) touch(); };

  return (
    <Popover
      opened={opened}
      onChange={(o) => { if (!o) { setPinned(false); setHover(false); touch(); } }}
      width={width}
      position="bottom-start"
      shadow="md"
      radius="lg"
      withArrow
      trapFocus={pinned}
      returnFocus={pinned}
      closeOnEscape
      closeOnClickOutside={pinned}
    >
      <Popover.Target>
        <span
          className="peek__target"
          data-pinned={pinned ? 'true' : undefined}
          onMouseEnter={enter} onMouseLeave={leave}
          onFocus={enter} onBlur={leave}
          onClick={pinnable ? (e) => { e.stopPropagation(); togglePin(); } : undefined}
          onKeyDown={pinnable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); togglePin(); } } : undefined}
          role={pinnable ? 'button' : undefined}
          tabIndex={pinnable ? 0 : undefined}
          aria-expanded={pinnable ? pinned : undefined}
        >
          {target}
        </span>
      </Popover.Target>
      <Popover.Dropdown
        className={pinned ? 'peek peek--pinned' : 'peek peek--hover'}
        onMouseEnter={pinned ? undefined : clear}
        onMouseLeave={pinned ? undefined : leave}
      >
        {peek}
        {pinned
          ? (actions && <div className="peek__actions">{actions}</div>)
          : (pinnable && <div className="peek__hint">нажмите — действия</div>)}
      </Popover.Dropdown>
    </Popover>
  );
}

/** Строка «подпись → значение» внутри peek */
export function PeekRow({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="peek__row" data-tone={tone}>
      <span className="peek__label">{label}</span>
      <span className="peek__value">{value}</span>
    </div>
  );
}
