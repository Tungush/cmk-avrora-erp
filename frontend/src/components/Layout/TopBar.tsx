import React, { useState } from 'react';
import { Group, Text, TextInput, ActionIcon, Badge, Box, Tooltip } from '@mantine/core';
import { IconSearch, IconBell, IconLogout, IconMenu2, IconBaselineDensityMedium, IconBaselineDensitySmall } from '@tabler/icons-react';
import { useAuthStore } from '../../store/auth';
import { notifications } from '@mantine/notifications';

interface TopBarProps {
  onToggleMobile?: () => void;
}

export function TopBar({ onToggleMobile }: TopBarProps) {
  const logout = useAuthStore((state) => state.logout);
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
        <TextInput
          placeholder="Поиск заказов, материалов, номенклатуры..."
          leftSection={<IconSearch size={16} stroke={1.8} />}
          style={{ flex: 1, maxWidth: 520 }}
          size="md"
          radius="xl"
          variant="filled"
        />
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
  );
}
