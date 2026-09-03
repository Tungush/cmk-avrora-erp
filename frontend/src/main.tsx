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
    // Шкалы темы (03.09.2026, ревизия 2). Соответствуют tokens.css:
    // холст #F7F6F3, графитовая панель #23211E, терракота #B8431F,
    // коралл #E98074 (цвет владельца), зелень «готово» #1E4D33.
    //
    // Держать здесь шкалы, а не одиночные цвета, обязательно: Mantine
    // просит десять ступеней, и цвет, которого нет в теме, молча падает
    // на СВОЮ палитру библиотеки — так в интерфейс и попадала чужая
    // серо-синяя гамма.

    // brand — терракота: заливка внимания и её тёмный текстовый брат
    brand: [
      '#FDF4F0', '#FBEDE7', '#F2CFC2', '#EFA88F', '#E88A66',
      '#E06A45', '#C0472A', '#B8431F', '#9A3412', '#7A2A0E',
    ],
    // accent — коралл владельца: мягкая заливка, наведение
    accent: [
      '#FEF7F5', '#FBEDE7', '#F6D6CF', '#F2BDB2', '#EE9E90',
      '#E98074', '#D2685A', '#B8431F', '#9A3412', '#7A2A0E',
    ],
    // ink — действие: тёмная пилюля, тёплые нейтрали
    ink: [
      '#F7F6F3', '#F2F0EB', '#E6E3DC', '#D5D0C5', '#A9A399',
      '#6B6760', '#4A473F', '#2E2C28', '#23211E', '#1C1B18',
    ],
    gray: [
      '#FFFFFF', '#F7F6F3', '#F2F0EB', '#E6E3DC', '#D5D0C5',
      '#A9A399', '#6B6760', '#4A473F', '#2E2C28', '#1C1B18',
    ],
    dark: [
      '#D5D0C5', '#A9A399', '#8B857B', '#6B6760', '#585449',
      '#4A473F', '#3A3833', '#2E2C28', '#23211E', '#1C1B18',
    ],
    // success — зелень «готово». Светлота разведена с терракотой в 2,5
    // раза: красный и зелёный одной светлоты для дальтоника один цвет.
    success: [
      '#EDF2EE', '#DAE5DE', '#B4C9BC', '#8AAC98', '#4E7C62',
      '#1E4D33', '#1A452D', '#163A26', '#12301F', '#0C2115',
    ],
    // warning и danger — один тон с brand намеренно: в цеху нет разницы
    // «предупреждение» и «ошибка», есть «требует решения». Отличает не
    // цвет, а слово рядом.
    warning: [
      '#FDF4F0', '#FBEDE7', '#F2CFC2', '#EFA88F', '#E88A66',
      '#E06A45', '#C0472A', '#B8431F', '#9A3412', '#7A2A0E',
    ],
    danger: [
      '#FDF4F0', '#FBEDE7', '#F2CFC2', '#EFA88F', '#E88A66',
      '#E06A45', '#C0472A', '#B8431F', '#9A3412', '#7A2A0E',
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
