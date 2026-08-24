/**
 * Трудозатраты: штат и подряд на одном переделе (09_COSTING_AND_STAGES.md §5).
 *
 * Норма — свойство изделия, исполнитель — свойство заказа. Подряд это
 * ситуативное решение («не успеваем — обшивку отдали на сторону»), и влияет
 * оно на себестоимость конкретного заказа, а не на эталон в справочнике.
 */

export type LaborKindValue = 'STAFF' | 'CONTRACTOR';
export type WorkLocationValue = 'OUR_SHOP' | 'CONTRACTOR_SITE';
export type RateTypeValue = 'PER_HOUR' | 'PER_UNIT' | 'PER_KG' | 'PER_TON' | 'FIXED';
export type StageValue = 'CUTTING' | 'ASSEMBLY' | 'PAINTING';

/**
 * Системный дефолт — за штуку. Вес заполнен у 70 артикулов из 2 161 (3,2 %),
 * поэтому весовые ставки по умолчанию давали бы ноль на 97 % изделий,
 * а количество известно точно всегда.
 */
export const DEFAULT_RATE_TYPE: RateTypeValue = 'PER_UNIT';

export const RATE_TYPE_LABELS: Record<RateTypeValue, string> = {
  PER_HOUR: '₸ / час',
  PER_UNIT: '₸ / шт',
  PER_KG: '₸ / кг',
  PER_TON: '₸ / т',
  FIXED: '₸ за объём',
};

/** Ставки по весу невозможно посчитать без веса изделия */
export const WEIGHT_BASED_RATES: RateTypeValue[] = ['PER_KG', 'PER_TON'];

export class LaborConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LaborConfigError';
  }
}

export interface LaborAssignment {
  id?: string;
  stage: StageValue;
  laborKind: LaborKindValue;
  /** Доля объёма передела: две строки по 0.5 — это «подряд вместе со штатом» */
  share: number;
  rateType: RateTypeValue;
  rate: number;
  /** Часы идут в загрузку цеха, только если работы выполняются у нас */
  countInShopHours: boolean;
  /** Норма изделия — нужна для PER_HOUR */
  workers?: number;
  hoursPerUnit?: number;
  /** Оценка часов для сдельного подряда, работающего в нашем цеху */
  plannedHours?: number | null;
  contractorId?: string | null;
  workCenterId?: string | null;
  /**
   * Измеренный факт подряда в единицах СВОЕЙ ставки (часы для PER_HOUR,
   * штуки для PER_UNIT, кг для PER_KG, тонны для PER_TON). Пока NULL —
   * объём считается плановым: qty × share.
   */
  actualQty?: number | null;
  /** Сумма, замороженная при приёмке работы: ставка потом может смениться */
  actualAmount?: number | null;
  /**
   * Доля работы, приходящаяся на ЭТУ позицию заказа, когда подряд заведён
   * на заказ целиком (0…1). Калькуляция считается по позициям, а «фикс
   * 500 000 ₸ за передел» и принятая сумма — величины абсолютные: без
   * разнесения они списались бы полностью в каждую позицию и заказ из двух
   * позиций стоил бы вдвое дороже.
   *
   * К сдельным плановым ставкам НЕ применяется: там объём и так берётся
   * из qty позиции, и сумма по позициям сходится сама.
   */
  allocationFactor?: number;
}

export interface LaborContext {
  qty: number;
  weightKg?: number | null;
}

export interface LaborLineCost {
  stage: StageValue;
  laborKind: LaborKindValue;
  share: number;
  rateType: RateTypeValue;
  rate: number;
  cost: number;
  manHours: number;
  countedInShopHours: boolean;
  contractorId?: string | null;
  workCenterId?: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const SHARE_TOLERANCE = 1e-4;

/** Доступен ли тип ставки для этого изделия (09 §5.2) */
export function rateTypeAvailable(rateType: RateTypeValue, weightKg?: number | null): boolean {
  return !WEIGHT_BASED_RATES.includes(rateType) || (weightKg ?? 0) > 0;
}

/**
 * Стоимость и трудоёмкость одной строки исполнения.
 *
 * Молчаливых нулей нет нигде: весовая ставка без веса и сдельный подряд
 * в нашем цеху без оценки часов — это ошибки, а не «ноль ₸» и «свободный цех».
 */
export function calcAssignmentCost(a: LaborAssignment, ctx: LaborContext): { cost: number; manHours: number } {
  const qty = Math.max(0, ctx.qty);
  const share = Math.max(0, a.share);
  const weightKg = ctx.weightKg ?? 0;

  // Доля заказ-уровневой работы, приходящаяся на эту позицию (см. поле)
  const alloc = a.allocationFactor != null && a.allocationFactor >= 0 ? a.allocationFactor : 1;

  // Измеренный объём уже выражен в единицах своей ставки — вес изделия
  // тогда не нужен: подрядчик сдал 3,2 тонны, а не «10 штук по 320 кг»
  const measuredRaw = a.actualQty != null && a.actualQty >= 0 ? a.actualQty : null;
  const measured = measuredRaw != null ? measuredRaw * alloc : null;

  if (WEIGHT_BASED_RATES.includes(a.rateType) && weightKg <= 0 && measuredRaw === null) {
    throw new LaborConfigError(
      'RATE_REQUIRES_WEIGHT',
      `Ставка ${RATE_TYPE_LABELS[a.rateType]} требует заполненного веса изделия`,
    );
  }

  const normManHours = round3((a.workers ?? 0) * (a.hoursPerUnit ?? 0) * qty * share);

  let cost: number;
  let manHours: number;

  switch (a.rateType) {
    case 'PER_HOUR':
      manHours = measured ?? normManHours;
      cost = round2(manHours * a.rate);
      break;
    case 'PER_UNIT':
      cost = round2((measured ?? qty * share) * a.rate);
      manHours = round3((a.plannedHours ?? 0) * alloc);
      break;
    case 'PER_KG':
      cost = round2((measured ?? qty * share * weightKg) * a.rate);
      manHours = round3((a.plannedHours ?? 0) * alloc);
      break;
    case 'PER_TON':
      cost = round2((measured ?? (qty * share * weightKg) / 1000) * a.rate);
      manHours = round3((a.plannedHours ?? 0) * alloc);
      break;
    case 'FIXED':
    default:
      // Фикс — сумма за весь передел: на позицию приходится своя доля
      cost = round2(a.rate * alloc);
      manHours = round3((a.plannedHours ?? 0) * alloc);
      break;
  }

  // Сумма, замороженная при приёмке, важнее пересчёта: платим то, что приняли,
  // даже если ставка в справочнике подрядчика с тех пор изменилась
  if (a.actualAmount != null && a.actualAmount >= 0) {
    cost = round2(a.actualAmount * alloc);
  }

  // Сдельная ставка не содержит часов. Если такие работы идут в нашем цеху,
  // без оценки планирование мощности покажет свободный участок, которого нет.
  if (a.countInShopHours && a.rateType !== 'PER_HOUR' && manHours <= 0) {
    throw new LaborConfigError(
      'SHOP_HOURS_ESTIMATE_REQUIRED',
      'Работы идут в нашем цеху по сдельной ставке — нужна оценка часов',
    );
  }

  return { cost, manHours };
}

/**
 * Проверять «сумма ровно 1» больше нельзя: штат не хранится строкой, он —
 * остаток от нормы (решение 23.08.2026). Осталась одна возможная ошибка:
 * подряд забрал больше целого передела, и тогда объём оплачен дважды.
 *
 * Недобор до единицы ошибкой НЕ является: это либо штатный остаток, либо
 * передел без нормы, где штату взяться неоткуда.
 */
export function validateShares(assignments: LaborAssignment[]): string | null {
  const byStage = new Map<StageValue, number>();
  for (const a of assignments) {
    if (a.share < 0) return `Доля не может быть отрицательной (${a.stage})`;
    byStage.set(a.stage, (byStage.get(a.stage) ?? 0) + a.share);
  }
  for (const [stage, sum] of byStage) {
    if (sum - 1 > SHARE_TOLERANCE) {
      return `Доли на переделе ${stage} дают ${round2(sum * 100)} % — объём посчитан дважды`;
    }
  }
  return null;
}

export interface LaborSummary {
  lines: LaborLineCost[];
  /** Трудозатраты цеха: штат плюс подряд, работающий у нас */
  shopManHours: number;
  staffCost: number;
  contractorCost: number;
  /** Из подряда — та часть, что выполняется на стороне */
  offsiteContractorCost: number;
  totalCost: number;
  byStage: Array<{ stage: StageValue; cost: number; manHours: number }>;
}

/** Сводка по всем строкам исполнения заказа */
export function summarizeLabor(assignments: LaborAssignment[], ctx: LaborContext): LaborSummary {
  const shareError = validateShares(assignments);
  if (shareError) throw new LaborConfigError('INVALID_SHARES', shareError);

  const lines: LaborLineCost[] = assignments.map((a) => {
    const { cost, manHours } = calcAssignmentCost(a, ctx);
    return {
      stage: a.stage,
      laborKind: a.laborKind,
      share: a.share,
      rateType: a.rateType,
      rate: a.rate,
      cost,
      manHours,
      countedInShopHours: a.countInShopHours,
      contractorId: a.contractorId ?? null,
      workCenterId: a.workCenterId ?? null,
    };
  });

  const sum = (pred: (l: LaborLineCost) => boolean, field: 'cost' | 'manHours') =>
    lines.filter(pred).reduce((s, l) => s + l[field], 0);

  const byStageMap = new Map<StageValue, { cost: number; manHours: number }>();
  for (const l of lines) {
    const cur = byStageMap.get(l.stage) ?? { cost: 0, manHours: 0 };
    byStageMap.set(l.stage, { cost: cur.cost + l.cost, manHours: cur.manHours + l.manHours });
  }

  return {
    lines,
    shopManHours: round3(sum((l) => l.countedInShopHours, 'manHours')),
    staffCost: round2(sum((l) => l.laborKind === 'STAFF', 'cost')),
    contractorCost: round2(sum((l) => l.laborKind === 'CONTRACTOR', 'cost')),
    offsiteContractorCost: round2(
      sum((l) => l.laborKind === 'CONTRACTOR' && !l.countedInShopHours, 'cost'),
    ),
    totalCost: round2(sum(() => true, 'cost')),
    byStage: [...byStageMap.entries()].map(([stage, v]) => ({
      stage,
      cost: round2(v.cost),
      manHours: round3(v.manHours),
    })),
  };
}

/**
 * Строки исполнения по умолчанию — целиком штат по нормам изделия.
 * Подряд появляется только явным решением человека.
 */
export function defaultStaffAssignments(
  norms: Array<{ stage: StageValue; workers: number; hoursPerUnit: number; hourlyRate: number; workCenterId?: string | null }>,
): LaborAssignment[] {
  return norms.map((n) => ({
    stage: n.stage,
    laborKind: 'STAFF',
    share: 1,
    rateType: 'PER_HOUR',
    rate: n.hourlyRate,
    countInShopHours: true,
    workers: n.workers,
    hoursPerUnit: n.hoursPerUnit,
    workCenterId: n.workCenterId ?? null,
  }));
}
