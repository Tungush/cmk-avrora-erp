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
  // Действие в референсе — чёрная пилюля, поэтому основной цвет чернильный.
  // Голубой (brand) остаётся спокойным акцентом, жёлтый (accent) — маркером
  primaryColor: 'ink',
  primaryShade: 9,
  autoContrast: true,
  colors: {
    // Палитра референса Callivio, ровно те hex со страницы «Typography & Color»:
    // #82ADD4 голубой, #DDFD2C жёлтый, #F0F0ED серый, #FFFFFF, #000000.
    // brand — голубой: спокойный акцент и большие плоские панели
    brand: [
      '#F1F6FA',
      '#DFEAF3',
      '#BFD5E8',
      '#A0C1DC',
      '#82ADD4',
      '#6B9AC4',
      '#5C89B2',
      '#4E7FA8',
      '#3C6285',
      '#2E5E88',
    ],
    // accent — кислотный жёлтый: маркер, а не заливка. Текст по нему чёрный
    accent: [
      '#FBFFE6',
      '#F5FFC0',
      '#EDFE8A',
      '#E5FE55',
      '#DDFD2C',
      '#CBE921',
      '#B3CE18',
      '#93AA10',
      '#6E8500',
      '#4C5C00',
    ],
    // Действие — чёрная пилюля: primaryColor указывает сюда
    ink: [
      '#F4F4F2',
      '#E6E6E2',
      '#C9C9C2',
      '#A8A8A1',
      '#8A8A85',
      '#5E5E59',
      '#3D3D39',
      '#232321',
      '#121211',
      '#000000',
    ],
    gray: [
      '#FFFFFF',
      '#F7F7F4',
      '#F0F0ED',
      '#E6E6E2',
      '#D3D3CD',
      '#B0B0A9',
      '#8A8A85',
      '#5E5E59',
      '#2C2C2A',
      '#000000',
    ],
    dark: [
      '#D3D3CD',
      '#B0B0A9',
      '#8A8A85',
      '#6B6B66',
      '#4F4F4B',
      '#3D3D39',
      '#2C2C2A',
      '#1C1C1B',
      '#101010',
      '#000000',
    ],
    // Состояний в референсе нет — заведены нами и приглушены под общий тон
    success: [
      '#F0F5EF',
      '#DDE9DB',
      '#BCD3B8',
      '#9BBD95',
      '#7EA778',
      '#5F8C5A',
      '#527D4D',
      '#46703F',
      '#365831',
      '#264022',
    ],
    warning: [
      '#FBFFE6',
      '#F5FFC0',
      '#EDFE8A',
      '#E5FE55',
      '#DDFD2C',
      '#CBE921',
      '#B3CE18',
      '#93AA10',
      '#6E8500',
      '#4C5C00',
    ],
    danger: [
      '#FCEDEA',
      '#F8D8D1',
      '#F0B0A2',
      '#E68872',
      '#DD654B',
      '#D6452F',
      '#C43D28',
      '#B33A26',
      '#8E2C1D',
      '#691F15',
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
