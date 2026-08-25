import React, { useState } from 'react';
import { Tabs } from '@mantine/core';
import { SpreadsheetTable } from '../../components/SpreadsheetTable';
import { useSpreadsheetRows } from '../../hooks/useSpreadsheet';
import {
  IconFileInvoice,
  IconReceiptTax,
  IconCashBanknote,
  IconScale,
} from '@tabler/icons-react';
import { Reconciliation } from './Reconciliation';

const FINANCE_SHEETS = [
  { id: '19.20-7п', label: '19.20-7п', icon: IconFileInvoice },
  { id: 'реестр АПП по заказчикам', label: 'Реестр АПП', icon: IconReceiptTax },
  { id: 'приходы др проектам', label: 'Приходы др. проектам', icon: IconCashBanknote },
] as const;

export function Finance() {
  const [activeSheet, setActiveSheet] = useState<string>('reconciliation');
  const [page, setPage] = useState(1);
  const isSheetTab = activeSheet !== 'reconciliation';
  const { data, isLoading } = useSpreadsheetRows(isSheetTab ? activeSheet : '', { page, pageSize: 100 });

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
        <Tabs.Tab value="reconciliation" leftSection={<IconScale size={16} />} py="md">
          Сверка «заказ ↔ ДО»
        </Tabs.Tab>
        {FINANCE_SHEETS.map((s) => {
          const Icon = s.icon;
          return (
            <Tabs.Tab key={s.id} value={s.id} leftSection={<Icon size={16} />} py="md">
              {s.label}
            </Tabs.Tab>
          );
        })}
      </Tabs.List>

      <Tabs.Panel value="reconciliation">
        <Reconciliation />
      </Tabs.Panel>

      {FINANCE_SHEETS.map((s) => (
        <Tabs.Panel key={s.id} value={s.id}>
          <SpreadsheetTable
            sheetName={activeSheet}
            title={`Финансы — ${activeSheet}`}
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
