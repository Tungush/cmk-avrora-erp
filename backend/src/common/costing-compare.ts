/**
 * Сравнение версий калькуляции (09_COSTING_AND_STAGES.md §6).
 *
 * Отвечает не «стало дороже», а «вот из-за чего»: сколько дал рост цен,
 * сколько — изменение состава, сколько — ставка, норма или смена исполнителя.
 *
 * Разложение дельты по материалу — стандартное:
 *   q₂p₂ − q₁p₁ = q₁(p₂−p₁) + p₂(q₂−q₁)
 *                 эффект цены  эффект объёма
 * Позиции, появившиеся или исчезнувшие, целиком относятся на изменение состава:
 * разделять цену и объём там не на чем.
 */

export interface SnapshotMaterial {
  materialId: string | null;
  name: string;
  qtyTotal: number;
  unitPrice: number;
  lineCost: number;
  batchId?: string | null;
  priceDate?: Date | string | null;
}

export interface SnapshotLabor {
  stage: string;
  laborKind: string;
  rateType: string;
  rate: number;
  manHours: number;
  lineCost: number;
  contractorId?: string | null;
}

export interface CostingSnapshot {
  version: number;
  calculatedAt: Date | string;
  qty: number;
  materialCost: number;
  laborCost: number;
  logisticsCost: number;
  utilitiesCost: number;
  totalCost: number;
  margin: number;
  price: number;
  logisticsPct: number;
  logisticsMode: string;
  utilitiesPct: number;
  marginPct: number;
  marginMode: string;
  materials: SnapshotMaterial[];
  labor: SnapshotLabor[];
}

export interface FactorDetail {
  key: string;
  label: string;
  delta: number;
  note?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (from: number, to: number) => (from !== 0 ? round2(((to - from) / Math.abs(from)) * 100) : null);
const fmt = (n: number) => n.toLocaleString('ru-RU');

/** Ключ материала: id, а если его нет (ручная строка) — нормализованное имя */
const materialKey = (m: SnapshotMaterial) => m.materialId ?? `name:${m.name.trim().toLowerCase()}`;

export function compareMaterials(base: SnapshotMaterial[], target: SnapshotMaterial[]) {
  const baseMap = new Map(base.map((m) => [materialKey(m), m]));
  const targetMap = new Map(target.map((m) => [materialKey(m), m]));

  let priceEffect = 0;
  let qtyEffect = 0;
  let mixEffect = 0;
  const details: FactorDetail[] = [];

  for (const [key, t] of targetMap) {
    const b = baseMap.get(key);
    if (!b) {
      mixEffect += t.lineCost;
      details.push({
        key, label: t.name, delta: round2(t.lineCost), note: 'добавлено в состав',
      });
      continue;
    }
    const price = b.qtyTotal * (t.unitPrice - b.unitPrice);
    const qty = t.unitPrice * (t.qtyTotal - b.qtyTotal);
    priceEffect += price;
    qtyEffect += qty;
    if (round2(price) !== 0 || round2(qty) !== 0) {
      const parts: string[] = [];
      if (round2(price) !== 0) {
        parts.push(`цена ${fmt(b.unitPrice)} → ${fmt(t.unitPrice)} ₸ (${pct(b.unitPrice, t.unitPrice)} %)`);
      }
      if (round2(qty) !== 0) parts.push(`расход ${b.qtyTotal} → ${t.qtyTotal}`);
      if (b.batchId && t.batchId && b.batchId !== t.batchId) parts.push('другая партия');
      details.push({ key, label: t.name, delta: round2(price + qty), note: parts.join('; ') });
    }
  }

  for (const [key, b] of baseMap) {
    if (targetMap.has(key)) continue;
    mixEffect -= b.lineCost;
    details.push({ key, label: b.name, delta: round2(-b.lineCost), note: 'убрано из состава' });
  }

  return {
    delta: round2(priceEffect + qtyEffect + mixEffect),
    priceEffect: round2(priceEffect),
    qtyEffect: round2(qtyEffect),
    mixEffect: round2(mixEffect),
    details: details.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
  };
}

const laborKey = (l: SnapshotLabor) => `${l.stage}`;

export function compareLabor(base: SnapshotLabor[], target: SnapshotLabor[]) {
  const baseMap = new Map(base.map((l) => [laborKey(l), l]));
  const targetMap = new Map(target.map((l) => [laborKey(l), l]));

  let rateEffect = 0;
  let normEffect = 0;
  let executorEffect = 0;
  let mixEffect = 0;
  const details: FactorDetail[] = [];

  for (const [key, t] of targetMap) {
    const b = baseMap.get(key);
    if (!b) {
      mixEffect += t.lineCost;
      details.push({ key, label: t.stage, delta: round2(t.lineCost), note: 'передел добавлен' });
      continue;
    }
    const delta = t.lineCost - b.lineCost;
    if (round2(delta) === 0) continue;

    // Смена штата на подряд (или типа ставки) — отдельная причина: раскладывать
    // её на «ставку» и «норму» бессмысленно, это разные способы счёта
    if (b.laborKind !== t.laborKind || b.rateType !== t.rateType) {
      executorEffect += delta;
      details.push({
        key, label: t.stage, delta: round2(delta),
        note: `исполнение ${b.laborKind} → ${t.laborKind}, ставка ${b.rateType} → ${t.rateType}`,
      });
      continue;
    }
    if (b.manHours > 0 || t.manHours > 0) {
      const rate = b.manHours * (t.rate - b.rate);
      const norm = t.rate * (t.manHours - b.manHours);
      rateEffect += rate;
      normEffect += norm;
      const parts: string[] = [];
      if (round2(rate) !== 0) parts.push(`ставка ${fmt(b.rate)} → ${fmt(t.rate)} ₸`);
      if (round2(norm) !== 0) parts.push(`часы ${b.manHours} → ${t.manHours}`);
      details.push({ key, label: t.stage, delta: round2(rate + norm), note: parts.join('; ') });
    } else {
      // Сдельная ставка без часов: вся разница — это ставка
      rateEffect += delta;
      details.push({ key, label: t.stage, delta: round2(delta), note: `ставка ${fmt(b.rate)} → ${fmt(t.rate)} ₸` });
    }
  }

  for (const [key, b] of baseMap) {
    if (targetMap.has(key)) continue;
    mixEffect -= b.lineCost;
    details.push({ key, label: b.stage, delta: round2(-b.lineCost), note: 'передел убран' });
  }

  return {
    delta: round2(rateEffect + normEffect + executorEffect + mixEffect),
    rateEffect: round2(rateEffect),
    normEffect: round2(normEffect),
    executorEffect: round2(executorEffect),
    mixEffect: round2(mixEffect),
    details: details.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
  };
}

export function compareCostings(base: CostingSnapshot, target: CostingSnapshot) {
  const materials = compareMaterials(base.materials, target.materials);
  const labor = compareLabor(base.labor, target.labor);

  const logisticsNote = base.logisticsMode !== target.logisticsMode
    ? `режим ${base.logisticsMode} → ${target.logisticsMode}`
    : base.logisticsPct !== target.logisticsPct
      ? `${round2(base.logisticsPct * 100)} % → ${round2(target.logisticsPct * 100)} %`
      : 'процент не менялся, эффект базы';

  const marginNote = base.marginMode !== target.marginMode
    ? `режим ${base.marginMode} → ${target.marginMode}`
    : base.marginPct !== target.marginPct
      ? `${round2(base.marginPct * 100)} % → ${round2(target.marginPct * 100)} %`
      : 'процент не менялся, эффект базы';

  return {
    base: { version: base.version, calculatedAt: base.calculatedAt, price: base.price },
    target: { version: target.version, calculatedAt: target.calculatedAt, price: target.price },
    price: {
      before: base.price,
      after: target.price,
      delta: round2(target.price - base.price),
      deltaPct: pct(base.price, target.price),
    },
    totalCost: {
      before: base.totalCost,
      after: target.totalCost,
      delta: round2(target.totalCost - base.totalCost),
    },
    factors: {
      materials,
      labor,
      logistics: { delta: round2(target.logisticsCost - base.logisticsCost), note: logisticsNote },
      utilities: { delta: round2(target.utilitiesCost - base.utilitiesCost) },
      margin: { delta: round2(target.margin - base.margin), note: marginNote },
    },
  };
}

/**
 * Проверка сходимости: сумма факторов обязана давать разницу цены до копейки.
 * Если не сходится — разбор врёт, и лучше это увидеть в тесте, чем в переговорах
 * с заказчиком.
 */
export function reconcile(cmp: ReturnType<typeof compareCostings>): number {
  const f = cmp.factors;
  const sum = f.materials.delta + f.labor.delta + f.logistics.delta + f.utilities.delta + f.margin.delta;
  return round2(cmp.price.delta - sum);
}
