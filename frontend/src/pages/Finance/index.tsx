import React from 'react';
import { Text, Tabs, Group } from '@mantine/core';
import { useSearchParams } from 'react-router-dom';
import { SectionHead } from '../../components/SectionHeader';
import { Receivables } from './Receivables';
import { OrderDebts } from './OrderDebts';
import { Reconciliation } from './Reconciliation';
import { PaymentDocuments } from './PaymentDocuments';
import { CreditLines } from './CreditLines';
import { FadeSwap } from '../../components/motion';
import { FitScreen } from '../../components/FitScreen';
import { TextReveal } from '../../components/motion';

/**
 * Деньги (переписано 05.09.2026: владелец хочет видеть долг по заказам
 * со статусами «изготовлен / отгружен»; сводка по заказчикам осталась
 * второй вкладкой). История: 31.08.2026 — До этого раздел был одной страницей сверки, которая
 * читала долг из незаполняемого поля и показывала ноль. Теперь три взгляда
 * на одни и те же деньги: сколько нам должны, сколько должны мы по закупу,
 * и сам реестр договоров-оснований.
 */
export function Finance() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'orders';

  const setTab = (v: string) => setParams({ tab: v }, { replace: true });

  /* Название и вкладки — одной строкой (04.09.2026): вкладки стояли
     отдельным рядом под названием и отнимали высоту у данных. */
  const header = (
    <SectionHead
      title="Деньги"
      subtitle="кто должен нам по заказам, сколько должны мы по закупу и чем это подтверждено"
      value={tab}
      onChange={setTab}
      tabs={[
        { value: 'orders', label: 'Нам должны по заказам' },
        { value: 'receivables', label: 'По заказчикам' },
        { value: 'reconciliation', label: 'Сверка с закупом' },
        { value: 'documents', label: 'Договоры-основания' },
        { value: 'damu', label: 'ДАМУ' },
      ]}
    />
  );

  return (
    <FitScreen header={header}>
      <Tabs
        value={tab}
        onChange={(v) => setParams({ tab: v ?? 'orders' }, { replace: true })}
        radius="md"
        keepMounted={false}
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        {/* Смена вкладки — плавная: старое растворяется, новое поднимается.
            Длинные реестры прокручиваются внутри панели, не страницей */}
        <div className="section-body">
        <FadeSwap swapKey={tab}>
          <Tabs.Panel value="orders"><OrderDebts /></Tabs.Panel>
          <Tabs.Panel value="receivables"><Receivables /></Tabs.Panel>
          <Tabs.Panel value="reconciliation"><Reconciliation /></Tabs.Panel>
          <Tabs.Panel value="documents"><PaymentDocuments /></Tabs.Panel>
          <Tabs.Panel value="damu"><CreditLines /></Tabs.Panel>
        </FadeSwap>
        </div>
      </Tabs>
    </FitScreen>
  );
}
