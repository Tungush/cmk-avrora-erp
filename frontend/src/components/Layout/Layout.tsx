import React from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { AppShell, Box } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useAuthStore } from '../../store/auth';
import { OrderCardProvider } from '../OrderCard/OrderCardProvider';
import { ReceiptCardProvider } from '../ReceiptCard/ReceiptCardProvider';
import { motion, useReducedMotion } from 'framer-motion';
import { SPRING } from '../motion';

export function Layout() {
  const token = useAuthStore((state) => state.token);
  const [mobileOpened, { toggle, close }] = useDisclosure();
  const { pathname } = useLocation();
  const reduced = useReducedMotion();

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return (
    // Провайдер обязан быть НАД AppShell: поиск живёт в шапке
    // и тоже открывает карточку заказа
    <OrderCardProvider>
    <ReceiptCardProvider>
    <AppShell
      header={{ height: 64 }}
      navbar={{ width: 260, breakpoint: 'sm', collapsed: { mobile: !mobileOpened } }}
      padding={{ base: 16, md: 24 }}
      bg="var(--app-bg)"
    >
      <AppShell.Header withBorder={false} bg="var(--app-surface)" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
        <TopBar onToggleMobile={toggle} />
      </AppShell.Header>

      <AppShell.Navbar p="md" bg="var(--app-surface)" withBorder>
        <Sidebar onNavigate={close} />
      </AppShell.Navbar>

      <AppShell.Main>
        {/* min-width:0 — иначе широкие таблицы растягивают main и ломают сетку */}
        <Box style={{ minWidth: 0, maxWidth: '100%' }}>
          {/* Смена раздела: новый экран поднимается с растворением, ключ —
              путь БЕЗ search-параметров, иначе открытие карточки заказа
              (?order=…) перезапускало бы весь экран */}
          <motion.div
            key={pathname}
            initial={reduced ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={SPRING}
          >
            <Outlet />
          </motion.div>
        </Box>
      </AppShell.Main>
    </AppShell>
    </ReceiptCardProvider>
    </OrderCardProvider>
  );
}
