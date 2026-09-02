import React, { useState } from 'react';
import {
  Card, Stack, Text, Table, Skeleton, Box, Group, Button, TextInput,
  Badge, Modal, Textarea, Pagination, SegmentedControl,
} from '@mantine/core';
import { IconSearch, IconCoin, IconCheck } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import api from '../../api/client';
import { useArticles } from '../../hooks/useCatalog';
import { useAuthStore } from '../../store/auth';
import { PriceReviewsPanel } from '../../components/PriceReviewsPanel';
import { formatCurrency } from '../../utils/formatters';

/**
 * Прайс (28.08.2026). Данные о ценах жили в модели с самого начала, но
 * экрана не существовало: посмотреть прайс списком и запустить пересмотр
 * было негде — цены 2026 года жили в Excel и, как показал разбор файла,
 * из-за съехавших формул в заказы даже там не попадали.
 *
 * Механика пересмотра НЕ новая: заявка → директор утверждает (аудит и
 * история цен пишутся там же). Эта страница — вход в неё списком.
 */
export function Prices() {
  const qc = useQueryClient();
  const hasRole = useAuthStore((s) => s.hasRole);
  const isDirector = hasRole(['director', 'admin']);
  const canRequest = hasRole(['engineer', 'accountant', 'sales_manager', 'admin']);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<'priced' | 'all'>('priced');
  const [reviewFor, setReviewFor] = useState<any | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading } = useArticles({
    search, page, pageSize: 30,
    ...(scope === 'priced' ? { onlyPriced: true } : {}),
  });

  const requestReview = useMutation({
    mutationFn: (articleId: string) =>
      api.post(`/articles/${articleId}/price-review`, { reason: reason.trim() || undefined }).then((r) => r.data),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['price-reviews'] });
      notifications.show({
        title: 'Заявка на пересмотр подана',
        message: `${res.article.articleCode} — решает директор`,
        color: 'success',
        icon: <IconCheck size={16} />,
      });
      setReviewFor(null); setReason('');
    },
    onError: (e: any) => notifications.show({
      title: 'Не подано',
      message: e?.response?.data?.error?.message ?? 'Ошибка',
      color: 'danger',
    }),
  });

  const rows: any[] = data?.data ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.meta?.total ?? 0) / 30));

  const deviation = (a: any): number | null => {
    const appr = Number(a.approvedPrice);
    const calc = Number(a.specPrice);
    if (!(appr > 0) || !(calc > 0)) return null;
    return Math.round(((appr - calc) / calc) * 1000) / 10;
  };

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={700} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.01em', lineHeight: 1.15 }}>
          Прайс
        </Text>
        <Text size="sm" c="dimmed">
          Утверждённые цены изделий против расчёта по спецификации.
          Цена меняется только через пересмотр — утверждает директор
        </Text>
      </Stack>

      <SegmentedControl
        value={scope}
        onChange={(v) => { setScope(v as 'priced' | 'all'); setPage(1); }}
        size="sm"
        w="fit-content"
        data={[
          { value: 'priced', label: 'Прайс-лист' },
          { value: 'all', label: 'Весь каталог' },
        ]}
      />

      {/* Директор видит очередь заявок прямо здесь, не бегая на дашборд */}
      {isDirector && <PriceReviewsPanel />}

      <TextInput
        placeholder="Код, название или старый код…"
        leftSection={<IconSearch size={15} />}
        value={search}
        onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        w={340}
        size="sm"
      />

      <Card withBorder radius="md" padding={0}>
        {isLoading ? (
          <Stack gap={4} p="md">{[...Array(8)].map((_, i) => <Skeleton key={i} height={34} radius="sm" />)}</Stack>
        ) : (
          <Box style={{ overflowX: 'auto' }}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Изделие</Table.Th>
                  <Table.Th ta="right">Утв. цена</Table.Th>
                  <Table.Th ta="right">Расчёт по спецификации</Table.Th>
                  <Table.Th ta="right">Отклонение</Table.Th>
                  {canRequest && <Table.Th w={150} />}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((a) => {
                  const dev = deviation(a);
                  return (
                    <Table.Tr key={a.id}>
                      <Table.Td>
                        <Text size="sm" ff="monospace" fw={600} c="brand.7">{a.articleCode}</Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>{a.name}</Text>
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                        {Number(a.approvedPrice) > 0
                          ? <Text span fw={700}>{formatCurrency(Number(a.approvedPrice))}</Text>
                          : <Text span size="xs" c="dimmed">не утверждена</Text>}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                        {Number(a.specPrice) > 0
                          ? formatCurrency(Number(a.specPrice))
                          : <Text span size="xs" c="dimmed">—</Text>}
                      </Table.Td>
                      <Table.Td ta="right">
                        {dev == null ? (
                          <Text size="xs" c="dimmed">—</Text>
                        ) : (
                          // Цена ниже расчёта — продаём дешевле себестоимости с маржой
                          <Badge
                            size="sm" variant="light" radius="xl"
                            color={dev < 0 ? 'danger' : Math.abs(dev) > 15 ? 'warning' : 'teal'}
                          >
                            {dev > 0 ? '+' : ''}{dev.toLocaleString('ru-RU')} %
                          </Badge>
                        )}
                      </Table.Td>
                      {canRequest && (
                        <Table.Td>
                          <Button
                            size="compact-xs"
                            variant="light"
                            leftSection={<IconCoin size={13} />}
                            onClick={() => setReviewFor(a)}
                          >
                            Пересмотр цены
                          </Button>
                        </Table.Td>
                      )}
                    </Table.Tr>
                  );
                })}
                {rows.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <Text size="sm" c="dimmed" ta="center" py="lg">Ничего не найдено</Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Card>

      {totalPages > 1 && (
        <Group justify="center">
          <Pagination value={page} onChange={setPage} total={totalPages} size="sm" radius="md" />
        </Group>
      )}

      <Modal
        opened={reviewFor !== null}
        onClose={() => setReviewFor(null)}
        title={<Text fw={700}>Пересмотр цены: {reviewFor?.articleCode}</Text>}
        radius="md" centered
      >
        {reviewFor && (
          <Stack gap="md">
            <Text size="sm" c="dimmed">{reviewFor.name}</Text>
            <Group gap="xl">
              <Stack gap={0}>
                <Text size="xs" c="dimmed">Сейчас в прайсе</Text>
                <Text fw={700} ff="monospace">
                  {Number(reviewFor.approvedPrice) > 0 ? formatCurrency(Number(reviewFor.approvedPrice)) : '—'}
                </Text>
              </Stack>
              <Stack gap={0}>
                <Text size="xs" c="dimmed">Расчёт по спецификации</Text>
                <Text fw={700} ff="monospace">
                  {Number(reviewFor.specPrice) > 0 ? formatCurrency(Number(reviewFor.specPrice)) : '—'}
                </Text>
              </Stack>
            </Group>
            <Textarea
              label="Почему цену надо пересмотреть"
              placeholder="подорожал металл, изменился состав…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autosize minRows={2}
            />
            <Text size="xs" c="dimmed">
              Новую цену называет директор при утверждении — заявка лишь запускает пересмотр.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setReviewFor(null)}>Отмена</Button>
              <Button loading={requestReview.isPending} onClick={() => requestReview.mutate(reviewFor.id)}>
                Подать заявку
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
