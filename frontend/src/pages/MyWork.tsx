import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Stack, Text, Group, Card, Badge, ThemeIcon, SimpleGrid, Anchor, Alert,
} from '@mantine/core';
import {
  IconTruck, IconCalendarClock, IconClipboardList, IconInbox,
  IconTarget, IconPackage, IconHammer, IconAlertTriangle,
} from '@tabler/icons-react';
import api from '../api/client';
import { formatCurrency, plural } from '../utils/formatters';
import { useAuthStore } from '../store/auth';
import { RoleWidgets } from '../components/RoleWidgets';
import { ShopFloor } from './Production/ShopFloor';
import { DirectorDashboard } from './Dashboard/DirectorDashboard';
import { OrdersInbox } from './Orders/OrdersInbox';
import { ContractorWork } from './Production/ContractorWork';
import { Stagger } from '../components/motion';
import { ROLE_LABELS } from '../utils/roles';

// Один аккаунт может держать сразу несколько ролей (30.08.2026: общий
// PIN убран, но многоролевые учётки остались — Settings → Пользователи
// выдаёт их по необходимости). Маршрутизация «первая подошедшая роль»
// тут не работает: человек с 3+ ролями мог зайти отметить этап, а мог —
// завести прогноз спроса. Показываем меню задач вместо угадывания ветки.
const SHARED_LOGIN_ROLE_THRESHOLD = 3;

const HUB_TASKS = [
  { to: '/production/kanban', icon: IconHammer, color: 'orange', title: 'Отметить изготовление', subtitle: 'Что готово по изделиям заказа' },
  { to: '/orders/inbox', icon: IconInbox, color: 'blue', title: 'Заказы из 1С', subtitle: 'Принять новые в производство' },
  { to: '/production/contractors', icon: IconTruck, color: 'grape', title: 'Подряд', subtitle: 'Заявки в Б24, разнесение по заказам' },
  { to: '/sales/pipeline', icon: IconTarget, color: 'success', title: 'Прогноз спроса', subtitle: 'Объекты и сделки до формального заказа' },
  { to: '/warehouse?tab=batches', icon: IconPackage, color: 'yellow', title: 'Партии и резервы', subtitle: 'Карантин цен, истекающие резервы' },
  { to: '/production', icon: IconCalendarClock, color: 'gray', title: 'План по неделям', subtitle: 'Загрузка цеха вперёд' },
];

/**
 * Принято по акту, но не разнесено ни на один заказ (26.08.2026).
 *
 * Самая опасная точка подряда: деньги реальны и уже оплачиваются, но не
 * сидят ни в одной себестоимости — подряд занижен, а штат на этих работах
 * при этом считается по норме на все 100 %. Тишины здесь быть не должно,
 * поэтому это цифра на первом экране дня, а не строка в глубине раздела.
 */
function UnallocatedContractorAlert() {
  const { data } = useQuery({
    queryKey: ['contractor-requests', 'unallocated'],
    queryFn: () => api.get('/contractor-requests').then((r) => r.data),
    refetchInterval: 120_000,
  });
  const u = data?.unallocated;
  if (!u || u.requests === 0) return null;
  return (
    <Anchor component={Link} to="/production/contractors" underline="never" c="inherit">
      <Alert color="danger" variant="light" radius="md" icon={<IconAlertTriangle size={18} />}>
        <Text size="sm" fw={600}>
          Подряд не разнесён: {u.requests}{' '}
          {plural(u.requests, 'заявка', 'заявки', 'заявок')}
          {u.amount > 0 ? ` на ${formatCurrency(u.amount)}` : ''}
        </Text>
        <Text size="xs" c="dimmed">
          Работа принята и оплачивается, но не попала ни в один заказ — штат
          на этих работах пока считается по норме целиком
        </Text>
      </Alert>
    </Anchor>
  );
}

function TaskHub() {
  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
          Моя работа
        </Text>
        <Text fw={700} size="xl">Что заполняем сегодня</Text>
      </Stack>
      <UnallocatedContractorAlert />
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
        <Stagger>
          {HUB_TASKS.map((task) => (
            <Anchor component={Link} to={task.to} key={task.to} underline="never" c="inherit">
              <Card withBorder radius="md" padding="lg" h="100%" style={{ cursor: 'pointer' }}>
                <Stack gap="sm">
                  <ThemeIcon variant="light" color={task.color} radius="md" size={40}>
                    <task.icon size={20} />
                  </ThemeIcon>
                  <Stack gap={2}>
                    <Text fw={700} size="sm">{task.title}</Text>
                    <Text size="xs" c="dimmed">{task.subtitle}</Text>
                  </Stack>
                </Stack>
              </Card>
            </Anchor>
          ))}
        </Stagger>
      </SimpleGrid>
    </Stack>
  );
}

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

  // Директор: маржа, что требует решения, деньги
  if (hasRole(['director'])) {
    return <DirectorDashboard />;
  }

  // Общий вход «для остальных» несёт сразу все операционные роли —
  // меню задач вместо угадывания одной ветки
  if (roles.length >= SHARED_LOGIN_ROLE_THRESHOLD) {
    return <TaskHub />;
  }

  // Мастер цеха: его работа — это очередь изделий, других экранов ему не нужно
  if (hasRole(['shop_foreman'])) {
    return <ShopFloor />;
  }

  // Плановик и менеджер: приём заказов из 1С, затем подряд —
  // отдельным разделом он больше не висит (решение пользователя)
  if (hasRole(['planner', 'sales_manager', 'admin'])) {
    return (
      <Stack gap="xl">
        <OrdersInbox />

        <Stack gap="xs">
          <Group gap="sm">
            <ThemeIcon variant="light" color="warning" radius="md" size="sm">
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
          <Anchor component={Link} to="/sales/pipeline" underline="never">
            <Card withBorder radius="md" padding="md">
              <Group gap="sm">
                <ThemeIcon variant="light" color="success" radius="md"><IconTarget size={16} /></ThemeIcon>
                <Text size="sm" fw={600}>Прогноз спроса</Text>
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
