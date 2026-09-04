import React from 'react';
import { Group, Text, ActionIcon, Tooltip, UnstyledButton, Kbd } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { GlobalSearch, useGlobalSearchHotkey } from '../GlobalSearch';
import {
  IconSearch, IconBell, IconLogout, IconMenu2,
} from '@tabler/icons-react';
import { useAuthStore } from '../../store/auth';
import { HeaderPulse } from './HeaderPulse';
import { notifications } from '@mantine/notifications';

export function TopBar() {
  const logout = useAuthStore((state) => state.logout);
  const [searchOpened, { open: openSearch, close: closeSearch }] = useDisclosure(false);
  useGlobalSearchHotkey(openSearch);
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
        {/* Кнопки «свернуть меню» больше нет (04.09.2026): боковая панель
            заменена нижней строкой разделов, сворачивать нечего. Знак
            остался кликабельной ссылкой на «Мою работу». */}
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
            <IconSearch size={16} style={{ color: 'var(--mantine-color-dimmed)' }} aria-hidden />
            <Text size="sm" c="dimmed" style={{ flex: 1 }} lineClamp={1}>
              Заказ, заказчик, объект, материал…
            </Text>
            <Group gap={2} visibleFrom="sm">
              <Kbd size="sm">⌘</Kbd><Kbd size="sm">K</Kbd>
            </Group>
          </Group>
        </UnstyledButton>
      </Group>

      <Group gap={8} wrap="nowrap">
        {/* Было «Онлайн» — значок, который горел всегда и ничего не значил.
            Теперь здесь живые числа завода, каждое ведёт в свой раздел */}
        <HeaderPulse />
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
          <IconBell size={20} aria-hidden />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          onClick={handleLogout}
          aria-label="Выйти"
        >
          <IconLogout size={20} aria-hidden />
        </ActionIcon>
      </Group>
    </Group>
      <GlobalSearch opened={searchOpened} onClose={closeSearch} />
    </>
  );
}
