import React, { useState, useMemo } from 'react';
import { Tabs, Stack, Text } from '@mantine/core';
import { IconCalendarWeek, IconFileSpreadsheet } from '@tabler/icons-react';
import { SpreadsheetTable } from '../../components/SpreadsheetTable';
import { useSpreadsheetRows } from '../../hooks/useSpreadsheet';
import { WeeklyPlan } from './WeeklyPlan';

const SHEET_NAME = 'План';

function PlanSheet() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useSpreadsheetRows(SHEET_NAME, { page, pageSize: 100 });

  const headers = useMemo(() => (data?.sheet?.headers as string[]) || [], [data]);
  const rows = useMemo(() => data?.data || [], [data]);

  return (
    <SpreadsheetTable
      sheetName={SHEET_NAME}
      title="Лист «План» (Excel-архив)"
      subtitle="Полная копия из Google Sheets — все 110 столбцов"
      headers={headers}
      rows={rows}
      meta={data?.meta}
      isLoading={isLoading}
      onPageChange={setPage}
    />
  );
}

export function ProductionPlan() {
  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={900} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.02em', lineHeight: 1.15 }}>
          Производственный план
        </Text>
        <Text size="sm" c="dimmed">Раскладка по неделям вместо 110 столбцов вправо</Text>
      </Stack>

      <Tabs defaultValue="weekly" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="weekly" leftSection={<IconCalendarWeek size={15} />}>По неделям</Tabs.Tab>
          <Tabs.Tab value="sheet" leftSection={<IconFileSpreadsheet size={15} />}>Лист «План»</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="weekly"><WeeklyPlan /></Tabs.Panel>
        <Tabs.Panel value="sheet"><PlanSheet /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
