import React from 'react';
import { Badge, Box } from '@mantine/core';
import { ORDER_STATUS_LABELS, ORDER_STATUS_COLORS } from '../utils/formatters';

interface StatusBadgeProps {
  status: string;
  labels?: Record<string, string>;
  colors?: Record<string, string>;
  className?: string;
}

/**
 * Доля тона в подложке (03.09.2026).
 *
 * Раньше альфа приклеивалась к hex строкой: `${customColor}15`. С
 * семантическим токеном так нельзя — к `var(--s-ok)` суффикс не
 * приклеишь. Да и на глаз это врало: 8 % подложки под охрой давали
 * бейджу «В производстве» 2,71:1 при 13 px вместо нужных 4,5.
 *
 * Мешаем не с `transparent`, а с белой поверхностью: тогда контраст
 * не зависит от того, лежит пилюля на карточке или на кремовом холсте.
 * Полупрозрачная подложка на холсте темнеет, и тихий тон проваливался
 * до 4,33:1 — а так везде ровно 5,3:1.
 */
const mix = (tone: string, pct: number) =>
  `color-mix(in srgb, ${tone} ${pct}%, var(--s-surface))`;
/** Ореол точки — декоративный, ему прозрачность не мешает */
const halo = (tone: string) => `color-mix(in srgb, ${tone} 18%, transparent)`;

/**
 * Пилюля статуса заказа.
 *
 * Карты цветов Mantine (blue / cyan / yellow / teal) здесь больше нет:
 * этих оттенков нет в теме, и библиотека подставляла свою дефолтную
 * палитру — на тёплом холсте они выглядели чужими. Тон берётся только
 * из ORDER_STATUS_COLORS, то есть из токенов палитры.
 */
export function StatusBadge({
  status,
  labels = ORDER_STATUS_LABELS,
  colors = ORDER_STATUS_COLORS,
}: StatusBadgeProps) {
  const label = labels[status] || status;
  // Незнакомый код статуса (в 1С завели новый) не красим — тихий тон
  const tone = colors[status] ?? 'var(--s-text-quiet)';
  // Живая точка — единственное, что отличает «в работе прямо сейчас»
  // от просто «в работе»: цветом эти два статуса теперь не разводятся
  const live = status === 'IN_PRODUCTION' || status === 'NEW';

  return (
    <Badge
      variant="light"
      size="md"
      radius="xl"
      leftSection={
        <Box
          w={6}
          h={6}
          className={live ? 'live-dot' : undefined}
          style={{
            borderRadius: 999,
            backgroundColor: tone,
            color: tone,
            boxShadow: `0 0 0 3px ${halo(tone)}`,
          }}
        />
      }
      style={{
        backgroundColor: mix(tone, 10),
        color: tone,
        border: `1px solid ${mix(tone, 24)}`,
      }}
    >
      {label}
    </Badge>
  );
}
