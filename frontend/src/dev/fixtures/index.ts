import type { FixtureRoute } from './types';
import { routes as platform } from './platform';
import { routes as orders } from './orders';
import { routes as production } from './production';
import { routes as contractors } from './contractors';
import { routes as warehouse } from './warehouse';
import { routes as purchases } from './purchases';
import { routes as sales } from './sales';
import { routes as finance } from './finance';
import { routes as catalog } from './catalog';

/**
 * Реестр фикстур режима дизайна. Модули подключаются по мере готовности;
 * маршрут, которого нет ни в одном модуле, получает пустой ответ
 * {data: [], meta: {total: 0}} — экран не падает, а показывает пустое
 * состояние. Порядок важен: первый подошедший match выигрывает.
 */
export const ALL_ROUTES: FixtureRoute[] = [
  ...platform,
  ...orders,
  ...production,
  ...contractors,
  ...warehouse,
  ...purchases,
  ...sales,
  ...finance,
  ...catalog,
];
