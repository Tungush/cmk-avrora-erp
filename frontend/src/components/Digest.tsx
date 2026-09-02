import React from 'react';
import { Skeleton, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { FadeRise, AnimatedNumber } from './motion';

/**
 * Сводка решений — то, чем экран начинается вместо списка (02.09.2026,
 * требование владельца: «я не хочу, чтобы сервис был как просто база
 * данных, нужен смарт-фронт, который уберёт все эти списки»).
 *
 * Карточка отвечает на вопрос, а не показывает строки: крупное число,
 * три-четыре конкретных виновника с долей от целого и одна кнопка
 * действия. Полный список никуда не делся — он за кнопкой «Все записи»,
 * для тех случаев, когда человек ищет конкретную строку.
 *
 * Доля рисуется полосой под именем: глазом видно, что три клиента дают
 * 80 % долга, — по таблице из 200 строк это не читается вовсе.
 */

export type DigestTone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger';

export interface DigestItem {
  id: string;
  /** Кто/что: клиент, материал, заказ */
  label: string;
  /** Пояснение мелким шрифтом */
  sub?: string;
  /** Правая колонка: сумма, количество, срок */
  value: string;
  /** 0…1 — доля от целого, рисуется полосой */
  share?: number;
  onClick?: () => void;
}

export interface DigestCardProps {
  title: string;
  /**
   * Крупное число под заголовком. Если передать число, а не строку, оно
   * доедет до значения пружиной — счётчик читается как «живой», и глаз
   * сам цепляется за карточку, где цифра изменилась.
   */
  value: React.ReactNode;
  /** Формат для числового value: разделители, ₸, проценты */
  format?: (n: number) => string;
  /** Подпись под числом: «₸ по 34 заказам» */
  caption?: string;
  tone?: DigestTone;
  icon?: React.ReactNode;
  items?: DigestItem[];
  /** Что показать, когда список пуст, — это тоже ответ */
  emptyText?: string;
  action?: { label: string; onClick: () => void };
  loading?: boolean;
}

export function DigestGrid({ children }: { children: React.ReactNode }) {
  return <FadeRise><div className="digest-grid">{children}</div></FadeRise>;
}

export function DigestCard({
  title, value, caption, tone = 'neutral', icon, items, emptyText, action, loading, format,
}: DigestCardProps) {
  if (loading) return <Skeleton height={230} radius="lg" />;

  const list = items ?? [];
  const shown = typeof value === 'number'
    ? <AnimatedNumber value={value} format={format} />
    : value;

  return (
    <section className="digest-card glass-lit" data-tone={tone}>
      <header className="digest-card__head">
        {icon && <span className="kpi-icon">{icon}</span>}
        <div style={{ minWidth: 0 }}>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase"
            style={{ letterSpacing: '0.07em', lineHeight: 1.3 }}>
            {title}
          </Text>
          <div className="digest-card__value">{shown}</div>
          {caption && <Text size="xs" c="dimmed" lineClamp={1}>{caption}</Text>}
        </div>
      </header>

      <div className="digest-card__body">
        {list.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="sm">{emptyText ?? 'Ничего не требует внимания'}</Text>
        ) : list.map((it) => (
          <button
            key={it.id}
            type="button"
            className="digest-item"
            onClick={it.onClick}
            disabled={!it.onClick}
          >
            <span className="digest-item__label" title={it.label}>{it.label}</span>
            <span className="digest-item__value">{it.value}</span>
            {it.sub && <span className="digest-item__sub">{it.sub}</span>}
            {it.share != null && (
              <span className="digest-item__bar">
                <i style={{ width: `${Math.max(2, Math.min(100, it.share * 100))}%` }} />
              </span>
            )}
          </button>
        ))}
      </div>

      {action && (
        <button type="button" className="digest-card__action" onClick={action.onClick}>
          {action.label}
          <IconArrowRight size={15} />
        </button>
      )}
    </section>
  );
}
