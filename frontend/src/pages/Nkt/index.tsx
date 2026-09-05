import React from 'react';
import { Tabs } from '@mantine/core';
import { IconListDetails, IconCategory } from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { SectionHead } from '../../components/SectionHeader';
import { FitScreen } from '../../components/FitScreen';
import { FadeSwap } from '../../components/motion';
import { NktRegistry } from './NktRegistry';
import { NktPassportCard } from './NktPassportCard';
import { NktCategories } from './NktCategories';
import './Nkt.css';

/**
 * «НКТ» — присвоение кодов NTIN изделиям ЦМК через Национальный каталог
 * товаров (05.09.2026). ТЗ, схема процесса и разбор фактического API —
 * docs/nkt/.
 *
 * Периметр — собственное производство. Покупная номенклатура сюда не
 * входит: ей NTIN ищется по чужому GTIN, а штрихкодов у нас нет — они
 * живут в 1С и ни в один обмен пока не приходят.
 *
 * Два слоя, не три: реестр → карточка изделия во весь экран. Открытая
 * карточка живёт в адресе, поэтому ссылку на «изделие в доработке» можно
 * переслать, а «назад» возвращает в тот же срез реестра.
 */
export function Nkt() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'registry';
  const openId = params.get('article');

  const set = (patch: Record<string, string | null>) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    Object.entries(patch).forEach(([k, v]) => (v === null ? next.delete(k) : next.set(k, v)));
    return next;
  }, { replace: true });

  const header = (
    <SectionHead
      title="НКТ"
      subtitle="коды NTIN для изделий ЦМК — Национальный каталог товаров"
      value={tab}
      onChange={(v) => set({ tab: v, article: null })}
      tabs={[
        { value: 'registry', label: 'Изделия', icon: <IconListDetails aria-hidden size={16} /> },
        { value: 'categories', label: 'Виды и категории', icon: <IconCategory aria-hidden size={16} /> },
      ]}
    />
  );

  return (
    <FitScreen header={header}>
      <Tabs
        value={tab}
        onChange={(v) => set({ tab: v ?? 'registry', article: null })}
        radius="md"
        keepMounted={false}
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <div className="section-body">
          <FadeSwap swapKey={openId ? `card:${openId}` : tab}>
            <Tabs.Panel value="registry">
              {openId
                ? <NktPassportCard articleId={openId} onBack={() => set({ article: null })} />
                : <NktRegistry onOpen={(id) => set({ article: id })} />}
            </Tabs.Panel>
            <Tabs.Panel value="categories">
              <NktCategories />
            </Tabs.Panel>
          </FadeSwap>
        </div>
      </Tabs>
    </FitScreen>
  );
}
