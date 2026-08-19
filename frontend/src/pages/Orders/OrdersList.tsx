import React, { useState } from 'react';
import { Tabs, Stack, Text } from '@mantine/core';
import { IconTable, IconFileSpreadsheet, IconFolder, IconInfoCircle } from '@tabler/icons-react';
import { SpreadsheetTable } from '../../components/SpreadsheetTable';
import { useSpreadsheetRows } from '../../hooks/useSpreadsheet';
import { OrdersRegistry } from './OrdersRegistry';

/** Excel-архив: исходные листы как есть — для сверки с оригиналом при переходе */
const ORDER_SHEETS = [
  { id: 'Telecom', label: 'Telecom', description: 'Заказы Telecom — 66 столбцов', icon: IconFileSpreadsheet },
  { id: 'Др проекты', label: 'Др проекты', description: 'Прочие проекты — 141 столбец', icon: IconFolder },
  { id: 'Инфо3', label: 'Инфо3', description: 'Сводная информация — 39 столбцов', icon: IconInfoCircle },
] as const;

function ExcelArchive() {
  const [activeSheet, setActiveSheet] = useState<string>('Telecom');
  const [page, setPage] = useState(1);

  const current = ORDER_SHEETS.find((s) => s.id === activeSheet) || ORDER_SHEETS[0];
  const { data, isLoading } = useSpreadsheetRows(activeSheet, { page, pageSize: 100 });

  const headers = (data?.sheet?.headers as string[]) || [];
  const rows = data?.data || [];

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
        {ORDER_SHEETS.map((sheet) => {
          const Icon = sheet.icon;
          return (
            <Tabs.Tab key={sheet.id} value={sheet.id} leftSection={<Icon size={15} />}>
              {sheet.label}
            </Tabs.Tab>
          );
        })}
      </Tabs.List>

      {ORDER_SHEETS.map((sheet) => (
        <Tabs.Panel key={sheet.id} value={sheet.id}>
          <SpreadsheetTable
            sheetName={activeSheet}
            title={`Excel-архив — ${current.label}`}
            subtitle={current.description}
            headers={headers}
            rows={rows}
            meta={data?.meta}
            isLoading={isLoading}
            onPageChange={setPage}
          />
        </Tabs.Panel>
      ))}
    </Tabs>
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
