import React, { useState } from 'react';
import { Tabs, Stack, Text } from '@mantine/core';
import { IconChartBar, IconFileInvoice, IconShoppingCartPlus } from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { PurchasesDashboard } from './PurchasesDashboard';
import { PurchasesRegistry } from './PurchasesRegistry';
import { PurchaseQueue } from './PurchaseQueue';

/**
 * «Закупки» — заказы поставщику из 1С (26.08.2026).
 * Раньше закуп жил осколками: 85 документов из 306 всплывали в журнале
 * приходов на складе, а остальные не были видны нигде.
 */
export function Purchases() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'dashboard';
  const [filters, setFilters] = useState<Record<string, string>>({});

  const setTab = (v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev); next.set('tab', v); return next;
  }, { replace: true });

  // Клик по цифре на дашборде открывает реестр уже отфильтрованным —
  // иначе «212 ДО без утвердителя» остаётся числом, с которым нечего делать
  const openRegistry = (f: Record<string, string>) => {
    setFilters(f);
    setTab('registry');
  };

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={700} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.01em', lineHeight: 1.15 }}>
          Закупки
        </Text>
        <Text size="sm" c="dimmed">
          Заказы поставщику из 1С — что заказано, что пришло, кому и сколько должны
        </Text>
      </Stack>

      <Tabs value={tab} onChange={(v) => setTab(v ?? 'dashboard')} radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="dashboard" leftSection={<IconChartBar size={15} />}>Дашборд</Tabs.Tab>
          <Tabs.Tab value="registry" leftSection={<IconFileInvoice size={15} />}>Все заказы поставщику</Tabs.Tab>
          <Tabs.Tab value="queue" leftSection={<IconShoppingCartPlus size={15} />}>На закуп</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="dashboard">
          <PurchasesDashboard onOpenRegistry={openRegistry} />
        </Tabs.Panel>
        <Tabs.Panel value="registry">
          <PurchasesRegistry filters={filters} onFiltersChange={setFilters} />
        </Tabs.Panel>
        <Tabs.Panel value="queue">
          <PurchaseQueue />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
