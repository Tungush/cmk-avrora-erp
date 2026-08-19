import React, { useState } from 'react';
import { Tabs } from '@mantine/core';
import { SpreadsheetTable } from '../../components/SpreadsheetTable';
import { useSpreadsheetRows } from '../../hooks/useSpreadsheet';
import {
  IconBox,
  IconTag,
  IconHistory,
  IconDatabase,
} from '@tabler/icons-react';

const CATALOG_SHEETS = [
  { id: 'Артикулы', label: 'Артикулы', icon: IconBox },
  { id: 'Прайс', label: 'Прайс', icon: IconTag },
  { id: 'Прайс 2024', label: 'Прайс 2024', icon: IconHistory },
  { id: 'База сырья', label: 'База сырья', icon: IconDatabase },
] as const;

export function Catalog() {
  const [activeSheet, setActiveSheet] = useState<string>('Артикулы');
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
      variant="outline"
      radius="md"
      keepMounted={false}
    >
      <Tabs.List mb="md" style={{ flexWrap: 'wrap' }}>
        {CATALOG_SHEETS.map((s) => {
          const Icon = s.icon;
          return (
            <Tabs.Tab key={s.id} value={s.id} leftSection={<Icon size={16} />} py="md">
              {s.label}
            </Tabs.Tab>
          );
        })}
      </Tabs.List>

      {CATALOG_SHEETS.map((s) => (
        <Tabs.Panel key={s.id} value={s.id}>
          <SpreadsheetTable
            sheetName={activeSheet}
            title={`Справочники — ${activeSheet}`}
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
