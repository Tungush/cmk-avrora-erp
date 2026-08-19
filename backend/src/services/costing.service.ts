/**
 * Калькуляция себестоимости — точный перенос формул листа «Спецификации 2022»
 * (разбор: 06_SHEET_ANALYSIS_AND_DESIGN.md §3.3, модуль: 07_ARCHITECTURE_AND_UX.md §3).
 *
 * Excel-оригинал (строка изделия, X = оклад ср./час из «ЗП сотр.»):
 *   AA = Z*Y*X                — стоимость резки
 *   AD = AC*AB*X              — стоимость сборки/сварки/обшивки
 *   AG = AF*AE*X              — стоимость зачистки/покраски
 *   AH = (Z*Y)+(AB*AC)+(AE*AF) — общий чел/час
 *   AI = AA+AD+AG             — себестоимость труда
 *   AJ = W * 3%               — логистика (W — цена материалов)
 *   AK = W * 1%               — вода/газ/электричество
 *   AM = W+AI+AJ+AK           — себестоимость
 *   AN = AM * 10%             — маржа
 *   AP = AM+AN                — цена
 */

export interface StageNorm {
  stage: 'CUTTING' | 'ASSEMBLY' | 'PAINTING';
  workers: number;
  hoursPerUnit: number;
  /** Ставка участка; если не задана — ставка из CostingConfig */
  hourlyRate?: number | null;
}

/**
 * Как трактуется процент маржи. Разница принципиальная: на себестоимости
 * 1 000 000 ₸ и проценте 35 MARKUP даёт цену 1 350 000, MARGIN — 1 538 462.
 * Поэтому режим обязателен и никогда не подразумевается по умолчанию.
 */
export type MarginMode =
  | 'MARGIN'   // 35 % от цены:          price = cost / (1 - pct)
  | 'MARKUP';  // 35 % сверх себестоимости: price = cost * (1 + pct)

/** Логистика: «мат × 3 %» ломается на тяжёлых дешёвых и лёгких дорогих изделиях */
export type LogisticsMode =
  | 'PERCENT_OF_MATERIAL'
  | 'FIXED_AMOUNT'
  | 'PER_KG';

/** Конфигурация расчёта невалидна — считать нельзя, молча подставлять ноль тем более */
export class CostingConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CostingConfigError';
  }
}

export interface CostingRates {
  hourlyRate: number;     // 2040 в исходнике
  logisticsPct: number;   // 0.03
  utilitiesPct: number;   // 0.01
  marginPct: number;      // 0.35 в новой схеме, 0.10 в исходнике
  /** Обязателен: от него зависит цена, и подразумевать его нельзя (09 §3.2) */
  marginMode: MarginMode;
  logisticsMode?: LogisticsMode;   // по умолчанию PERCENT_OF_MATERIAL
  logisticsFixed?: number;         // для FIXED_AMOUNT
  logisticsPerKg?: number;         // для PER_KG
}

/** Что известно об изделии сверх норм и цены материалов */
export interface CostingContext {
  /** Вес изделия; нужен только для логистики PER_KG */
  weightKg?: number;
}

export interface StageCostLine {
  stage: StageNorm['stage'];
  workers: number;
  hoursPerUnit: number;
  hourlyRate: number;
  manHours: number;   // workers × hours
  stageCost: number;  // manHours × rate
}

export interface CostingResult {
  materialCost: number;
  stages: StageCostLine[];
  totalManHours: number;
  laborCost: number;
  logisticsCost: number;
  utilitiesCost: number;
  totalCost: number;
  margin: number;
  price: number;
  marginMode: MarginMode;
  marginPct: number;
  /** Доля маржи в цене — то, что обычно называют «маржинальностью» */
  marginOfPricePct: number;
  /** Наценка на себестоимость — то, что обычно называют «накрутили N %» */
  markupPct: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Логистика по выбранному режиму. Нулевой вес при режиме PER_KG — не «ноль ₸»,
 * а незаполненные данные: на 2 161 артикуле вес есть у 70, и молчаливый ноль
 * ушёл бы прямо в цену (09 §3.2).
 */
function logisticsCostOf(
  materialCost: number,
  rates: CostingRates,
  ctx?: CostingContext,
): number {
  switch (rates.logisticsMode ?? 'PERCENT_OF_MATERIAL') {
    case 'FIXED_AMOUNT':
      return round2(rates.logisticsFixed ?? 0);
    case 'PER_KG': {
      const weightKg = ctx?.weightKg ?? 0;
      if (weightKg <= 0) {
        throw new CostingConfigError(
          'LOGISTICS_PER_KG_WITHOUT_WEIGHT',
          'Логистика «за кг» требует заполненного веса изделия',
        );
      }
      return round2(weightKg * (rates.logisticsPerKg ?? 0));
    }
    default:
      return round2(materialCost * rates.logisticsPct);
  }
}

/** Маржа и цена по выбранному режиму (09 §3.2) */
function marginAndPrice(totalCost: number, rates: CostingRates): { margin: number; price: number } {
  if (rates.marginMode === 'MARGIN') {
    // Доля маржи в цене не может быть 100 % и выше — это деление на ноль
    if (!(rates.marginPct < 1)) {
      throw new CostingConfigError(
        'MARGIN_PCT_OUT_OF_RANGE',
        `Маржинальность от цены должна быть меньше 100 %, получено ${round2(rates.marginPct * 100)} %`,
      );
    }
    const price = round2(totalCost / (1 - rates.marginPct));
    return { margin: round2(price - totalCost), price };
  }
  const margin = round2(totalCost * rates.marginPct);
  return { margin, price: round2(totalCost + margin) };
}

/** Полный расчёт себестоимости изделия по нормам переделов и цене материалов */
export function calculateArticleCosting(
  materialCost: number,
  norms: StageNorm[],
  rates: CostingRates,
  ctx?: CostingContext,
): CostingResult {
  const stages: StageCostLine[] = norms.map((n) => {
    const hourlyRate = n.hourlyRate ?? rates.hourlyRate;
    const manHours = round3(n.workers * n.hoursPerUnit);
    return {
      stage: n.stage,
      workers: n.workers,
      hoursPerUnit: n.hoursPerUnit,
      hourlyRate,
      manHours,
      stageCost: round2(manHours * hourlyRate),
    };
  });

  const totalManHours = round3(stages.reduce((s, x) => s + x.manHours, 0));
  const laborCost = round2(stages.reduce((s, x) => s + x.stageCost, 0));
  const logisticsCost = logisticsCostOf(materialCost, rates, ctx);
  const utilitiesCost = round2(materialCost * rates.utilitiesPct);
  const totalCost = round2(materialCost + laborCost + logisticsCost + utilitiesCost);
  const { margin, price } = marginAndPrice(totalCost, rates);

  return {
    materialCost: round2(materialCost),
    stages,
    totalManHours,
    laborCost,
    logisticsCost,
    utilitiesCost,
    totalCost,
    margin,
    price,
    marginMode: rates.marginMode,
    marginPct: rates.marginPct,
    // Обе цифры считаются из факта, а не из режима — поэтому всегда согласованы
    marginOfPricePct: price > 0 ? round2((margin / price) * 100) : 0,
    markupPct: totalCost > 0 ? round2((margin / totalCost) * 100) : 0,
  };
}

/** Процент выводится из факта, если ставки не переданы — цифра в подписи всегда честная */
function pctFormula(value: number, base: number, pct?: number): string {
  const shown = pct != null ? pct * 100 : base > 0 ? (value / base) * 100 : 0;
  return `материалы × ${round2(shown)} %`;
}

function logisticsFormula(result: CostingResult, rates?: CostingRates): string {
  switch (rates?.logisticsMode ?? 'PERCENT_OF_MATERIAL') {
    case 'FIXED_AMOUNT':
      return 'фиксированная сумма на заказ';
    case 'PER_KG':
      return `${round2(rates?.logisticsPerKg ?? 0)} ₸/кг × вес изделия`;
    default:
      return pctFormula(result.logisticsCost, result.materialCost, rates?.logisticsPct);
  }
}

function marginFormula(result: CostingResult): string {
  const pct = round2(result.marginPct * 100);
  return result.marginMode === 'MARGIN'
    ? `себестоимость / (1 − ${pct} %) − себестоимость`
    : `себестоимость × ${pct} %`;
}

/**
 * «Разбор формулы» для UI (§2.3 ③): человекочитаемые строки расчёта
 * со ссылками на источники — вместо =IF(IFERROR(VLOOKUP(...))).
 */
export function explainCosting(
  result: CostingResult,
  approvedPrice?: number | null,
  rates?: CostingRates,
) {
  const STAGE_LABELS: Record<StageNorm['stage'], string> = {
    CUTTING: 'Резка',
    ASSEMBLY: 'Сборка / сварка / обшивка',
    PAINTING: 'Зачистка / покраска',
  };

  const lines: Array<{ label: string; value: number; unit: string; source?: string; formula?: string }> = [
    { label: 'Материалы', value: result.materialCost, unit: '₸', source: 'bom' },
    ...result.stages.map((s) => ({
      label: STAGE_LABELS[s.stage],
      value: s.stageCost,
      unit: '₸',
      source: 'routing',
      formula: `${s.workers} чел × ${s.hoursPerUnit} ч × ${s.hourlyRate} ₸/час`,
    })),
    { label: 'Логистика', value: result.logisticsCost, unit: '₸', source: 'costingConfig', formula: logisticsFormula(result, rates) },
    { label: 'Вода / газ / электричество', value: result.utilitiesCost, unit: '₸', source: 'costingConfig', formula: pctFormula(result.utilitiesCost, result.materialCost, rates?.utilitiesPct) },
    { label: 'Себестоимость', value: result.totalCost, unit: '₸' },
    { label: 'Маржа', value: result.margin, unit: '₸', formula: marginFormula(result) },
    { label: 'Расчётная цена', value: result.price, unit: '₸' },
  ];

  const priceCheck =
    approvedPrice != null && approvedPrice > 0
      ? {
          approvedPrice,
          deviationPct: round2(((approvedPrice - result.price) / result.price) * 100),
          belowCost: approvedPrice < result.totalCost,
        }
      : null;

  // Обе трактовки процента рядом — иначе «35 %» читается как угодно (09 §3.2)
  const marginSummary = {
    mode: result.marginMode,
    pct: round2(result.marginPct * 100),
    marginOfPricePct: result.marginOfPricePct,
    markupPct: result.markupPct,
    label:
      result.marginMode === 'MARGIN'
        ? `маржа ${result.marginOfPricePct} % от цены = наценка ${result.markupPct} %`
        : `наценка ${result.markupPct} % = маржа ${result.marginOfPricePct} % от цены`,
  };

  return { lines, totalManHours: result.totalManHours, priceCheck, marginSummary };
}

export interface CostingImpactLine {
  label: string;
  before: number;
  after: number;
  delta: number;
  deltaPct: number | null;
  unit: '₸' | 'чел/час';
}

/**
 * Сравнение «до / после» для предпросмотра влияния (§2.3 ④):
 * что именно пересчитается при правке нормы — до сохранения.
 */
export function costingImpact(current: CostingResult, proposed: CostingResult): CostingImpactLine[] {
  const line = (
    label: string,
    before: number,
    after: number,
    unit: CostingImpactLine['unit'] = '₸',
  ): CostingImpactLine => ({
    label,
    before,
    after,
    delta: round2(after - before),
    deltaPct: before !== 0 ? round2(((after - before) / before) * 100) : null,
    unit,
  });

  return [
    line('Трудоёмкость', current.totalManHours, proposed.totalManHours, 'чел/час'),
    line('Себестоимость труда', current.laborCost, proposed.laborCost),
    line('Себестоимость', current.totalCost, proposed.totalCost),
    line('Расчётная цена', current.price, proposed.price),
  ];
}

/** Отклонение факта от нормы в процентах; null — факта нет */
export function actualDeviationPct(
  normManHours: number,
  actualWorkers?: number | null,
  actualHours?: number | null,
): number | null {
  if (actualWorkers == null || actualHours == null || normManHours <= 0) return null;
  const actualManHours = actualWorkers * actualHours;
  return round2(((actualManHours - normManHours) / normManHours) * 100);
}
