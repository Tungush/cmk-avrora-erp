import React from 'react';
import { Stack, Group, Text, Card, Badge, Table, Skeleton, Progress } from '@mantine/core';
import { usePaymentDoc } from '../../hooks/useFinance';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { formatCurrency, formatDate } from '../../utils/formatters';

const STATUS_LABELS: Record<string, string> = {
  UNPAID: 'Не оплачен',
  PARTIALLY_PAID: 'Частично оплачен',
  PAID: 'Оплачен',
  EXECUTED: 'Исполнен',
};
const STATUS_COLORS: Record<string, string> = {
  UNPAID: 'danger', PARTIALLY_PAID: 'warning', PAID: 'success', EXECUTED: 'gray',
};

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="md" align="flex-start">
      <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{label}</Text>
      <Text size="sm" fw={500} ff={mono ? 'monospace' : undefined} ta="right">
        {value ?? <Text span c="dimmed">нет данных</Text>}
      </Text>
    </Group>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card withBorder radius="md" padding="md">
      <Text fw={700} size="sm" mb="xs">{title}</Text>
      <Stack gap={6}>{children}</Stack>
    </Card>
  );
}

/**
 * Карточка прихода на склад (ДО = «Заказ поставщику» в 1С). До 25.08.2026
 * у ДО не было ни одной детальной карточки — только суммы в агрегатах.
 * «Материалы по этому приходу» — то, что реально пришло по этому
 * документу (MaterialBatch.paymentDocumentId, настоящая связь, не текст).
 */
export function ReceiptDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: doc, isLoading } = usePaymentDoc(id);

  if (isLoading || !doc) {
    return (
      <Stack gap="md">
        {[...Array(3)].map((_, i) => <Skeleton key={i} height={100} radius="md" />)}
      </Stack>
    );
  }

  const total = Number(doc.totalAmount ?? 0);
  const paid = Number(doc.paidAmount ?? 0);
  const unpaid = Number(doc.unpaidAmount ?? 0);
  const paidPct = total > 0 ? Math.min(100, (paid / total) * 100) : 0;

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="sm" wrap="wrap">
          <Text fw={800} size="lg" ff="monospace">{doc.doNumber}</Text>
          <Badge color={STATUS_COLORS[doc.status] ?? 'gray'} variant="light" radius="xl">
            {STATUS_LABELS[doc.status] ?? doc.status}
          </Badge>
        </Group>
      </Group>

      <Section title="Приход">
        <Row label="Поставщик" value={doc.contractor?.name ?? doc.contractorName} />
        <Row label="Дата ДО" value={formatDate(doc.doDate)} />
        <Row label="Валюта" value={doc.currency} />
        {doc.category && <Row label="Категория" value={doc.category} />}
        {doc.order && (
          <Row label="Заказ" value={<OrderRef id={doc.order.id} number={doc.order.orderNumber} size="sm" />} />
        )}
      </Section>

      <Card withBorder radius="md" padding="md">
        <Text fw={700} size="sm" mb="xs">Деньги</Text>
        <Stack gap={6}>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">Законтрактовано</Text>
            <Text size="xs" ff="monospace" fw={700}>{formatCurrency(total)}</Text>
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">Оплачено</Text>
            <Text size="xs" ff="monospace" fw={700} c="success.7">{formatCurrency(paid)}</Text>
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">Остаток</Text>
            <Text size="xs" ff="monospace" fw={700} c={unpaid > 0 ? 'danger.7' : undefined}>{formatCurrency(unpaid)}</Text>
          </Group>
          <Progress value={paidPct} size="sm" radius="xl" mt={4} color={paidPct >= 100 ? 'teal' : 'brand'} />
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="md">
        <Text fw={700} size="sm" mb="xs">Материалы по этому приходу ({doc.batches?.length ?? 0})</Text>
        {!doc.batches?.length ? (
          <Text size="sm" c="dimmed">Партий склада по этому ДО не заведено</Text>
        ) : (
          <Table.ScrollContainer minWidth={420}>
            <Table highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Материал</Table.Th>
                  <Table.Th ta="right">Кол-во</Table.Th>
                  <Table.Th ta="right">Цена</Table.Th>
                  <Table.Th>Дата прихода</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {doc.batches.map((b) => (
                  <Table.Tr key={b.id}>
                    <Table.Td>
                      <Text size="sm" ff="monospace" c="brand.7">{b.material.materialCode}</Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>{b.material.name}</Text>
                    </Table.Td>
                    <Table.Td ta="right">{Number(b.qtyReceived).toLocaleString('ru-RU')} {b.material.unit}</Table.Td>
                    <Table.Td ta="right">
                      {formatCurrency(Number(b.unitPrice))}
                      {b.priceAnomaly && <Badge ml={6} size="xs" color="danger" variant="light">карантин</Badge>}
                    </Table.Td>
                    <Table.Td>{formatDate(b.receiptDate)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
    </Stack>
  );
}
