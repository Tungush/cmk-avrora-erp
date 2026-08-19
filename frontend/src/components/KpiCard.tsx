import React from 'react';
import { Card, Text, Group, Stack, ThemeIcon, Box } from '@mantine/core';
import { IconTrendingUp, IconTrendingDown } from '@tabler/icons-react';

interface KpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: React.ReactNode;
  trend?: { value: number; label: string };
}

export function KpiCard({ title, value, subtitle, icon, trend }: KpiCardProps) {
  const isPositive = trend ? trend.value >= 0 : true;

  return (
    <Card padding="lg" radius="lg" h="100%" withBorder>
      <Stack gap="md" justify="space-between" h="100%">
        <Group justify="space-between" align="flex-start">
          <Stack gap={4}>
            <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
              {title}
            </Text>
            <Text fw={800} ff="'Manrope Variable', sans-serif" style={{ fontSize: 30, lineHeight: 1.05, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
              {value}
            </Text>
          </Stack>
          {icon && (
            <ThemeIcon variant="light" color="brand" size={44} radius="md">
              {icon}
            </ThemeIcon>
          )}
        </Group>

        {(subtitle || trend) && (
          <Group gap="xs" align="center" pt="sm" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
            {trend && (
              <ThemeIcon
                variant="light"
                color={isPositive ? 'success' : 'danger'}
                size="sm"
                radius="xl"
                px="xs"
                style={{ width: 'auto', gap: 4 }}
              >
                {isPositive ? <IconTrendingUp size={12} /> : <IconTrendingDown size={12} />}
                <Text size="xs" fw={800} component="span">
                  {isPositive ? '+' : ''}{trend.value}%
                </Text>
              </ThemeIcon>
            )}
            <Text size="xs" c="dimmed" fw={500} lineClamp={1}>
              {subtitle || trend?.label}
            </Text>
          </Group>
        )}
      </Stack>
    </Card>
  );
}
