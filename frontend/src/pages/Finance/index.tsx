import React from 'react';
import { Stack, Text, Tabs } from '@mantine/core';
import { useSearchParams } from 'react-router-dom';
import { Receivables } from './Receivables';
import { Reconciliation } from './Reconciliation';
import { PaymentDocuments } from './PaymentDocuments';
import { CreditLines } from './CreditLines';

/**
 * Деньги (31.08.2026). До этого раздел был одной страницей сверки, которая
 * читала долг из незаполняемого поля и показывала ноль. Теперь три взгляда
 * на одни и те же деньги: сколько нам должны, сколько должны мы по закупу,
 * и сам реестр договоров-оснований.
 */
export function Finance() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'receivables';

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={700} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.01em', lineHeight: 1.15 }}>
          Деньги
        </Text>
        <Text size="sm" c="dimmed">
          Кто должен нам по заказам, сколько должны мы по закупу и чем это подтверждено
        </Text>
      </Stack>

      <Tabs
        value={tab}
        onChange={(v) => setParams({ tab: v ?? 'receivables' }, { replace: true })}
        radius="md"
        keepMounted={false}
      >
        <Tabs.List mb="md">
          <Tabs.Tab value="receivables">Нам должны</Tabs.Tab>
          <Tabs.Tab value="reconciliation">Сверка с закупом</Tabs.Tab>
          <Tabs.Tab value="documents">Договоры-основания</Tabs.Tab>
          <Tabs.Tab value="damu">ДАМУ</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="receivables"><Receivables /></Tabs.Panel>
        <Tabs.Panel value="reconciliation"><Reconciliation /></Tabs.Panel>
        <Tabs.Panel value="documents"><PaymentDocuments /></Tabs.Panel>
        <Tabs.Panel value="damu"><CreditLines /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
