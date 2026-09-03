import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../store/auth';
import { ALL_ROUTES } from './fixtures';

/**
 * Режим дизайна (03.09.2026).
 *
 * Включается параметром ?design=1 (запоминается в localStorage, выключить
 * — ?design=0). В этом режиме:
 *   1) пользователь — администратор со всеми правами, входить не нужно;
 *   2) все запросы к API отвечают из фикстур (src/dev/fixtures), бэкенд
 *      и база не трогаются вовсе.
 *
 * Зачем: экраны надо ВИДЕТЬ, чтобы их рисовать. До этого правки шли
 * вслепую — токен истекал, а входить за владельца нельзя. Теперь любой
 * раздел открывается с реалистичными данными за секунду.
 *
 * Только для разработки: в продакшен-сборке код не включается вовсе
 * (см. isDesignMode — import.meta.env.DEV).
 */

const KEY = 'ui-design';

export function isDesignMode(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const q = new URLSearchParams(window.location.search).get('design');
    if (q === '1') localStorage.setItem(KEY, '1');
    if (q === '0') localStorage.removeItem(KEY);
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Псевдо-пользователь режима дизайна: админ, видит все разделы */
export function enterDesignMode(): void {
  const s = useAuthStore.getState();
  if (s.token === 'design-mode') return;
  s.setAuth('design-mode', {
    userId: '00000000-0000-4000-8000-000000000001',
    email: 'design@avrora.kz',
    roles: ['admin'],
  } as any);
}

const API_PREFIX = /^(?:https?:\/\/[^/]+)?\/api\/v1/;

function strip(url: string): { path: string; params: URLSearchParams } {
  const u = new URL(url, window.location.origin);
  const path = u.pathname.replace(API_PREFIX, '') || '/';
  return { path, params: u.searchParams };
}

/** Адаптер axios: отвечает из фикстур, имитируя небольшую задержку сети */
export const designAdapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const method = (config.method ?? 'get').toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const full = (config.baseURL ?? '') + (config.url ?? '');
  const { path, params } = strip(full);
  if (config.params) {
    for (const [k, v] of Object.entries(config.params as Record<string, unknown>)) {
      if (v != null) params.set(k, String(v));
    }
  }
  let body: unknown;
  try { body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data; } catch { body = config.data; }

  const route = ALL_ROUTES.find((r) => r.method === method && r.match.test(path));
  // Задержка небольшая, но не нулевая: скелеты и полоса загрузки должны
  // быть видны дизайнеру так же, как пользователю
  await new Promise((r) => setTimeout(r, 120 + (path.length % 5) * 40));

  // Заглушка для маршрута без фикстуры должна подходить обеим формам
  // ответа: одни экраны ждут голый массив (`items.slice`), другие —
  // конверт `{data, meta}`. Массив с дополнительными полями устраивает
  // и тех и других, и раздел показывает пустое состояние вместо падения
  // (03.09.2026).
  const empty = Object.assign([] as unknown[], {
    data: [] as unknown[],
    meta: { total: 0, page: 1, pageSize: Number(params.get('pageSize') ?? 25) },
    totals: {},
  });
  const data = route ? route.handler({ path, params, body }) : empty;
  if (!route && import.meta.env.DEV) {
    // Видно в консоли, каких фикстур не хватает — это и есть список работ
    console.info(`[design] нет фикстуры: ${method} ${path}`);
  }

  // Отказы по требованию: ?design=1&fail=offcuts или &fail=* (04.09.2026).
  //
  // Состояние ошибки — такой же экран, как и все остальные, и его тоже
  // надо уметь посмотреть без бэкенда. Раньше адаптер всегда отвечал
  // 200, поэтому проверить сообщение об отказе можно было только на
  // живом сервере — то есть почти никогда.
  //
  // Код задаётся через &failStatus (по умолчанию 500); GET не трогаем,
  // иначе разделы просто не наполнятся.
  const q = new URLSearchParams(window.location.search);
  const fail = q.get('fail');
  // failGet — отдельным флагом: если бы отказы по умолчанию касались и
  // чтения, раздел вообще не наполнился бы и смотреть было бы нечего.
  // Но состояние ошибки СПИСКА без этого не увидеть, а именно оно
  // раньше было неотличимо от «всё хорошо» (04.09.2026).
  const failGet = q.get('failGet');
  const target = method === 'GET' ? failGet : fail;
  if (target && (target === '*' || path.includes(target))) {
    const status = Number(q.get('failStatus')) || 500;
    const err = new Error(`[design] запрошен отказ ${status} на ${method} ${path}`) as Error & {
      response?: AxiosResponse; config?: InternalAxiosRequestConfig; isAxiosError?: boolean;
    };
    err.isAxiosError = true;
    err.config = config;
    err.response = {
      data: status === 500 ? {} : { error: { message: 'Партия уже зарезервирована другим заказом' } },
      status,
      statusText: 'Error',
      headers: {},
      config,
      request: {},
    };
    throw err;
  }

  const res: AxiosResponse = {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
    request: {},
  };
  return res;
};
