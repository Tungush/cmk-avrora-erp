import React, { useState } from 'react';
import {
  Stack, Group, Text, Card, SimpleGrid, Table, Badge, Skeleton, Box,
  SegmentedControl, Progress, Alert, Anchor,
} from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { purchasesApi } from '../../api/purchases';
import { ReceiptRef } from '../../components/ReceiptCard/ReceiptCardProvider';
import { formatMoney, formatDate } from '../../utils/formatters';

const pct = (v: number) => `${(v * 100).toFixed(1).replace('.0', '')} %`;

const DIMENSIONS = [
  { value: 'project', label: 'Проект' },
  { value: 'costCategory', label: 'Категория затрат' },
  { value: 'author', label: 'Автор' },
  { value: 'manager', label: 'Менеджер' },
  { value: 'warehouse', label: 'Склад' },
  { value: 'division', label: 'Подразделение' },
];

function Kpi({ label, value, hint, tone }: {
  label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: string;
}) {
  return (
    <Card withBorder radius="md" padding="md">
      <Text size="xs" c="dimmed" fw={600} tt="uppercase" style={{ letterSpacing: '0.05em' }}>
        {label}
      </Text>
      <Text fw={800} c={tone} style={{ fontSize: 'clamp(18px, 2vw, 24px)', lineHeight: 1.2 }} mt={6}>
        {value}
      </Text>
      {hint && <Text size="xs" c="dimmed" mt={4}>{hint}</Text>}
    </Card>
  );
}

export function PurchasesDashboard({ onOpenRegistry }: { onOpenRegistry: (f: Record<string, string>) => void }) {
  const [dim, setDim] = useState('project');
  const { data, isLoading } = useQuery({
    queryKey: ['purchases-dashboard'],
    queryFn: () => purchasesApi.dashboard().then((r) => r.data),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return <Stack gap="md">{[...Array(3)].map((_, i) => <Skeleton key={i} height={120} radius="md" />)}</Stack>;
  }

  const { kpi } = data;
  const rows = data.dimensions[dim] ?? [];
  // Один-единственный ключ на все документы — это не разрез, а константа.
  // Рисуем честную подпись вместо графика из одного столбика.
  const degenerate = rows.length <= 1;
  const trend = kpi.spendMonth.prevAmount
    ? (kpi.spendMonth.amount - kpi.spendMonth.prevAmount) / kpi.spendMonth.prevAmount
    : null;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        <Kpi
          label="Должны поставщикам"
          value={formatMoney(kpi.owed.amount)}
          tone="danger.7"
          hint={
            <>
              по {kpi.owed.docs} ДО из {kpi.owed.totalDocs}
              {kpi.owed.otherCurrencies.length > 0 && (
                <> · отдельно {kpi.owed.otherCurrencies.map((c) => formatMoney(c.amount, c.currency)).join(' · ')}</>
              )}
            </>
          }
        />
        <Kpi
          label="Не оплачено больше 30 дней"
          value={formatMoney(kpi.overdue30.amount)}
          tone="danger.7"
          hint={<>{kpi.overdue30.docs} ДО, из них 90+ дней: {kpi.overdue30.over90}. Срок оплаты 1С не отдаёт — считаем возраст от даты документа</>}
        />
        <Kpi
          label="Закуп за 30 дней"
          value={formatMoney(kpi.spendMonth.amount)}
          hint={
            <>
              {kpi.spendMonth.docs} ДО
              {trend != null && (
                <> · {trend >= 0 ? '+' : ''}{pct(trend)} к прошлым 30 дням</>
              )}
            </>
          }
        />
        <Kpi
          label="ДО без прихода на склад"
          value={`${kpi.noReceipt.docs} из ${kpi.noReceipt.totalDocs}`}
          tone="orange.7"
          hint={<>{kpi.noReceipt.paidDocs} из них уже оплачены на {formatMoney(kpi.noReceipt.paidAmount)}</>}
        />
      </SimpleGrid>

      {/* Блок А. Куда ушли деньги */}
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="sm" wrap="wrap" gap="sm">
          <Text fw={700} size="sm">Куда ушли деньги</Text>
          <SegmentedControl size="xs" data={DIMENSIONS} value={dim} onChange={setDim} />
        </Group>

        {degenerate ? (
          <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
            <Text size="sm">
              «{rows[0]?.key ?? 'не заполнено'}» — все {rows[0]?.docs ?? 0} документов.
              Разрез не работает: в 1С у всех заказов поставщику здесь одно значение.
            </Text>
          </Alert>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{DIMENSIONS.find((d) => d.value === dim)?.label}</Table.Th>
                  <Table.Th ta="right">ДО</Table.Th>
                  <Table.Th ta="right">Телеком</Table.Th>
                  <Table.Th ta="right">Другие</Table.Th>
                  <Table.Th ta="right">Всего</Table.Th>
                  <Table.Th ta="right">Доля</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => (
                  <Table.Tr key={r.key ?? '__none__'}>
                    <Table.Td>
                      {r.key ? (
                        <Anchor size="sm" onClick={() => onOpenRegistry({ [dimParam(dim)]: r.key! })}>
                          {r.key}
                        </Anchor>
                      ) : (
                        <Text size="sm" c="dimmed" fs="italic">не указано в 1С</Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">{r.docs}</Table.Td>
                    <Table.Td ta="right" ff="monospace" fz="xs">{formatMoney(r.telecom)}</Table.Td>
                    <Table.Td ta="right" ff="monospace" fz="xs">{formatMoney(r.other)}</Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={700}>{formatMoney(r.total)}</Table.Td>
                    <Table.Td ta="right" ff="monospace" fz="xs" c="dimmed">
                      {data.totalKzt ? pct(r.total / data.totalKzt) : '—'}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        )}
        <Text size="xs" c="dimmed" mt="sm">
          Только тенговые документы. Что заказано — видно у всех {kpi.owed.totalDocs} ДО,
          что реально пришло на склад — у {kpi.noReceipt.totalDocs - kpi.noReceipt.docs}.
        </Text>
      </Card>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        {/* Блок Б. Кому платить */}
        <Card withBorder radius="md" padding="md">
          <Text fw={700} size="sm" mb="xs">Кому платить</Text>
          <SimpleGrid cols={2} spacing="xs" mb="sm">
            {data.buckets.map((b) => (
              <Box key={b.label}>
                <Text size="xs" c="dimmed">{b.label}</Text>
                <Text size="sm" fw={700} ff="monospace">{formatMoney(b.amount)}</Text>
                <Text size="xs" c="dimmed">{b.docs} ДО</Text>
              </Box>
            ))}
          </SimpleGrid>
          <Box style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
            <Table highlightOnHover verticalSpacing={4} fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>№ ДО</Table.Th>
                  <Table.Th ta="right">Дней</Table.Th>
                  <Table.Th>Поставщик</Table.Th>
                  <Table.Th ta="right">Остаток</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.unpaidDocs.map((d) => (
                  <Table.Tr key={d.id}>
                    <Table.Td><ReceiptRef id={d.id} number={d.doNumber} size="xs" /></Table.Td>
                    <Table.Td ta="right" ff="monospace" c={d.ageDays > 90 ? 'danger.7' : undefined}>
                      {d.ageDays}
                    </Table.Td>
                    <Table.Td><Text size="xs" lineClamp={1}>{d.supplier}</Text></Table.Td>
                    <Table.Td ta="right" ff="monospace" fw={600}>
                      {formatMoney(d.unpaidAmount, d.currency)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        </Card>

        {/* Блок В. Поставщики */}
        <Card withBorder radius="md" padding="md">
          <Text fw={700} size="sm">Поставщики: кто нас держит</Text>
          <Text size="xs" c="dimmed" mb="sm">
            Топ-5 = {pct(data.supplierStats.top5Share)} закупа, топ-10 = {pct(data.supplierStats.top10Share)}.
            Всего {data.supplierStats.total}, разовых — {data.supplierStats.oneOff}.
          </Text>
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover verticalSpacing={4} fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Поставщик</Table.Th>
                  <Table.Th ta="right">ДО</Table.Th>
                  <Table.Th ta="right">Законтрактовано</Table.Th>
                  <Table.Th ta="right">Остаток</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.suppliers.map((s) => (
                  <Table.Tr key={s.id}>
                    <Table.Td>
                      <Anchor size="xs" onClick={() => onOpenRegistry({ supplierId: s.id })} lineClamp={1}>
                        {s.name}
                      </Anchor>
                      {s.noReceipt > 0 && (
                        <Text size="xs" c="dimmed">{s.noReceipt} без прихода</Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">{s.docs}</Table.Td>
                    <Table.Td ta="right" ff="monospace">{formatMoney(s.total)}</Table.Td>
                    <Table.Td ta="right" ff="monospace" c={s.unpaid > 0 ? 'danger.7' : undefined}>
                      {formatMoney(s.unpaid)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        </Card>
      </SimpleGrid>

      {/* Блок Г. Контроль */}
      <Card withBorder radius="md" padding="md">
        <Group gap="xs" mb="xs">
          <IconAlertTriangle size={16} style={{ color: 'var(--mantine-color-orange-6)' }} />
          <Text fw={700} size="sm">Где закуп прошёл мимо процедуры</Text>
        </Group>
        <Stack gap={6}>
          {data.control.map((c) => (
            <Group key={c.code} justify="space-between" wrap="nowrap">
              <Anchor
                size="sm"
                onClick={() => c.code === 'noApprover' || c.code === 'noWarehouse'
                  ? onOpenRegistry({ control: c.code })
                  : undefined}
                style={{ cursor: c.code === 'noApprover' || c.code === 'noWarehouse' ? 'pointer' : 'default' }}
                c={c.code === 'noApprover' || c.code === 'noWarehouse' ? undefined : 'dimmed'}
              >
                {c.label}
              </Anchor>
              <Group gap="md" wrap="nowrap">
                <Text size="sm" ff="monospace" fw={700}>{c.docs} ДО</Text>
                <Text size="sm" ff="monospace" c="dimmed" style={{ minWidth: 140, textAlign: 'right' }}>
                  {formatMoney(c.amount)}
                </Text>
              </Group>
            </Group>
          ))}
        </Stack>
        <Text size="xs" c="dimmed" mt="sm">
          Считается по колонкам выгрузки, заполненным у всех 306 документов.
        </Text>
      </Card>
    </Stack>
  );
}

/** Ключ разреза → имя фильтра в реестре */
function dimParam(dim: string): string {
  return ({
    project: 'project', costCategory: 'costCategory', warehouse: 'warehouse',
    author: 'author', manager: 'manager', division: 'division',
  } as Record<string, string>)[dim] ?? dim;
}
