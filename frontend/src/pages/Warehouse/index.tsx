import React from 'react';
import { Tabs, Stack, Text } from '@mantine/core';
import {
  IconGavel,
  IconBoxSeam,
  IconTruckDelivery,
} from '@tabler/icons-react';
import { MaterialsStock } from './MaterialsStock';
import { MaterialReceipts } from './MaterialReceipts';
import { BatchesReserves } from './BatchesReserves';
import { useSearchParams } from 'react-router-dom';

export function Warehouse() {
  // Вкладка живёт в адресе: ссылки «Требует решения» с экрана директора
  // ведут прямо в «Партии и резервы», а не на первую попавшуюся вкладку
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'stock';
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
          База сырья с ценами закупа — отсюда берётся себестоимость в спецификациях
        </Text>
      </Stack>

      <Tabs value={tab} onChange={(v) => setTab(v ?? 'stock')} radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="stock" leftSection={<IconBoxSeam size={15} />}>База сырья</Tabs.Tab>
          <Tabs.Tab value="batches" leftSection={<IconGavel size={15} />}>Партии и резервы</Tabs.Tab>
          <Tabs.Tab value="receipts" leftSection={<IconTruckDelivery size={15} />}>Приход материалов</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="stock"><MaterialsStock /></Tabs.Panel>
        <Tabs.Panel value="batches"><BatchesReserves /></Tabs.Panel>
        <Tabs.Panel value="receipts"><MaterialReceipts /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
