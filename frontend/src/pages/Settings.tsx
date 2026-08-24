import React from 'react';
import { Stack, Text, Tabs } from '@mantine/core';
import { IconPlugConnected, IconShieldLock, IconBook } from '@tabler/icons-react';
import { Integration } from './Integration';
import { Catalog } from './Catalog';

/**
 * Настройки: то, куда заходят редко — обмен с 1С, справочники, аудит
 * (решение 23.08.2026). Раньше это были три отдельных пункта меню,
 * которые видели все, хотя нужны они администратору и директору.
 */
export function Settings() {
  return (
    <Stack gap="md">
      <Stack gap={4}>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
          Настройки
        </Text>
        <Text fw={700} size="xl">Обмен, справочники, аудит</Text>
      </Stack>

      <Tabs defaultValue="integration" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="integration" leftSection={<IconPlugConnected size={15} />}>Обмен с 1С</Tabs.Tab>
          <Tabs.Tab value="catalog" leftSection={<IconBook size={15} />}>Справочники</Tabs.Tab>
          <Tabs.Tab value="audit" leftSection={<IconShieldLock size={15} />}>Аудит</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="integration"><Integration /></Tabs.Panel>
        <Tabs.Panel value="catalog"><Catalog /></Tabs.Panel>
        <Tabs.Panel value="audit">
          <Text size="sm" c="dimmed">Журнал действий — в работе</Text>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
