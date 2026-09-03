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
import { isDesignMode, enterDesignMode } from './dev/designMode';

/**
 * Дизайн-система «горячий металл»: тёплая бумага + графитовые нейтральные +
 * один акцент цвета раскалённой стали. Одна светлая схема, один шрифт для UI,
 * моноширинный — для чисел. Ничего лишнего: рамки вместо теней,
 * выравнивание вместо украшений.
 */
const theme = createTheme({
  // Действие в референсе — чёрная пилюля, поэтому основной цвет чернильный.
  // Голубой (brand) остаётся спокойным акцентом, жёлтый (accent) — маркером
  primaryColor: 'ink',
  primaryShade: 9,
  autoContrast: true,
  colors: {
    // Палитра владельца (Exteta), 03.09.2026: кремовый холст #EAE7DC,
    // бежевая панель #D8C3A5, тёплый серый #8E8D8A, коралл #E98074,
    // терракота #E85A4F. Чернила и «готово» добавлены нами — см. шапку
    // styles/aurora.css.
    brand: [
      '#FBEEEA',
      '#F8DBD6',
      '#F3B8AF',
      '#EE9689',
      '#EB776A',
      '#E85A4F',
      '#D24C41',
      '#B8402F',
      '#8F3225',
      '#66231A',
    ],
    accent: [
      '#FDF2F0',
      '#FADFDB',
      '#F5C0B8',
      '#EFA095',
      '#EC8E80',
      '#E98074',
      '#D26C60',
      '#B8402F',
      '#8F3225',
      '#66231A',
    ],
    // Действие — тёмная пилюля тёплого угля
    ink: [
      '#F5F2E9',
      '#DCD7C9',
      '#CFC8B7',
      '#B3AC9B',
      '#8E8D8A',
      '#66625A',
      '#4A473F',
      '#3B3934',
      '#3A382F',
      '#33312C',
    ],
    gray: [
      '#FFFFFF',
      '#F5F2E9',
      '#EAE7DC',
      '#DCD7C9',
      '#CFC8B7',
      '#8E8D8A',
      '#66625A',
      '#4A473F',
      '#3B3934',
      '#33312C',
    ],
    dark: [
      '#CFC8B7',
      '#B3AC9B',
      '#8E8D8A',
      '#77736B',
      '#5C584F',
      '#4A473F',
      '#403D36',
      '#3A382F',
      '#36342E',
      '#33312C',
    ],
    success: [
      '#F1F3E9',
      '#E2E7D3',
      '#C7D0AE',
      '#ACB98A',
      '#96A671',
      '#7D8A5C',
      '#6D7A4F',
      '#5E6B41',
      '#4A5433',
      '#363D25',
    ],
    warning: [
      '#FDF2F0',
      '#FADFDB',
      '#F5C0B8',
      '#EFA095',
      '#EC8E80',
      '#E98074',
      '#D26C60',
      '#B8402F',
      '#8F3225',
      '#66231A',
    ],
    danger: [
      '#FBEAE8',
      '#F7D2CE',
      '#F0A9A1',
      '#E88075',
      '#E86A5E',
      '#E85A4F',
      '#D04A40',
      '#B8402F',
      '#8F3225',
      '#66231A',
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

// Режим дизайна: псевдо-вход до первого рендера, чтобы Layout не отправил на /login
if (isDesignMode()) enterDesignMode();

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
