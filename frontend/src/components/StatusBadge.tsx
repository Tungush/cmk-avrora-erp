import React from 'react';
import { Badge, Box } from '@mantine/core';
import { ORDER_STATUS_LABELS, ORDER_STATUS_COLORS } from '../utils/formatters';

interface StatusBadgeProps {
  status: string;
  labels?: Record<string, string>;
  colors?: Record<string, string>;
  className?: string;
}

const STATUS_TO_MANTINE: Record<string, 'blue' | 'green' | 'yellow' | 'cyan' | 'gray' | 'red' | 'teal'> = {
  NEW: 'red',
  DRAFT: 'gray',
  CONFIRMED: 'blue',
  IN_PRODUCTION: 'yellow',
  READY_TO_SHIP: 'cyan',
  SHIPPED: 'green',
  CLOSED: 'teal',
  CANCELLED: 'red',
};

export function StatusBadge({
  status,
  labels = ORDER_STATUS_LABELS,
  colors = ORDER_STATUS_COLORS,
}: StatusBadgeProps) {
  const label = labels[status] || status;
  const customColor = colors[status];
  const mantineColor = STATUS_TO_MANTINE[status] || 'gray';

  if (customColor) {
    return (
      <Badge
        variant="light"
        size="md"
        radius="xl"
        leftSection={
          <Box
            w={6}
            h={6}
            className={status === 'IN_PRODUCTION' || status === 'NEW' ? 'live-dot' : undefined}
            style={{
              borderRadius: 999,
              backgroundColor: customColor,
              color: customColor,
              boxShadow: `0 0 0 3px ${customColor}22`,
            }}
          />
        }
        style={{
          backgroundColor: `${customColor}15`,
          color: customColor,
          border: `1px solid ${customColor}30`,
        }}
      >
        {label}
      </Badge>
    );
  }

  return (
    <Badge color={mantineColor} variant="light" size="md" radius="xl">
      {label}
    </Badge>
  );
}
