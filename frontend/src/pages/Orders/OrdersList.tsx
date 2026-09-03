import React from 'react';
import { Stack, Text, Tabs } from '@mantine/core';
import { IconTable, IconChartBar } from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { OrdersRegistry } from './OrdersRegistry';
import { OrdersDashboard } from './OrdersDashboard';
import { FadeSwap } from '../../components/motion';

export function OrdersList() {
  // Вкладка в адресе — ссылки с других экранов могут вести сразу на дашборд
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'registry';
  const setTab = (v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev); next.set('tab', v); return next;
  }, { replace: true });

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={900} style={{ fontSize: 'clamp(22px, 2.4vw, 28px)', letterSpacing: '-0.02em', lineHeight: 1.15 }}>
          Заказы
        </Text>
        <Text size="sm" c="dimmed">
          Реестр с пресетами колонок и карточкой по клику — вместо 66 столбцов вправо
        </Text>
      </Stack>

      <Tabs value={tab} onChange={(v) => setTab(v ?? 'registry')} radius="md">
        <Tabs.List>
          <Tabs.Tab value="registry" leftSection={<IconTable aria-hidden size={16} />}>Реестр</Tabs.Tab>
          <Tabs.Tab value="dashboard" leftSection={<IconChartBar aria-hidden size={16} />}>Дашборд</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {/* Содержимое вкладки живёт вне Tabs.Panel: так смена вкладки
          анимируется, а не «мигает» — старое растворяется, новое поднимается */}
      <FadeSwap swapKey={tab}>
        {tab === 'dashboard' ? <OrdersDashboard /> : <OrdersRegistry />}
      </FadeSwap>
    </Stack>
  );
}
