# Общая часть задания на новый интерфейс «ЦМК АВРОРА» (03.09.2026)

## Продукт
ERP завода металлоконструкций (Казахстан, интерфейс на русском). Завод делает решётчатые
мачты под базовые станции сотовой связи, лестницы, ограждения. Роли: директор, плановик,
инженер, мастер цеха (планшет), кладовщики (сырьё/ГП), закупщик, бухгалтер, менеджер продаж.
Мониторы 1280–1920, в цехе планшеты. В системе работают весь день.

## Жёсткие правила владельца (нарушать нельзя)
1. Страница НИКОГДА не прокручивается: раздел целиком влезает в 1440×900 и 1280×800.
   `document.documentElement.scrollHeight === clientHeight`, боковой прокрутки нет ни у
   одного контейнера. Данных больше экрана → страницы, срезы, клавиши ← →, а не колесо.
2. «Смарт-фронт»: экран начинается с ответа (что требует решения), список — вторичен, за кликом.
3. Палитра ровно: холст #F0F0ED, поверхности #FFFFFF, чернила #000000, голубой #82ADD4
   (большая плоская панель), кислотно-жёлтый #DDFD2C (маркер; текст по нему только чёрный).
   Состояния: готово #5F8C5A, просрочено #D6452F. Токены уже в `src/index.css` и
   `src/styles/aurora.css` (`--ref-*`, `--c-*`). Никаких чужих цветов Mantine (teal/blue/orange…).
4. Текст ≥ 13 px. Числа крупные и лёгкие (вес 300), единица рядом мельче и серее.
5. Шрифт Onest (вариативный 100–900). Urbanist из референса — без кириллицы.
6. Знак — SVG-мачта `src/components/Mast.tsx` (progress, signal, beacon). Использовать умно.
7. Движение под `prefers-reduced-motion` и `useMotionOff()`; в скрытой вкладке framer не
   анимирует — компоненты не должны застревать на opacity 0.

## Стек и что уже есть (переиспользовать, не дублировать)
React 19, Mantine 9, framer-motion 13, TanStack Query, react-router 6.30 (`viewTransition`),
Tailwind-утилиты, CSS custom properties.
- `src/components/FitScreen.tsx`: `FitScreen{header,footer}`, `useFitRows(rowH,min,max,chrome)`,
  `useFitGrid(minW,cardH,gap)`, `usePageKeys(page,total,setPage)`. Включает `data-fit` на html.
- `src/components/Digest.tsx`: `DigestGrid`, `DigestCard{title,value(number→счётчик),format,
  caption,tone,icon,items[{label,value,sub,share,onClick}],emptyText,action}`.
- `src/components/SectionHeader.tsx`: `PulseRow` (плитки-фильтры), `PageHeader`.
- `src/components/ViewSwitch.tsx`: сводка ↔ список.
- `src/components/PaginationBar.tsx`: `PaginationBar`, `usePagedList(items,pageSize,resetKey)`.
- `src/components/motion.tsx`: `SPRING`, `FadeRise`, `Stagger`, `AnimatedNumber`, `Collapse`,
  `FadeSwap`, `TextReveal`, `useMotionOff`.
- `src/components/Mast.tsx`: `Mast`, `MastLoader`.
- `src/components/OrderCard/OrderCardProvider.tsx`: `useOrderCard().open(id, focus)` — карточка
  заказа шторкой поверх любого экрана (состояние в `?order=`).
- `src/components/Layout/*`: `Layout`, `TopBar`, `Sidebar`, `HeaderPulse`, `LoadBar`.
- CSS: `src/styles/aurora.css` (система), `src/index.css` (токены и базовые правила).

## Данные (эндпоинты, уже есть хуки/типы)
- Заказы: `GET /orders?page,pageSize,search,status,overdueOnly` → `{data, meta.total}`;
  `/orders/sites` → площадки; `/orders/inbox`; `/orders-dashboard`; `ordersApi` в `src/api/orders.ts`.
- Цех: `GET /production-plan/shop-floor?search` → `{orders[{products[]}], totalProducts,
  doneProducts, waitingProducts, blockedProducts, openRequests}`; отметка — `ordersApi.updateStage`.
- Изделия: `useArticles`, `useRouting`, `useCosting`, `useBom` (`src/hooks/useCatalog.ts`,
  `useRouting.ts`); `/articles/price-digest`.
- Склад: `/min-stock-levels`, `/material-batches/anomalies`, `/batch-reservations/expiring`,
  `/batch-reservations/overrides`, `/warehouse/offcuts`, `/materials`.
- Закупки: `purchasesApi.dashboard()` → `{kpi, unpaidDocs, suppliers, dimensions}`.
- Деньги: `/payment-documents/customer-debts` → `{customers[], totals}`.
- Подряд: `contractorRequestsApi.list()` → `{data, unallocated}`; `/contractor-work` → `{data, byContractor}`.
- Шапка: `dashboardApi.getWorkloadForecast()`; директор: `dashboardApi.getDirector()`.

## Режим дизайна (обязателен для проверки)
`http://localhost:5173/?design=1` — без входа, данные из `src/dev/fixtures`. Проверять
на 1440×900 и 1280×800: скриншот + скрипт `verify-screen.js` (pageY=0, pageX=0, нет
контейнеров с переполнением, нет текста < 13px, нет `.section-crash`). Консоль без ошибок.

## Файловая дисциплина (агенты работают параллельно в одном дереве)
Каждый агент правит ТОЛЬКО файлы своего раздела (список в его задании) и может ДОБАВЛЯТЬ
новые файлы в свою папку. Общие файлы (`aurora.css`, `index.css`, `Layout/*`, `Digest.tsx`,
`FitScreen.tsx`, `motion.tsx`, `main.tsx`, `App.tsx`) правит только оболочка. Если разделу
нужен новый общий стиль — положить его в `src/pages/<Раздел>/<Раздел>.css` и импортировать
из своего компонента. `npx tsc --noEmit -p tsconfig.json` перед возвратом — чисто.
Комментарии в коде — по-русски, объясняют «почему», с датой решения.
