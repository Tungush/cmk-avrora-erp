/**
 * Отметка производства: по ИЗДЕЛИЯМ, а не по видам работ (26.08.2026).
 *
 * Было пять шагов, потом три вида работ — но цеху и это лишнее: мастер
 * должен показать, что конкретное изделие изготовлено, а не расписывать,
 * какую операцию он делал (запрос пользователя: «уберём этапы работ,
 * просто покажем, что сделано по конкретной готовой продукции»).
 *
 * Виды работ (CUTTING/ASSEMBLY/PAINTING) НЕ исчезли из системы — они
 * остались там, где действительно нужны: нормы труда, ставка часа по
 * каждому виду работ, подряд. Себестоимость от отметок цеха не зависит
 * вообще (проверено: order-costing.service.ts не читает ProductionStage),
 * поэтому убрать их из отметки безопасно.
 *
 * Сырьё и ТМЦ (Article.isMaterialResale) в производство не попадают:
 * завод их не изготавливает, а перепродаёт. В активных заказах это
 * 378 позиций из 1942 — пятая часть очереди цеха была мусором.
 */

export type OrderStageCodeValue = 'PRODUCTION';
export type RoutingStageValue = 'CUTTING' | 'ASSEMBLY' | 'PAINTING';

export interface StageStep {
  code: OrderStageCodeValue;
  routingStage: RoutingStageValue;
  key: string;
  label: string;
}

/**
 * Виды работ — справочник для НОРМ и СТАВОК, не для отметки цеха.
 * Мастер их не выбирает; они нужны калькуляции (норма чел×часы на вид
 * работ) и подряду (какую работу отдали на сторону).
 */
export const STAGE_STEPS: StageStep[] = [
  { code: 'PRODUCTION', routingStage: 'CUTTING', key: 'PRODUCTION:CUTTING', label: 'Резка' },
  { code: 'PRODUCTION', routingStage: 'ASSEMBLY', key: 'PRODUCTION:ASSEMBLY', label: 'Сборка / сварка / обшивка' },
  { code: 'PRODUCTION', routingStage: 'PAINTING', key: 'PRODUCTION:PAINTING', label: 'Зачистка / покраска' },
];

export const ORDER_STAGE_CODES: OrderStageCodeValue[] = ['PRODUCTION'];
export const ROUTING_STAGES: RoutingStageValue[] = ['CUTTING', 'ASSEMBLY', 'PAINTING'];

/** Ключ шага: «PRODUCTION:CUTTING» — по нему сопоставляются записи БД */
export function stepKey(code: string, routingStage?: string | null): string {
  return routingStage ? `${code}:${routingStage}` : code;
}

/**
 * Отметка изделия: этап всегда PRODUCTION, вид работ НЕ обязателен —
 * мастер отмечает «изделие изготовлено» целиком. Вид работ принимается,
 * если его всё же прислали (совместимость и возможные частичные отметки).
 */
export function stageShapeError(code: string, routingStage?: string | null): string | null {
  if (!ORDER_STAGE_CODES.includes(code as OrderStageCodeValue)) {
    return `Неизвестный этап: ${code}. Допустимо: ${ORDER_STAGE_CODES.join(', ')}`;
  }
  if (routingStage && !ROUTING_STAGES.includes(routingStage as RoutingStageValue)) {
    return `Неизвестный вид работ: ${routingStage}. Допустимо: ${ROUTING_STAGES.join(', ')}`;
  }
  return null;
}

/**
 * Готовность заказа = сколько его ИЗДЕЛИЙ изготовлено (26.08.2026).
 *
 * Мерой служит список изделий заказа, а не отметки в базе: строки этапов
 * создаются лениво, и `every(done)` по ним пропускал бы заказ с одной
 * отметкой вперёд, минуя остальные изделия. Сырьё и ТМЦ в список не
 * входят — их не изготавливают.
 */
export function stageProgress(
  rows: Array<{ orderLineId?: string | null; status: string }>,
  /** Позиции-изделия заказа (без сырья и ТМЦ). Пусто — считать нечего */
  productLineIds: string[] = [],
): { allDone: boolean; anyStarted: boolean; doneCount: number; totalSteps: number } {
  const doneLines = new Set<string>();
  let anyStarted = false;
  for (const r of rows) {
    const st = r.status.toLowerCase();
    if (st === 'done' || st === 'in_progress') anyStarted = true;
    if (st === 'done' && r.orderLineId) doneLines.add(r.orderLineId);
  }

  const needed = productLineIds.length;
  const doneCount = productLineIds.filter((id) => doneLines.has(id)).length;
  return {
    // Заказ без изделий (только сырьё) готовым по цеху не становится
    allDone: needed > 0 && doneCount === needed,
    anyStarted,
    doneCount,
    totalSteps: needed,
  };
}

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
