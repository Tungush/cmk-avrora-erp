import React from 'react';
import { NavLink as RouterNavLink, useLocation } from 'react-router-dom';
import { Stack, Text, Group, Avatar, Divider, Box, UnstyledButton, Tooltip } from '@mantine/core';
import { motion } from 'framer-motion';
import { useMotionOff } from '../motion';
import {
  IconClipboardList,
  IconSettings,
  IconShoppingCart,
  IconPackage,
  IconBuildingBank,
  IconRuler2,
  IconTruckDelivery,
  IconHammer, IconTruck, IconCoin,
  IconAntenna,
} from '@tabler/icons-react';
import { useAuthStore } from '../../store/auth';
import { LogoLockup, LogoMark } from '../Brand';
import { canAccessModule, ROLE_LABELS } from '../../utils/roles';

interface SidebarProps {
  onNavigate?: () => void;
  /** Рейка иконок: подписи уходят в подсказки, меню занимает 76 px */
  collapsed?: boolean;
}

export function Sidebar({ onNavigate, collapsed = false }: SidebarProps) {
  const user = useAuthStore((state) => state.user);
  const permissions = useAuthStore((state) => state.permissions);
  const { pathname } = useLocation();
  const reduced = useMotionOff();

  // Меню собирается из прав: у кладовщика останется 4 пункта, у директора — все (§2.2)
  const navItems = [
    { to: '/', icon: IconClipboardList, label: 'Моя работа', module: 'work' },
    { to: '/orders', icon: IconShoppingCart, label: 'Заказы', module: 'orders' },
    // Объекты (базовые станции): телеком спрашивает про площадку, а не про
    // номер заказа — срез по project_site из 1С (02.09.2026)
    { to: '/sites', icon: IconAntenna, label: 'Объекты', module: 'orders' },
    { to: '/production/kanban', icon: IconHammer, label: 'Цех', module: 'production' },
    // Подряд стал самостоятельным потоком (26.08.2026): заявка партией →
    // пачкой в Б24 → разнесение по заказам. До сих пор попасть сюда можно
    // было только с плитки «Моей работы», хотя это прямые деньги наружу
    { to: '/production/contractors', icon: IconTruck, label: 'Подряд', module: 'production' },
    { to: '/specs', icon: IconRuler2, label: 'Изделия', module: 'specs' },
    // Прайс — коммерция, а не инженерия: цену видит тот, кто видит деньги заказа
    { to: '/prices', icon: IconCoin, label: 'Прайс', module: 'money' },
    { to: '/warehouse', icon: IconPackage, label: 'Материалы', module: 'materials' },
    { to: '/purchases', icon: IconTruckDelivery, label: 'Закупки', module: 'purchases' },
    { to: '/finance', icon: IconBuildingBank, label: 'Деньги', module: 'money' },
    { to: '/settings', icon: IconSettings, label: 'Настройки', module: 'settings' },
  ];

  const initials = user?.email?.[0]?.toUpperCase() || 'U';
  const displayName = user?.email?.split('@')[0] || 'Пользователь';
  const roleLabel = user?.roles?.[0] ? ROLE_LABELS[user.roles[0]] || user.roles[0] : 'Оператор';

  return (
    <Stack justify="space-between" h="100%" gap={0}>
      {/* Меню обязано влезать целиком: одиннадцать пунктов по 44 px плюс
          знак, разделители и блок пользователя на невысоком окне не
          помещались, и нижние пункты обрезались (03.09.2026). Высота
          пункта теперь тянется от высоты окна — clamp в nav.css */}
      <Stack gap={0} style={{ minHeight: 0, flex: '1 1 auto' }} className="nav-top">
        <Box pb={6} mb={2} style={{ display: 'flex', justifyContent: collapsed ? 'center' : 'flex-start' }}>
          {collapsed ? <LogoMark size={26} /> : <LogoLockup />}
        </Box>

        <Divider my={6} />

        {!collapsed && (
          <Text size="xs" tt="uppercase" fw={700} c="dimmed" px="sm" mb={4} className="nav-label"
            style={{ letterSpacing: '0.1em' }}>
            Меню
          </Text>
        )}

        <Stack gap={1} mt={2} className="nav-list" style={{ minHeight: 0 }}>
          {navItems.map((item) => {
            if (!canAccessModule(item.module, permissions)) return null;
            if ((item as any).roles && !(item as any).roles.some((r: string) => user?.roles?.includes(r))) return null;
            const Icon = item.icon;
            const isActive = pathname === item.to;
            const button = (
              /* Активная пилюля — ОДНА на всё меню, скользит между пунктами
                 (layoutId): выбор ощущается перемещением, а не перекраской */
              <UnstyledButton
                key={item.to}
                component={RouterNavLink}
                to={item.to}
                // Нативный переход между разделами: браузер сам морфит
                // старый кадр в новый (View Transitions API)
                viewTransition
                onClick={onNavigate}
                className="nav-item"
                aria-label={item.label}
                px={collapsed ? 0 : 'xs'}
                style={{
                  position: 'relative',
                  borderRadius: 'var(--r-full)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                }}
              >
                {isActive && (
                  <motion.span
                    layoutId={reduced ? undefined : 'nav-active-pill'}
                    transition={{ type: 'spring', stiffness: 480, damping: 38 }}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: 'var(--r-full)',
                      background: 'var(--pill-dark)',
                      boxShadow: '0 6px 16px rgba(30, 29, 25, 0.22)',
                    }}
                  />
                )}
                <Group gap="sm" wrap="nowrap" style={{ position: 'relative', zIndex: 1 }}>
                  <Icon size={collapsed ? 22 : 20} stroke={1.8}
                    style={{ color: isActive ? '#fff' : 'var(--gray-6)', flexShrink: 0 }} />
                  {!collapsed && (
                    <Text size="md" fw={isActive ? 700 : 500}
                      c={isActive ? 'white' : undefined} style={{ whiteSpace: 'nowrap' }}>
                      {item.label}
                    </Text>
                  )}
                </Group>
              </UnstyledButton>
            );
            return collapsed
              ? (
                <Tooltip key={item.to} label={item.label} position="right" withArrow openDelay={150}
                  transitionProps={{ transition: 'fade-right', duration: 120 }}>
                  {button}
                </Tooltip>
              )
              : button;
          })}
        </Stack>
      </Stack>

      <Box pt={6} style={{ flex: '0 0 auto' }}>
        <Divider mb={6} />
        {collapsed ? (
          <Tooltip label={`${displayName} · ${roleLabel}`} position="right" withArrow>
            <Group justify="center" p={2}>
              <Avatar size={32} radius="xl" color="dark.9">
                <Text fw={700} c="white" size="sm">{initials}</Text>
              </Avatar>
            </Group>
          </Tooltip>
        ) : (
          <Group gap="sm" wrap="nowrap" p={6}>
            <Avatar size={34} radius="xl" color="dark.9">
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
        )}
      </Box>
    </Stack>
  );
}
