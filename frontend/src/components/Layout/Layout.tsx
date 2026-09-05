import React, { useCallback, useEffect, useState } from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { AppShell, Box } from '@mantine/core';
import { TopBar } from './TopBar';
import { useAuthStore } from '../../store/auth';
import { OrderCardProvider } from '../OrderCard/OrderCardProvider';
import { ReceiptCardProvider } from '../ReceiptCard/ReceiptCardProvider';
import { motion } from 'framer-motion';
import { SPRING, useMotionOff } from '../motion';
import { LoadBar } from './LoadBar';
import { SectionErrorBoundary } from '../ErrorBoundary';
import { EntityProvider } from '../EntityRef';

/**
 * Оболочка приложения (05.09.2026).
 *
 * Разделы живут в шапке (TopBar) — единственной постоянной полосе.
 * Боковое меню ушло 04.09 (260 px по всей высоте), нижняя плавающая
 * строка — 05.09: на ноутбуке она съедала 74 px высоты и мешала
 * (снимки владельца). Низ экрана теперь целиком под содержимое.
 *
 * Сворачивание шапки убрано 04.09.2026: требовало двух кнопок, владелец
 * дважды назвал их лишними; ради 56 px это дорого.
 */
export function Layout() {
  const token = useAuthStore((state) => state.token);
  const { pathname } = useLocation();
  const reduced = useMotionOff();

  // Шапку можно скрыть совсем (меню аккаунта → «Скрыть меню», 05.09):
  // в скрытом виде её не видно, содержимое начинается от верха плашки, а
  // при подведении курсора к верхнему краю она выезжает поверх и уходит,
  // когда курсор ушёл. На планшете наведения нет — там шапка всегда видна.
  const canHide = typeof window !== 'undefined' && !window.matchMedia('(hover: none)').matches;
  const [peek, setPeek] = useState(false);
  const [chromeHidden, setChromeHidden] = useState<boolean>(() => {
    try { return localStorage.getItem('ui-chrome') === 'hidden'; } catch { return false; }
  });
  const toggleChrome = useCallback(() => setChromeHidden((v) => {
    const next = !v;
    try { localStorage.setItem('ui-chrome', next ? 'hidden' : 'shown'); } catch { /* приватный режим */ }
    return next;
  }), []);
  const hidden = chromeHidden && canHide;
  useEffect(() => { document.documentElement.dataset.chrome = hidden ? 'hidden' : 'shown'; if (!hidden) setPeek(false); }, [hidden]);


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
    <AppShell
      header={{ height: hidden ? 0 : 56 }}
      padding={{ base: 16, md: 24 }}
      bg="transparent"
      transitionDuration={reduced ? 0 : 240}
      transitionTimingFunction="cubic-bezier(0.25, 1, 0.5, 1)"
    >
      <AppShell.Header withBorder={false} data-peek={hidden && peek ? 'true' : undefined} onMouseLeave={() => setPeek(false)}>
        <TopBar hidden={hidden} onToggle={toggleChrome} />
      </AppShell.Header>
      {/* Невидимая зона у верхнего края: подвёл курсор — шапка выехала поверх */}
      {hidden && (
        <div
          className="chrome-hotzone" aria-hidden
          onMouseEnter={() => setPeek(true)}
          // курсор ушёл из зоны не в шапку — прячем сразу; в шапку — прячет её собственный onMouseLeave
          onMouseLeave={(e) => { const h = document.querySelector('.mantine-AppShell-header'); if (!(h && e.relatedTarget instanceof Node && h.contains(e.relatedTarget))) setPeek(false); }}
        />
      )}


      {/* Ссылка «к содержимому»: с клавиатуры без неё приходится проходить
          одиннадцать разделов шапки на каждом экране */}
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
