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
const ACCENT: [string, string, string, string, string, string, string, string, string, string] = [
  '#EAF4F7', '#CFE6EC', '#9CCCD9', '#5FAFC2', '#2E93AB',
  '#1985A1', '#17788F', '#146B7E', '#11596A', '#0E4755',
];
/* Шкала строится ТОЛЬКО из палитры владельца: ступень 2 — холст
   #C5C3C6, ступень 1 — карточка #DCDCDD, ступень 7 — структура
   #4C5C68, ступень 8 — чернила #46494C. Промежуточные выведены
   интерполяцией, потому что Mantine требует десять ступеней и без них
   подставит СВОЮ палитру. Контраст на карточке #DCDCDD: ступень 6 =
   4,52:1 (текст годится), 7 = 5,04:1, 8 = 6,61:1. */
const NEUTRAL: [string, string, string, string, string, string, string, string, string, string] = [
  '#E8E8E9', '#DCDCDD', '#C5C3C6', '#AFAEB1', '#93959A',
  '#6E747C', '#59626C', '#4C5C68', '#46494C', '#46494C',
];
const theme = createTheme({
  // Действие в референсе — чёрная пилюля, поэтому основной цвет чернильный.
  // Голубой (brand) остаётся спокойным акцентом, жёлтый (accent) — маркером
  // Главное действие — индиго: в этой палитре структуру держит синий
  primaryColor: 'accent',
  primaryShade: 7,
  autoContrast: true,
  /* Чернила вместо чистого чёрного (04.09.2026). Без этого Mantine берёт
     --mantine-color-text = #000, и наш токен --s-text (#16181A) до
     компонентов не доходил: замер на «Закупках» показал чистый чёрный на
     135 элементах — таблицы, тексты, бейджи. Отсюда и ощущение, что
     интерфейс давит: контраст был жёстче задуманного. */
  black: '#46494C',   /* чернила палитры, не чистый чёрный */
  colors: {
    /* Палитра владельца, 04.09.2026
       (coolors.co/palette/dcdcdd-c5c3c6-46494c-4c5c68-1985a1).

       Держать здесь ПОЛНЫЕ десятиступенчатые шкалы обязательно: цвет,
       которого нет в теме, молча падает на СВОЮ палитру Mantine — так в
       интерфейс и попадала чужая гамма.

       Шкала NEUTRAL построена по палитре: ступени 1,2,5 — это ровно
       #E1E5EE, #C7CCDB и #767B91 владельца; 7 — #2A324B. Ступени 3,4,6,8,9
       выведены, потому что Mantine требует десять.
       Контраст на холсте #E1E5EE: ступень 5 = 3,32:1 (только линии и
       значки), 6 = 4,92:1 (текст годится), 7 = 10,05:1.

       Шкала ACCENT — персик #F7C59F на ступени 2. Ступени 0-6 текстом
       НЕ ГОДЯТСЯ (максимум 3,38:1), поэтому текст внимания берёт
       ступень 7 (#8A5220, 5,03:1), а персик работает только заливкой:
       тёмный на нём даёт 8,12:1. */

    // accent — тёмный #2A324B: структура, панель, кнопки, фокус
    accent: NEUTRAL,
    // brand — персик: внимание. Заливкой; текстом только ступень 7+
    brand: ACCENT,
    ink: NEUTRAL,
    gray: NEUTRAL,
    dark: NEUTRAL,

    /* «Сделано» отдельного цвета НЕ имеет: в палитре его нет, и норму
       не красят. Уходит в нейтраль — читается подписью, а указатель на
       экране остаётся один. */
    success: NEUTRAL,

    /* warning и danger — один тон с brand намеренно: в цеху нет разницы
       «предупреждение» и «ошибка», есть «требует решения». Отличает не
       цвет, а слово рядом. */
    warning: ACCENT,
    danger: ACCENT,

    /* ЗАПАСНЫЕ ИМЕНА. Mantine тянет `red` для --mantine-color-error, у
       Badge и Alert по умолчанию `blue`, у части состояний `green`.
       Перекрыть переменной в CSS не выходит: библиотека печатает свои
       значения в собственном блоке и выигрывает по порядку. Поэтому
       имена переопределены здесь — иначе на экране появляется чужой
       #fa5252 (3,28:1), которого нет ни в одной нашей палитре. */
    red: ACCENT,
    orange: ACCENT,
    yellow: ACCENT,
    pink: ACCENT,
    green: NEUTRAL,
    lime: NEUTRAL,
    teal: NEUTRAL,
    blue: NEUTRAL,
    cyan: NEUTRAL,
    indigo: NEUTRAL,
    violet: NEUTRAL,
    grape: NEUTRAL,
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
