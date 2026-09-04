import React, { useCallback, useEffect, useState } from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { AppShell, Box } from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
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

const TOPBAR_KEY = 'ui-topbar';

function readTopCollapsed(): boolean {
  try { return localStorage.getItem(TOPBAR_KEY) === 'mini'; } catch { return false; }
}

/**
 * Оболочка приложения (04.09.2026).
 *
 * Боковое меню убрано: разделы живут в плавающей строке внизу
 * (BottomNav). Вместе с ним ушли сворачивание в рейку, запоминание
 * выбора в localStorage и выезжающее меню на телефоне — нижняя строка
 * одинаково работает на всех ширинах и не отнимает у содержимого 260 px
 * по всей высоте.
 *
 * Шапка и строка разделов сворачиваются независимо: обе освобождают
 * место данным, но нужны в разные моменты.
 */
export function Layout() {
  const token = useAuthStore((state) => state.token);
  const { pathname } = useLocation();
  const reduced = useMotionOff();

  /**
   * Шапка сворачивается по требованию (04.09.2026, просьба владельца:
   * «чтобы эта часть экрана освобождалась, когда нам надо»). Полоса
   * поиска занимает 56 px, и на разделе с длинной таблицей это две
   * лишние строки данных.
   *
   * Шапка именно СКРЫВАЕТСЯ, а не размонтируется: внутри неё живёт
   * общий поиск, и Cmd/Ctrl+K обязан работать в свёрнутом виде тоже.
   */
  const [topMini, setTopMini] = useState(readTopCollapsed);

  useEffect(() => {
    document.documentElement.dataset.topbar = topMini ? 'mini' : 'full';
  }, [topMini]);

  const toggleTop = useCallback(() => {
    setTopMini((v) => {
      const next = !v;
      try { localStorage.setItem(TOPBAR_KEY, next ? 'mini' : 'full'); } catch { /* приватный режим */ }
      return next;
    });
  }, []);

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
      header={{ height: 56 }}   /* 64 -> 56: полоса поиска не нуждается в такой высоте */
      padding={{ base: 16, md: 24 }}
      bg="transparent"
      transitionDuration={reduced ? 0 : 240}
      transitionTimingFunction="cubic-bezier(0.25, 1, 0.5, 1)"
    >
      <AppShell.Header withBorder={false}>
        <TopBar />
        <button type="button" className="topbar-toggle" onClick={toggleTop}
          aria-expanded title="Свернуть шапку" aria-label="Свернуть шапку">
          <IconChevronUp size={15} stroke={2.2} aria-hidden />
        </button>
      </AppShell.Header>

      {/* В свёрнутом виде — язычок, которым шапку возвращают. Нужен именно
          видимый, а не «подвести курсор к краю»: в цеху работают с
          планшета, где наведения нет. */}
      {topMini && (
        <button type="button" className="topbar-peek" onClick={toggleTop}
          aria-expanded={false} title="Показать шапку и поиск"
          aria-label="Показать шапку и поиск">
          <IconChevronDown size={15} stroke={2.2} aria-hidden />
        </button>
      )}

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
