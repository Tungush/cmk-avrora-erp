import React from 'react';
import { Stack } from '@mantine/core';
import { IconTable, IconChartBar } from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { OrdersRegistry } from './OrdersRegistry';
import { OrdersDashboard } from './OrdersDashboard';
import { FadeSwap } from '../../components/motion';
import { SectionHead } from '../../components/SectionHeader';

/**
 * Два вида раздела — один ряд вкладок (05.09.2026).
 *
 * Карточки «Что требует решения» убраны: владелец 05.09 сказал, что так
 * показывать «не совсем корректно» и ему не нравится. Раздел открывается
 * реестром — таблицей заказов с карточкой по клику; счётчики просрочки
 * и новых из 1С живут в фильтрах реестра.
 *
 * История: три вида, один ряд вкладок (04.09.2026).
 *
 * Раньше видов тоже было три, но выбирались они в ДВУХ местах: здесь
 * стояли «Реестр / Дашборд», а внутри реестра — второй переключатель
 * «Что требует решения / Реестр · 384». Вместе с блоком названия это
 * съедало 154 px до первой строки данных, и владелец справедливо сказал,
 * что реестром пользоваться неудобно: из 384 заказов было видно шесть
 * строк. Два переключателя делали одну работу, поэтому сведены в один.
 */
export function OrdersList() {
  // Вид в адресе — ссылки с других экранов ведут сразу куда нужно
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'registry';
  const setTab = (v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev); next.set('tab', v); return next;
  }, { replace: true });

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <SectionHead
        title="Заказы"
        subtitle="карточка по клику — вместо 66 столбцов вправо"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'registry', label: 'Реестр', icon: <IconTable aria-hidden size={16} /> },
          { value: 'dashboard', label: 'Дашборд', icon: <IconChartBar aria-hidden size={16} /> },
        ]}
      />

      {/* Содержимое вида живёт вне Tabs.Panel: так смена анимируется,
          а не «мигает» — старое растворяется, новое поднимается */}
      <FadeSwap swapKey={tab}>
        {tab === 'dashboard'
          ? <OrdersDashboard />
          : <OrdersRegistry />}
      </FadeSwap>
    </Stack>
  );
}
