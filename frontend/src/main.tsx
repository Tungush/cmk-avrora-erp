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
// Шкалы для запасных имён Mantine — те же значения, что у brand /
// success / accent. Вынесены в константы, чтобы не расходились.
/* Бирюза владельца #1985A1 стоит на ступени 5. Ступени 0-5 текстом
   НЕ ГОДЯТСЯ (максимум 3,65:1 на карточке), поэтому текст внимания
   берёт ступень 7 (#146B7E, 5,23:1), а сама бирюза работает заливкой. */
type Scale = [string, string, string, string, string, string, string, string, string, string];

/* Тёмная нейтраль (05.09.2026). Порядок — от светлого к тёмному, как
   требует Mantine для схемы dark: dark[0] — текст, dark[6] — карточка,
   dark[7] — холст. Значения совпадают с tokens.css: карточка #1E293B,
   холст #0F172A, вторичный текст #A3B1C6 (6,73:1). */
const SLATE: Scale = [
  '#E2E8F0', '#CBD5E1', '#A3B1C6', '#94A3B8', '#334155',
  '#273449', '#1E293B', '#0F172A', '#0B1220', '#070D1A',
];
/* Четыре пастельных акцента — по категории, не по статусу. Ступень 4
   (индекс) — рабочая на тёмном: indigo 4,90:1, rose 5,44, emerald 7,61,
   amber 8,76 к карточке. autoContrast сам ставит тёмный текст на них. */
const INDIGO: Scale = ['#EEF2FF', '#E0E7FF', '#C7D2FE', '#A5B4FC', '#818CF8', '#6366F1', '#4F46E5', '#4338CA', '#3730A3', '#312E81'];
const ROSE: Scale    = ['#FFF1F2', '#FFE4E6', '#FECDD3', '#FDA4AF', '#FB7185', '#F43F5E', '#E11D48', '#BE123C', '#9F1239', '#881337'];
const EMERALD: Scale = ['#ECFDF5', '#D1FAE5', '#A7F3D0', '#6EE7B7', '#34D399', '#10B981', '#059669', '#047857', '#065F46', '#064E3B'];
const AMBER: Scale   = ['#FFFBEB', '#FEF3C7', '#FDE68A', '#FCD34D', '#FBBF24', '#F59E0B', '#D97706', '#B45309', '#92400E', '#78350F'];

const theme = createTheme({
  // Действие в референсе — чёрная пилюля, поэтому основной цвет чернильный.
  // Голубой (brand) остаётся спокойным акцентом, жёлтый (accent) — маркером
  // Главное действие — индиго: в этой палитре структуру держит синий
  primaryColor: 'accent',
  primaryShade: { light: 6, dark: 4 },
  autoContrast: true,
  /* Чернила вместо чистого чёрного (04.09.2026). Без этого Mantine берёт
     --mantine-color-text = #000, и наш токен --s-text (#16181A) до
     компонентов не доходил: замер на «Закупках» показал чистый чёрный на
     135 элементах — таблицы, тексты, бейджи. Отсюда и ощущение, что
     интерфейс давит: контраст был жёстче задуманного. */
  black: '#0F172A',
  white: '#E2E8F0',
  colors: {
    /* accent — индиго: главное действие, фокус, ссылка */
    accent: INDIGO,
    /* brand — rose: внимание, просрочка, долг */
    brand: ROSE,
    ink: SLATE, gray: SLATE, dark: SLATE,
    success: EMERALD,
    warning: AMBER,
    danger: ROSE,
    /* Запасные имена Mantine — чтобы библиотека не подставила свою гамму */
    red: ROSE, pink: ROSE, orange: AMBER, yellow: AMBER,
    green: EMERALD, lime: EMERALD, teal: EMERALD,
    blue: INDIGO, cyan: INDIGO, indigo: INDIGO, violet: INDIGO, grape: INDIGO,
  },

  fontFamily: "'Onest Variable', 'Onest', -apple-system, 'Segoe UI', sans-serif",
  // 02.09.2026: шаг вверх по всей шкале — xs 12→13, sm 14→15, md 16, lg 18, xl 22.
  // Тексту size="xs" (подписи, второстепенное) 12 px не хватало на мониторе цеха.
  /* Mantine берёт --mantine-color-dimmed со ступени 6 своей серой
     шкалы, мимо наших токенов: все подписи через c="dimmed" шли
     цветом #59626C и давали 3,46-3,66:1 при пороге 4,5 (найдено
     обходом 04.09.2026). Ступени 5 и 6 сведены к #45515D. */
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
        /* Пастельная заливка светлая — белый текст Mantine давал 1,35:1
           (счётчики «Требует решения», замер 05.09.2026). autoContrast
           ставит на неё тёмный текст. */
        autoContrast: true,
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
      defaultProps: { radius: 'md', autoContrast: true },
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
    <MantineProvider theme={theme} forceColorScheme="dark">
      <DatesProvider settings={{ locale: 'ru', firstDayOfWeek: 1 }}>
        <Notifications position="top-right" zIndex={9999} />
        <App />
      </DatesProvider>
    </MantineProvider>
  </React.StrictMode>,
);
