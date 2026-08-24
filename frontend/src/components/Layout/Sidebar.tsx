import React from 'react';
import { NavLink as RouterNavLink, useLocation } from 'react-router-dom';
import { Stack, Text, Group, Avatar, Divider, Box, UnstyledButton } from '@mantine/core';
import { motion, useReducedMotion } from 'framer-motion';
import {
  IconClipboardList,
  IconSettings,
  IconShoppingCart,
  IconPackage,
  IconBuildingBank,
  IconRuler2,
} from '@tabler/icons-react';
import { useAuthStore } from '../../store/auth';
import { LogoLockup } from '../Brand';
import { canAccessModule, ROLE_LABELS } from '../../utils/roles';

interface SidebarProps {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const user = useAuthStore((state) => state.user);
  const permissions = useAuthStore((state) => state.permissions);
  const { pathname } = useLocation();
  const reduced = useReducedMotion();

  // Меню собирается из прав: у кладовщика останется 4 пункта, у директора — все (§2.2)
  const navItems = [
    { to: '/', icon: IconClipboardList, label: 'Моя работа', module: 'work' },
    { to: '/orders', icon: IconShoppingCart, label: 'Заказы', module: 'orders' },
    { to: '/specs', icon: IconRuler2, label: 'Изделия', module: 'specs' },
    { to: '/warehouse', icon: IconPackage, label: 'Материалы', module: 'materials' },
    { to: '/finance', icon: IconBuildingBank, label: 'Деньги', module: 'money' },
    { to: '/settings', icon: IconSettings, label: 'Настройки', module: 'settings' },
  ];


  const initials = user?.email?.[0]?.toUpperCase() || 'U';
  const displayName = user?.email?.split('@')[0] || 'Пользователь';
  const roleLabel = user?.roles?.[0] ? ROLE_LABELS[user.roles[0]] || user.roles[0] : 'Оператор';

  return (
    <Stack justify="space-between" h="100%" gap={0}>
      <Stack gap={0}>
        <Box pb="sm" mb="sm">
          <LogoLockup />
        </Box>

        <Divider my="sm" />

        <Text size="xs" tt="uppercase" fw={700} c="dimmed" px="sm" mb={6} style={{ letterSpacing: '0.1em', fontSize: 10 }}>
          Меню
        </Text>

        <Stack gap={2} mt="xs">
          {navItems.map((item) => {
            if (!canAccessModule(item.module, permissions)) return null;
            if ((item as any).roles && !(item as any).roles.some((r: string) => user?.roles?.includes(r))) return null;
            const Icon = item.icon;
            const isActive = pathname === item.to;
            return (
              /* Активная пилюля — ОДНА на всё меню, скользит между пунктами
                 (layoutId): выбор ощущается перемещением, а не перекраской */
              <UnstyledButton
                key={item.to}
                component={RouterNavLink}
                to={item.to}
                onClick={onNavigate}
                className="nav-item"
                px="xs"
                h={42}
                style={{ position: 'relative', borderRadius: 'var(--mantine-radius-md)', display: 'flex', alignItems: 'center' }}
              >
                {isActive && (
                  <motion.span
                    layoutId={reduced ? undefined : 'nav-active-pill'}
                    transition={{ type: 'spring', stiffness: 480, damping: 38 }}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: 'var(--mantine-radius-md)',
                      background: 'var(--brand-0)',
                      border: '1px solid color-mix(in srgb, var(--brand-6) 18%, transparent)',
                    }}
                  />
                )}
                <Group gap="sm" wrap="nowrap" style={{ position: 'relative', zIndex: 1 }}>
                  <Icon size={18} stroke={1.8}
                    style={{ color: isActive ? 'var(--brand-7)' : 'var(--gray-6)' }} />
                  <Text size="sm" fw={isActive ? 700 : 500}
                    c={isActive ? 'brand.8' : undefined}>
                    {item.label}
                  </Text>
                </Group>
              </UnstyledButton>
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
