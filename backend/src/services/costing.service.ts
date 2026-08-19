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

export interface CostingRates {
  hourlyRate: number;     // 2040 в исходнике
  logisticsPct: number;   // 0.03
  utilitiesPct: number;   // 0.01
  marginPct: number;      // 0.10
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
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Полный расчёт себестоимости изделия по нормам переделов и цене материалов */
export function calculateArticleCosting(
  materialCost: number,
  norms: StageNorm[],
  rates: CostingRates,
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
  const logisticsCost = round2(materialCost * rates.logisticsPct);
  const utilitiesCost = round2(materialCost * rates.utilitiesPct);
  const totalCost = round2(materialCost + laborCost + logisticsCost + utilitiesCost);
  const margin = round2(totalCost * rates.marginPct);
  const price = round2(totalCost + margin);

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
  };
}

/**
 * «Разбор формулы» для UI (§2.3 ③): человекочитаемые строки расчёта
 * со ссылками на источники — вместо =IF(IFERROR(VLOOKUP(...))).
 */
export function explainCosting(result: CostingResult, approvedPrice?: number | null) {
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
    { label: 'Логистика', value: result.logisticsCost, unit: '₸', source: 'costingConfig', formula: 'материалы × 3 %' },
    { label: 'Вода / газ / электричество', value: result.utilitiesCost, unit: '₸', source: 'costingConfig', formula: 'материалы × 1 %' },
    { label: 'Себестоимость', value: result.totalCost, unit: '₸' },
    { label: 'Маржа', value: result.margin, unit: '₸', formula: 'себестоимость × 10 %' },
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

  return { lines, totalManHours: result.totalManHours, priceCheck };
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
