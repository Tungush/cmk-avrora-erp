import React from 'react';
import { Tabs, Stack, Text } from '@mantine/core';
import {
  IconGavel,
  IconBoxSeam,
  IconTool,
  IconBuildingWarehouse,
  IconGauge,
  IconScissors,
} from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { MaterialsStock } from './MaterialsStock';
import { BatchesReserves } from './BatchesReserves';
import { FinishedGoodsStock } from './FinishedGoodsStock';
import { MinStock } from './MinStock';
import { Offcuts } from './Offcuts';
import { FadeSwap } from '../../components/motion';

/** Склад сырья — то, из чего делают изделия */
const RAW = ['METAL', 'HARDWARE', 'COMPONENTS'];
/** Кладовая — расходники и инструмент, в изделие не входят */
const STOREROOM = ['CONSUMABLES', 'INSTRUMENTS'];

const TABS = ['stock', 'storeroom', 'fg', 'batches', 'minstock', 'offcuts'] as const;
type TabKey = (typeof TABS)[number];

export function Warehouse() {
  // Вкладка живёт в адресе: ссылки «Требует решения» с экрана директора
  // ведут прямо в «Партии и резервы», а не на первую попавшуюся вкладку
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? 'stock';
  const tab: TabKey = (TABS as readonly string[]).includes(raw) ? (raw as TabKey) : 'stock';
  const setTab = (v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev); next.set('tab', v); return next;
  }, { replace: true });

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={700} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.01em', lineHeight: 1.15 }}>
          Склад
        </Text>
        <Text size="sm" c="dimmed">
          Сырьё с ценами закупа — отсюда берётся себестоимость в спецификациях
        </Text>
      </Stack>

      {/* Панели рисуем сами под списком вкладок: так смена вкладки
          анимируется одним FadeSwap, а не «мигает» при перемонтировании */}
      <Tabs value={tab} onChange={(v) => setTab(v ?? 'stock')} radius="md">
        <Tabs.List>
          <Tabs.Tab value="stock" leftSection={<IconBoxSeam size={16} />}>Склад сырья</Tabs.Tab>
          <Tabs.Tab value="storeroom" leftSection={<IconTool size={16} />}>Кладовая</Tabs.Tab>
          <Tabs.Tab value="fg" leftSection={<IconBuildingWarehouse size={16} />}>Склад ГП</Tabs.Tab>
          <Tabs.Tab value="batches" leftSection={<IconGavel size={16} />}>Партии и резервы</Tabs.Tab>
          <Tabs.Tab value="minstock" leftSection={<IconGauge size={16} />}>Мин. остатки</Tabs.Tab>
          <Tabs.Tab value="offcuts" leftSection={<IconScissors size={16} />}>Обрезки</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      <FadeSwap swapKey={tab} style={{ minWidth: 0 }}>
        {tab === 'stock' && <MaterialsStock only={RAW} pageKey="warehouse-stock" />}
        {tab === 'storeroom' && <MaterialsStock only={STOREROOM} pageKey="warehouse-storeroom" />}
        {tab === 'fg' && <FinishedGoodsStock />}
        {tab === 'batches' && <BatchesReserves />}
        {tab === 'minstock' && <MinStock />}
        {tab === 'offcuts' && <Offcuts />}
      </FadeSwap>
    </Stack>
  );
}
