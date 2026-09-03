import React, { useState } from 'react';
import { Group, Text, Tabs } from '@mantine/core';
import { IconPlugConnected, IconShieldLock, IconCalculator, IconUsers } from '@tabler/icons-react';
import { Integration } from './Integration';
import { CostingSettings } from './Settings/CostingSettings';
import { UsersAdmin } from './Settings/UsersAdmin';
import { FitScreen } from '../components/FitScreen';
import { FadeSwap, TextReveal } from '../components/motion';

/**
 * Настройки: то, куда заходят редко — обмен с 1С, аудит (решение
 * 23.08.2026). Раньше это были три отдельных пункта меню, которые
 * видели все, хотя нужны они администратору и директору.
 * «Справочники» убраны 25.08.2026 — были голым просмотром сырых
 * Excel-листов без единого поля реальных данных.
 *
 * 03.09.2026: страница больше не прокручивается (решение владельца
 * «раздел влезает в один экран»). Содержимое здесь принципиально
 * длинное — это формы обмена и таблица пользователей, резать их на
 * страницы нечестно: человек заполняет форму сверху вниз. Поэтому
 * рамка стоит намертво (FitScreen), а прокручивается ровно одна
 * панель — тело вкладки (.section-body). Заголовок и список вкладок
 * при этом всегда на месте, и «где я» не теряется.
 */
export function Settings() {
  const [tab, setTab] = useState('integration');

  const header = (
    <Group gap="sm" wrap="nowrap" align="baseline" style={{ minWidth: 0 }}>
      <Text component="h1" className="page-title" style={{ fontSize: 26, lineHeight: 1.1, whiteSpace: 'nowrap', margin: 0 }}>
        <TextReveal text="Настройки" />
      </Text>
      <Text size="sm" c="dimmed" lineClamp={1}>
        обмен с 1С, маржа и себестоимость, пользователи, аудит
      </Text>
    </Group>
  );

  return (
    <FitScreen header={header}>
      <Tabs
        value={tab}
        onChange={(v) => setTab(v ?? 'integration')}
        radius="md"
        keepMounted={false}
      >
        <Tabs.List>
          <Tabs.Tab value="integration" leftSection={<IconPlugConnected size={15} />}>Обмен с 1С</Tabs.Tab>
          <Tabs.Tab value="costing" leftSection={<IconCalculator size={15} />}>Маржа и себестоимость</Tabs.Tab>
          <Tabs.Tab value="users" leftSection={<IconUsers size={15} />}>Пользователи</Tabs.Tab>
          <Tabs.Tab value="audit" leftSection={<IconShieldLock size={15} />}>Аудит</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {/* Панели рисуем сами под списком вкладок: смена вкладки — один
          FadeSwap, а прокрутка живёт ВНУТРИ панели, не на странице */}
      <div className="section-body">
        <FadeSwap swapKey={tab} style={{ minWidth: 0 }}>
          {tab === 'integration' && <Integration />}
          {tab === 'costing' && <CostingSettings />}
          {tab === 'users' && <UsersAdmin />}
          {tab === 'audit' && <Text size="sm" c="dimmed">Журнал действий — в работе</Text>}
        </FadeSwap>
      </div>
    </FitScreen>
  );
}
