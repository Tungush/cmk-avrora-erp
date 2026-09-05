import React from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ActionIcon, Kbd, Menu } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { motion } from 'framer-motion';
import { IconSearch, IconBell, IconLogout, IconSettings, IconUserCircle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { GlobalSearch, useGlobalSearchHotkey } from '../GlobalSearch';
import { useAuthStore } from '../../store/auth';
import { canAccessModule } from '../../utils/roles';
import { useMotionOff } from '../motion';
import { NAV_ITEMS } from './navItems';

/**
 * Шапка с разделами (05.09.2026).
 *
 * Разделы переехали из плавающей строки внизу сюда, в шапку, которая
 * есть всё равно. Владелец показал три снимка с ноутбука: нижняя
 * строка «мешает и занимает место» — на высоте 720–800 px она съедала
 * 74 px, список решений на экране директора обрезался на второй
 * строке. Верхняя строка разделов — то, что делает Vercel: навигация
 * в единственной постоянной полосе, низ экрана целиком под данные.
 *
 * Что ушло вместе с нижней строкой: сворачивание в пилюлю (незачем —
 * строка ничего не отнимает у содержимого) и «пульс завода» в шапке
 * (три числа не помещаются рядом с одиннадцатью разделами на 1280;
 * они же есть на «Моей работе» и у директора). «Настройки» — в меню
 * аккаунта, как везде: это не раздел смены, а редкое действие.
 *
 * Уже 1180 px подписи разделов прячутся, остаются значки с подсказкой
 * (container query по ширине шапки, не по окну).
 */
export function TopBar() {
  const logout = useAuthStore((s) => s.logout);
  const permissions = useAuthStore((s) => s.permissions);
  const { pathname } = useLocation();
  const reduced = useMotionOff();
  const [searchOpened, { open: openSearch, close: closeSearch }] = useDisclosure(false);
  useGlobalSearchHotkey(openSearch);

  const items = NAV_ITEMS.filter((i) => i.to !== '/settings' && canAccessModule(i.module, permissions));
  const canSettings = canAccessModule('settings', permissions);
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`));

  const handleLogout = () => {
    logout();
    notifications.show({ title: 'Выход выполнен', message: 'Сессия завершена', color: 'gray' });
  };

  return (
    <>
      <div className="topbar">
        <Link to="/" className="topbar__brand" aria-label="Моя работа">ЦМК</Link>

        <nav className="topnav" aria-label="Разделы">
          {items.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.to);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className="topnav__item"
                data-active={active ? 'true' : undefined}
                aria-current={active ? 'page' : undefined}
                title={item.label}
              >
                {active && (
                  <motion.span
                    layoutId={reduced ? undefined : 'topnav-pill'}
                    className="topnav__pill"
                    aria-hidden
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="topnav__face">
                  <Icon size={16} stroke={1.9} />
                  <span className="topnav__label">{item.short ?? item.label}</span>
                </span>
              </NavLink>
            );
          })}
        </nav>

        <div className="topbar__tools">
          <button
            type="button"
            className="topbar__search"
            onClick={openSearch}
            aria-label="Поиск: заказ, заказчик, объект, материал (⌘K)"
          >
            <IconSearch size={16} aria-hidden />
            <span className="topbar__search-label">Поиск</span>
            <span className="topbar__kbd" aria-hidden><Kbd size="xs">⌘</Kbd><Kbd size="xs">K</Kbd></span>
          </button>
          <ActionIcon
            variant="subtle" color="gray" size="lg" aria-label="Уведомления"
            onClick={() => notifications.show({ title: 'Уведомления', message: 'Нет новых уведомлений', color: 'gray' })}
          >
            <IconBell size={20} aria-hidden />
          </ActionIcon>
          <Menu position="bottom-end" width={200} shadow="md" radius="md">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" size="lg" aria-label="Аккаунт">
                <IconUserCircle size={22} aria-hidden />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {canSettings && (
                <Menu.Item component={Link} to="/settings" leftSection={<IconSettings size={16} aria-hidden />}>Настройки</Menu.Item>
              )}
              <Menu.Item leftSection={<IconLogout size={16} aria-hidden />} onClick={handleLogout}>Выйти</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
      </div>
      <GlobalSearch opened={searchOpened} onClose={closeSearch} />
    </>
  );
}
