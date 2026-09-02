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
export function PulseRow({ items, loading }: { items: PulseItem[]; loading?: boolean }) {
  if (loading) {
    return (
      <div className="pulse-row">
        {[...Array(4)].map((_, i) => <Skeleton key={i} height={92} radius="lg" />)}
      </div>
    );
  }
  return (
    <FadeRise>
      <div className="pulse-row">
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
              {it.hint && (
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
