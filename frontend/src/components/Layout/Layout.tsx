import React, { useCallback, useEffect, useRef, useState } from 'react';
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

  /* Выезд шапки по положению курсора, а не по невидимой полоске в 12 px
     (07.09.2026: «неудобно, надо попасть, чтобы оно появилось»).
     Полоска была элементом поверх содержимого — расширить её значило
     перехватывать клики по верхним строкам. Слушаем движение мыши:
     цель стала 64 px вместо 12, кликам ничего не мешает.
     Прячем с запасом до 150 px и с задержкой — короткий промах курсором
     больше не закрывает меню, и его можно спокойно вести к нужному разделу.
     Пока открыто выпадающее меню шапки (аккаунт, поиск), не прячем вовсе. */
  const hideTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!hidden) return undefined;
    const onMove = (e: PointerEvent) => {
      if (e.clientY <= 64) {
        window.clearTimeout(hideTimer.current);
        setPeek(true);
      } else if (e.clientY > 150) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => {
          if (document.querySelector('.mantine-Menu-dropdown, .mantine-Modal-content, .mantine-Popover-dropdown')) return;
          setPeek(false);
        }, 320);
      }
    };
    document.addEventListener('pointermove', onMove);
    return () => { document.removeEventListener('pointermove', onMove); window.clearTimeout(hideTimer.current); };
  }, [hidden]);


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
      <AppShell.Header withBorder={false} data-peek={hidden && peek ? 'true' : undefined}>
        <TopBar hidden={hidden} onToggle={toggleChrome} />
      </AppShell.Header>


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
