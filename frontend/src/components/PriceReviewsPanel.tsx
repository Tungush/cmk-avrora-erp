import React, { useState } from 'react';
import {
  Card, Stack, Group, Text, Badge, Button, NumberInput, TextInput, Skeleton,
} from '@mantine/core';
import { IconCheck, IconX, IconCoin } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { usePriceReviews, useDecidePriceReview } from '../hooks/useRouting';
import { useAuthStore } from '../store/auth';
import { formatCurrency, formatDate } from '../utils/formatters';
import type { PriceReview } from '../api/routing';

/** Одна заявка: расчёт против прайса + поле новой цены + решение */
function ReviewRow({ review }: { review: PriceReview }) {
  const decide = useDecidePriceReview();
  const [newPrice, setNewPrice] = useState<number | string>(Number(review.calculatedPrice));
  const [comment, setComment] = useState('');

  const handle = async (decision: 'approve' | 'reject') => {
    try {
      await decide.mutateAsync({
        id: review.id,
        decision,
        newPrice: decision === 'approve' ? Number(newPrice) : undefined,
        comment: comment || undefined,
      });
      notifications.show({
        title: decision === 'approve' ? 'Цена утверждена' : 'Заявка отклонена',
        message: decision === 'approve'
          ? `${review.article.articleCode}: новый прайс ${formatCurrency(Number(newPrice))}`
          : `${review.article.articleCode}: прайс остаётся ${formatCurrency(Number(review.approvedPrice))}`,
        color: decision === 'approve' ? 'success' : 'gray',
        icon: decision === 'approve' ? <IconCheck size={16} /> : <IconX size={16} />,
      });
    } catch (e: any) {
      notifications.show({
        title: 'Ошибка',
        message: e?.response?.data?.error?.message ?? 'Не удалось сохранить решение',
        color: 'danger',
      });
    }
  };

  const deviation = Number(review.deviationPct);

  return (
    <Card withBorder radius="md" padding="sm">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Stack gap={2} style={{ minWidth: 200, flex: 1 }}>
          <Group gap="xs">
            <Text size="sm" ff="monospace" fw={700} c="brand.7">{review.article.articleCode}</Text>
            <Badge
              size="sm"
              variant="light"
              radius="xl"
              color={Math.abs(deviation) > 15 ? 'danger' : 'warning'}
            >
              {deviation > 0 ? '+' : ''}{deviation.toLocaleString('ru-RU')} % к расчёту
            </Badge>
          </Group>
          <Text size="xs" lineClamp={1}>{review.article.name}</Text>
          <Text size="xs" c="dimmed">
            Прайс {formatCurrency(Number(review.approvedPrice))} · расчёт {formatCurrency(Number(review.calculatedPrice))}
            {' · '}{formatDate(review.createdAt)}
          </Text>
          {review.reason && <Text size="xs" c="dimmed" fs="italic" lineClamp={1}>{review.reason}</Text>}
        </Stack>

        <Group gap="xs" wrap="nowrap" align="flex-end">
          <NumberInput
            label="Новая цена"
            value={newPrice}
            onChange={setNewPrice}
            min={0}
            w={130}
            size="xs"
            suffix=" ₸"
            thousandSeparator=" "
          />
          <TextInput
            label="Комментарий"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            w={160}
            size="xs"
            placeholder="необязательно"
          />
          <Button
            size="xs"
            color="success"
            onClick={() => handle('approve')}
            loading={decide.isPending}
            disabled={!(Number(newPrice) > 0)}
            leftSection={<IconCheck size={13} />}
          >
            Утвердить
          </Button>
          <Button
            size="xs"
            variant="light"
            color="gray"
            onClick={() => handle('reject')}
            loading={decide.isPending}
            leftSection={<IconX size={13} />}
          >
            Отклонить
          </Button>
        </Group>
      </Group>
    </Card>
  );
}

/**
 * Задачи директора на пересмотр цен (§3.4): заявки создаются инженером вручную
 * или автоматически при |отклонении| > 5 % на пересчёте. Утверждение меняет
 * прайс с записью в аудит и историю цен — не молчаливый PATCH (§1.7).
 */
export function PriceReviewsPanel() {
  const can = useAuthStore((s) => s.can);
  const { data, isLoading } = usePriceReviews('PENDING');

  // Панель видна только тем, кто вправе утверждать цены (director, admin)
  if (!can('approve', 'article.price')) return null;
  if (isLoading) return <Skeleton height={90} radius="md" />;

  const reviews = data?.data ?? [];
  if (reviews.length === 0) return null;

  return (
    <Card withBorder radius="md" padding="md">
      <Group gap="xs" mb="sm">
        <IconCoin size={18} style={{ color: 'var(--mantine-color-warning-6)' }} />
        <Text fw={700} size="sm">Пересмотр цен — ждут решения</Text>
        <Badge variant="light" color="warning" radius="xl">{reviews.length}</Badge>
      </Group>
      <Stack gap="xs">
        {reviews.slice(0, 5).map((r) => <ReviewRow key={r.id} review={r} />)}
        {reviews.length > 5 && (
          <Text size="xs" c="dimmed">… и ещё {reviews.length - 5}</Text>
        )}
      </Stack>
    </Card>
  );
}
