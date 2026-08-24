import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { DatesProvider } from '@mantine/dates';
import 'dayjs/locale/ru';
// Локальные вариативные шрифты — без CDN: в цехе интернет не гарантирован.
// Golos Text — гротеск с образцовой кириллицей (Paratype).
import '@fontsource-variable/golos-text';
import '@fontsource-variable/jetbrains-mono';
import App from './App.tsx';
import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import './index.css';

/**
 * Дизайн-система «горячий металл»: тёплая бумага + графитовые нейтральные +
 * один акцент цвета раскалённой стали. Одна светлая схема, один шрифт для UI,
 * моноширинный — для чисел. Ничего лишнего: рамки вместо теней,
 * выравнивание вместо украшений.
 */
const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: 6,
  autoContrast: true,
  colors: {
    // Акцент: раскалённый металл — сварка, резка, прокат
    brand: [
      '#FDF1E8',
      '#FBE0CE',
      '#F6C3A1',
      '#F0A272',
      '#E98147',
      '#E16323',
      '#D9480F',
      '#B93B0B',
      '#8F2E09',
      '#652106',
    ],
    // Нейтральные: тёплый графит на бумаге, без синевы
    gray: [
      '#FAF9F7',
      '#F2F1ED',
      '#E7E5DF',
      '#D7D4CC',
      '#B0ACA1',
      '#8A867B',
      '#6B675D',
      '#504D45',
      '#33312B',
      '#1E1D19',
    ],
    dark: [
      '#D5D2CA',
      '#B0ACA1',
      '#8A867B',
      '#6B675D',
      '#504D45',
      '#3D3B34',
      '#33312B',
      '#282722',
      '#1E1D19',
      '#151410',
    ],
    // Статусы — чернильные, приглушённые: не спорят с акцентом
    success: [
      '#EAF6EE',
      '#D3EDDC',
      '#A8DBBA',
      '#7CC898',
      '#54B478',
      '#379D5D',
      '#2B8A57',
      '#227048',
      '#1A5638',
      '#123C28',
    ],
    warning: [
      '#FBF4DE',
      '#F6E8BD',
      '#EDD285',
      '#E3BB4E',
      '#D8A522',
      '#C08F0E',
      '#96700A',
      '#7A5B08',
      '#5E4606',
      '#423104',
    ],
    danger: [
      '#FBEBEA',
      '#F6D6D4',
      '#EDACA9',
      '#E3827E',
      '#D95953',
      '#CE3F38',
      '#C92A2A',
      '#A62222',
      '#821B1B',
      '#5E1313',
    ],
  },
  fontFamily: "'Golos Text Variable', 'Golos Text', -apple-system, 'Segoe UI', sans-serif",
  fontFamilyMonospace: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
  headings: {
    fontFamily: "'Golos Text Variable', 'Golos Text', sans-serif",
    fontWeight: '700',
  },
  defaultRadius: 'md',
  cursorType: 'pointer',
  components: {
    // Рамка 1px вместо тени — данные важнее украшений
    Card: {
      defaultProps: {
        withBorder: true,
      },
    },
    Button: {
      defaultProps: {
        radius: 'md',
      },
    },
    Badge: {
      defaultProps: {
        radius: 'sm',
      },
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
  },
});

// Плотность интерфейса: кладовщику — крупно, плановику — 40 строк
document.documentElement.dataset.density = localStorage.getItem('ui-density') ?? 'normal';

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
