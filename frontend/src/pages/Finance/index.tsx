import React from 'react';
import { Text, Tabs, Group } from '@mantine/core';
import { useSearchParams } from 'react-router-dom';
import { Receivables } from './Receivables';
import { Reconciliation } from './Reconciliation';
import { PaymentDocuments } from './PaymentDocuments';
import { CreditLines } from './CreditLines';
import { FadeSwap } from '../../components/motion';
import { FitScreen } from '../../components/FitScreen';
import { TextReveal } from '../../components/motion';

/**
 * Деньги (31.08.2026). До этого раздел был одной страницей сверки, которая
 * читала долг из незаполняемого поля и показывала ноль. Теперь три взгляда
 * на одни и те же деньги: сколько нам должны, сколько должны мы по закупу,
 * и сам реестр договоров-оснований.
 */
export function Finance() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'receivables';

  const header = (
    <Group gap="sm" wrap="nowrap" align="baseline" style={{ minWidth: 0 }}>
      <Text className="page-title" style={{ fontSize: 26, lineHeight: 1.1, whiteSpace: 'nowrap' }}>
        <TextReveal text="Деньги" />
      </Text>
      <Text size="sm" c="dimmed" lineClamp={1}>
        кто должен нам по заказам, сколько должны мы по закупу и чем это подтверждено
      </Text>
    </Group>
  );

  return (
    <FitScreen header={header}>
      <Tabs
        value={tab}
        onChange={(v) => setParams({ tab: v ?? 'receivables' }, { replace: true })}
        radius="md"
        keepMounted={false}
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <Tabs.List mb="sm">
          <Tabs.Tab value="receivables">Нам должны</Tabs.Tab>
          <Tabs.Tab value="reconciliation">Сверка с закупом</Tabs.Tab>
          <Tabs.Tab value="documents">Договоры-основания</Tabs.Tab>
          <Tabs.Tab value="damu">ДАМУ</Tabs.Tab>
        </Tabs.List>

        {/* Смена вкладки — плавная: старое растворяется, новое поднимается.
            Длинные реестры прокручиваются внутри панели, не страницей */}
        <div className="section-body">
        <FadeSwap swapKey={tab}>
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
