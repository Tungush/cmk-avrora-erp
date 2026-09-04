import React from 'react';
import { NavLink as RouterNavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuthStore } from '../../store/auth';
import { canAccessModule } from '../../utils/roles';
import { useMotionOff } from '../motion';
import { NAV_ITEMS } from './navItems';

/**
 * Разделы плавающей строкой внизу экрана (04.09.2026).
 *
 * Замена боковому меню по эталону, который прислал владелец. Причина не
 * в моде: боковая панель занимала 260 px (в свёрнутом виде 76) по всей
 * высоте — это 18 % ширины ноутбука 1440 px, отданные под одиннадцать
 * ссылок, которые нажимают несколько раз за смену. Нижняя строка стоит
 * 60 px по высоте и возвращает содержимому всю ширину.
 *
 * Строка именно ПЛАВАЮЩАЯ, а не приклеенная к низу окна: между ней и
 * краем есть воздух, и она читается как предмет поверх экрана, а не как
 * вторая рамка вокруг него.
 *
 * Активный раздел — одна заливка на всю строку, которая переезжает
 * между пунктами (layoutId): выбор ощущается перемещением, а не
 * перекраской. Тот же приём был в боковом меню.
 */
export function BottomNav() {
  const permissions = useAuthStore((state) => state.permissions);
  const { pathname } = useLocation();
  const reduced = useMotionOff();

  const items = NAV_ITEMS.filter((item) => canAccessModule(item.module, permissions));

  return (
    <nav className="botnav" aria-label="Разделы">
      <div className="botnav__bar">
        {items.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.to;
          return (
            <RouterNavLink
              key={item.to}
              to={item.to}
              className="botnav__item"
              data-active={active ? 'true' : undefined}
              aria-current={active ? 'page' : undefined}
            >
              {active && (
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
      </div>
    </nav>
  );
}
