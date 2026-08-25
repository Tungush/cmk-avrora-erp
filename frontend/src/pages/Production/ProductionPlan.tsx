import React from 'react';
import { Stack, Text } from '@mantine/core';
import { WeeklyPlan } from './WeeklyPlan';

export function ProductionPlan() {
  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={900} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.02em', lineHeight: 1.15 }}>
          Производственный план
        </Text>
        <Text size="sm" c="dimmed">Раскладка по неделям вместо 110 столбцов вправо</Text>
      </Stack>

      <WeeklyPlan />
    </Stack>
  );
}
