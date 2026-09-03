import React, { useState } from 'react';
import { Tabs, Text, Group } from '@mantine/core';
import { IconChartBar, IconFileInvoice, IconShoppingCartPlus, IconLayoutGrid } from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { PurchasesDashboard } from './PurchasesDashboard';
import { PurchasesRegistry } from './PurchasesRegistry';
import { PurchaseQueue } from './PurchaseQueue';
import { PurchasesDigest } from './PurchasesDigest';
import { FitScreen } from '../../components/FitScreen';
import { TextReveal } from '../../components/motion';
import { FadeSwap } from '../../components/motion';

/**
 * «Закупки» — заказы поставщику из 1С (26.08.2026).
 * Раньше закуп жил осколками: 85 документов из 306 всплывали в журнале
 * приходов на складе, а остальные не были видны нигде.
 */
export function Purchases() {
  const [params, setParams] = useSearchParams();
  // Раздел открывается сводкой: три таблицы подряд заставляли прокручивать
  // экран, а ответ на «кому мы должны» был в самом низу (03.09.2026)
  const tab = params.get('tab') ?? 'digest';
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

  const header = (
    <Group gap="sm" wrap="nowrap" align="baseline" style={{ minWidth: 0 }}>
      <Text component="h1" className="page-title" style={{ fontSize: 26, lineHeight: 1.1, whiteSpace: 'nowrap', margin: 0 }}>
        <TextReveal text="Закупки" />
      </Text>
      <Text size="sm" c="dimmed" lineClamp={1}>
        заказы поставщику из 1С — что заказано, что пришло, кому и сколько должны
      </Text>
    </Group>
  );

  return (
    <FitScreen header={header}>

      <Tabs
        value={tab}
        onChange={(v) => setTab(v ?? 'digest')}
        radius="md"
        keepMounted={false}
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <Tabs.List mb="sm">
          <Tabs.Tab value="digest" leftSection={<IconLayoutGrid size={15} />}>Что требует решения</Tabs.Tab>
          <Tabs.Tab value="dashboard" leftSection={<IconChartBar size={15} />}>Разрезы</Tabs.Tab>
          <Tabs.Tab value="registry" leftSection={<IconFileInvoice size={15} />}>Все заказы поставщику</Tabs.Tab>
          <Tabs.Tab value="queue" leftSection={<IconShoppingCartPlus size={15} />}>На закуп</Tabs.Tab>
        </Tabs.List>

        {/* Сводка влезает в экран целиком; разрезы и реестры длиннее —
            они прокручиваются ВНУТРИ панели, страница остаётся неподвижной */}
        <div className="section-body">
        <FadeSwap swapKey={tab}>
          <Tabs.Panel value="digest">
            <PurchasesDigest onOpenRegistry={openRegistry} onGoTab={setTab} />
          </Tabs.Panel>
          <Tabs.Panel value="dashboard">
            <PurchasesDashboard onOpenRegistry={openRegistry} />
          </Tabs.Panel>
          <Tabs.Panel value="registry">
            <PurchasesRegistry filters={filters} onFiltersChange={setFilters} />
          </Tabs.Panel>
          <Tabs.Panel value="queue">
            <PurchaseQueue />
          </Tabs.Panel>
        </FadeSwap>
        </div>
      </Tabs>
    </FitScreen>
  );
}
