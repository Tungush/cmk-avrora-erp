import React from 'react';
import { Button } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { apiErrorMessage, apiErrorTitle } from '../api/errors';

/**
 * Пусто или не загрузилось (04.09.2026).
 *
 * Раньше называлось MastLoader и рисовало силуэт вышки. Владелец
 * попросил убрать мачты: декоративный рисунок в пустом состоянии
 * ничего не сообщает, а места занимает больше, чем сам текст.
 * Остались подпись, пояснение и — если запрос упал — причина отказа
 * с кнопкой «Повторить».
 *
 * Подпись обязательна и должна называть, ЧЕГО нет («Заказов по такому
 * запросу нет»), а не быть общим «Нет данных»: пустой экран без
 * объяснения читается как поломка.
 */
export function EmptyState({
  title, hint, height = 168, error, onRetry,
}: {
  title: string;
  hint?: string;
  /** Минимальная высота: держит место, чтобы блок не прыгал при загрузке */
  height?: number;
  /** Запрос упал: показываем отказ вместо пустого состояния */
  error?: unknown;
  /** Повторить запрос — кнопка появляется, только если есть чем повторять */
  onRetry?: () => void;
}) {
  if (error) {
    return (
      <div className="empty-state" style={{ minHeight: height }} role="alert">
        <IconAlertTriangle size={28} aria-hidden className="empty-state__icon" />
        <div className="empty-state__title">{apiErrorTitle(error)}</div>
        <div className="empty-state__hint">{apiErrorMessage(error)}</div>
        {onRetry && (
          <Button
            variant="default"
            size="sm"
            mt="sm"
            leftSection={<IconRefresh size={16} aria-hidden />}
            onClick={onRetry}
          >
            Повторить
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="empty-state" style={{ minHeight: height }}>
      <div className="empty-state__title">{title}</div>
      {hint && <div className="empty-state__hint">{hint}</div>}
    </div>
  );
}
