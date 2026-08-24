import React from 'react';
import { Card, Text, Group, Stack, ThemeIcon } from '@mantine/core';
import { IconTrendingUp, IconTrendingDown } from '@tabler/icons-react';
import { AnimatedNumber } from './motion';

interface KpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: React.ReactNode;
  trend?: { value: number; label: string };
}

/**
 * Размер цифры подбирается под её длину, а не наоборот.
 * «37.5%» получает 30px, «8 689 933 104,74 ₸» — 20px и всё равно
 * остаётся одной строкой: рвать число переносом нельзя вообще,
 * «8 689 933 10 / 4,74» читается как два разных числа.
 */
function valueFontSize(v: string | number): number {
  const len = String(v).length;
  if (len <= 8) return 30;
  if (len <= 12) return 26;
  if (len <= 16) return 22;
  return 19;
}

export function KpiCard({ title, value, subtitle, icon, trend }: KpiCardProps) {
  const isPositive = trend ? trend.value >= 0 : true;

  // Число доезжает до значения пружиной; строки («35% / 5 из 7») не анимируем —
  // промежуточные состояния текста читались бы как мусор
  const rendered = typeof value === 'number'
    ? <AnimatedNumber value={value} />
    : value;

  return (
    <Card padding="lg" radius="lg" h="100%" withBorder className="kpi-glow">
      {/* Жёсткая сетка: шапка → значение → подвал, прижатый к низу.
          Раньше шапка была Group с переносом: широкое значение сталкивало
          иконку вниз, и в ряду из четырёх карточек иконки оказывались
          на четырёх разных местах — тот самый «разброс» */}
      <Stack gap={6} justify="space-between" h="100%">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
          <Text
            size="xs" fw={700} c="dimmed" tt="uppercase"
            style={{ letterSpacing: '0.08em', lineHeight: 1.35 }}
          >
            {title}
          </Text>
          {icon && (
            <ThemeIcon
              variant="gradient"
              gradient={{ from: 'brand.5', to: 'brand.7', deg: 135 }}
              size={40}
              radius="md"
              style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.25)', flexShrink: 0 }}
            >
              {icon}
            </ThemeIcon>
          )}
        </Group>

        <Text
          fw={800}
          style={{
            fontSize: valueFontSize(value),
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
            // Глобальный перенос «anywhere» рвал сумму внутри числа —
            // для значения он выключен явно
            overflowWrap: 'normal',
            wordBreak: 'keep-all',
            whiteSpace: 'nowrap',
          }}
        >
          {rendered}
        </Text>

        <Group
          gap="xs" align="center" wrap="nowrap" mt="auto" pt="sm"
          style={{ borderTop: '1px solid var(--mantine-color-default-border)', minHeight: 34 }}
        >
          {trend && (
            <ThemeIcon
              variant="light"
              color={isPositive ? 'success' : 'danger'}
              size="sm"
              radius="xl"
              px="xs"
              style={{ width: 'auto', gap: 4, flexShrink: 0 }}
            >
              {isPositive ? <IconTrendingUp size={12} /> : <IconTrendingDown size={12} />}
              <Text size="xs" fw={800} component="span">
                {isPositive ? '+' : ''}{trend.value}%
              </Text>
            </ThemeIcon>
          )}
          <Text size="xs" c="dimmed" fw={500} lineClamp={1}>
            {subtitle || trend?.label || ' '}
          </Text>
        </Group>
      </Stack>
    </Card>
  );
}
