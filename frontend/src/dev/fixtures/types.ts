/**
 * Контракт фикстур режима дизайна (03.09.2026).
 *
 * Режим дизайна — это фронтенд без бэкенда и без входа: запросы axios
 * перехватываются адаптером (см. ../designMode.ts) и отвечают отсюда.
 * Нужен, чтобы видеть и править экраны с реалистичными данными, не
 * трогая базу и не имея токена.
 *
 * Каждый модуль (orders.ts, warehouse.ts, …) экспортирует `routes`.
 * `match` проверяется по пути БЕЗ префикса /api/v1 и без query-строки.
 */
export interface FixtureContext {
  /** Путь без префикса и query: «/orders/sites» */
  path: string;
  /** Query-параметры запроса */
  params: URLSearchParams;
  /** Тело для POST/PATCH/PUT, уже распарсенное */
  body?: unknown;
}

export interface FixtureRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  match: RegExp;
  handler: (ctx: FixtureContext) => unknown;
}
