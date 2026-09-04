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
const BRICK: [string, string, string, string, string, string, string, string, string, string] = [
  '#FDF5F3', '#FAEBE8', '#F2CFC8', '#E39C90', '#DA7B66',
  '#D46553', '#C24A38', '#B23A2C', '#96301F', '#75251A',
];
const FOREST: [string, string, string, string, string, string, string, string, string, string] = [
  '#EDF3EF', '#D8E6DE', '#AEC9BC', '#7FA893', '#3E7458',
  '#134C34', '#11452F', '#0F412C', '#0B3323', '#072418',
];
const INDIGO: [string, string, string, string, string, string, string, string, string, string] = [
  '#F1F5FA', '#E2EAF4', '#C3D2E6', '#8FA9C9', '#5A7FAB',
  '#3E68A8', '#2C4E7E', '#17314D', '#112640', '#0C1B2E',
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
  black: '#16181A',
  colors: {
    // Шкалы темы «Индиго и кирпич» (04.09.2026). Соответствуют
    // tokens.css: холст #F8F8F7, индиговая плитка #17314D, кирпич
    // #B23A2C, зелень «сделано» #134C34.
    //
    // Держать здесь полные шкалы обязательно: Mantine просит десять
    // ступеней, и цвет, которого нет в теме, молча падает на СВОЮ
    // палитру библиотеки — так в интерфейс и попадала чужая гамма.

    // brand — кирпич: внимание. Им красится то, что требует решения
    brand: [
      '#FDF5F3', '#FAEBE8', '#F2CFC8', '#E39C90', '#DA7B66',
      '#D46553', '#C24A38', '#B23A2C', '#96301F', '#75251A',
    ],
    // accent — индиго: структура. Панель, кнопки, фокус
    accent: [
      '#F1F5FA', '#E2EAF4', '#C3D2E6', '#8FA9C9', '#5A7FAB',
      '#3E68A8', '#2C4E7E', '#17314D', '#112640', '#0C1B2E',
    ],
    // ink и gray — холодные нейтрали: рядом с индиго тёплый серый грязнит
    ink: [
      '#F8F8F7', '#F0F1F2', '#E3E4E4', '#D0D3D5', '#A2A7AB',
      '#61666B', '#43484D', '#2A2E33', '#1E2124', '#16181A',
    ],
    gray: [
      '#FFFFFF', '#F8F8F7', '#F0F1F2', '#E3E4E4', '#D0D3D5',
      '#A2A7AB', '#61666B', '#43484D', '#2A2E33', '#16181A',
    ],
    dark: [
      '#D0D3D5', '#A2A7AB', '#878C91', '#61666B', '#53585D',
      '#43484D', '#36393E', '#2A2E33', '#1E2124', '#16181A',
    ],
    // success — зелень «сделано». Светлота разведена с кирпичом в 2,3
    // раза: красный и зелёный одной светлоты для дальтоника один цвет.
    success: [
      '#EDF3EF', '#D8E6DE', '#AEC9BC', '#7FA893', '#3E7458',
      '#134C34', '#11452F', '#0F412C', '#0B3323', '#072418',
    ],
    // warning и danger — один тон с brand намеренно: в цеху нет разницы
    // «предупреждение» и «ошибка», есть «требует решения». Отличает не
    // цвет, а слово рядом.
    warning: [
      '#FDF5F3', '#FAEBE8', '#F2CFC8', '#E39C90', '#DA7B66',
      '#D46553', '#C24A38', '#B23A2C', '#96301F', '#75251A',
    ],
    danger: [
      '#FDF5F3', '#FAEBE8', '#F2CFC8', '#E39C90', '#DA7B66',
      '#D46553', '#C24A38', '#B23A2C', '#96301F', '#75251A',
    ],

    // ЗАПАСНЫЕ ШКАЛЫ (04.09.2026). Mantine знает свои имена цветов и
    // берёт их, когда мы не назвали своё: `--mantine-color-error` тянет
    // шкалу `red`, у Badge и Alert по умолчанию `blue`, у некоторых
    // состояний `green`. Шкал с такими именами в теме не было, поэтому
    // библиотека подставляла СВОЮ палитру — так на экране входа
    // появлялась звёздочка обязательного поля цветом #fa5252 (3,28:1
    // на белом), которого нет ни в одной нашей палитре.
    //
    // Перекрыть это переменной в CSS не выходит: Mantine печатает свои
    // значения в собственном блоке и выигрывает по порядку. Поэтому
    // имена переопределены здесь. Тревожные тона уходят в кирпич,
    // холодные — в индиго, зелёные — в зелень «сделано». Случайный
    // цвет теперь физически не может оказаться вне палитры.
    red: BRICK, orange: BRICK, yellow: BRICK, pink: BRICK,
    green: FOREST, lime: FOREST, teal: FOREST,
    blue: INDIGO, cyan: INDIGO, indigo: INDIGO, violet: INDIGO, grape: INDIGO,
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
