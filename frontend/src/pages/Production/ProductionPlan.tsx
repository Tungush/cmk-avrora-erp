import React from 'react';
import { IconCalendarWeek, IconTable } from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { WeeklyPlan } from './WeeklyPlan';
import { PlanMatrix } from './PlanMatrix';
import { FadeSwap } from '../../components/motion';
import { FitScreen } from '../../components/FitScreen';
import { SectionHead } from '../../components/SectionHeader';

export function ProductionPlan() {
  // Вкладка в адресе — чтобы ссылки вели на конкретный разрез
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'weekly' ? 'weekly' : 'matrix';
  const setTab = (v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev); next.set('tab', v); return next;
  }, { replace: true });

  /* Название и вкладки одной строкой, как в остальных разделах; матрица и
     недели длиннее экрана и крутятся внутри раздела, а не страницей
     («По неделям» прокручивал страницу на 312 px при 1280×800, 06.09.2026) */
  const header = (
    <SectionHead
      title="Производственный план"
      subtitle="план по изделиям и раскладка по неделям — вместо 110 столбцов вправо"
      value={tab}
      onChange={setTab}
      tabs={[
        { value: 'matrix', label: 'По изделиям', icon: <IconTable aria-hidden size={16} /> },
        { value: 'weekly', label: 'По неделям', icon: <IconCalendarWeek aria-hidden size={16} /> },
      ]}
    />
  );

  return (
    <FitScreen header={header}>
      <div className="section-body" style={{ minWidth: 0 }}>
        <FadeSwap swapKey={tab}>
          {tab === 'matrix' ? <PlanMatrix /> : <WeeklyPlan />}
        </FadeSwap>
      </div>
    </FitScreen>
  );
}
