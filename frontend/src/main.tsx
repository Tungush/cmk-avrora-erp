import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { DatesProvider } from '@mantine/dates';
import 'dayjs/locale/ru';
// Локальные вариативные шрифты — без CDN: в цехе интернет не гарантирован.
// Golos Text — гротеск с образцовой кириллицей (Paratype).
// Onest — замена Urbanist из референса: та же геометрия, но с кириллицей
import '@fontsource-variable/onest';
import '@fontsource-variable/jetbrains-mono';
import App from './App.tsx';
import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import './index.css';
// Слой «тёплое стекло» — последним: он переопределяет базовые поверхности
import './styles/aurora.css';

/**
 * Дизайн-система «горячий металл»: тёплая бумага + графитовые нейтральные +
 * один акцент цвета раскалённой стали. Одна светлая схема, один шрифт для UI,
 * моноширинный — для чисел. Ничего лишнего: рамки вместо теней,
 * выравнивание вместо украшений.
 */
const theme = createTheme({
  // Основной цвет — Energy Orange: по правилу 60–30–10 действие всегда
  // оранжевое, а Luminous Blue держит структуру (меню, шапки, блоки)
  primaryColor: 'accent',
  primaryShade: 6,
  autoContrast: true,
  colors: {
    // Палитра WGSN × Coloro S/S 27 (задана владельцем 02.09.2026).
    // brand = Luminous Blue, цвет года 2027: меню, шапки, ключевые блоки
    brand: [
      '#EDF2FE',
      '#D6E1FC',
      '#AEC3F8',
      '#83A3F4',
      '#5A84EF',
      '#2B62E8',
      '#2354CF',
      '#1B44B0',
      '#153588',
      '#0F1F4D',
    ],
    // accent = Energy Orange: 10 % палитры, только на действиях
    accent: [
      '#FFF1EB',
      '#FFDCCB',
      '#FFBB9C',
      '#FC9A6E',
      '#F87F4B',
      '#F4642A',
      '#E45520',
      '#D14A15',
      '#A63A11',
      '#7A2A0C',
    ],
    // Pop Pink — точечно: то, что требует человека, а не системы
    pink: [
      '#FEEDF4',
      '#FBD6E5',
      '#F7AECB',
      '#F286B1',
      '#EE6EA3',
      '#E85E9B',
      '#D44C87',
      '#B63C70',
      '#8E2C56',
      '#661D3C',
    ],
    // Нейтральные: холст молочный с глиняным подтоном, чернила с синевой
    gray: [
      '#FAF8F6',
      '#F5F3F0',
      '#EFEBE6',
      '#E7E2DC',
      '#CBC7C1',
      '#A5A9B2',
      '#7B8494',
      '#565F70',
      '#2A3242',
      '#0E1420',
    ],
    dark: [
      '#D2D6DE',
      '#AEB4C0',
      '#8A92A2',
      '#6A7385',
      '#4E5768',
      '#3A4252',
      '#2A3242',
      '#1D2433',
      '#141A28',
      '#0E1420',
    ],
    // Meadowland Green — «всё в порядке», спокойное, не кислотное
    success: [
      '#F0F6ED',
      '#DCEBD5',
      '#BCD9AF',
      '#9BC688',
      '#82B36C',
      '#6E9E5C',
      '#5F8C4E',
      '#4F7C40',
      '#3C6030',
      '#2A4522',
    ],
    // Тёплый янтарь на глине — ожидание, требует внимания
    warning: [
      '#FEF5E7',
      '#FBE7C6',
      '#F6CE8C',
      '#F1B75A',
      '#EDAA45',
      '#E8A33C',
      '#D48F26',
      '#B97A18',
      '#8F5D11',
      '#65420C',
    ],
    danger: [
      '#FDECE7',
      '#F9D5CB',
      '#F2AB99',
      '#E97F65',
      '#DF5C3D',
      '#D14A15',
      '#BB4012',
      '#9C350F',
      '#78290B',
      '#551C07',
    ],
  },
  fontFamily: "'Onest Variable', 'Onest', -apple-system, 'Segoe UI', sans-serif",
  // 02.09.2026: шаг вверх по всей шкале — xs 12→13, sm 14→15, md 16, lg 18, xl 22.
  // Тексту size="xs" (подписи, второстепенное) 12 px не хватало на мониторе цеха.
  fontSizes: { xs: '0.8125rem', sm: '0.9375rem', md: '1rem', lg: '1.125rem', xl: '1.375rem' },
  lineHeights: { xs: '1.4', sm: '1.45', md: '1.5', lg: '1.5', xl: '1.45' },
  fontFamilyMonospace: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
  headings: {
    fontFamily: "'Onest Variable', 'Onest', sans-serif",
    fontWeight: '700',
  },
  // Референс 02.09.2026 (Behance «ERP UI – POS»): крупные скругления,
  // белые карточки на светлом холсте с мягкой тенью вместо рамок, пилюли.
  // Скругления референса: поле 14, плитка 20, карточка 24
  radius: { xs: '8px', sm: '12px', md: '14px', lg: '20px', xl: '24px' },
  defaultRadius: 'md',
  shadows: {
    xs: '0 1px 2px rgba(20, 20, 18, 0.04)',
    sm: '0 1px 2px rgba(20, 20, 18, 0.04), 0 4px 14px rgba(20, 20, 18, 0.05)',
    md: '0 2px 4px rgba(20, 20, 18, 0.04), 0 10px 28px rgba(20, 20, 18, 0.07)',
    lg: '0 4px 8px rgba(20, 20, 18, 0.05), 0 18px 44px rgba(20, 20, 18, 0.10)',
    xl: '0 8px 16px rgba(20, 20, 18, 0.06), 0 28px 64px rgba(20, 20, 18, 0.14)',
  },
  cursorType: 'pointer',
  components: {
    // Карточка — белая плоскость с едва заметной тенью, без рамки
    Card: {
      defaultProps: {
        withBorder: false,
        radius: 'lg',
        shadow: 'sm',
        padding: 'lg',
      },
    },
    Paper: {
      defaultProps: { radius: 'lg' },
    },
    Button: {
      defaultProps: {
        radius: 'xl',
        fw: 600,
      },
    },
    ActionIcon: {
      defaultProps: { radius: 'xl' },
    },
    Badge: {
      defaultProps: {
        radius: 'xl',
        fw: 600,
      },
    },
    SegmentedControl: {
      defaultProps: { radius: 'xl', size: 'md' },
    },
    Tabs: {
      defaultProps: { variant: 'pills', radius: 'xl' },
    },
    Progress: {
      defaultProps: { radius: 'xl' },
    },
    ThemeIcon: {
      defaultProps: { radius: 'md' },
    },
    Menu: {
      defaultProps: { radius: 'lg', shadow: 'md' },
    },
    Popover: {
      defaultProps: { radius: 'lg', shadow: 'md' },
    },
    Tooltip: {
      defaultProps: {
        radius: 'md',
      },
    },
    // Движение (решение 23.08.2026): одна кривая на систему.
    // Шторка выезжает 280 мс, модалки появляются подъёмом 220 мс —
    // быстро, но с весом; ничего не «телепортируется»
    Drawer: {
      defaultProps: {
        transitionProps: { transition: 'slide-left', duration: 280, timingFunction: 'cubic-bezier(0.25, 1, 0.5, 1)' },
        overlayProps: { backgroundOpacity: 0.35, blur: 3 },
      },
    },
    Modal: {
      defaultProps: {
        transitionProps: { transition: 'pop', duration: 220, timingFunction: 'cubic-bezier(0.25, 1, 0.5, 1)' },
        overlayProps: { backgroundOpacity: 0.35, blur: 3 },
      },
    },
    Skeleton: {
      defaultProps: { radius: 'md' },
    },
    // Поля ввода и селекты — по умолчанию md: крупнее цель для пальца и глаза
    TextInput: { defaultProps: { size: 'md', radius: 'md' } },
    NumberInput: { defaultProps: { size: 'md', radius: 'md' } },
    Select: { defaultProps: { size: 'md', radius: 'md', comboboxProps: { transitionProps: { transition: 'pop', duration: 140 }, radius: 'lg', shadow: 'md' } } },
    Pagination: { defaultProps: { size: 'md', radius: 'xl' } },
    Table: { defaultProps: { verticalSpacing: 'sm', horizontalSpacing: 'md' } },
  },
});

// Плотность интерфейса: кладовщику — крупно, плановику — 40 строк
document.documentElement.dataset.density = localStorage.getItem('ui-density') ?? 'normal';
document.documentElement.dataset.motion = localStorage.getItem('ui-motion') === 'off' ? 'off' : 'on';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} forceColorScheme="light">
      <DatesProvider settings={{ locale: 'ru', firstDayOfWeek: 1 }}>
        <Notifications position="top-right" zIndex={9999} />
        <App />
      </DatesProvider>
    </MantineProvider>
  </React.StrictMode>,
);
