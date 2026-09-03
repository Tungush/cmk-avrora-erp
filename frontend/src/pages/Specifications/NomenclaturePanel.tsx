import React, { useState } from 'react';
import {
  Modal, Stack, Group, Text, Badge, Button, TextInput, Textarea, Select, Card, Skeleton,
} from '@mantine/core';
import { IconCheck, IconX, IconClipboardPlus } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import {
  useNomenclatureRequests, useCreateNomenclatureRequest, useDecideNomenclatureRequest,
} from '../../hooks/useCatalog';
import { useAuthStore } from '../../store/auth';
import { formatDate } from '../../utils/formatters';
import { PaginationBar, usePagedList } from '../../components/PaginationBar';
import { FadeSwap, Stagger } from '../../components/motion';

const SERIES_OPTIONS = [
  { value: 'k', label: 'k — крепёж' },
  { value: 'n', label: 'n — изделия' },
  { value: 'd', label: 'd — детали' },
  { value: 't', label: 't — трубные' },
  { value: 'z', label: 'z — заказные' },
];

/** Заявок на странице списка */
const REQUESTS_PAGE_SIZE = 25;

/** Бейдж вне таблицы: lg — 13 px (единственный размер не мельче 12 px), высота под строку */
const tagProps = { size: 'lg', h: 22, px: 8, variant: 'light' } as const;

/**
 * Модал «Запросить номенклатуру»: артикула нет — заявка уходит на создание
 * (процесс «как в 1С»: при одобрении номенклатуре присваивается артикул).
 */
export function RequestNomenclatureModal({
  opened, onClose, initialName,
}: {
  opened: boolean;
  onClose: () => void;
  initialName?: string;
}) {
  const [name, setName] = useState(initialName ?? '');
  const [series, setSeries] = useState<string | null>('n');
  const [reason, setReason] = useState('');
  const create = useCreateNomenclatureRequest();

  React.useEffect(() => {
    if (opened) setName(initialName ?? '');
  }, [opened, initialName]);

  const submit = async () => {
    try {
      await create.mutateAsync({
        proposedName: name,
        series: series ?? undefined,
        reason: reason || undefined,
      });
      notifications.show({
        title: 'Заявка отправлена',
        message: 'После одобрения номенклатуре будет присвоен артикул',
        color: 'success',
        icon: <IconCheck aria-hidden size={16} />,
      });
      setReason('');
      onClose();
    } catch (e: any) {
      const err = e?.response?.data?.error;
      notifications.show({
        title: err?.code === 'ARTICLE_EXISTS' ? 'Изделие уже есть' : 'Ошибка',
        message: err?.message ?? 'Не удалось создать заявку',
        color: err?.code === 'ARTICLE_EXISTS' ? 'warning' : 'danger',
      });
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={700}>Заявка на номенклатуру</Text>} size="md" radius="md" centered>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Артикула нет в справочнике — заявка уходит на создание номенклатуры.
          При одобрении будет присвоен следующий свободный артикул серии.
        </Text>
        <TextInput
          label="Наименование изделия"
          placeholder="U-болт под трубу ф89мм"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          data-autofocus
        />
        <Select label="Серия артикула" data={SERIES_OPTIONS} value={series} onChange={setSeries} />
        <Textarea
          label="Обоснование"
          placeholder="Под заказ П-…, аналога в справочнике нет"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>Отмена</Button>
          <Button onClick={submit} disabled={!name.trim()} loading={create.isPending}>
            Отправить заявку
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING: { label: 'На рассмотрении', color: 'warning' },
  APPROVED: { label: 'Создана', color: 'success' },
  REJECTED: { label: 'Отклонена', color: 'gray' },
};

/** Список заявок: инженер/админ присваивают артикул («создать в 1С») или отклоняют */
export function NomenclatureRequestsModal({
  opened, onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const can = useAuthStore((s) => s.can);
  const canDecide = can('write', 'article.core'); // engineer, admin
  const { data: requests, isLoading } = useNomenclatureRequests();
  const decide = useDecideNomenclatureRequest();
  const paged = usePagedList(requests ?? [], REQUESTS_PAGE_SIZE, opened);

  const handle = async (id: string, decision: 'approve' | 'reject') => {
    try {
      const res: any = await decide.mutateAsync({ id, decision });
      notifications.show({
        title: decision === 'approve' ? 'Номенклатура создана' : 'Заявка отклонена',
        message: decision === 'approve'
          ? `Присвоен артикул ${res?.article?.articleCode ?? '—'}`
          : 'Прайс и справочник не изменены',
        color: decision === 'approve' ? 'success' : 'gray',
        icon: decision === 'approve' ? <IconCheck aria-hidden size={16} /> : <IconX aria-hidden size={16} />,
      });
    } catch (e: any) {
      notifications.show({
        title: 'Ошибка',
        message: e?.response?.data?.error?.message ?? 'Не удалось сохранить решение',
        color: 'danger',
      });
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={700}>Заявки на номенклатуру</Text>} size="lg" radius="md" centered>
      {isLoading ? (
        <Skeleton height={160} radius="md" />
      ) : !requests || requests.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">Заявок нет</Text>
      ) : (
        <Stack gap="sm">
          <FadeSwap swapKey={paged.page}>
            <Stack gap="xs">
              <Stagger>
                {paged.slice.map((r) => {
                  const meta = STATUS_META[r.status] ?? { label: r.status, color: 'gray' };
                  return (
                    <Card key={r.id} withBorder radius="md" padding="sm">
                      <Group justify="space-between" wrap="wrap" gap="sm">
                        <Stack gap={4} style={{ flex: 1, minWidth: 220 }}>
                          <Group gap="xs" wrap="wrap">
                            <Text size="md" fw={600} lineClamp={1}>{r.proposedName}</Text>
                            <Badge {...tagProps} color={meta.color}>{meta.label}</Badge>
                            {r.article && (
                              <Badge {...tagProps} color="brand" ff="monospace">{r.article.articleCode}</Badge>
                            )}
                          </Group>
                          <Text size="xs" c="dimmed">
                            {r.requestedBy ?? '—'} · {formatDate(r.createdAt)}
                            {r.series ? ` · серия «${r.series}»` : ''}
                          </Text>
                          {r.reason && <Text size="xs" c="dimmed" fs="italic" lineClamp={1}>{r.reason}</Text>}
                        </Stack>
                        {r.status === 'PENDING' && canDecide && (
                          <Group gap="xs" wrap="nowrap">
                            <Button
                              color="success"
                              leftSection={<IconCheck aria-hidden size={16} />}
                              onClick={() => handle(r.id, 'approve')}
                              loading={decide.isPending}
                            >
                              Присвоить артикул
                            </Button>
                            <Button
                              variant="light"
                              color="gray"
                              leftSection={<IconX aria-hidden size={16} />}
                              onClick={() => handle(r.id, 'reject')}
                              loading={decide.isPending}
                            >
                              Отклонить
                            </Button>
                          </Group>
                        )}
                      </Group>
                    </Card>
                  );
                })}
              </Stagger>
            </Stack>
          </FadeSwap>
          {paged.total > REQUESTS_PAGE_SIZE && (
            <PaginationBar
              page={paged.page}
              total={paged.total}
              pageSize={REQUESTS_PAGE_SIZE}
              onPageChange={paged.setPage}
              variant="compact"
              noun="заявок"
            />
          )}
        </Stack>
      )}
    </Modal>
  );
}

/** Кнопка «Заявки (N)» для шапки Спецификаций */
export function NomenclatureRequestsButton() {
  const [opened, setOpened] = useState(false);
  const { data } = useNomenclatureRequests('PENDING');
  const pending = data?.length ?? 0;

  return (
    <>
      <Button
        variant="default"
        leftSection={<IconClipboardPlus aria-hidden size={16} />}
        onClick={() => setOpened(true)}
      >
        Заявки{pending > 0 ? ` (${pending})` : ''}
      </Button>
      <NomenclatureRequestsModal opened={opened} onClose={() => setOpened(false)} />
    </>
  );
}
