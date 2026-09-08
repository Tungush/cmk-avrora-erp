import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ActionIcon, Kbd, Menu, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconBell, IconChevronLeft, IconChevronRight, IconLogout, IconSearch, IconSettings, IconUserCircle,
} from '@tabler/icons-react';
import { GlobalSearch, useGlobalSearchHotkey } from '../GlobalSearch';
import { useAuthStore } from '../../store/auth';
import { canAccessModule } from '../../utils/roles';
import { NAV_ITEMS } from './navItems';

/**
 * Разделы — узкой вертикальной рейкой слева (08.09.2026).
 *
 * Четвёртая попытка, и на этот раз не на глаз. Владелец: «меню надо
 * переработать, мне неудобно работать, посмотри лучшие решения». Что
 * говорит практика для внутренних систем с таким числом разделов:
 * при частых переходах и более чем семи пунктах выигрывает боковая
 * навигация, а не строка сверху; свёрнутая рейка — 56–64 px значками с
 * подсказкой, раскрытая — 240–280 px; больше семи пунктов верхнего
 * уровня требуют группировки.
 *
 * Что было не так у прежних вариантов:
 *   • боковое меню на 260 px всегда — съедало пятую часть ширины (снято 04.09);
 *   • строка внизу — 74 px высоты на ноутбуке (снята 05.09);
 *   • строка сверху — одиннадцать пунктов в ряд, на 1280 подписи прятались,
 *     а в скрытом виде за шапкой приходилось охотиться курсором.
 *
 * Здесь рейка 60 px видна ВСЕГДА — охотиться не за чем, — но занимает
 * вчетверо меньше прежнего бокового меню и возвращает содержимому 56 px
 * высоты: шапки больше нет вовсе. При наведении рейка разъезжается до
 * 240 px ПОВЕРХ содержимого, поэтому таблицы не перекладываются. Кнопка
 * вверху закрепляет её раскрытой насовсем.
 *
 * Одиннадцать разделов разложены на пять групп: работа, производство,
 * каталог, снабжение, деньги. Группы подписаны в раскрытом виде.
 */

interface Group { caption?: string; paths: string[] }

const GROUPS: Group[] = [
  { paths: ['/'] },
  { caption: 'Производство', paths: ['/orders', '/sites', '/production/kanban', '/production/contractors'] },
  { caption: 'Каталог', paths: ['/specs', '/nkt', '/prices'] },
  { caption: 'Снабжение', paths: ['/warehouse', '/purchases'] },
  { caption: 'Деньги', paths: ['/finance'] },
];

export function SideRail() {
  const logout = useAuthStore((s) => s.logout);
  const permissions = useAuthStore((s) => s.permissions);
  const { pathname } = useLocation();
  const [searchOpened, { open: openSearch, close: closeSearch }] = useDisclosure(false);
  useGlobalSearchHotkey(openSearch);

  // Закреплённая рейка переживает перезагрузку: это выбор рабочего места,
  // а не настроение
  const [pinned, setPinned] = useState<boolean>(() => {
    try { return localStorage.getItem('ui-rail') === 'open'; } catch { return false; }
  });
  const [hover, setHover] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const open = pinned || hover;

  const togglePin = useCallback(() => setPinned((v) => {
    const next = !v;
    try { localStorage.setItem('ui-rail', next ? 'open' : 'rail'); } catch { /* приватный режим */ }
    return next;
  }), []);

  // Уводим задержкой: короткий промах курсором не должен схлопывать меню
  const enter = () => { window.clearTimeout(closeTimer.current); setHover(true); };
  const leave = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHover(false), 220);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const byPath = new Map(NAV_ITEMS.map((i) => [i.to, i]));
  const allowed = (to: string) => {
    const item = byPath.get(to);
    return item ? canAccessModule(item.module, permissions) : false;
  };
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`));
  const canSettings = canAccessModule('settings', permissions);

  const handleLogout = () => {
    logout();
    notifications.show({ title: 'Выход выполнен', message: 'Сессия завершена', color: 'gray' });
  };

  /** Пункт рейки: в свёрнутом виде значок с подсказкой, в раскрытом — с подписью */
  const railLink = (to: string) => {
    const item = byPath.get(to)!;
    const Icon = item.icon;
    const active = isActive(to);
    const link = (
      <NavLink
        key={to}
        to={to}
        className="rail__item"
        data-active={active ? 'true' : undefined}
        aria-label={item.label}
      >
        <span className="rail__icon"><Icon size={20} stroke={1.7} /></span>
        <span className="rail__label">{item.label}</span>
      </NavLink>
    );
    return open ? link : (
      <Tooltip key={to} label={item.label} position="right" offset={10} openDelay={200} withArrow>
        {link}
      </Tooltip>
    );
  };

  return (
    <>
      <aside
        className="rail"
        data-open={open ? 'true' : undefined}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocusCapture={enter}
        onBlurCapture={leave}
        aria-label="Разделы"
      >
        <div className="rail__top">
          <Link to="/" className="rail__brand" aria-label="Моя работа">
            <span className="rail__brand-mark">Ц</span>
            <span className="rail__brand-full">ЦМК АВРОРА</span>
          </Link>
          <ActionIcon
            className="rail__pin"
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={pinned ? 'Свернуть меню' : 'Закрепить меню раскрытым'}
            onClick={togglePin}
          >
            {pinned ? <IconChevronLeft size={16} /> : <IconChevronRight size={16} />}
          </ActionIcon>
        </div>

        <nav className="rail__nav">
          {GROUPS.map((g, gi) => {
            const paths = g.paths.filter(allowed);
            if (paths.length === 0) return null;
            return (
              <div className="rail__group" key={g.caption ?? `g${gi}`}>
                {g.caption && <div className="rail__caption">{g.caption}</div>}
                {paths.map(railLink)}
              </div>
            );
          })}
        </nav>

        <div className="rail__foot">
          <button type="button" className="rail__item rail__action" onClick={openSearch} aria-label="Поиск">
            <span className="rail__icon"><IconSearch size={20} stroke={1.7} /></span>
            <span className="rail__label">Поиск</span>
            <Kbd className="rail__kbd">⌘K</Kbd>
          </button>

          <button
            type="button"
            className="rail__item rail__action"
            aria-label="Уведомления"
            onClick={() => notifications.show({ title: 'Уведомления', message: 'Новых нет', color: 'gray' })}
          >
            <span className="rail__icon"><IconBell size={20} stroke={1.7} /></span>
            <span className="rail__label">Уведомления</span>
          </button>

          <Menu position="right-end" offset={12} width={220} withArrow>
            <Menu.Target>
              <button type="button" className="rail__item rail__action" aria-label="Аккаунт">
                <span className="rail__icon"><IconUserCircle size={20} stroke={1.7} /></span>
                <span className="rail__label">Аккаунт</span>
              </button>
            </Menu.Target>
            <Menu.Dropdown>
              {canSettings && (
                <Menu.Item component={Link} to="/settings" leftSection={<IconSettings size={16} aria-hidden />}>
                  Настройки
                </Menu.Item>
              )}
              <Menu.Item color="red" leftSection={<IconLogout size={16} aria-hidden />} onClick={handleLogout}>
                Выйти
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
      </aside>

      <GlobalSearch opened={searchOpened} onClose={closeSearch} />
    </>
  );
}
