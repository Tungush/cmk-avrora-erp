/**
 * Единая точка правды для адреса бэкенда — её используют и axios-клиент,
 * и EventSource живых событий.
 *
 * Пусто (по умолчанию) — тот же origin:
 *   • локальная разработка: vite-прокси /api → localhost:3100;
 *   • self-hosted одним контейнером: Go сам раздаёт этот фронтенд.
 * Задано (`VITE_API_URL=https://api.example.kz`) — фронт и бэкенд на разных
 * доменах: фронт на Vercel, Go рядом с базой на VPS. Тогда бэкенду нужен
 * HTTPS (страница по https не может ходить на http) и CORS_ORIGINS с этим
 * доменом фронта.
 */
const raw = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '');

export const API_BASE = raw ? `${raw}/api/v1` : '/api/v1';

/** true — бэкенд на другом домене (нужны CORS и HTTPS на его стороне) */
export const IS_CROSS_ORIGIN = raw !== '';
