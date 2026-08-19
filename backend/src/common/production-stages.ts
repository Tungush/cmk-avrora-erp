/**
 * Этапы заказа: два уровня вместо восьми в один ряд (09_COSTING_AND_STAGES.md §2).
 *
 * Верхний уровень — вехи заказа: КД → Снабжение → Производство.
 * Нижний — три передела внутри производства, и это тот же справочник
 * RoutingStage, по которому считается себестоимость. Один список вместо двух:
 * галочка мастера и калькуляция наконец говорят на одном языке.
 */

export type OrderStageCodeValue = 'DESIGN' | 'SUPPLY' | 'PRODUCTION';
export type RoutingStageValue = 'CUTTING' | 'ASSEMBLY' | 'PAINTING';

export interface StageStep {
  code: OrderStageCodeValue;
  routingStage: RoutingStageValue | null;
  key: string;
  label: string;
}

/** Порядок прохождения заказа: 2 вехи + 3 передела */
export const STAGE_STEPS: StageStep[] = [
  { code: 'DESIGN', routingStage: null, key: 'DESIGN', label: 'КД' },
  { code: 'SUPPLY', routingStage: null, key: 'SUPPLY', label: 'Снабжение' },
  { code: 'PRODUCTION', routingStage: 'CUTTING', key: 'PRODUCTION:CUTTING', label: 'Резка' },
  { code: 'PRODUCTION', routingStage: 'ASSEMBLY', key: 'PRODUCTION:ASSEMBLY', label: 'Сборка / сварка / обшивка' },
  { code: 'PRODUCTION', routingStage: 'PAINTING', key: 'PRODUCTION:PAINTING', label: 'Зачистка / покраска' },
];

export const ORDER_STAGE_CODES: OrderStageCodeValue[] = ['DESIGN', 'SUPPLY', 'PRODUCTION'];
export const ROUTING_STAGES: RoutingStageValue[] = ['CUTTING', 'ASSEMBLY', 'PAINTING'];

/** Ключ шага: «PRODUCTION:CUTTING» или «DESIGN» — по нему сопоставляются записи БД */
export function stepKey(code: string, routingStage?: string | null): string {
  return routingStage ? `${code}:${routingStage}` : code;
}

/**
 * Передел обязателен ровно для PRODUCTION и запрещён для остальных:
 * «Снабжение / Резка» — бессмыслица, которая потом всплывёт в отчётах.
 */
export function stageShapeError(code: string, routingStage?: string | null): string | null {
  if (!ORDER_STAGE_CODES.includes(code as OrderStageCodeValue)) {
    return `Неизвестный этап: ${code}. Допустимо: ${ORDER_STAGE_CODES.join(', ')}`;
  }
  if (code === 'PRODUCTION') {
    if (!routingStage) {
      return `Для этапа «Производство» нужен передел: ${ROUTING_STAGES.join(', ')}`;
    }
    if (!ROUTING_STAGES.includes(routingStage as RoutingStageValue)) {
      return `Неизвестный передел: ${routingStage}. Допустимо: ${ROUTING_STAGES.join(', ')}`;
    }
    return null;
  }
  if (routingStage) {
    return `Передел указывается только для этапа «Производство», не для «${code}»`;
  }
  return null;
}

/**
 * Режим отметки по числу позиций (§2.2). Половина заказов — до трёх позиций,
 * там одна галочка на заказ идеальна; но 28 % содержат 11 и больше, и для них
 * «резка по заказу целиком» ничего не значит.
 */
/** Значение по умолчанию, если CostingConfig недоступен */
export const DEFAULT_STAGE_TRACKING_THRESHOLD = 5;

export function resolveTrackingMode(lineCount: number, threshold: number): 'ORDER' | 'LINE' {
  return lineCount > threshold ? 'LINE' : 'ORDER';
}

export interface LineNorm {
  orderLineId: string;
  /** Нормативная трудоёмкость позиции на переделе: чел × часы × количество */
  normManHours: number;
}

export interface HoursAllocation {
  orderLineId: string;
  sharePct: number;
  hours: number;
}

/**
 * Раскладка фактических часов по позициям пропорционально нормам (§2.3).
 * Мастер вводит один факт на заказ — себестоимость всё равно получает разбивку
 * по изделиям, без второго ввода.
 *
 * Если норм нет вовсе (новое изделие без нормирования), часы делятся поровну —
 * это честнее, чем отдать всё первой позиции или потерять их совсем.
 */
export function allocateActualHours(actualHours: number, lines: LineNorm[]): HoursAllocation[] {
  if (lines.length === 0) return [];
  const totalNorm = lines.reduce((s, l) => s + Math.max(0, l.normManHours), 0);
  const weights = totalNorm > 0
    ? lines.map((l) => Math.max(0, l.normManHours) / totalNorm)
    : lines.map(() => 1 / lines.length);

  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const allocated = lines.map((l, i) => ({
    orderLineId: l.orderLineId,
    sharePct: Math.round(weights[i] * 10000) / 100,
    hours: round3(actualHours * weights[i]),
  }));

  // Хвост округления кладём в самую крупную позицию: сумма долей должна
  // сходиться с введённым фактом до копейки, иначе план/факт не сойдётся
  const diff = round3(actualHours - allocated.reduce((s, a) => s + a.hours, 0));
  if (diff !== 0) {
    const biggest = allocated.reduce((a, b) => (b.hours > a.hours ? b : a), allocated[0]);
    biggest.hours = round3(biggest.hours + diff);
  }
  return allocated;
}
