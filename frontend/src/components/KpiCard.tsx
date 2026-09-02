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
 * «37.5%» получает 34px, «8 689 933 104,74 ₸» — 22px и всё равно
 * остаётся одной строкой: рвать число переносом нельзя вообще,
 * «8 689 933 10 / 4,74» читается как два разных числа.
 */
function valueFontSize(v: string | number): number {
  const len = String(v).length;
  if (len <= 6) return 34;
  if (len <= 10) return 30;
  if (len <= 14) return 26;
  if (len <= 18) return 22;
  return 20;
}

/**
 * KPI-плитка в духе референса 02.09.2026: иконка в мягком квадрате,
 * крупное число, подпись серым под ним. Белая карточка без рамки.
 */
export function KpiCard({ title, value, subtitle, icon, trend }: KpiCardProps) {
  const isPositive = trend ? trend.value >= 0 : true;

  // Число доезжает до значения пружиной; строки («35% / 5 из 7») не анимируем —
  // промежуточные состояния текста читались бы как мусор
  const rendered = typeof value === 'number'
    ? <AnimatedNumber value={value} />
    : value;

  return (
    <Card padding="lg" radius="lg" h="100%" className="kpi-glow" style={{ minWidth: 0 }}>
      <Stack gap="md" justify="space-between" h="100%">
        <Group gap="sm" wrap="nowrap" align="center">
          {icon && <div className="kpi-icon" aria-hidden>{icon}</div>}
          <Text
            size="sm" fw={600} c="dimmed"
            style={{ lineHeight: 1.3, minWidth: 0 }}
            lineClamp={2}
          >
            {title}
          </Text>
        </Group>

        <Text className="kpi-value" style={{ fontSize: valueFontSize(value) }}>
          {rendered}
        </Text>

        <Group gap="xs" align="center" wrap="nowrap" style={{ minHeight: 24 }}>
          {trend && (
            <ThemeIcon
              variant="light"
              color={isPositive ? 'success' : 'danger'}
              size="md"
              radius="xl"
              px="xs"
              style={{ width: 'auto', gap: 4, flexShrink: 0 }}
            >
              {isPositive ? <IconTrendingUp size={14} /> : <IconTrendingDown size={14} />}
              <Text size="xs" fw={800} component="span">
                {isPositive ? '+' : ''}{trend.value}%
              </Text>
            </ThemeIcon>
          )}
          <Text size="sm" c="dimmed" fw={500} lineClamp={1}>
            {subtitle || trend?.label || ' '}
          </Text>
        </Group>
      </Stack>
    </Card>
  );
}
