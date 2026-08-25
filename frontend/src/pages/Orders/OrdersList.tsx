import React from 'react';
import { Stack, Text } from '@mantine/core';
import { OrdersRegistry } from './OrdersRegistry';

export function OrdersList() {
  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text fw={900} style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', letterSpacing: '-0.02em', lineHeight: 1.15 }}>
          Заказы
        </Text>
        <Text size="sm" c="dimmed">
          Реестр с пресетами колонок и карточкой по клику — вместо 66 столбцов вправо
        </Text>
      </Stack>

      <OrdersRegistry />
    </Stack>
  );
}
