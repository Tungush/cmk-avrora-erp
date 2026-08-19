import React from 'react';
import { NavLink as RouterNavLink, useLocation } from 'react-router-dom';
import { NavLink, Stack, Text, Group, Avatar, Divider, Box } from '@mantine/core';
import {
  IconLayoutDashboard,
  IconShoppingCart,
  IconCalendarClock,
  IconLayoutKanban,
  IconPackage,
  IconBuildingBank,
  IconBook,
  IconRuler2,
  IconShieldLock,
  IconPlugConnected,
} from '@tabler/icons-react';
import { useAuthStore } from '../../store/auth';
import { canAccessModule, ROLE_LABELS } from '../../utils/roles';

interface SidebarProps {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const user = useAuthStore((state) => state.user);
  const permissions = useAuthStore((state) => state.permissions);
  const { pathname } = useLocation();

  // Меню собирается из прав: у кладовщика останется 4 пункта, у директора — все (§2.2)
  const navItems = [
    { to: '/dashboard', icon: IconLayoutDashboard, label: 'Дашборд', module: 'dashboard' },
    { to: '/orders', icon: IconShoppingCart, label: 'Заказы', module: 'orders' },
    { to: '/production', icon: IconCalendarClock, label: 'План производства', module: 'production' },
    { to: '/production/kanban', icon: IconLayoutKanban, label: 'Цех', module: 'kanban' },
    { to: '/specs', icon: IconRuler2, label: 'Спецификации', module: 'specs' },
    { to: '/warehouse', icon: IconPackage, label: 'Склад', module: 'warehouse' },
    { to: '/finance', icon: IconBuildingBank, label: 'Финансы', module: 'finance' },
    { to: '/catalog', icon: IconBook, label: 'Справочники', module: 'catalog' },
    { to: '/integration', icon: IconPlugConnected, label: 'Обмен с 1С', module: 'audit' },
    { to: '/audit', icon: IconShieldLock, label: 'Аудит', module: 'audit' },
  ];

  const initials = user?.email?.[0]?.toUpperCase() || 'U';
  const displayName = user?.email?.split('@')[0] || 'Пользователь';
  const roleLabel = user?.roles?.[0] ? ROLE_LABELS[user.roles[0]] || user.roles[0] : 'Оператор';

  return (
    <Stack justify="space-between" h="100%" gap={0}>
      <Stack gap={0}>
        <Box pb="sm" mb="sm">
          <Group gap="sm">
            <Avatar size={40} radius="md" variant="filled" color="brand.6">
              <Text fw={900} size="lg" c="white">А</Text>
            </Avatar>
            <Stack gap={0}>
              <Text fw={800} size="md" lh={1} tt="uppercase" style={{ letterSpacing: '-0.02em' }}>
              ЦМК АВРОРА
            </Text>
            <Text size="xs" tt="uppercase" fw={500} c="dimmed" style={{ letterSpacing: '0.12em', fontSize: 10 }}>
              ERP System
            </Text>
            </Stack>
          </Group>
        </Box>

        <Divider my="sm" />

        <Text size="xs" tt="uppercase" fw={700} c="dimmed" px="sm" mb={6} style={{ letterSpacing: '0.1em', fontSize: 10 }}>
          Меню
        </Text>

        <Stack gap={2} mt="xs">
          {navItems.map((item) => {
            if (!canAccessModule(item.module, permissions)) return null;
            const Icon = item.icon;
            const isActive = pathname === item.to;
            return (
              <NavLink
                key={item.to}
                component={RouterNavLink}
                to={item.to}
                onClick={onNavigate}
                label={item.label}
                leftSection={<Icon size={18} stroke={1.8} />}
                variant="subtle"
                active={isActive}
                color="brand"
                h={42}
                px="xs"
                style={{ borderRadius: 'var(--mantine-radius-md)' }}
              />
            );
          })}
        </Stack>
      </Stack>

      <Box pt="md">
        <Divider mb="sm" />
        <Group gap="sm" wrap="nowrap" p="xs">
          <Avatar size={38} radius="xl" color="dark.9">
            <Text fw={700} c="white" size="sm">{initials}</Text>
          </Avatar>
          <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" fw={700} lineClamp={1}>
              {displayName}
            </Text>
            <Text size="xs" c="dimmed" lineClamp={1}>
              {roleLabel}
            </Text>
          </Stack>
        </Group>
      </Box>
    </Stack>
  );
}
