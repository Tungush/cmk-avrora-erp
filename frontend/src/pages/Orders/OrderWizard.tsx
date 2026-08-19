import React, { useMemo, useState } from 'react';
import {
  Stack, Group, Text, Button, Stepper, Select, TextInput, NumberInput,
  Card, Table, ActionIcon, Divider, Badge,
} from '@mantine/core';
import { IconPlus, IconTrash, IconCheck, IconLock } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useCustomers, useArticles } from '../../hooks/useCatalog';
import { useCreateOrder } from '../../hooks/useOrders';
import { useAuthStore } from '../../store/auth';
import { formatCurrency } from '../../utils/formatters';

interface WizardLine {
  articleId: string;
  qty: number;
  unitPrice: number;
  prepayment: number;
}

const emptyLine = (): WizardLine => ({ articleId: '', qty: 1, unitPrice: 0, prepayment: 0 });

/**
 * Мастер создания заказа в 4 шага (§2.3 ②, эскиз 06 §6.1):
 * клиент → позиции → оплата → план вывоза. Заказ с >10 полями не влезает
 * в одну форму — шаги вместо простыни.
 */
export function OrderWizard({ onClose }: { onClose: () => void }) {
  const can = useAuthStore((s) => s.can);
  const canCommercial = can('write', 'order.commercial');

  const [step, setStep] = useState(0);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [orderType, setOrderType] = useState<string>('ФЗ');
  const [region, setRegion] = useState('');
  const [requestDate, setRequestDate] = useState(new Date().toISOString().split('T')[0]);
  const [plannedShipmentDate, setPlannedShipmentDate] = useState('');
  const [lines, setLines] = useState<WizardLine[]>([emptyLine()]);
  const [articleSearch, setArticleSearch] = useState('');

  const { data: customersData } = useCustomers({ pageSize: '200' });
  const { data: articlesData } = useArticles({ search: articleSearch, pageSize: 50 });
  const { mutateAsync: createOrder, isPending } = useCreateOrder();

  const customers: any[] = (customersData as any)?.data ?? [];
  const articles: any[] = (articlesData as any)?.data ?? [];

  const articleOptions = useMemo(
    () => articles.map((a) => ({ value: a.id, label: `${a.articleCode} · ${a.name}` })),
    [articles],
  );
  const articleById = useMemo(() => new Map(articles.map((a) => [a.id, a])), [articles]);

  const validLines = lines.filter((l) => l.articleId && l.qty > 0);
  const totalAmount = validLines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const customer = customers.find((c) => c.id === customerId);

  const stepValid = [
    !!customerId,                 // 0: клиент выбран
    validLines.length > 0,        // 1: есть хотя бы одна позиция
    true,                         // 2: оплата — необязательна
    true,                         // 3: подтверждение
  ];

  const updateLine = (i: number, patch: Partial<WizardLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const handleSubmit = async () => {
    try {
      const order: any = await createOrder({
        customerId,
        orderType,
        region: region || undefined,
        requestDate: requestDate || undefined,
        plannedShipmentDate: plannedShipmentDate || undefined,
        lines: validLines.map((l) => ({
          articleId: l.articleId,
          qty: l.qty,
          unit: 'шт',
          ...(canCommercial ? { unitPrice: l.unitPrice, prepayment: l.prepayment } : {}),
        })),
      });
      notifications.show({
        title: 'Заказ создан',
        message: `${order.orderNumber} · ${customer?.name ?? ''}`,
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      onClose();
    } catch (e: any) {
      notifications.show({
        title: 'Ошибка',
        message: e?.response?.data?.error?.message ?? 'Не удалось создать заказ',
        color: 'danger',
      });
    }
  };

  return (
    <Stack gap="md">
      <Stepper active={step} onStepClick={setStep} size="sm" radius="md" allowNextStepsSelect={false}>
        {/* Шаг 1 — клиент */}
        <Stepper.Step label="Клиент" description="Кто заказывает">
          <Stack gap="sm" mt="md">
            <Select
              label="Заказчик"
              placeholder="Выберите заказчика"
              data={customers.map((c) => ({ value: c.id, label: c.name }))}
              value={customerId}
              onChange={setCustomerId}
              searchable
              required
            />
            <Group grow>
              <Select
                label="Тип заказа"
                data={[
                  { value: 'ФЗ', label: 'ФЗ (фиксированный)' },
                  { value: 'ВЗ', label: 'ВЗ (внутренний)' },
                ]}
                value={orderType}
                onChange={(v) => setOrderType(v ?? 'ФЗ')}
              />
              <TextInput label="Регион" placeholder="Алматы" value={region} onChange={(e) => setRegion(e.target.value)} />
            </Group>
          </Stack>
        </Stepper.Step>

        {/* Шаг 2 — позиции */}
        <Stepper.Step label="Позиции" description="Что изготовить">
          <Stack gap="sm" mt="md">
            {lines.map((line, i) => (
              <Card key={i} withBorder radius="md" padding="sm">
                <Group align="flex-end" gap="sm" wrap="wrap">
                  <Select
                    label={i === 0 ? 'Артикул' : undefined}
                    placeholder="Поиск артикула..."
                    data={articleOptions}
                    value={line.articleId || null}
                    onChange={(v) => {
                      const art = v ? articleById.get(v) : null;
                      updateLine(i, {
                        articleId: v ?? '',
                        unitPrice: art ? Number(art.approvedPrice ?? 0) : line.unitPrice,
                      });
                    }}
                    searchable
                    onSearchChange={setArticleSearch}
                    style={{ flex: 1, minWidth: 240 }}
                  />
                  <NumberInput
                    label={i === 0 ? 'Кол-во' : undefined}
                    value={line.qty}
                    onChange={(v) => updateLine(i, { qty: Number(v) || 0 })}
                    min={1}
                    w={100}
                  />
                  <ActionIcon
                    variant="subtle"
                    color="danger"
                    onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                    disabled={lines.length === 1}
                    mb={4}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Card>
            ))}
            <Button
              variant="light"
              leftSection={<IconPlus size={15} />}
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
              w="fit-content"
            >
              Добавить позицию
            </Button>
          </Stack>
        </Stepper.Step>

        {/* Шаг 3 — оплата (пишет только коммерция; у остальных шаг честно заблокирован) */}
        <Stepper.Step label="Оплата" description="Цены и аванс">
          <Stack gap="sm" mt="md">
            {!canCommercial ? (
              <Card withBorder radius="md" padding="md" bg="var(--mantine-color-default-hover)">
                <Group gap="xs">
                  <IconLock size={15} style={{ color: 'var(--mantine-color-gray-5)' }} />
                  <Text size="sm" c="dimmed">
                    Коммерческие условия задаёт менеджер по продажам — у вашей роли нет права записи
                  </Text>
                </Group>
              </Card>
            ) : (
              validLines.map((line) => {
                const i = lines.indexOf(line);
                const art = articleById.get(line.articleId);
                return (
                  <Card key={i} withBorder radius="md" padding="sm">
                    <Group align="flex-end" gap="sm" wrap="wrap">
                      <Text size="sm" ff="monospace" fw={600} w={90} pb={8}>{art?.articleCode ?? '—'}</Text>
                      <NumberInput
                        label="Цена за ед."
                        value={line.unitPrice}
                        onChange={(v) => updateLine(i, { unitPrice: Number(v) || 0 })}
                        min={0}
                        w={150}
                        suffix=" ₸"
                        thousandSeparator=" "
                      />
                      <NumberInput
                        label="Аванс"
                        value={line.prepayment}
                        onChange={(v) => updateLine(i, { prepayment: Number(v) || 0 })}
                        min={0}
                        w={150}
                        suffix=" ₸"
                        thousandSeparator=" "
                      />
                      <Text size="sm" c="dimmed" pb={8} ff="monospace">
                        = {formatCurrency(line.qty * line.unitPrice)}
                      </Text>
                    </Group>
                  </Card>
                );
              })
            )}
          </Stack>
        </Stepper.Step>

        {/* Шаг 4 — план вывоза и подтверждение */}
        <Stepper.Step label="План вывоза" description="Сроки и итог">
          <Stack gap="sm" mt="md">
            <Group grow>
              <TextInput
                label="Дата заявки"
                type="date"
                value={requestDate}
                onChange={(e) => setRequestDate(e.target.value)}
              />
              <TextInput
                label="План вывоза"
                type="date"
                value={plannedShipmentDate}
                onChange={(e) => setPlannedShipmentDate(e.target.value)}
              />
            </Group>

            <Divider label="Проверьте перед созданием" labelPosition="center" />

            <Card withBorder radius="md" padding="md">
              <Stack gap={6}>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Заказчик</Text>
                  <Text size="sm" fw={600}>{customer?.name ?? '—'}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Тип · регион</Text>
                  <Text size="sm">{orderType}{region ? ` · ${region}` : ''}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">Позиций</Text>
                  <Text size="sm" ff="monospace">{validLines.length} · {validLines.reduce((s, l) => s + l.qty, 0)} шт</Text>
                </Group>
                {canCommercial && (
                  <Group justify="space-between">
                    <Text size="sm" c="dimmed">Сумма без НДС</Text>
                    <Text size="sm" fw={700} ff="monospace">{formatCurrency(totalAmount)}</Text>
                  </Group>
                )}
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">№ заказа</Text>
                  <Badge variant="light" color="gray" radius="xl">будет присвоен автоматически</Badge>
                </Group>
              </Stack>
            </Card>

            {validLines.length > 0 && (
              <Table withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Артикул</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Кол-во</Table.Th>
                    {canCommercial && <Table.Th style={{ textAlign: 'right' }}>Цена</Table.Th>}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {validLines.map((l, i) => (
                    <Table.Tr key={i}>
                      <Table.Td ff="monospace">{articleById.get(l.articleId)?.articleCode ?? '—'}</Table.Td>
                      <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{l.qty} шт</Table.Td>
                      {canCommercial && (
                        <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{formatCurrency(l.unitPrice)}</Table.Td>
                      )}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Stack>
        </Stepper.Step>
      </Stepper>

      <Group justify="space-between" mt="sm">
        <Button variant="default" onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>
          {step === 0 ? 'Отмена' : 'Назад'}
        </Button>
        {step < 3 ? (
          <Button onClick={() => setStep(step + 1)} disabled={!stepValid[step]}>
            Далее
          </Button>
        ) : (
          <Button onClick={handleSubmit} loading={isPending} disabled={!customerId || validLines.length === 0}>
            Создать заказ
          </Button>
        )}
      </Group>
    </Stack>
  );
}
