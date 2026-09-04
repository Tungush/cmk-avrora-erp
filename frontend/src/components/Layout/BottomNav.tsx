import React, { useCallback, useEffect, useState } from 'react';
import { NavLink as RouterNavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { IconChevronUp, IconChevronDown } from '@tabler/icons-react';
import { useAuthStore } from '../../store/auth';
import { canAccessModule } from '../../utils/roles';
import { useMotionOff } from '../motion';
import { NAV_ITEMS } from './navItems';

const KEY = 'ui-botnav';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === 'mini';
  } catch {
    return false; // приватный режим
  }
}

/**
 * Разделы плавающей строкой внизу экрана (04.09.2026).
 *
 * Замена боковому меню по эталону. Панель занимала 260 px по всей
 * высоте — 18 % ширины ноутбука под одиннадцать ссылок, которые
 * нажимают несколько раз за смену.
 *
 * Строка сворачивается в пилюлю с текущим разделом (просьба владельца).
 * Прятать её по прокрутке нельзя: у нас страница не прокручивается по
 * правилу, прятать было бы нечем. Поэтому сворачивание явное — нажатием,
 * а не по наведению: в цеху работают с планшета, где наведения нет и
 * панель было бы не достать.
 *
 * В свёрнутом виде разделы не пропадают из виду совсем: пилюля
 * показывает, где ты сейчас, и открывает полный ряд одним нажатием.
 * Свёрнутая строка возвращает содержимому 40 px — высота пересчитается
 * сама, за отступом главной области следит ResizeObserver в useFitHeight.
 */
export function BottomNav() {
  const permissions = useAuthStore((state) => state.permissions);
  const { pathname } = useLocation();
  const reduced = useMotionOff();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const items = NAV_ITEMS.filter((item) => canAccessModule(item.module, permissions));
  const active = items.find((i) => i.to === pathname) ?? items[0];

  // Высота полосы под строкой живёт в CSS: её же читает useFitHeight
  useEffect(() => {
    document.documentElement.dataset.botnav = collapsed ? 'mini' : 'full';
  }, [collapsed]);

  const toggle = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(KEY, next ? 'mini' : 'full'); } catch { /* приватный режим */ }
      return next;
    });
  }, []);

  // Esc сворачивает — как любой временный слой поверх экрана
  useEffect(() => {
    if (collapsed) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') toggle(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed, toggle]);

  if (collapsed) {
    const Icon = active?.icon;
    return (
      <nav className="botnav" aria-label="Разделы">
        <button
          type="button"
          className="botnav__bar botnav__mini"
          onClick={toggle}
          aria-expanded={false}
          aria-label={`Показать разделы. Сейчас: ${active?.label ?? 'раздел'}`}
        >
          {Icon && <Icon size={17} stroke={1.9} />}
          <span className="botnav__mini-label">{active?.short ?? active?.label}</span>
          <IconChevronUp size={15} stroke={2.2} aria-hidden />
        </button>
      </nav>
    );
  }

  return (
    <nav className="botnav" aria-label="Разделы">
      <div className="botnav__bar">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.to;
          return (
            <RouterNavLink
              key={item.to}
              to={item.to}
              className="botnav__item"
              data-active={isActive ? 'true' : undefined}
              aria-current={isActive ? 'page' : undefined}
            >
              {isActive && (
                <motion.span
                  layoutId={reduced ? undefined : 'botnav-pill'}
                  className="botnav__pill"
                  aria-hidden
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="botnav__face">
                <Icon size={17} stroke={1.9} />
                {item.short ?? item.label}
              </span>
            </RouterNavLink>
          );
        })}

        <button
          type="button"
          className="botnav__collapse"
          onClick={toggle}
          aria-expanded
          title="Свернуть разделы (Esc)"
          aria-label="Свернуть разделы"
        >
          <IconChevronDown size={15} stroke={2.2} aria-hidden />
        </button>
      </div>
    </nav>
  );
}
