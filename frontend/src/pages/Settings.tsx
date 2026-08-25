import React from 'react';
import { Stack, Text, Tabs } from '@mantine/core';
import { IconPlugConnected, IconShieldLock, IconCalculator } from '@tabler/icons-react';
import { Integration } from './Integration';
import { CostingSettings } from './Settings/CostingSettings';

/**
 * Настройки: то, куда заходят редко — обмен с 1С, аудит (решение
 * 23.08.2026). Раньше это были три отдельных пункта меню, которые
 * видели все, хотя нужны они администратору и директору.
 * «Справочники» убраны 25.08.2026 — были голым просмотром сырых
 * Excel-листов без единого поля реальных данных.
 */
export function Settings() {
  return (
    <Stack gap="md">
      <Stack gap={4}>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
          Настройки
        </Text>
        <Text fw={700} size="xl">Обмен, себестоимость, аудит</Text>
      </Stack>

      <Tabs defaultValue="integration" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="integration" leftSection={<IconPlugConnected size={15} />}>Обмен с 1С</Tabs.Tab>
          <Tabs.Tab value="costing" leftSection={<IconCalculator size={15} />}>Маржа и себестоимость</Tabs.Tab>
          <Tabs.Tab value="audit" leftSection={<IconShieldLock size={15} />}>Аудит</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="integration"><Integration /></Tabs.Panel>
        <Tabs.Panel value="costing"><CostingSettings /></Tabs.Panel>
        <Tabs.Panel value="audit">
          <Text size="sm" c="dimmed">Журнал действий — в работе</Text>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
