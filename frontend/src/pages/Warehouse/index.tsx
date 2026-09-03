import React from 'react';
import { SectionHead } from '../../components/SectionHeader';
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

  /* Название и вкладки — одной строкой (04.09.2026). Вкладки стояли
     отдельным рядом под названием: вместе это 88 px до первой строки
     данных на каждом из семи видов раздела. */
  const header = (
    <SectionHead
      title="Склад"
      subtitle="сырьё с ценами закупа — отсюда берётся себестоимость в спецификациях"
      value={tab}
      onChange={setTab}
      tabs={[
        { value: 'digest', label: 'Сводка', icon: <IconLayoutGrid aria-hidden size={16} /> },
        { value: 'stock', label: 'Склад сырья', icon: <IconBoxSeam aria-hidden size={16} /> },
        { value: 'storeroom', label: 'Кладовая', icon: <IconTool aria-hidden size={16} /> },
        { value: 'fg', label: 'Склад ГП', icon: <IconBuildingWarehouse aria-hidden size={16} /> },
        { value: 'batches', label: 'Партии и резервы', icon: <IconGavel aria-hidden size={16} /> },
        { value: 'minstock', label: 'Мин. остатки', icon: <IconGauge aria-hidden size={16} /> },
        { value: 'offcuts', label: 'Обрезки', icon: <IconScissors aria-hidden size={16} /> },
      ]}
    />
  );

  return (
    <FitScreen header={header}>
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
