import React from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { AppShell, Box } from '@mantine/core';
import { TopBar } from './TopBar';
import { BottomNav } from './BottomNav';
import { useAuthStore } from '../../store/auth';
import { OrderCardProvider } from '../OrderCard/OrderCardProvider';
import { ReceiptCardProvider } from '../ReceiptCard/ReceiptCardProvider';
import { motion } from 'framer-motion';
import { SPRING, useMotionOff } from '../motion';
import { AuroraCanvas } from '../Aurora';
import { LoadBar } from './LoadBar';
import { SectionErrorBoundary } from '../ErrorBoundary';
import { EntityProvider } from '../EntityRef';

/**
 * Оболочка приложения (04.09.2026).
 *
 * Боковое меню убрано: разделы живут в плавающей строке внизу
 * (BottomNav). Вместе с ним ушли сворачивание в рейку, запоминание
 * выбора в localStorage и выезжающее меню на телефоне — нижняя строка
 * одинаково работает на всех ширинах и не отнимает у содержимого 260 px
 * по всей высоте.
 */
export function Layout() {
  const token = useAuthStore((state) => state.token);
  const { pathname } = useLocation();
  const reduced = useMotionOff();

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
      padding={{ base: 16, md: 24 }}
      bg="transparent"
      transitionDuration={reduced ? 0 : 240}
      transitionTimingFunction="cubic-bezier(0.25, 1, 0.5, 1)"
    >
      <AppShell.Header withBorder={false}>
        <TopBar />
      </AppShell.Header>

      {/* Ссылка «к содержимому»: с клавиатуры без неё приходится проходить
          одиннадцать разделов нижней строки на каждом экране */}
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

      {/* Разделы — плавающей строкой внизу, поверх содержимого */}
      <BottomNav />
    </AppShell>
    </EntityProvider>
    </ReceiptCardProvider>
    </OrderCardProvider>
  );
}
