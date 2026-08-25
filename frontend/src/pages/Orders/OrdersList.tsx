import React, { useState } from 'react';
import { Tabs, Stack, Text, Select, Group } from '@mantine/core';
import { IconTable, IconFileSpreadsheet } from '@tabler/icons-react';
import { SpreadsheetTable } from '../../components/SpreadsheetTable';
import { useSpreadsheetRows, useSpreadsheetSheets } from '../../hooks/useSpreadsheet';
import { OrdersRegistry } from './OrdersRegistry';

function ExcelArchive() {
  const [activeSheet, setActiveSheet] = useState<string>('Telecom');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  const { data: sheetsResponse } = useSpreadsheetSheets();
  const sheets = (sheetsResponse?.data as Array<{ name: string; colCount: number; rowCount: number }>) || [];
  const sheetOptions = sheets.map((s) => ({
    value: s.name,
    label: `${s.name} — ${s.colCount} стб., ${s.rowCount.toLocaleString('ru-RU')} стр.`,
  }));

  const { data, isLoading } = useSpreadsheetRows(activeSheet, { page, pageSize: 100, search });

  const headers = (data?.sheet?.headers as string[]) || [];
  const rows = data?.data || [];

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Select
          label="Лист исходного файла (все, как есть в 2025_План Производства.xlsx)"
          data={sheetOptions}
          value={activeSheet}
          onChange={(value) => {
            if (value) {
              setActiveSheet(value);
              setPage(1);
              setSearch('');
            }
          }}
          searchable
          radius="md"
          style={{ minWidth: 340, maxWidth: '100%' }}
        />
      </Group>

      <SpreadsheetTable
        sheetName={activeSheet}
        title={`Excel-архив — ${activeSheet}`}
        headers={headers}
        rows={rows}
        meta={data?.meta}
        isLoading={isLoading}
        onPageChange={setPage}
        search={search}
        onSearchChange={(v) => {
          setSearch(v);
          setPage(1);
        }}
      />
    </Stack>
  );
}

export function OrdersList() {
  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={900} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.02em', lineHeight: 1.15 }}>
          Заказы
        </Text>
        <Text size="sm" c="dimmed">
          Реестр с пресетами колонок и карточкой по клику — вместо 66 столбцов вправо
        </Text>
      </Stack>

      <Tabs defaultValue="registry" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="registry" leftSection={<IconTable size={15} />}>Реестр</Tabs.Tab>
          <Tabs.Tab value="archive" leftSection={<IconFileSpreadsheet size={15} />}>Excel-архив</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="registry">
          <OrdersRegistry />
        </Tabs.Panel>
        <Tabs.Panel value="archive">
          <ExcelArchive />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
