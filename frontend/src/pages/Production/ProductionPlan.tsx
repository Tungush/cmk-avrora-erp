import React from 'react';
import { Stack, Text, Tabs } from '@mantine/core';
import { IconCalendarWeek, IconTable } from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { WeeklyPlan } from './WeeklyPlan';
import { PlanMatrix } from './PlanMatrix';

export function ProductionPlan() {
  // Вкладка в адресе — чтобы ссылки вели на конкретный разрез
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'matrix';
  const setTab = (v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev); next.set('tab', v); return next;
  }, { replace: true });

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={900} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.02em', lineHeight: 1.15 }}>
          Производственный план
        </Text>
        <Text size="sm" c="dimmed">План по изделиям и раскладка по неделям — вместо 110 столбцов вправо</Text>
      </Stack>

      <Tabs value={tab} onChange={(v) => setTab(v ?? 'matrix')} radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="matrix" leftSection={<IconTable size={15} />}>По изделиям</Tabs.Tab>
          <Tabs.Tab value="weekly" leftSection={<IconCalendarWeek size={15} />}>По неделям</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="matrix"><PlanMatrix /></Tabs.Panel>
        <Tabs.Panel value="weekly"><WeeklyPlan /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
