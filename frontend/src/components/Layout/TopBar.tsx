import React, { useState } from 'react';
import { Group, Text, ActionIcon, Badge, Box, Tooltip, UnstyledButton, Kbd } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { GlobalSearch, useGlobalSearchHotkey } from '../GlobalSearch';
import { IconSearch, IconBell, IconLogout, IconMenu2, IconBaselineDensityMedium, IconBaselineDensitySmall } from '@tabler/icons-react';
import { useAuthStore } from '../../store/auth';
import { notifications } from '@mantine/notifications';

interface TopBarProps {
  onToggleMobile?: () => void;
}

export function TopBar({ onToggleMobile }: TopBarProps) {
  const logout = useAuthStore((state) => state.logout);
  const [searchOpened, { open: openSearch, close: closeSearch }] = useDisclosure(false);
  useGlobalSearchHotkey(openSearch);
  // Плотность (§4.1 п.3): «компактно» — таблицы в 40 строк для плановика
  const [density, setDensity] = useState(
    () => localStorage.getItem('ui-density') ?? 'normal',
  );
  const toggleDensity = () => {
    const next = density === 'compact' ? 'normal' : 'compact';
    setDensity(next);
    localStorage.setItem('ui-density', next);
    document.documentElement.dataset.density = next;
  };

  const handleLogout = () => {
    logout();
    notifications.show({
      title: 'Выход выполнен',
      message: 'Сессия завершена',
      color: 'gray',
    });
  };

  return (
    <>
    <Group h="100%" px="md" justify="space-between" wrap="nowrap">
      <Group wrap="nowrap" style={{ flex: 1 }}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          onClick={onToggleMobile}
          display={{ base: 'inline-flex', sm: 'none' }}
          aria-label="Открыть меню"
        >
          <IconMenu2 size={20} />
        </ActionIcon>
        {/* Поле было TextInput без обработчика — обещало поиск и не делало
            ничего. Теперь это кнопка, открывающая общий поиск (Cmd/Ctrl+K) */}
        <UnstyledButton
          onClick={openSearch}
          style={{ flex: 1, maxWidth: 520 }}
          aria-label="Поиск"
        >
          <Group
            gap="sm"
            wrap="nowrap"
            px="md"
            py={8}
            style={{
              borderRadius: 999,
              background: 'var(--mantine-color-default-hover)',
            }}
          >
            <IconSearch size={16} stroke={1.8} style={{ color: 'var(--mantine-color-dimmed)' }} />
            <Text size="sm" c="dimmed" style={{ flex: 1 }} lineClamp={1}>
              Заказ, заказчик, объект, материал…
            </Text>
            <Group gap={2} visibleFrom="sm">
              <Kbd size="xs">⌘</Kbd><Kbd size="xs">K</Kbd>
            </Group>
          </Group>
        </UnstyledButton>
      </Group>

      <Group gap={8} wrap="nowrap">
        <Tooltip label={density === 'compact' ? 'Обычная плотность' : 'Компактная плотность'}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            onClick={toggleDensity}
            aria-label="Плотность интерфейса"
          >
            {density === 'compact'
              ? <IconBaselineDensityMedium size={19} stroke={1.8} />
              : <IconBaselineDensitySmall size={19} stroke={1.8} />}
          </ActionIcon>
        </Tooltip>
        <Badge
          color="success"
          variant="light"
          size="lg"
          radius="xl"
          leftSection={
            <Box
              w={6}
              h={6}
              bg="success.6"
              style={{ borderRadius: 999 }}
            />
          }
          display={{ base: 'none', md: 'inline-flex' }}
        >
          Онлайн
        </Badge>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          aria-label="Уведомления"
          onClick={() => notifications.show({
            title: 'Уведомления',
            message: 'Нет новых уведомлений',
            color: 'gray',
          })}
        >
          <IconBell size={20} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          onClick={handleLogout}
          aria-label="Выйти"
        >
          <IconLogout size={20} />
        </ActionIcon>
      </Group>
    </Group>
      <GlobalSearch opened={searchOpened} onClose={closeSearch} />
    </>
  );
}
