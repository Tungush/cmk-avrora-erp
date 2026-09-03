import React from 'react';
import { Box, Group, Skeleton, Stack, Text } from '@mantine/core';
import { FadeRise } from './motion';

/**
 * Шапка раздела и «пульс» — плитки с теми числами, ради которых человек
 * сюда зашёл (02.09.2026, запрос владельца: «чтобы я не видел длинные
 * списки, не искал и не терялся в данных»).
 *
 * Плитка — не украшение, а фильтр: клик по «Просрочено 12» показывает
 * эти двенадцать. Нужное достаётся одним касанием, список остаётся
 * внизу для тех, кто ищет глазами.
 */

export function PageHeader({
  eyebrow, title, subtitle, actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
      <Stack gap={2} style={{ minWidth: 0 }}>
        {eyebrow && (
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.1em' }}>
            {eyebrow}
          </Text>
        )}
        <Text
          component="h1"
          className="page-title"
          fw={900}
          style={{ fontSize: 'clamp(24px, 2.6vw, 34px)', lineHeight: 1.12, letterSpacing: '-0.025em', margin: 0 }}
        >
          {title}
        </Text>
        {subtitle && <Text size="sm" c="dimmed" mt={2}>{subtitle}</Text>}
      </Stack>
      {actions && <Group gap="sm" wrap="wrap">{actions}</Group>}
    </Group>
  );
}

export interface SectionTab {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

/**
 * Шапка раздела в ОДНУ строку: название, пояснение и вкладки (04.09.2026).
 *
 * До этого обвязка раздела занимала три уровня по вертикали: блок с
 * названием и пояснением, под ним вкладки «Реестр / Дашборд», под ними
 * ещё один переключатель «Что требует решения / Реестр · 384». Два
 * переключателя делали одну работу — выбирали, что показать, — и вместе
 * с блоком названия съедали 154 px до первой строки данных. В реестре из
 * 384 заказов на экран влезало шесть строк.
 *
 * Теперь это одна строка: название слева, вкладки справа. Пояснение
 * стоит рядом с названием, а не отдельной строкой под ним, — оно
 * прочитывается один раз и дальше только занимает место.
 *
 * Все виды раздела — равноправные вкладки одного ряда. Вложенных
 * переключателей больше нет: если вид один из трёх, он и должен
 * выбираться в одном месте.
 */
export function SectionHead({
  title, subtitle, tabs, value, onChange, actions,
}: {
  title: string;
  subtitle?: string;
  tabs?: SectionTab[];
  value?: string;
  onChange?: (v: string) => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="section-head">
      <div className="section-head__title">
        <Text component="h1" className="page-title" fw={900}
          style={{ fontSize: 'clamp(21px, 2.1vw, 26px)', lineHeight: 1.15, letterSpacing: '-0.025em', margin: 0 }}>
          {title}
        </Text>
        {subtitle && <Text size="sm" c="dimmed" className="section-head__sub">{subtitle}</Text>}
      </div>

      {tabs && tabs.length > 0 && (
        <div className="view-switch" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={value === t.value}
              data-active={value === t.value ? 'true' : undefined}
              onClick={() => onChange?.(t.value)}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      )}

      {actions && <Group gap="sm" wrap="nowrap" className="section-head__actions">{actions}</Group>}
    </div>
  );
}

export type PulseTone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger';

export interface PulseItem {
  key: string;
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: PulseTone;
  icon?: React.ReactNode;
  /** Клик по плитке = включить этот срез. Без него плитка просто цифра */
  onClick?: () => void;
  active?: boolean;
}

/**
 * Ряд плиток-срезов. Пустые (0) не прячем: «просроченных нет» — это
 * ответ на вопрос, а исчезнувшая плитка заставила бы искать заново.
 */
/**
 * @param compact Плитки как строка фильтров, а не как KPI-карточки.
 *
 * Нужен там, где плитки ПЕРЕКЛЮЧАЮТ список, а не отвечают на вопрос
 * «что происходит». В реестре заказов такая строка занимала 169 px при
 * таблице в 281 px: фильтр съедал больше половины того, что доставалось
 * данным, и из 384 заказов на экран влезало четыре строки. Фильтр не
 * должен выглядеть как карточка отчёта — в компактном виде это строка
 * пилюль «подпись + число» высотой 46 px (04.09.2026).
 */
export function PulseRow({ items, loading, compact }: { items: PulseItem[]; loading?: boolean; compact?: boolean }) {
  if (loading) {
    return (
      <div className="pulse-row" data-compact={compact ? 'true' : undefined}>
        {[...Array(4)].map((_, i) => <Skeleton key={i} height={compact ? 46 : 92} radius={compact ? 'xl' : 'lg'} />)}
      </div>
    );
  }
  return (
    <FadeRise>
      <div className="pulse-row" data-compact={compact ? 'true' : undefined}>
        {items.map((it) => {
          const clickable = !!it.onClick;
          return (
            <Box
              key={it.key}
              component={clickable ? 'button' : 'div'}
              type={clickable ? 'button' : undefined}
              onClick={it.onClick}
              className="pulse-tile glass-lit"
              data-tone={it.tone ?? 'neutral'}
              data-active={it.active ? 'true' : undefined}
              data-clickable={clickable ? 'true' : undefined}
              aria-pressed={clickable ? !!it.active : undefined}
            >
              <Group justify="space-between" wrap="nowrap" gap="xs" mb={6}>
                <Text size="xs" fw={700} c="dimmed" tt="uppercase"
                  style={{ letterSpacing: '0.07em', lineHeight: 1.25, textAlign: 'left' }}>
                  {it.label}
                </Text>
                {it.icon && <span className="pulse-tile__icon">{it.icon}</span>}
              </Group>
              <div className="pulse-tile__value">{it.value}</div>
              {/* Пояснение — только в полном виде. В компактной пилюле оно
                  не помещается: четыре пилюли с пояснениями переносятся на
                  вторую строку и съедают ещё 32 px у таблицы. Подпись рядом
                  с числом и так называет фильтр (04.09.2026). */}
              {it.hint && !compact && (
                <Text size="xs" c="dimmed" mt={4} lineClamp={1} style={{ textAlign: 'left' }}>
                  {it.hint}
                </Text>
              )}
            </Box>
          );
        })}
      </div>
    </FadeRise>
  );
}
