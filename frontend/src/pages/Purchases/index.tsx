import React, { useState } from 'react';
import { Tabs, Text, Group } from '@mantine/core';
import { IconChartBar, IconFileInvoice, IconShoppingCartPlus, IconLayoutGrid } from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { SectionHead } from '../../components/SectionHeader';
import { PurchasesDashboard } from './PurchasesDashboard';
import { PurchasesRegistry } from './PurchasesRegistry';
import { PurchaseQueue } from './PurchaseQueue';
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
  const tab = params.get('tab') ?? 'registry';
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

  /* Название и вкладки — одной строкой (04.09.2026): вкладки стояли
     отдельным рядом под названием и отнимали высоту у данных. */
  const header = (
    <SectionHead
      title="Закупки"
      subtitle="заказы поставщику из 1С — что заказано, что пришло, кому и сколько должны"
      value={tab}
      onChange={setTab}
      tabs={[
        { value: 'dashboard', label: 'Разрезы', icon: <IconChartBar aria-hidden size={16} /> },
        { value: 'registry', label: 'Все заказы поставщику', icon: <IconFileInvoice aria-hidden size={16} /> },
        { value: 'queue', label: 'На закуп', icon: <IconShoppingCartPlus aria-hidden size={16} /> },
      ]}
    />
  );

  return (
    <FitScreen header={header}>

      <Tabs
        value={tab}
        onChange={(v) => setTab(v ?? 'registry')}
        radius="md"
        keepMounted={false}
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        {/* Сводка влезает в экран целиком; разрезы и реестры длиннее —
            они прокручиваются ВНУТРИ панели, страница остаётся неподвижной */}
        <div className="section-body">
        <FadeSwap swapKey={tab}>
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
