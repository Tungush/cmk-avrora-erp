import { format, formatDistanceToNow, parseISO } from 'date-fns';
import { ru } from 'date-fns/locale';

export function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '—';
  try {
    return format(parseISO(dateStr), 'dd.MM.yyyy', { locale: ru });
  } catch {
    return dateStr;
  }
}

export function formatDateTime(dateStr?: string | null): string {
  if (!dateStr) return '—';
  try {
    return format(parseISO(dateStr), 'dd.MM.yyyy HH:mm', { locale: ru });
  } catch {
    return dateStr;
  }
}

export function formatRelative(dateStr?: string | null): string {
  if (!dateStr) return '—';
  try {
    return formatDistanceToNow(parseISO(dateStr), { addSuffix: true, locale: ru });
  } catch {
    return dateStr;
  }
}

/**
 * Сумма в валюте документа. formatCurrency всегда рисует тенге, и 17 ДО
 * в рублях показывались как тенговые — деньги завышались молча (26.08.2026).
 */
export function formatMoney(value?: number | null, currency = 'KZT'): string {
  if (value == null) return '—';
  const symbols: Record<string, string> = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€', CNY: '¥' };
  const num = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
  return `${num} ${symbols[currency] ?? currency}`;
}

/**
 * Крупные суммы коротко: 184 220 900 → «184,2 млн ₸» (03.09.2026).
 *
 * В сводках число стоит на карточке 28-м кеглем, и полная запись из
 * девяти цифр туда просто не влезала — обрезалась на середине. Референс
 * решает это так же: «10.8k», «3.3/5», а не «10 832».
 *
 * Точность падает намеренно: в сводке важен порядок величины, точную
 * цифру человек смотрит в реестре.
 */
export function formatCompactMoney(value?: number | null, currency = 'KZT'): string {
  if (value == null) return '—';
  const symbols: Record<string, string> = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€', CNY: '¥' };
  const sym = symbols[currency] ?? currency;
  const abs = Math.abs(value);
  const one = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  if (abs >= 1e9) return `${one(value / 1e9)} млрд ${sym}`;
  if (abs >= 1e6) return `${one(value / 1e6)} млн ${sym}`;
  if (abs >= 1e4) return `${one(value / 1e3)} тыс ${sym}`;
  return `${Math.round(value).toLocaleString('ru-RU')} ${sym}`;
}

export function formatCurrency(value?: number | null): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('ru-KZ', {
    style: 'currency',
    currency: 'KZT',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value?: number | null, decimals = 2): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('ru-KZ', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatPercent(value?: number | null): string {
  if (value == null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  NEW: 'Новый из 1С',
  DRAFT: 'Черновик',
  CONFIRMED: 'Подтверждён',
  IN_PRODUCTION: 'В производстве',
  READY_TO_SHIP: 'Готов к отгрузке',
  SHIPPED: 'Отгружен',
  CLOSED: 'Закрыт',
  CANCELLED: 'Отменён',
};

/**
 * Цвет статуса — только семантический токен палитры (03.09.2026).
 *
 * Было восемь сырых hex (бирюза, фиолет, охра, алый) — чужая радуга из
 * дефолтной палитры Mantine. Охра #C08F0E на своей же подложке давала
 * 2,71:1 при 13 px: «В производстве» читалось на пределе. Плюс восемь
 * тонов на экране убивают правило 60‑30‑10 — акцент перестаёт значить
 * «сюда смотреть», если им покрашено всё подряд.
 *
 * Теперь восемь статусов сведены к четырём ролям палитры. Различать их
 * по цвету и не надо: рядом всегда стоит слово, а «В производстве» и
 * «Новый» дополнительно помечены живой точкой (см. StatusBadge).
 *   внимание  — требует решения (новый из 1С, отменён);
 *   чернила   — в работе (подтверждён, в производстве);
 *   готово    — доведено до конца (к отгрузке, отгружен);
 *   тихий     — не требует внимания (черновик, закрыт).
 */
export const ORDER_STATUS_COLORS: Record<string, string> = {
  NEW: 'var(--s-attention)',
  DRAFT: 'var(--s-text-quiet)',
  CONFIRMED: 'var(--s-text)',
  IN_PRODUCTION: 'var(--s-text)',
  READY_TO_SHIP: 'var(--s-ok)',
  SHIPPED: 'var(--s-ok)',
  CLOSED: 'var(--s-text-quiet)',
  CANCELLED: 'var(--s-attention)',
};

/**
 * Виды работ остались только там, где считаются деньги: нормы,
 * ставки часа и подряд (26.08.2026). Цех операции больше не отмечает —
 * он показывает, что изготовлено конкретное изделие, поэтому списка
 * этапов заказа (STAGE_ORDER / STAGE_SHORT) больше нет.
 */
export const ROUTING_STAGE_LABELS: Record<string, string> = {
  CUTTING: 'Резка',
  ASSEMBLY: 'Сборка / сварка / обшивка',
  PAINTING: 'Зачистка / покраска',
};

/**
 * Русское склонение по числу: 1 изделие, 2 изделия, 73 изделия, 75 изделий.
 * Наивное `n < 5` врало на любом числе больше двадцати — а цифры на экранах
 * цеха и подряда как раз такие.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
