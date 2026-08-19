import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card, Stack, Group, Text, Badge, Button, Table, Skeleton, Box, SimpleGrid,
  Alert, ActionIcon, Tooltip, Tabs,
} from '@mantine/core';
import {
  IconRefresh, IconAlertTriangle, IconArrowUp, IconArrowDown, IconPlugConnected,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { formatDateTime } from '../../utils/formatters';

interface IntegrationStatus {
  configured: boolean;
  endpoint: string | null;
  outbox: Record<string, number>;
  inbox: Record<string, number>;
}

interface Message {
  id: string;
  type: string;
  status: string;
  attempts: number;
  payload: Record<string, any>;
  createdAt?: string;
  receivedAt?: string;
  sentAt?: string | null;
  processedAt?: string | null;
  lastError?: string | null;
  error?: string | null;
  entityType?: string;
  externalKey?: string;
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'warning',
  SENT: 'success',
  PROCESSED: 'success',
  FAILED: 'danger',
  DEAD: 'danger',
  IGNORED: 'gray',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Ждёт',
  SENT: 'Отправлено',
  PROCESSED: 'Обработано',
  FAILED: 'Ошибка',
  DEAD: 'Не доставлено',
  IGNORED: 'Пропущено',
};

function StatusCounts({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  return (
    <Card withBorder radius="md" padding="md">
      <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb="xs">{title}</Text>
      {entries.length === 0 ? (
        <Text size="sm" c="dimmed">Сообщений нет</Text>
      ) : (
        <Group gap="xs">
          {entries.map(([status, count]) => (
            <Badge key={status} variant="light" color={STATUS_COLOR[status] ?? 'gray'} size="lg">
              {STATUS_LABEL[status] ?? status}: {count}
            </Badge>
          ))}
        </Group>
      )}
    </Card>
  );
}

function MessagesTable({ rows, onRetry }: { rows: Message[]; onRetry: (id: string) => void }) {
  if (rows.length === 0) {
    return <Text size="sm" c="dimmed" ta="center" py="lg">Сообщений нет</Text>;
  }
  return (
    <Box style={{ overflowX: 'auto' }}>
      <Table highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Когда</Table.Th>
            <Table.Th>Тип</Table.Th>
            <Table.Th>Статус</Table.Th>
            <Table.Th style={{ textAlign: 'right' }}>Попыток</Table.Th>
            <Table.Th>Ошибка</Table.Th>
            <Table.Th w={40} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((m) => {
            const err = m.lastError ?? m.error;
            return (
              <Table.Tr key={m.id}>
                <Table.Td ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                  {formatDateTime(m.createdAt ?? m.receivedAt)}
                </Table.Td>
                <Table.Td><Text size="sm" ff="monospace">{m.type}</Text></Table.Td>
                <Table.Td>
                  <Badge variant="light" color={STATUS_COLOR[m.status] ?? 'gray'} size="sm">
                    {STATUS_LABEL[m.status] ?? m.status}
                  </Badge>
                </Table.Td>
                <Table.Td ff="monospace" style={{ textAlign: 'right' }}>{m.attempts}</Table.Td>
                <Table.Td>
                  {err ? (
                    <Text size="xs" c="danger.7" lineClamp={2}>{err}</Text>
                  ) : (
                    <Text size="xs" c="dimmed">—</Text>
                  )}
                </Table.Td>
                <Table.Td>
                  {(m.status === 'FAILED' || m.status === 'DEAD') && (
                    <Tooltip label="Повторить доставку">
                      <ActionIcon variant="subtle" size="sm" onClick={() => onRetry(m.id)}>
                        <IconRefresh size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

/**
 * Журнал обмена с 1С (08_INTEGRATION_1C.md §3).
 * Показывает то, что в Excel было невидимо: что не долетело и почему.
 */
export function Integration() {
  const qc = useQueryClient();

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['integration-status'],
    queryFn: () => api.get<IntegrationStatus>('/integrations/status').then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: messages, isLoading } = useQuery({
    queryKey: ['integration-messages'],
    queryFn: () => api.get<{ outbox: Message[]; inbox: Message[] }>('/integrations/messages').then((r) => r.data),
    refetchInterval: 30_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['integration-status'] });
    qc.invalidateQueries({ queryKey: ['integration-messages'] });
  };

  const flush = useMutation({
    mutationFn: () => api.post('/integrations/outbox/flush').then((r) => r.data),
    onSuccess: (d: any) => {
      notifications.show({
        title: d.skipped ? 'Отправка пропущена' : 'Отправлено',
        message: d.skipped ? `${d.reason} · ждёт: ${d.waiting}` : `Успешно: ${d.sent}, с ошибкой: ${d.failed}`,
        color: d.skipped ? 'warning' : 'success',
      });
      invalidate();
    },
  });

  const process = useMutation({
    mutationFn: () => api.post('/integrations/inbox/process').then((r) => r.data),
    onSuccess: (d: any) => {
      notifications.show({
        title: 'Входящие разобраны',
        message: `Обработано: ${d.processed}, ошибок: ${d.failed}, пропущено: ${d.ignored}`,
        color: d.failed > 0 ? 'warning' : 'success',
      });
      invalidate();
    },
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/integrations/messages/${id}/retry`).then((r) => r.data),
    onSuccess: () => {
      notifications.show({ title: 'Поставлено в очередь', message: 'Сообщение будет отправлено заново', color: 'success' });
      invalidate();
    },
  });

  if (statusLoading || isLoading) {
    return (
      <Stack gap="md">
        <Skeleton height={90} radius="md" />
        <Skeleton height={320} radius="md" />
      </Stack>
    );
  }

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={700} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.01em', lineHeight: 1.15 }}>
          Обмен с 1С
        </Text>
        <Text size="sm" c="dimmed">
          Что ушло, что пришло и что не долетело — вместо ручных выгрузок в Excel
        </Text>
      </Stack>

      {!status?.configured && (
        <Alert color="warning" radius="md" variant="light" icon={<IconPlugConnected size={17} />}>
          <Text size="sm" fw={600}>Адрес 1С не задан</Text>
          <Text size="xs">
            Исходящие сообщения копятся со статусом «Ждёт» и уйдут сразу после настройки
            <Text span ff="monospace"> INTEGRATION_1C_URL</Text>. Входящие вебхуки принимаются уже сейчас.
          </Text>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <StatusCounts title="Исходящие (мы → 1С)" counts={status?.outbox ?? {}} />
        <StatusCounts title="Входящие (1С → мы)" counts={status?.inbox ?? {}} />
      </SimpleGrid>

      <Group gap="sm">
        <Button
          leftSection={<IconArrowUp size={16} />}
          onClick={() => flush.mutate()}
          loading={flush.isPending}
        >
          Отправить накопленное
        </Button>
        <Button
          variant="default"
          leftSection={<IconArrowDown size={16} />}
          onClick={() => process.mutate()}
          loading={process.isPending}
        >
          Разобрать входящие
        </Button>
      </Group>

      <Card withBorder radius="md" padding="md">
        <Tabs defaultValue="out" radius="md" keepMounted={false}>
          <Tabs.List mb="md">
            <Tabs.Tab value="out" leftSection={<IconArrowUp size={15} />}>
              Исходящие{messages?.outbox.length ? ` (${messages.outbox.length})` : ''}
            </Tabs.Tab>
            <Tabs.Tab value="in" leftSection={<IconArrowDown size={15} />}>
              Входящие{messages?.inbox.length ? ` (${messages.inbox.length})` : ''}
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="out">
            <MessagesTable rows={messages?.outbox ?? []} onRetry={(id) => retry.mutate(id)} />
          </Tabs.Panel>
          <Tabs.Panel value="in">
            <MessagesTable rows={messages?.inbox ?? []} onRetry={(id) => retry.mutate(id)} />
          </Tabs.Panel>
        </Tabs>
      </Card>

      <Card withBorder radius="md" padding="md">
        <Group gap="xs" mb="xs">
          <IconAlertTriangle size={16} style={{ color: 'var(--warn-6)' }} />
          <Text fw={700} size="sm">Как подключить 1С</Text>
        </Group>
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            1. Задать <Text span ff="monospace">INTEGRATION_1C_URL</Text> и{' '}
            <Text span ff="monospace">INTEGRATION_1C_SECRET</Text> в окружении сервиса.
          </Text>
          <Text size="xs" c="dimmed">
            2. В 1С настроить отправку на <Text span ff="monospace">POST /api/v1/integrations/1c/webhook/&#123;тип&#125;</Text>{' '}
            с заголовком <Text span ff="monospace">X-Signature</Text> (HMAC-SHA256 тела на общем секрете).
          </Text>
          <Text size="xs" c="dimmed">
            3. Типы: <Text span ff="monospace">nomenclature.created</Text>,{' '}
            <Text span ff="monospace">receipt.posted</Text>,{' '}
            <Text span ff="monospace">stock.snapshot</Text>. Каждое сообщение должно нести{' '}
            <Text span ff="monospace">externalKey</Text> — GUID документа 1С для идемпотентности.
          </Text>
        </Stack>
      </Card>
    </Stack>
  );
}
