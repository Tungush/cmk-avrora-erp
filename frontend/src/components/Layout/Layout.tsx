import React, { useCallback, useEffect, useState } from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { AppShell, Box } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useAuthStore } from '../../store/auth';
import { OrderCardProvider } from '../OrderCard/OrderCardProvider';
import { ReceiptCardProvider } from '../ReceiptCard/ReceiptCardProvider';
import { motion } from 'framer-motion';
import { SPRING, useMotionOff } from '../motion';
import { AuroraCanvas } from '../Aurora';
import { LoadBar } from './LoadBar';
import { SectionErrorBoundary } from '../ErrorBoundary';
import { EntityProvider } from '../EntityRef';

export const NAV_WIDTH = 260;
export const NAV_RAIL_WIDTH = 76;
const NAV_KEY = 'ui-nav';

/**
 * Свёрнутое меню (решение 02.09.2026): на ноутбуке 1280–1400 px полная
 * панель съедала четверть экрана, и таблицы уезжали вбок. Ниже 1400 px
 * меню по умолчанию сворачивается в рейку иконок (+184 px контенту);
 * выбор пользователя запоминается и дальше главнее автоматики.
 */
function readNavPreference(): boolean | null {
  try {
    const v = localStorage.getItem(NAV_KEY);
    return v === 'rail' ? true : v === 'full' ? false : null;
  } catch {
    return null;
  }
}

export function Layout() {
  const token = useAuthStore((state) => state.token);
  const [mobileOpened, { toggle, close }] = useDisclosure();
  const { pathname } = useLocation();
  const reduced = useMotionOff();
  const narrow = useMediaQuery('(max-width: 1399px)');
  const [pref, setPref] = useState<boolean | null>(readNavPreference);
  const collapsed = pref ?? !!narrow;

  const toggleNav = useCallback(() => {
    const next = !collapsed;
    setPref(next);
    try { localStorage.setItem(NAV_KEY, next ? 'rail' : 'full'); } catch { /* приватный режим */ }
  }, [collapsed]);

  // Ширина меню нужна и CSS (липкие панели инструментов считают отступ)
  useEffect(() => {
    document.documentElement.dataset.nav = collapsed ? 'rail' : 'full';
  }, [collapsed]);

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return (
    // Провайдер обязан быть НАД AppShell: поиск живёт в шапке
    // и тоже открывает карточку заказа
    <OrderCardProvider>
    <ReceiptCardProvider>
    {/* Провайдер сущностей — НАД оболочкой: карточку материала или
        заказчика открывают из любого раздела и из шторки заказа тоже */}
    <EntityProvider>
    <AuroraCanvas />
    <AppShell
      header={{ height: 64 }}
      navbar={{ width: collapsed ? NAV_RAIL_WIDTH : NAV_WIDTH, breakpoint: 'sm', collapsed: { mobile: !mobileOpened } }}
      padding={{ base: 16, md: 24 }}
      bg="transparent"
      transitionDuration={reduced ? 0 : 240}
      transitionTimingFunction="cubic-bezier(0.25, 1, 0.5, 1)"
    >
      <AppShell.Header withBorder={false}>
        <TopBar onToggleMobile={toggle} navCollapsed={collapsed} onToggleNav={toggleNav} />
      </AppShell.Header>

      <AppShell.Navbar p={collapsed ? 'xs' : 'md'} withBorder={false} style={{ transition: 'padding 240ms cubic-bezier(0.25, 1, 0.5, 1)' }}>
        {/* На телефоне выезжающее меню всегда полное — иконки без подписей там не нужны */}
        <Sidebar onNavigate={close} collapsed={collapsed && !mobileOpened} />
      </AppShell.Navbar>

      {/* Ссылка «к содержимому»: с клавиатуры без неё приходится проходить
          одиннадцать пунктов меню на каждом разделе (03.09.2026) */}
      <a href="#main" className="skip-link">К содержимому</a>

      {/* Полоса загрузки и зерно живут поверх всего приложения */}
      <LoadBar />
      <div className="grain" aria-hidden />

      <AppShell.Main>
        {/* min-width:0 — иначе широкие таблицы растягивают main и ломают сетку */}
        <Box id="main" style={{ minWidth: 0, maxWidth: '100%' }}>
          {/* Смена раздела: новый экран поднимается с растворением, ключ —
              путь БЕЗ search-параметров, иначе открытие карточки заказа
              (?order=…) перезапускало бы весь экран */}
          <motion.div
            key={pathname}
            initial={reduced ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={SPRING}
          >
            <SectionErrorBoundary resetKey={pathname}>
              <Outlet />
            </SectionErrorBoundary>
          </motion.div>
        </Box>
      </AppShell.Main>
    </AppShell>
    </EntityProvider>
    </ReceiptCardProvider>
    </OrderCardProvider>
  );
}
