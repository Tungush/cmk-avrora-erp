import React from 'react';
import { Tabs, Text, Group } from '@mantine/core';
import {
  IconGavel,
  IconBoxSeam,
  IconTool,
  IconBuildingWarehouse,
  IconGauge,
  IconScissors,
  IconLayoutGrid,
} from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { MaterialsStock } from './MaterialsStock';
import { BatchesReserves } from './BatchesReserves';
import { FinishedGoodsStock } from './FinishedGoodsStock';
import { MinStock } from './MinStock';
import { Offcuts } from './Offcuts';
import { WarehouseDigest } from './WarehouseDigest';
import { FadeSwap } from '../../components/motion';
import { FitScreen } from '../../components/FitScreen';
import { TextReveal } from '../../components/motion';
import './Warehouse.css';

/** Обёртка сводки тянется на всю высоту — по ней меряется сетка карточек */
const FIT_PANE: React.CSSProperties = {
  flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column',
};

/** Склад сырья — то, из чего делают изделия */
const RAW = ['METAL', 'HARDWARE', 'COMPONENTS'];
/** Кладовая — расходники и инструмент, в изделие не входят */
const STOREROOM = ['CONSUMABLES', 'INSTRUMENTS'];

// «Сводка» — первая и по умолчанию: раздел открывается ответом, а не
// шестью реестрами (02.09.2026)
const TABS = ['digest', 'stock', 'storeroom', 'fg', 'batches', 'minstock', 'offcuts'] as const;
type TabKey = (typeof TABS)[number];

export function Warehouse() {
  // Вкладка живёт в адресе: ссылки «Требует решения» с экрана директора
  // ведут прямо в «Партии и резервы», а не на первую попавшуюся вкладку
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? 'digest';
  const tab: TabKey = (TABS as readonly string[]).includes(raw) ? (raw as TabKey) : 'stock';
  const setTab = (v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev); next.set('tab', v); return next;
  }, { replace: true });

  const header = (
    <Group gap="sm" wrap="nowrap" align="baseline" style={{ minWidth: 0 }}>
      <Text component="h1" className="page-title" style={{ fontSize: 26, lineHeight: 1.1, whiteSpace: 'nowrap', margin: 0 }}>
        <TextReveal text="Склад" />
      </Text>
      <Text size="sm" c="dimmed" lineClamp={1}>
        сырьё с ценами закупа — отсюда берётся себестоимость в спецификациях
      </Text>
    </Group>
  );

  return (
    <FitScreen header={header}>
      {/* Панели рисуем сами под списком вкладок: так смена вкладки
          анимируется одним FadeSwap, а не «мигает» при перемонтировании */}
      <Tabs value={tab} onChange={(v) => setTab(v ?? 'digest')} radius="md">
        <Tabs.List>
          <Tabs.Tab value="digest" leftSection={<IconLayoutGrid size={16} />}>Сводка</Tabs.Tab>
          <Tabs.Tab value="stock" leftSection={<IconBoxSeam size={16} />}>Склад сырья</Tabs.Tab>
          <Tabs.Tab value="storeroom" leftSection={<IconTool size={16} />}>Кладовая</Tabs.Tab>
          <Tabs.Tab value="fg" leftSection={<IconBuildingWarehouse size={16} />}>Склад ГП</Tabs.Tab>
          <Tabs.Tab value="batches" leftSection={<IconGavel size={16} />}>Партии и резервы</Tabs.Tab>
          <Tabs.Tab value="minstock" leftSection={<IconGauge size={16} />}>Мин. остатки</Tabs.Tab>
          <Tabs.Tab value="offcuts" leftSection={<IconScissors size={16} />}>Обрезки</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {/* Сводка обязана влезать целиком — у неё своя панель без прокрутки
          (иначе пятая карточка «Перехваты резерва» уезжала под край,
          03.09.2026). Реестрам прокрутка внутри панели по-прежнему нужна */}
      <div className={tab === 'digest' ? 'wh-pane' : 'section-body'}>
      <FadeSwap swapKey={tab} style={tab === 'digest' ? FIT_PANE : { minWidth: 0 }}>
        {tab === 'digest' && <WarehouseDigest onGoTab={setTab} />}
        {tab === 'stock' && <MaterialsStock only={RAW} pageKey="warehouse-stock" />}
        {tab === 'storeroom' && <MaterialsStock only={STOREROOM} pageKey="warehouse-storeroom" />}
        {tab === 'fg' && <FinishedGoodsStock />}
        {tab === 'batches' && <BatchesReserves />}
        {tab === 'minstock' && <MinStock />}
        {tab === 'offcuts' && <Offcuts />}
      </FadeSwap>
      </div>
    </FitScreen>
  );
}
