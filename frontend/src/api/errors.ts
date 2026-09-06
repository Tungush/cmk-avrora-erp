/**
 * Человеческое сообщение из ошибки запроса (04.09.2026).
 *
 * По коду разбор ответа был размазан: 28 мест писали свой вариант
 * `e?.response?.data?.error?.message`, ещё три — другие формы. Из-за
 * этого сообщение зависело от того, какой именно вариант вспомнил автор
 * экрана, а незнакомая форма молча превращалась в «Ошибка».
 *
 * Здесь собраны все формы, которые реально отдаёт бэкенд, плюс два
 * случая, которых раньше не разбирал никто: запрос не дошёл до сервера
 * (нет сети, бэкенд лежит) и отказ по правам. Их важно различать: «нет
 * связи» человек чинит сам и повторяет, а «нет прав» — повод идти к
 * администратору, повторять бессмысленно.
 */

interface ApiErrorish {
  code?: string;
  message?: string;
  response?: {
    status?: number;
    data?: {
      error?: string | { message?: string };
      message?: string;
    };
  };
}

/** Короткий заголовок для всплывающего сообщения */
export function apiErrorTitle(error: unknown): string {
  const e = error as ApiErrorish | null;
  if (!e) return 'Не удалось';
  if (!e.response) return 'Нет связи с сервером';
  const s = e.response.status;
  if (s === 403) return 'Недостаточно прав';
  if (s === 404) return 'Запись не найдена';
  if (s === 409) return 'Конфликт данных';
  return 'Не удалось';
}

/** Текст: сначала то, что сказал бэкенд, потом осмысленный запасной */
export function apiErrorMessage(error: unknown): string {
  const e = error as ApiErrorish | null;
  if (!e) return 'Неизвестная ошибка';

  // Запрос не дошёл: сети нет или бэкенд не отвечает
  if (!e.response) {
    return e.code === 'ECONNABORTED'
      ? 'Сервер не ответил вовремя. Проверьте связь и повторите.'
      : 'Сервер недоступен. Проверьте связь и повторите.';
  }

  const d = e.response.data;
  const fromBackend =
    (typeof d?.error === 'string' ? d.error : d?.error?.message) ?? d?.message;
  // Бизнес-запреты приходят как «[КОД] текст» (наследие NestJS): код человеку
  // ни к чему, он и так виден в заголовке «Конфликт данных» (06.09.2026)
  if (fromBackend) return fromBackend.replace(/^\[[A-Z0-9_]+\]\s*/, '');

  switch (e.response.status) {
    case 403: return 'Действие недоступно для вашей роли.';
    case 404: return 'Запись не найдена — возможно, её уже удалили.';
    case 409: return 'Данные изменились, пока вы работали. Обновите экран.';
    case 422: return 'Данные не приняты: проверьте заполнение полей.';
    default:  return `Ошибка сервера (${e.response.status ?? '—'}).`;
  }
}
