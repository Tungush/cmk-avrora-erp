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

/** Статусы — чернильная гамма (§4.4): приглушённые, различимые по тону, не кричат */
export const ORDER_STATUS_COLORS: Record<string, string> = {
  NEW: '#D9480F',
  DRAFT: '#8A867B',
  CONFIRMED: '#0E7490',
  IN_PRODUCTION: '#C08F0E',
  READY_TO_SHIP: '#7C4FA8',
  SHIPPED: '#2B8A57',
  CLOSED: '#227048',
  CANCELLED: '#C92A2A',
};

/**
 * Этапы заказа = три вида работ цеха (26.08.2026, «Чертежи» и «Закуп»
 * убраны отовсюду — это не работа цеха, и они блокировали готовность).
 * Ключ — «PRODUCTION:CUTTING», как его отдаёт бэкенд.
 */
export const STAGE_LABELS: Record<string, string> = {
  PRODUCTION: 'Производство',
  'PRODUCTION:CUTTING': 'Резка',
  'PRODUCTION:ASSEMBLY': 'Сборка / сварка / обшивка',
  'PRODUCTION:PAINTING': 'Зачистка / покраска',
};

export const STAGE_ORDER = [
  'PRODUCTION:CUTTING',
  'PRODUCTION:ASSEMBLY',
  'PRODUCTION:PAINTING',
];

/** Короткие метки для полосы этапов — два символа читаются на любой ширине */
export const STAGE_SHORT: Record<string, string> = {
  'PRODUCTION:CUTTING': 'РЗ',
  'PRODUCTION:ASSEMBLY': 'СВ',
  'PRODUCTION:PAINTING': 'ПК',
};
