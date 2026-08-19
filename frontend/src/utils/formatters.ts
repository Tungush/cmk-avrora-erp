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
  DRAFT: '#8A867B',
  CONFIRMED: '#0E7490',
  IN_PRODUCTION: '#C08F0E',
  READY_TO_SHIP: '#7C4FA8',
  SHIPPED: '#2B8A57',
  CLOSED: '#227048',
  CANCELLED: '#C92A2A',
};

export const STAGE_LABELS: Record<string, string> = {
  OS_WITH_CUSTOMER: 'ОС с заказчиком',
  GENERAL_VIEW: 'Общий вид',
  DRAWINGS: 'Чертежи',
  PROCUREMENT: 'Закуп',
  CUTTING: 'Резка',
  WELDING_ASSEMBLY: 'Сборка/сварка',
  PAINTING: 'Покраска',
  CLADDING: 'Обшивка',
};

export const STAGE_ORDER = [
  'OS_WITH_CUSTOMER',
  'GENERAL_VIEW',
  'DRAWINGS',
  'PROCUREMENT',
  'CUTTING',
  'WELDING_ASSEMBLY',
  'PAINTING',
  'CLADDING',
];
