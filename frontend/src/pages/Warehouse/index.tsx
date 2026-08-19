import React, { useState } from 'react';
import { Tabs, Stack, Text } from '@mantine/core';
import { SpreadsheetTable } from '../../components/SpreadsheetTable';
import { useSpreadsheetRows } from '../../hooks/useSpreadsheet';
import {
  IconBoxSeam,
  IconTruckDelivery,
  IconAlertSquare,
  IconLayoutDashboard,
  IconFileSpreadsheet,
} from '@tabler/icons-react';
import { MaterialsStock } from './MaterialsStock';
import { MaterialReceipts } from './MaterialReceipts';

/** Excel-архив: исходные листы как есть — для сверки с оригиналом */
const WAREHOUSE_SHEETS = [
  { id: 'Склад ТМЦ (импорт)', label: 'Склад ТМЦ', icon: IconBoxSeam },
  { id: 'Приход ГП', label: 'Приход ГП', icon: IconTruckDelivery },
  { id: 'Минимальные остатки', label: 'Мин. остатки', icon: IconAlertSquare },
  { id: 'Сводная по ГП', label: 'Сводная по ГП', icon: IconLayoutDashboard },
] as const;

function ExcelArchive() {
  const [activeSheet, setActiveSheet] = useState<string>('Склад ТМЦ (импорт)');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useSpreadsheetRows(activeSheet, { page, pageSize: 100 });

  return (
    <Tabs
      value={activeSheet}
      onChange={(value) => {
        if (value) {
          setActiveSheet(value);
          setPage(1);
        }
      }}
      variant="pills"
      radius="md"
      keepMounted={false}
    >
      <Tabs.List mb="md" style={{ flexWrap: 'wrap' }}>
        {WAREHOUSE_SHEETS.map((s) => {
          const Icon = s.icon;
          return (
            <Tabs.Tab key={s.id} value={s.id} leftSection={<Icon size={15} />}>
              {s.label}
            </Tabs.Tab>
          );
        })}
      </Tabs.List>

      {WAREHOUSE_SHEETS.map((s) => (
        <Tabs.Panel key={s.id} value={s.id}>
          <SpreadsheetTable
            sheetName={activeSheet}
            title={`Excel-архив — ${activeSheet}`}
            headers={(data?.sheet?.headers as string[]) || []}
            rows={data?.data || []}
            meta={data?.meta}
            isLoading={isLoading}
            onPageChange={setPage}
          />
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

export function Warehouse() {
  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={700} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.01em', lineHeight: 1.15 }}>
          Склад
        </Text>
        <Text size="sm" c="dimmed">
          База сырья с ценами закупа — отсюда берётся себестоимость в спецификациях
        </Text>
      </Stack>

      <Tabs defaultValue="stock" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="stock" leftSection={<IconBoxSeam size={15} />}>База сырья</Tabs.Tab>
          <Tabs.Tab value="receipts" leftSection={<IconTruckDelivery size={15} />}>Приход материалов</Tabs.Tab>
          <Tabs.Tab value="archive" leftSection={<IconFileSpreadsheet size={15} />}>Excel-архив</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="stock"><MaterialsStock /></Tabs.Panel>
        <Tabs.Panel value="receipts"><MaterialReceipts /></Tabs.Panel>
        <Tabs.Panel value="archive"><ExcelArchive /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
