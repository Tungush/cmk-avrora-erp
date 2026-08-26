import React, { useState } from 'react';
import {
  Stack, Group, Text, Card, Badge, Table, Skeleton, Progress, Button, Alert, Switch,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { usePaymentDoc } from '../../hooks/useFinance';
import { OrderRef } from '../../components/OrderCard/OrderCardProvider';
import { Collapse } from '../../components/motion';
import { formatMoney, formatDate } from '../../utils/formatters';

const STATUS_LABELS: Record<string, string> = {
  UNPAID: 'Не оплачен',
  PARTIALLY_PAID: 'Частично оплачен',
  PAID: 'Оплачен',
  EXECUTED: 'Исполнен',
};
const STATUS_COLORS: Record<string, string> = {
  UNPAID: 'danger', PARTIALLY_PAID: 'warning', PAID: 'success', EXECUTED: 'gray',
};

const DAY = 24 * 60 * 60 * 1000;
const dayOf = (d: string) => {
  const x = new Date(d);
  return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
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

function Section({ title, children, extra }: {
  title: string; children: React.ReactNode; extra?: React.ReactNode;
}) {
  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="xs">
        <Text fw={700} size="sm">{title}</Text>
        {extra}
      </Group>
      <Stack gap={6}>{children}</Stack>
    </Card>
  );
}

/**
 * Карточка заказа поставщику (ДО). Раньше показывала пять полей и таблицу
 * партий — а по 221 документу из 306 партий нет вовсе, и карточка была
 * пустой. Теперь здесь всё, что 1С прислала по документу: подразделение,
 * направление, проект, кто оформил и кто утвердил, документы поставщика,
 * строки заказа и, отдельно, что реально пришло на склад (26.08.2026).
 */
export function ReceiptDetail({ id }: { id: string; onClose?: () => void }) {
  const { data: doc, isLoading } = usePaymentDoc(id);
  const [rawOpen, setRawOpen] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);

  if (isLoading || !doc) {
    return <Stack gap="md">{[...Array(3)].map((_, i) => <Skeleton key={i} height={100} radius="md" />)}</Stack>;
  }

  const d: any = doc;
  const cur = d.currency ?? 'KZT';
  const total = Number(d.totalAmount ?? 0);
  const paid = Number(d.paidAmount ?? 0);
  const unpaid = Number(d.unpaidAmount ?? 0);
  const paidPct = total > 0 ? Math.min(100, (paid / total) * 100) : 0;

  const lines: any[] = d.lines ?? [];
  const batches: any[] = d.batches ?? [];
  const payments: any[] = d.payments ?? [];
  const raw: Record<string, string | null> = d.rawColumns ?? {};

  const approvalDays = d.approvedAt && d.doDate
    ? Math.round((dayOf(d.approvedAt) - dayOf(d.doDate)) / DAY)
    : null;
  const backdatedDays = d.supplierDocDate && d.doDate
    ? Math.round((dayOf(d.doDate) - dayOf(d.supplierDocDate)) / DAY)
    : null;

  const linesTotal = lines.reduce((s, l) => s + Number(l.amount ?? 0), 0);
  const mismatchCount = lines.filter((l) => l.amountMismatch).length;

  const rawEntries = Object.entries(raw);
  const filledEntries = rawEntries.filter(([, v]) => v != null && String(v).trim() !== '');
  const shownEntries = showEmpty ? rawEntries : filledEntries;

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="sm" wrap="wrap">
          <Text fw={800} size="lg" ff="monospace">{d.doNumber}</Text>
          <Badge color={STATUS_COLORS[d.status] ?? 'gray'} variant="light" radius="xl">
            {STATUS_LABELS[d.status] ?? d.status}
          </Badge>
          {cur !== 'KZT' && <Badge variant="outline" color="gray" radius="xl">{cur}</Badge>}
        </Group>
      </Group>

      <Section title="Заказ поставщику">
        <Row label="Поставщик" value={d.contractor?.name ?? d.contractorName} />
        <Row label="Дата документа" value={formatDate(d.doDate)} />
        <Row label="Валюта" value={cur} />
        {d.costCategory && <Row label="Категория затрат" value={d.costCategory} />}
      </Section>

      <Card withBorder radius="md" padding="md">
        <Text fw={700} size="sm" mb="xs">Деньги</Text>
        <Stack gap={6}>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">Законтрактовано</Text>
            <Text size="xs" ff="monospace" fw={700}>{formatMoney(total, cur)}</Text>
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">Оплачено</Text>
            <Text size="xs" ff="monospace" fw={700} c="success.7">{formatMoney(paid, cur)}</Text>
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">Остаток</Text>
            <Text size="xs" ff="monospace" fw={700} c={unpaid > 0 ? 'danger.7' : undefined}>
              {formatMoney(unpaid, cur)}
            </Text>
          </Group>
          <Progress value={paidPct} size="sm" radius="xl" mt={4} color={paidPct >= 100 ? 'teal' : 'brand'} />
          {payments.length > 0 && (
            <Stack gap={2} mt="xs">
              <Text size="xs" c="dimmed" fw={600}>Платежи ({payments.length})</Text>
              {payments.slice(0, 8).map((p) => (
                <Group key={p.id} justify="space-between">
                  <Text size="xs" ff="monospace">{formatDate(p.paymentDate)}</Text>
                  <Text size="xs" ff="monospace">{formatMoney(Number(p.amount), cur)}</Text>
                </Group>
              ))}
            </Stack>
          )}
        </Stack>
      </Card>

      <Section title="Кто и когда">
        <Row label="Автор" value={d.author} />
        <Row label="Менеджер" value={d.managerName} />
        <Row label="Дата согласования" value={formatDate(d.approvedAt)} />
        {approvalDays != null && (
          <Row
            label="Дней на согласование"
            value={
              <Badge size="sm" variant="light" color={approvalDays > 30 ? 'danger' : 'gray'}>
                {approvalDays}
              </Badge>
            }
          />
        )}
        <Row
          label="Утвердитель"
          value={d.approver ?? <Text span size="sm" c="orange.7">не указан</Text>}
        />
      </Section>

      <Section title="Куда">
        <Row label="Подразделение" value={d.division} />
        <Row label="Склад" value={d.warehouseName} />
        <Row label="Направление деятельности" value={d.businessDirection} />
        <Row label="Проект" value={d.projectName} />
        {raw['ГруппаПроектов'] && <Row label="Группа проектов" value={raw['ГруппаПроектов']} />}
        {raw['Регион'] && <Row label="Регион" value={raw['Регион']} />}
      </Section>

      <Section title="Документы поставщика">
        <Row label="Номер по данным поставщика" value={d.supplierDocNumber} mono />
        <Row label="Дата по данным поставщика" value={formatDate(d.supplierDocDate)} />
        {backdatedDays != null && backdatedDays > 0 && (
          <Alert color="orange" variant="light" p="xs" icon={<IconInfoCircle size={15} />}>
            <Text size="xs">
              Документ поставщика датирован на {backdatedDays} дн. раньше нашего заказа —
              закуп оформлен задним числом.
            </Text>
          </Alert>
        )}
      </Section>

      {(d.order || d.salesOrderNumber) && (
        <Section title="Связь с заказом клиента">
          {d.order && (
            <Row label="Заказ" value={<OrderRef id={d.order.id} number={d.order.orderNumber} focus="money" size="sm" />} />
          )}
          {d.salesOrderNumber && <Row label="Номер заказа на продажу" value={d.salesOrderNumber} mono />}
        </Section>
      )}

      {/* Что заказано — есть почти по всем ДО, в отличие от партий */}
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="xs">
          <Text fw={700} size="sm">Что заказано ({lines.length})</Text>
          {linesTotal > 0 && (
            <Text size="xs" c="dimmed" ff="monospace">итого {formatMoney(linesTotal, cur)}</Text>
          )}
        </Group>
        {lines.length === 0 ? (
          <Text size="sm" c="dimmed">Строк заказа в выгрузке 1С нет</Text>
        ) : (
          <>
            {mismatchCount > 0 && (
              <Alert color="gray" variant="light" p="xs" mb="xs" icon={<IconInfoCircle size={15} />}>
                <Text size="xs">
                  В {mismatchCount} строках количество × цена ≠ сумма — цена, скорее всего,
                  за тонну при количестве в штуках. Итоги считаем по колонке «Сумма».
                </Text>
              </Alert>
            )}
            <Table.ScrollContainer minWidth={520}>
              <Table highlightOnHover verticalSpacing="xs" fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Номенклатура</Table.Th>
                    <Table.Th ta="right">Кол-во</Table.Th>
                    <Table.Th ta="right">Цена</Table.Th>
                    <Table.Th ta="right">Сумма</Table.Th>
                    <Table.Th>НДС</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {lines.map((l) => (
                    <Table.Tr key={l.id}>
                      <Table.Td>
                        <Text size="xs" lineClamp={2}>{l.itemName}</Text>
                        {l.expenseItem && <Text size="xs" c="dimmed">{l.expenseItem}</Text>}
                        {l.amountMismatch && (
                          <Badge size="xs" color="gray" variant="light" mt={2}>кол-во × цена ≠ сумма</Badge>
                        )}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                        {l.qty ? Number(l.qty).toLocaleString('ru-RU') : '—'} {l.packaging ?? ''}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace">
                        {l.unitPrice ? formatMoney(Number(l.unitPrice), cur) : '—'}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" fw={600}>
                        {l.amount ? formatMoney(Number(l.amount), cur) : '—'}
                      </Table.Td>
                      <Table.Td>{l.vatRate ?? '—'}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </>
        )}
      </Card>

      <Card withBorder radius="md" padding="md">
        <Text fw={700} size="sm" mb="xs">Что пришло на склад ({batches.length})</Text>
        {batches.length === 0 ? (
          <Text size="sm" c="dimmed">
            Приход на склад по этому документу не зарегистрирован — это либо услуга или
            подряд, либо материал не был опознан при загрузке из 1С.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={420}>
            <Table highlightOnHover verticalSpacing="xs" fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Материал</Table.Th>
                  <Table.Th ta="right">Кол-во</Table.Th>
                  <Table.Th ta="right">Цена</Table.Th>
                  <Table.Th>Дата</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {batches.map((b) => (
                  <Table.Tr key={b.id}>
                    <Table.Td>
                      <Text size="xs" ff="monospace" c="brand.7">{b.material.materialCode}</Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>{b.material.name}</Text>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {Number(b.qtyReceived).toLocaleString('ru-RU')} {b.material.unit}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {formatMoney(Number(b.unitPrice), cur)}
                      {b.priceAnomaly && <Badge ml={4} size="xs" color="danger" variant="light">карантин</Badge>}
                    </Table.Td>
                    <Table.Td>{formatDate(b.receiptDate)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      {/* Всё, что прислала 1С, дословно — включая то, для чего нет своего поля */}
      {rawEntries.length > 0 && (
        <Section
          title="Все данные 1С"
          extra={
            <Button variant="subtle" size="xs" onClick={() => setRawOpen((v) => !v)}>
              {rawOpen ? 'Свернуть' : `Показать (${filledEntries.length})`}
            </Button>
          }
        >
          <Collapse opened={rawOpen}>
            <Stack gap={6} pt={2}>
              <Switch
                size="xs" label="показать незаполненные"
                checked={showEmpty}
                onChange={(e) => setShowEmpty(e.currentTarget.checked)}
                mb={4}
              />
              {shownEntries.map(([k, v]) => (
                <Row key={k} label={k} value={v && String(v).trim() !== '' ? String(v) : '—'} />
              ))}
            </Stack>
          </Collapse>
          {!rawOpen && (
            <Text size="xs" c="dimmed">
              Полный ряд из ЗаказыШапки.csv — {filledEntries.length} заполненных из {rawEntries.length}
            </Text>
          )}
        </Section>
      )}
    </Stack>
  );
}
