import React from 'react';
import { Link } from 'react-router-dom';
import { Stack, Text, Group, Card, Badge, ThemeIcon, SimpleGrid, Anchor } from '@mantine/core';
import { IconTruck, IconCalendarClock, IconClipboardList } from '@tabler/icons-react';
import { useAuthStore } from '../store/auth';
import { RoleWidgets } from '../components/RoleWidgets';
import { ShopFloor } from './Production/ShopFloor';
import { DirectorDashboard } from './Dashboard/DirectorDashboard';
import { OrdersInbox } from './Orders/OrdersInbox';
import { ContractorWork } from './Production/ContractorWork';
import { ROLE_LABELS } from '../utils/roles';

/**
 * «Моя работа» — единственный экран, с которого начинается день
 * (решение 23.08.2026).
 *
 * Раньше меню давало 9–13 пунктов каждой роли, хотя мастеру нужен один,
 * а кладовщику два: фильтрация по правам была формальной. Теперь человек
 * попадает сразу в свою очередь, а разделы остаются способом найти,
 * а не местом, куда надо идти.
 *
 * Это не новый функционал, а диспетчер: собирает уже существующие экраны
 * по роли, чтобы не заводить пятую версию одного и того же списка.
 */
export function MyWork() {
  const user = useAuthStore((s) => s.user);
  const hasRole = useAuthStore((s) => s.hasRole);
  const roles = user?.roles ?? [];
  const roleLabel = roles[0] ? ROLE_LABELS[roles[0]] ?? roles[0] : 'Оператор';

  // Мастер цеха: его работа — это очередь переделов, других экранов ему не нужно
  if (hasRole(['shop_foreman']) && !hasRole(['admin', 'director', 'planner'])) {
    return <ShopFloor />;
  }

  // Директор: маржа, что требует решения, деньги
  if (hasRole(['director'])) {
    return <DirectorDashboard />;
  }

  // Плановик и менеджер: приём заказов из 1С, затем подряд —
  // отдельным разделом он больше не висит (решение пользователя)
  if (hasRole(['planner', 'sales_manager', 'admin'])) {
    return (
      <Stack gap="xl">
        <OrdersInbox />

        <Stack gap="xs">
          <Group gap="sm">
            <ThemeIcon variant="light" color="orange" radius="md" size="sm">
              <IconTruck size={14} />
            </ThemeIcon>
            <Text fw={700} size="lg">Подряд</Text>
          </Group>
          <ContractorWork />
        </Stack>

        <Group gap="md">
          <Anchor component={Link} to="/production" underline="never">
            <Card withBorder radius="md" padding="md">
              <Group gap="sm">
                <ThemeIcon variant="light" radius="md"><IconCalendarClock size={16} /></ThemeIcon>
                <Text size="sm" fw={600}>План производства по неделям</Text>
              </Group>
            </Card>
          </Anchor>
          <Anchor component={Link} to="/production/kanban" underline="never">
            <Card withBorder radius="md" padding="md">
              <Group gap="sm">
                <ThemeIcon variant="light" radius="md"><IconClipboardList size={16} /></ThemeIcon>
                <Text size="sm" fw={600}>Очередь цеха</Text>
              </Group>
            </Card>
          </Anchor>
        </Group>
      </Stack>
    );
  }

  // Остальные роли: ролевые виджеты — то, что уже собрано по правам
  return (
    <Stack gap="md">
      <Stack gap={4}>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
          Моя работа
        </Text>
        <Group gap="sm">
          <Text fw={700} size="xl">Что ждёт сегодня</Text>
          <Badge variant="light" color="gray" radius="xl">{roleLabel}</Badge>
        </Group>
      </Stack>
      <RoleWidgets />
    </Stack>
  );
}
