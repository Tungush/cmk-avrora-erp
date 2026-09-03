import type { FixtureRoute } from './types';

/**
 * Фикстуры модуля «Закупки» для режима дизайна (03.09.2026).
 *
 * Форма ответов повторяет Go-обработчики байт-в-байт:
 *   backend-go/internal/modules/finance/purchases.go            — дашборд закупок и реестр ДО
 *   backend-go/internal/modules/warehouse/purchase_requests.go  — очередь на закуп (заявки)
 *
 * Правила сериализации Go, воспроизведённые здесь:
 *   • раздел «Закупки» (payment_documents) отдаёт суммы float64 → числа;
 *   • заявки на закуп: decimal.Decimal → строка без хвостовых нулей ("12.5");
 *   • common.PDate → "2026-08-25T00:00:00.000Z" или null;
 *   • статус ДО переводится из русской метки 1С в код API
 *     (Не оплачен → UNPAID, Частично оплачен → PARTIALLY_PAID, Оплачено → PAID, Исполнен → EXECUTED).
 *
 * Данные — поставщики и материалы из реальной базы ЦМК Аврора (те же имена,
 * что в warehouse.ts), размноженные детерминированным генератором:
 * 306 документов оплаты за 13 месяцев, ~212 из них с долгом, 51 заявка
 * на закуп по 10 группам (заказ-источник или пометка). Без Math.random
 * и Date.now — всё считается от 2026-09-03.
 *
 * Номера ДО — в стиле 1С «Т7АА-001866»: настоящий формат do_number в базе
 * не сверялся (БД в момент написания недоступна).
 */

// ───────────────────────────── время и генератор ─────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
/** «Сегодня» режима дизайна — 2026-09-03 00:00 UTC */
const TODAY = Date.UTC(2026, 8, 3);
/** «Сейчас» — 10:17 по UTC того же дня (time.Now() у Go-обработчика) */
const NOW_MS = TODAY + 10 * 3600_000 + 17 * 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();
const dayMs = (offsetDays: number): number => TODAY + Math.round(offsetDays) * DAY;
/** Полночь UTC через offset дней от «сегодня» — как date-колонки 1С */
const dayISO = (offsetDays: number): string => iso(dayMs(offsetDays));

/** mulberry32 — маленький детерминированный генератор */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20260903 ^ 0x9a7c);
const int = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
const chance = (p: number): boolean => rnd() < p;
function weighted<T extends { w: number }>(arr: readonly T[]): T {
  const total = arr.reduce((s, x) => s + x.w, 0);
  let r = rnd() * total;
  for (const x of arr) {
    r -= x.w;
    if (r <= 0) return x;
  }
  return arr[arr.length - 1];
}

/** Стабильный uuid из пространства имён и ключа — тот же алгоритм, что в warehouse.ts,
 *  поэтому uid('material', 'С0604') совпадает с id материала в складском модуле */
function uid(ns: string, i: number | string): string {
  const s = `${ns}:${i}`;
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const r = mulberry32(h);
  const hex = (n: number) => {
    let out = '';
    for (let k = 0; k < n; k++) out += Math.floor(r() * 16).toString(16);
    return out;
  };
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(r() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

/** decimal.Decimal в JSON — строка без хвостовых нулей: "4322.5", "3600" */
const dec = (n: number, places = 3): string => String(Number(n.toFixed(places)));
const round2 = (n: number): number => Math.round(n * 100) / 100;
/** common.JsRound — Math.floor(x + 0.5) */
const jsRound = (n: number): number => Math.floor(n + 0.5);
/** strconv.Atoi — только целое; мусор, дробь или пусто → 0 (и дальше срабатывает значение по умолчанию, как в Go) */
const atoi = (v: string | null): number => (v != null && /^[+-]?\d+$/.test(v) ? parseInt(v, 10) : 0);

const DESIGN_USER = '00000000-0000-4000-8000-000000000001';

// ───────────────────────────── поставщики и измерения ─────────────────────────────

type Cat =
  | 'metal' | 'hardware' | 'paint' | 'welding' | 'tools' | 'components'
  | 'galvanizing' | 'transport' | 'household' | 'services';

interface SupplierSeed { name: string; cat: Cat; w: number; currency?: string }

/** Реальные поставщики из базы (см. warehouse.ts) + несколько разовых; w — доля в потоке ДО */
const SUPPLIERS: readonly SupplierSeed[] = [
  { name: 'Модуль сталь, ТОО', cat: 'metal', w: 22 },
  { name: 'Торговый дом "Алаш", ТОО', cat: 'metal', w: 18 },
  { name: 'Металлобаза Астана, ТОО', cat: 'metal', w: 16 },
  { name: 'Фирма "А -Профиль" ТОО', cat: 'metal', w: 12 },
  { name: 'IRON TRADE COMPANY, ТОО', cat: 'metal', w: 9 },
  { name: 'Avrora Global trade, ТОО', cat: 'metal', w: 8 },
  { name: 'ЕвразМеталл Казахстан, ТОО', cat: 'metal', w: 5 },
  { name: 'HEFA STEEL GROUP Co.,LTD', cat: 'metal', w: 3, currency: 'CNY' },
  { name: 'Магнитогорский металл, ООО', cat: 'metal', w: 2, currency: 'RUB' },
  { name: 'Bugel Алматы, ТОО', cat: 'hardware', w: 14 },
  { name: 'ТОО "КРЕПЁЖНАЯ ЗАСТАВА"', cat: 'hardware', w: 9 },
  { name: 'Тукор ТОО', cat: 'hardware', w: 6 },
  { name: 'Алмаросметиз ИП Парыгин Сергей Петрович', cat: 'hardware', w: 3, currency: 'RUB' },
  { name: 'МАЙ ТОО', cat: 'paint', w: 8 },
  { name: 'ТОО "ASIAN PAINTS"', cat: 'paint', w: 5 },
  { name: 'ТОО "NATIONAL COATING"', cat: 'paint', w: 4 },
  { name: 'Welding Company TOO', cat: 'welding', w: 9 },
  { name: 'PromGazProduct, ТОО', cat: 'welding', w: 6 },
  { name: 'ЛАМЭД ТОО', cat: 'welding', w: 5 },
  { name: 'G-GAS-PRO,ТОО', cat: 'welding', w: 3 },
  { name: 'КАЛИБР KZ, ТОО', cat: 'tools', w: 5 },
  { name: '220 VOLT, ТОО', cat: 'tools', w: 4 },
  { name: 'ТОО "PROEXPERT.KZ"', cat: 'tools', w: 3 },
  { name: 'Toolsmart, ТОО', cat: 'tools', w: 2 },
  { name: 'AKS KAZAKHSTAN (АКС Казахстан) ТОО', cat: 'components', w: 7 },
  { name: 'ТОО "ТЕХНОСИСТЕМА МР"', cat: 'components', w: 5 },
  { name: 'ВИП СИСТЕМЫ, ТОО', cat: 'components', w: 4 },
  { name: 'ТОО "KAZ PROVIDER"', cat: 'components', w: 3 },
  { name: 'Kazgid IT Technology, ТОО', cat: 'components', w: 2 },
  { name: 'E-STOCK, ТОО', cat: 'components', w: 2 },
  { name: 'Steel Trade Overseas FZE', cat: 'components', w: 1, currency: 'USD' },
  { name: 'Горячее цинкование KZ, ТОО', cat: 'galvanizing', w: 9 },
  { name: 'Focus Logistics', cat: 'transport', w: 5 },
  { name: 'Sinooil, Алматинский филиал ТОО', cat: 'transport', w: 4 },
  { name: 'JAMBYL TAZALYK, ИП', cat: 'transport', w: 1 },
  { name: 'Optomir, ИП', cat: 'household', w: 2 },
  { name: 'STROYKA, ИП', cat: 'household', w: 2 },
  { name: 'CleanHouse, ТОО', cat: 'household', w: 2 },
  { name: 'Anirise, ТОО', cat: 'household', w: 1 },
  { name: 'Safety construction, ТОО', cat: 'services', w: 2 },
  { name: 'Long Partners, ТОО', cat: 'services', w: 1 },
  { name: 'SAFA Trade, ТОО', cat: 'services', w: 1 },
  { name: 'RESMA.KZ, ТОО', cat: 'services', w: 1 },
  { name: 'АФД-Снаб,ТОО', cat: 'services', w: 1 },
  { name: 'Zenith invest, ТОО', cat: 'services', w: 1 },
  { name: 'TECHNO POWER, ТОО', cat: 'services', w: 1 },
  { name: 'SENSATA INVEST GROUP, ТОО', cat: 'services', w: 1 },
  { name: 'Алматерм, ИП', cat: 'services', w: 1 },
  { name: 'АМАНАТ К, ТОО', cat: 'services', w: 1 },
  { name: 'INTERCOM ENGINEERING, ТОО', cat: 'services', w: 1 },
  { name: 'BMK Integration Service ТОО', cat: 'services', w: 1 },
  { name: 'ANTARES ENGINEERING, ТОО', cat: 'services', w: 1 },
  { name: 'ТОО "Densaulyq Life"', cat: 'services', w: 1 },
];

const COST_CATEGORY: Record<Cat, string> = {
  metal: 'Металлопрокат', hardware: 'Метизы', paint: 'ЛКМ', welding: 'Сварочные материалы и газы',
  tools: 'Инструмент и оснастка', components: 'Комплектующие', galvanizing: 'Оцинкование (услуги)',
  transport: 'Транспортные услуги', household: 'Хозтовары', services: 'Услуги сторонних организаций',
};

const WAREHOUSE: Record<Cat, string | null> = {
  metal: 'Склад сырья', hardware: 'Склад метизов', paint: 'Склад расходных материалов',
  welding: 'Склад расходных материалов', tools: 'Инструментальная', components: 'Склад комплектующих',
  galvanizing: null, transport: null, household: 'Склад АХО', services: null,
};

const SERVICE_CATS: ReadonlySet<Cat> = new Set<Cat>(['galvanizing', 'transport', 'services']);

interface Opt { v: string | null; w: number }
const DIRECTIONS: readonly Opt[] = [
  { v: 'ЦМК Телекоммуникации', w: 65 }, { v: 'ЦМК Металлоконструкции', w: 25 }, { v: null, w: 10 },
];
const PROJECTS: readonly Opt[] = [
  { v: 'Казахтелеком — мачты М25 (2026)', w: 60 }, { v: 'KTC — площадки БС', w: 30 },
  { v: 'Beeline — ограждения', w: 20 }, { v: 'Шелторы для Tele2', w: 15 },
  { v: 'Общезаводские нужды', w: 40 }, { v: 'LVE Group — металлоконструкции', w: 12 }, { v: null, w: 40 },
];
const DIVISIONS: readonly Opt[] = [
  { v: 'Снабжение', w: 50 }, { v: 'Производство', w: 25 }, { v: 'Телеком проекты', w: 15 },
  { v: 'АХО', w: 10 }, { v: null, w: 10 },
];
const AUTHORS: readonly Opt[] = [
  { v: 'Досжанов Ерлан Бауыржанович', w: 55 }, { v: 'Сұлтанмұратқызы Гүлнұр', w: 20 },
  { v: 'Султангалиева Айнура Жаксыгалеевна', w: 10 }, { v: 'Бисен Азамат Мырзақанұлы', w: 8 },
  { v: 'Администратор 1С', w: 7 },
];
const MANAGERS: readonly Opt[] = [
  { v: 'Досжанов Е.Б.', w: 60 }, { v: 'Ахметов А.А.', w: 15 }, { v: 'Ким В.С.', w: 10 }, { v: null, w: 15 },
];
const APPROVERS: readonly Opt[] = [
  { v: 'Абдрахманов Д.С. (директор)', w: 70 }, { v: 'Султангалиева А.Ж.', w: 15 }, { v: null, w: 15 },
];

/** Сумма ДО по категории затрат и валюте — «как в жизни»: металл миллионы, хозтовары десятки тысяч */
function amountFor(cat: Cat, currency: string): number {
  if (currency === 'RUB') return int(300, 2500) * 1000 + int(0, 999);
  if (currency === 'CNY') return int(40, 400) * 1000 + int(0, 999);
  if (currency === 'USD') return int(5, 60) * 1000 + int(0, 999);
  const range: Record<Cat, [number, number]> = {
    metal: [1200, 9500], hardware: [120, 1400], paint: [180, 950], welding: [90, 650], tools: [45, 480],
    components: [250, 2800], galvanizing: [900, 6500], transport: [120, 520], household: [25, 190], services: [150, 1900],
  };
  const [a, b] = range[cat];
  const base = int(a, b) * 1000 + int(0, 999);
  return chance(0.4) ? base + int(1, 99) / 100 : base;
}

// ───────────────────────────── документы оплаты (ДО) ─────────────────────────────

interface Doc {
  id: string;
  doNumber: string;
  supplierDocNumber: string;
  contractorId: string;
  contractorName: string;
  currency: string;
  /** код API: UNPAID / PARTIALLY_PAID / PAID / EXECUTED */
  status: string;
  /** мс полуночи UTC */
  doDate: number;
  approvedAt: number | null;
  supplierDocDate: number | null;
  total: number;
  paid: number;
  unpaid: number;
  businessDirection: string | null;
  projectName: string | null;
  costCategory: string | null;
  author: string | null;
  managerName: string | null;
  warehouseName: string | null;
  division: string | null;
  approver: string | null;
  batches: number;
  lines: number;
}

function buildDocs(): Doc[] {
  const out: Doc[] = [];
  for (let i = 0; i < 306; i++) {
    const s = weighted(SUPPLIERS);
    // Возраст скошен к недавнему: снабжение живёт последними месяцами
    const age = Math.floor(400 * Math.pow(rnd(), 1.6));
    const doDate = dayMs(-age);
    const currency = s.currency ?? 'KZT';
    const total = amountFor(s.cat, currency);
    // Чем свежее документ, тем вероятнее, что он ещё не оплачен
    const pUnpaid = age < 45 ? 0.92 : age < 120 ? 0.8 : age < 240 ? 0.65 : 0.5;
    let paid: number;
    if (chance(pUnpaid)) paid = chance(0.3) ? round2(total * (0.2 + rnd() * 0.6)) : 0;
    else paid = chance(0.03) ? round2(total * 1.02) : total;
    const unpaid = round2(Math.max(0, total - paid));
    const isService = SERVICE_CATS.has(s.cat);
    const lines = isService ? int(1, 3) : int(1, 12);
    const batches = isService || age < 7 ? 0 : chance(0.78) ? int(1, lines) : 0;
    const status = unpaid <= 0
      ? (batches > 0 && age > 45 && chance(0.7) ? 'EXECUTED' : 'PAID')
      : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
    const approvedAt = chance(0.08) ? null : doDate + (chance(0.06) ? int(31, 70) : int(0, 12)) * DAY;
    const supplierDocDate = chance(0.1) ? null : doDate + (chance(0.05) ? -int(1, 15) : int(0, 20)) * DAY;
    const noWarehouse = chance(0.09);
    out.push({
      id: uid('payment-doc', i),
      doNumber: '',
      supplierDocNumber: chance(0.3) ? `СЧ-${String(int(12, 4870)).padStart(6, '0')}` : String(int(12, 4870)),
      contractorId: uid('supplier', s.name),
      contractorName: s.name,
      currency,
      status,
      doDate,
      approvedAt,
      supplierDocDate,
      total,
      paid,
      unpaid,
      businessDirection: weighted(DIRECTIONS).v,
      projectName: isService && chance(0.5) ? 'Общезаводские нужды' : weighted(PROJECTS).v,
      costCategory: chance(0.06) ? null : COST_CATEGORY[s.cat],
      author: weighted(AUTHORS).v,
      managerName: weighted(MANAGERS).v,
      warehouseName: noWarehouse ? null : WAREHOUSE[s.cat],
      division: weighted(DIVISIONS).v,
      approver: weighted(APPROVERS).v,
      batches,
      lines,
    });
  }
  // ORDER BY do_date DESC; номера 1С убывают вместе с датой
  out.sort((a, b) => b.doDate - a.doDate || (a.id < b.id ? -1 : 1));
  out.forEach((d, i) => { d.doNumber = `Т7АА-${String(1866 - i).padStart(6, '0')}`; });
  return out;
}

const DOCS: Doc[] = buildDocs();

const pdate = (ms: number | null): string | null => (ms == null ? null : iso(ms));
const ageOf = (d: Doc): number => Math.floor((NOW_MS - d.doDate) / DAY);
const sum = (list: Doc[], f: (d: Doc) => number): number => list.reduce((s, d) => s + f(d), 0);

/** GET /purchases/dashboard — порт PurchasesHandler.Dashboard */
function dashboard() {
  const docs = DOCS;
  const kzt = docs.filter((d) => d.currency === 'KZT');
  const other = docs.filter((d) => d.currency !== 'KZT');
  const unpaid = kzt.filter((d) => d.unpaid > 0);
  const overdue30 = unpaid.filter((d) => ageOf(d) > 30);
  const bucket = (from: number, to: number) => unpaid.filter((d) => { const a = ageOf(d); return a > from && a <= to; });
  const monthAgo = NOW_MS - 30 * DAY;
  const prevMonth = NOW_MS - 60 * DAY;
  const spendMonth = kzt.filter((d) => d.doDate > monthAgo && d.doDate <= NOW_MS);
  const spendPrev = kzt.filter((d) => d.doDate > prevMonth && d.doDate <= monthAgo);
  const noReceipt = docs.filter((d) => d.batches === 0);

  const cut = (key: (d: Doc) => string | null) => {
    const m = new Map<string, { docs: number; total: number; telecom: number; other: number }>();
    for (const d of kzt) {
      const k = key(d) ?? '__none__';
      let a = m.get(k);
      if (!a) { a = { docs: 0, total: 0, telecom: 0, other: 0 }; m.set(k, a); }
      a.docs++;
      a.total += d.total;
      if (d.businessDirection === 'ЦМК Телекоммуникации') a.telecom += d.total; else a.other += d.total;
    }
    return [...m.entries()]
      .sort((x, y) => y[1].total - x[1].total)
      .map(([k, a]) => ({ key: k === '__none__' ? null : k, docs: a.docs, total: a.total, telecom: a.telecom, other: a.other }));
  };

  interface Sup { id: string; name: string; docs: number; noReceipt: number; total: number; paid: number; unpaid: number; lastDate: number | null }
  const bySup = new Map<string, Sup>();
  for (const d of docs) {
    let s = bySup.get(d.contractorId);
    if (!s) { s = { id: d.contractorId, name: d.contractorName, docs: 0, noReceipt: 0, total: 0, paid: 0, unpaid: 0, lastDate: null }; bySup.set(d.contractorId, s); }
    s.docs++;
    if (d.currency === 'KZT') { s.total += d.total; s.paid += d.paid; s.unpaid += d.unpaid; }
    if (d.batches === 0) s.noReceipt++;
    if (s.lastDate == null || d.doDate > s.lastDate) s.lastDate = d.doDate;
  }
  const suppliers = [...bySup.values()].sort((a, b) => b.total - a.total);
  const totalKzt = sum(kzt, (d) => d.total);

  const noApprover = docs.filter((d) => !d.approver);
  const slowApproval = docs.filter((d) => d.approvedAt != null && (d.approvedAt - d.doDate) / DAY > 30);
  const backdated = docs.filter((d) => d.supplierDocDate != null && d.supplierDocDate < d.doDate);
  const noWarehouse = docs.filter((d) => !d.warehouseName);
  const overpaid = docs.filter((d) => d.paid > d.total);

  const otherCur = new Map<string, number>();
  for (const d of other) otherCur.set(d.currency, (otherCur.get(d.currency) ?? 0) + d.unpaid);
  const otherCurrencies = [...otherCur.entries()].filter(([, a]) => a > 0).map(([currency, amount]) => ({ currency, amount }));

  const bucketH = (label: string, list: Doc[]) => ({ label, docs: list.length, amount: sum(list, (d) => d.unpaid) });
  const unpaidSorted = [...unpaid].sort((a, b) => ageOf(b) - ageOf(a));
  const topN = (n: number) => suppliers.slice(0, n).map((s) => ({
    id: s.id, name: s.name, docs: s.docs, total: s.total, paid: s.paid, unpaid: s.unpaid, noReceipt: s.noReceipt, lastDate: pdate(s.lastDate),
  }));
  const share = (n: number) => (totalKzt === 0 ? 0 : suppliers.slice(0, n).reduce((s, x) => s + x.total, 0) / totalKzt);
  const ctl = (code: string, label: string, list: Doc[], f: (d: Doc) => number) => ({ code, label, docs: list.length, amount: sum(list, f) });
  const over90 = bucket(90, 1e9);
  const paidNoReceipt = noReceipt.filter((d) => d.paid > 0);

  return {
    kpi: {
      owed: { amount: sum(unpaid, (d) => d.unpaid), docs: unpaid.length, totalDocs: docs.length, otherCurrencies },
      overdue30: { amount: sum(overdue30, (d) => d.unpaid), docs: overdue30.length, over90: over90.length, over90Amount: sum(over90, (d) => d.unpaid) },
      spendMonth: { amount: sum(spendMonth, (d) => d.total), docs: spendMonth.length, prevAmount: sum(spendPrev, (d) => d.total) },
      noReceipt: { docs: noReceipt.length, totalDocs: docs.length, paidDocs: paidNoReceipt.length, paidAmount: sum(paidNoReceipt, (d) => d.paid) },
    },
    totalKzt,
    dimensions: {
      project: cut((d) => d.projectName), costCategory: cut((d) => d.costCategory),
      author: cut((d) => d.author), manager: cut((d) => d.managerName),
      warehouse: cut((d) => d.warehouseName), division: cut((d) => d.division),
    },
    buckets: [bucketH('90+ дней', over90), bucketH('61–90 дней', bucket(60, 90)), bucketH('31–60 дней', bucket(30, 60)), bucketH('до 30 дней', bucket(-1, 30))],
    unpaidDocs: unpaidSorted.map((d) => ({
      id: d.id, doNumber: d.doNumber, doDate: pdate(d.doDate), ageDays: ageOf(d), supplier: d.contractorName,
      supplierId: d.contractorId, currency: d.currency, totalAmount: d.total, paidAmount: d.paid, unpaidAmount: d.unpaid,
    })),
    suppliers: topN(10),
    supplierStats: { total: suppliers.length, top5Share: share(5), top10Share: share(10), oneOff: suppliers.filter((s) => s.docs === 1).length },
    control: [
      ctl('noApprover', 'без утвердителя', noApprover, (d) => d.total),
      ctl('slowApproval', 'согласование дольше 30 дней', slowApproval, (d) => d.total),
      ctl('backdated', 'документ поставщика раньше нашего заказа', backdated, (d) => d.total),
      ctl('noWarehouse', 'без склада', noWarehouse, (d) => d.total),
      ctl('overpaid', 'оплачено больше суммы документа', overpaid, (d) => d.paid - d.total),
    ],
  };
}

/** GET /purchases/documents — порт PurchasesHandler.Documents (реестр ДО с фильтрами) */
function documents(params: URLSearchParams) {
  let page = atoi(params.get('page'));
  if (page < 1) page = 1;
  let pageSize = atoi(params.get('pageSize'));
  if (pageSize < 1) pageSize = 50;
  if (pageSize > 200) pageSize = 200;
  let list = DOCS;
  const q = (params.get('search') ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter((d) => d.doNumber.toLowerCase().includes(q) || d.supplierDocNumber.toLowerCase().includes(q) || d.contractorName.toLowerCase().includes(q));
  }
  const direction = params.get('direction');
  if (direction) list = list.filter((d) => d.businessDirection === direction);
  const nullable = (get: (d: Doc) => string | null, v: string | null) => {
    if (!v) return;
    list = v === '__none__' ? list.filter((d) => get(d) == null) : list.filter((d) => get(d) === v);
  };
  nullable((d) => d.projectName, params.get('project'));
  nullable((d) => d.costCategory, params.get('costCategory'));
  nullable((d) => d.warehouseName, params.get('warehouse'));
  const supplierId = params.get('supplierId');
  if (supplierId) list = list.filter((d) => d.contractorId === supplierId);
  if (params.get('unpaidOnly') === '1') list = list.filter((d) => d.unpaid > 0);
  if (params.get('hasBatches') === '0') list = list.filter((d) => d.batches === 0);
  if (params.get('hasBatches') === '1') list = list.filter((d) => d.batches > 0);
  if (params.get('control') === 'noApprover') list = list.filter((d) => d.approver == null);
  if (params.get('control') === 'noWarehouse') list = list.filter((d) => d.warehouseName == null);
  const overdueDays = params.get('overdueDays');
  if (overdueDays) {
    // strconv.ParseFloat: мусор → 0 → cutoff = «сейчас»
    const cutoff = NOW_MS - (Number(overdueDays) || 0) * DAY;
    list = list.filter((d) => d.doDate < cutoff && d.unpaid > 0);
  }
  const total = list.length;
  const data = list.slice((page - 1) * pageSize, page * pageSize).map((d) => ({
    id: d.id, doNumber: d.doNumber, doDate: pdate(d.doDate), status: d.status, supplier: d.contractorName,
    supplierId: d.contractorId, currency: d.currency, totalAmount: d.total, paidAmount: d.paid, unpaidAmount: d.unpaid,
    businessDirection: d.businessDirection, projectName: d.projectName, costCategory: d.costCategory, warehouseName: d.warehouseName,
    linesCount: d.lines, batchesCount: d.batches,
  }));
  return { data, meta: { page, pageSize, total } };
}

// ───────────────────────────── заявки на закуп ─────────────────────────────

/** Реальные uuid ключевых материалов — те же, что в warehouse.ts, чтобы ссылки сходились */
const REAL_IDS: Record<string, string> = {
  'С0604': '22fa6aaa-4aad-4bce-b5a3-816d0b70fb2c',
  'С0605': 'c2a62075-e81a-487b-8278-00da09d622b6',
  'С0603': 'ced04fe9-d713-4b63-9e4d-9d96cd0970a5',
  'С0508': '5584fa86-bcdc-4f8f-a305-7a13da0af124',
  'С0509': '7bb1d9b4-eefa-46a3-bb7d-d78b35a20581',
  'С0507': '09e31129-acc6-40dc-ad1c-b0cca048ada3',
  'С0513': '35628187-dacf-44bc-a776-a5aa4b493c7d',
  'С0406': '3212700a-dc7c-4308-bb40-474166e70fa1',
  'С0412': '5a93d3c4-3c55-45e2-a3fc-f54ba8999c33',
  'С0103': 'babd4c07-ab52-48c1-a879-736d7573c7da',
  'С0104': '10e8201a-e922-4478-9992-89fdb26c49ac',
  'С0106': '0d5e7f0c-e562-4c72-9721-d4a6330c5dc8',
  'С0113': '6572b801-4f6d-478b-8f2e-ad9fc8f9bc3f',
  'С0308': '1d65137d-9e24-4f69-81e4-d4545cf621b2',
  'С0318': '1367b3bc-6f89-4412-b650-100523c80ff8',
  'М0104': '6ac80540-7977-4b75-a759-4c03b6c8cb25',
  'М0119': '7ebe96fe-5175-4360-8d5b-cb4199182808',
  'М0139': 'f2840f6d-6773-430c-adb8-215e86a01fd7',
  'М0201': '7bca9d1d-2189-4ac4-87b0-6911326c99da',
  'Л0003': 'd278e45d-5c20-4b2d-be3f-1ce351858334',
  'Л0006': '6dc0cad6-ada7-4e66-81c3-a993ca467175',
};

interface Mat { id: string; code: string; category: string; name: string; unit: string; price: number; weight: number }

const MAT_SEEDS: ReadonlyArray<[string, string, string, string, number, number]> = [
  // код, категория API, название, единица, учётная цена ₸, вес кг/ед
  ['С0604', 'METAL', 'Швеллер 12У', 'м', 4320, 10.2],
  ['С0603', 'METAL', 'Швеллер 12П', 'м', 4320, 10.2],
  ['С0605', 'METAL', 'Швеллер 14П', 'м', 5040, 11.9],
  ['С0614', 'METAL', 'Швеллер 20П', 'м', 7200, 17],
  ['С0509', 'METAL', 'Уголок 50х50х5 мм', 'м', 1225, 3.925],
  ['С0507', 'METAL', 'Уголок 40х40х4 мм', 'м', 784, 2.512],
  ['С0513', 'METAL', 'Уголок 63х63х5 мм', 'м', 1543.5, 4.946],
  ['С0406', 'METAL', 'Лист г/к 6 мм 1500х6000', 'т', 442000, 1000],
  ['С0412', 'METAL', 'Лист г/к 12 мм 1500х6000', 'т', 454000, 1000],
  ['С0418', 'METAL', 'Лист г/к 4 мм 1500х6000', 'т', 447000, 1000],
  ['С0103', 'METAL', 'Круг ф 10 мм', 'м', 200, 0.617],
  ['С0104', 'METAL', 'Круг ф 12 мм', 'м', 288, 0.888],
  ['С0106', 'METAL', 'Круг ф 16 мм', 'м', 512, 1.58],
  ['С0308', 'METAL', 'Труба э/с ф102х4 мм', 'м', 3672, 10.06],
  ['С0318', 'METAL', 'Труба э/с ф76х3,5 мм', 'м', 2394, 6.56],
  ['С0810', 'METAL', 'Полоса 40х4 мм', 'м', 640, 1.256],
  ['С0803', 'METAL', 'Сетка рабица 50х50х2,5 мм оц.', 'м2', 1980, 2.1],
  ['С0215', 'METAL', 'Лист оцинкованный 1250х2500х0,5', 'м2', 3200, 4],
  ['К0238', 'COMPONENTS', 'Профнастил оц. С8 0,45х1150 мм (2,63м)', 'шт', 6900, 12.5],
  ['М0104', 'HARDWARE', 'Болт М10х35 оц.', 'кг', 700, 1],
  ['М0119', 'HARDWARE', 'Болт М20х80 оц.', 'кг', 760, 1],
  ['М0139', 'HARDWARE', 'Болт М24х120 оц. 10,9', 'кг', 824, 1],
  ['М0201', 'HARDWARE', 'Гайка M20 оц.', 'кг', 860, 1],
  ['Л0003', 'PAINT', 'Грунтовка ГФ-021 красно-кор.', 'кг', 690, 1],
  ['Л0006', 'PAINT', 'Грунт-эмаль Anticor 101 RAL 5005', 'кг', 3017, 1],
  ['Л0077', 'PAINT', 'Эмаль ПФ-115 синяя', 'кг', 1000, 1],
  ['Р0010', 'CONSUMABLES', 'Электроды УОНИ-13/55 д.3 мм', 'кг', 1340, 1],
  ['Р0020', 'CONSUMABLES', 'Проволока сварочная ER70S-6 1,2 мм (кассета 15 кг)', 'кг', 1150, 1],
  ['Р0030', 'CONSUMABLES', 'Круг отрезной 125х1,2х22', 'шт', 180, 0.05],
];

const MATERIALS: Mat[] = MAT_SEEDS.map(([code, category, name, unit, price, weight]) => ({
  id: REAL_IDS[code] ?? uid('material', code), code, category, name, unit, price, weight,
}));
const MAT_BY_CODE = new Map(MATERIALS.map((m) => [m.code, m]));
const MAT_BY_ID = new Map(MATERIALS.map((m) => [m.id, m]));
const mat = (code: string): Mat => MAT_BY_CODE.get(code) as Mat;

/** Заказы-источники дефицита — те же id и номера, что в warehouse.ts / contractors.ts */
interface Ord { id: string; number: string; planned: string | null; customer: string }
const ORDERS: Ord[] = [
  { id: 'c0ca51a3-5bce-4454-a187-6b281be8811d', number: 'Т7АА-002549', planned: dayISO(-14), customer: 'Аврора Сервис, ТОО' },
  { id: '36eee01e-689f-4df7-b195-12dfcbfc2ac0', number: 'Т7АА-002542', planned: dayISO(-7), customer: 'ТОО «GravIX Urban»' },
  { id: '9b918428-55ff-454a-ace8-2edcb7d8b5cc', number: 'Т7АА-002541', planned: dayISO(-6), customer: 'Central Build, ТОО' },
  { id: '913d67ff-cf79-4e1b-a193-641ec67d0d69', number: 'Т7АА-002538', planned: dayISO(-2), customer: 'НУР АСТАНА КУРЫЛЫС ТОО' },
  { id: 'e7020ed2-9f80-4359-b402-dcaa9d873614', number: 'Т7АА-002530', planned: dayISO(0), customer: 'BI URBAN CONSTRUCTION, ТОО' },
  { id: 'cd92a829-9b7f-4fdf-9982-1b77615ac995', number: 'Т7АА-002529', planned: dayISO(1), customer: 'IDA INTERTASCO JV, ТОО' },
  { id: '074ce3b0-d942-442c-81c6-ef564641d19c', number: 'Т7АА-002523', planned: dayISO(2), customer: 'IDA INTERTASCO JV, ТОО' },
  { id: '46c8b3ff-c20b-4741-b28c-29b136ce74d2', number: 'Т7АА-002518', planned: dayISO(5), customer: 'Greystone Construction, ТОО' },
  { id: '32e5a76c-c1c4-4ea9-9e53-ef15b0c78368', number: 'Т7АА-002517', planned: dayISO(6), customer: 'Qonay Stroy, ТОО' },
  { id: 'fe559184-40df-4632-a88a-9a72e9b7dfb6', number: 'Т7АА-002558', planned: dayISO(-21), customer: 'Дельта Казстрой, ТОО' },
];
const ORD_BY_NUMBER = new Map(ORDERS.map((o) => [o.number, o]));
const ORD_BY_ID = new Map(ORDERS.map((o) => [o.id, o]));

/** Пользователи-заявители: дизайн-админ и мастер цеха (uuid стабильные) */
const FOREMAN = uid('user', 'a.bisen@avh.kz');
const STOREKEEPER = uid('user', 'warehouse_material@avh.kz');

interface PR {
  id: string;
  materialId: string;
  requestedQty: number;
  unit: string | null;
  estimatedPrice: number | null;
  orderId: string | null;
  note: string | null;
  requestedById: string | null;
  status: 'DRAFT' | 'APPROVED' | 'ORDERED' | 'REJECTED';
  bitrixDealId: string | null;
  bitrixSentAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** для заказов, которых нет в ORDERS (пришли из orders.ts через from-order) */
  orderStub?: Ord;
}

interface GroupSeed {
  order: string | null;
  note?: string;
  status: PR['status'];
  days: number;
  deal?: string;
  items: string[];
}

/** 10 групп: 6 накопленных, 2 отправленных в Б24, 1 с созданным заказом, 1 отклонённая */
const GROUPS: readonly GroupSeed[] = [
  { order: 'Т7АА-002549', status: 'DRAFT', days: 1, items: ['С0604', 'С0318', 'С0308', 'С0509', 'С0406', 'М0119', 'М0201', 'Л0006', 'Р0020', 'С0103', 'С0810'] },
  { order: 'Т7АА-002538', status: 'DRAFT', days: 2, items: ['С0603', 'С0513', 'С0412', 'С0104', 'М0139', 'Л0003', 'Р0010'] },
  { order: 'Т7АА-002542', status: 'DRAFT', days: 3, items: ['С0803', 'С0507', 'С0318', 'М0104', 'Л0077'] },
  { order: 'Т7АА-002529', status: 'DRAFT', days: 4, items: ['С0614', 'С0418', 'С0106', 'М0119'] },
  { order: null, note: 'Пополнение склада метизов (мин. остаток)', status: 'DRAFT', days: 5, items: ['М0104', 'М0119', 'М0139', 'М0201', 'Р0030'] },
  { order: 'Т7АА-002518', status: 'DRAFT', days: 6, items: ['К0238', 'С0215', 'С0810'] },
  { order: 'Т7АА-002541', status: 'REJECTED', days: 8, items: ['С0412', 'С0803'] },
  { order: 'Т7АА-002530', status: 'APPROVED', days: 9, deal: '1842', items: ['С0604', 'С0605', 'С0509', 'С0406', 'М0119', 'Л0006'] },
  { order: null, note: 'Расходники на сентябрь', status: 'APPROVED', days: 11, deal: '1839', items: ['Р0010', 'Р0020', 'Р0030', 'Л0003'] },
  { order: 'Т7АА-002523', status: 'ORDERED', days: 16, deal: '1827', items: ['С0308', 'С0318', 'С0104', 'М0201'] },
];

/** Правдоподобное количество по единице измерения: метры сотнями, тонны с десятыми, метизы килограммами */
function qtyFor(unit: string): number {
  switch (unit) {
    case 'т': return int(8, 64) / 10;
    case 'кг': return int(10, 120);
    case 'шт': return int(20, 400);
    case 'м2': return int(30, 300);
    default: return chance(0.3) ? int(24, 420) + 0.5 : int(24, 420);
  }
}

function buildRequests(): PR[] {
  const out: PR[] = [];
  let n = 0;
  for (const g of GROUPS) {
    const order = g.order ? ORD_BY_NUMBER.get(g.order) ?? null : null;
    const created = dayMs(-g.days) + int(8, 16) * 3600_000 + int(0, 59) * 60_000;
    const sentAt = g.deal ? created + int(2, 30) * 3600_000 : null;
    const updated = sentAt ?? (g.status === 'REJECTED' ? created + int(6, 40) * 3600_000 : created);
    g.items.forEach((code, k) => {
      const m = mat(code);
      out.push({
        id: uid('purchase-request', n++),
        materialId: m.id,
        requestedQty: qtyFor(m.unit),
        unit: m.unit,
        estimatedPrice: chance(0.08) ? null : m.price,
        orderId: order?.id ?? null,
        note: order ? `Дефицит по заказу ${order.number}` : g.note ?? null,
        requestedById: order ? FOREMAN : STOREKEEPER,
        status: g.status,
        bitrixDealId: g.deal ?? null,
        bitrixSentAt: sentAt,
        createdAt: created + k * 1000,
        updatedAt: updated + k * 1000,
      });
    });
  }
  return out;
}

/** Изменяемое состояние очереди: мутации режима дизайна живут до перезагрузки */
const REQUESTS: PR[] = buildRequests();

/** prJSON — базовая форма заявки (models.PurchaseRequest) */
function prJSON(r: PR) {
  return {
    id: r.id,
    materialId: r.materialId,
    requestedQty: dec(r.requestedQty),
    unit: r.unit,
    estimatedPrice: r.estimatedPrice == null ? null : dec(r.estimatedPrice),
    orderId: r.orderId,
    note: r.note,
    requestedById: r.requestedById,
    status: r.status,
    bitrixDealId: r.bitrixDealId,
    bitrixSentAt: pdate(r.bitrixSentAt),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

function orderOf(r: PR): Ord | null {
  if (!r.orderId) return null;
  return ORD_BY_ID.get(r.orderId) ?? r.orderStub ?? null;
}

/** Строка списка: заявка + material (4 поля) + order (или null) — как в FindAll */
function prRow(r: PR) {
  const m = MAT_BY_ID.get(r.materialId);
  const o = orderOf(r);
  return {
    ...prJSON(r),
    material: m
      ? { materialCode: m.code, name: m.name, unit: m.unit, purchasePrice: dec(m.price) }
      : { materialCode: '—', name: 'Материал не найден', unit: r.unit ?? 'шт', purchasePrice: '0' },
    order: o ? { id: o.id, orderNumber: o.number, plannedShipmentDate: o.planned, customer: { name: o.customer } } : null,
  };
}

/** models.Material целиком — так Create возвращает материал (catalog.ScanMaterial) */
function materialJSON(m: Mat) {
  return {
    id: m.id, materialCode: m.code, category: m.category, name: m.name, unit: m.unit,
    unitWeightKg: dec(m.weight), purchasePrice: dec(m.price), purchasePriceUpdatedAt: dayISO(-int(3, 60)),
    lastPurchasePrice: dec(m.price), lastPurchaseDate: dayISO(-int(3, 60)), priceListPrice: dec(m.price * 1.12),
    stockQty: dec(int(0, 40)),
  };
}

/** common.APIError — конверт { error: { code, message, details } }, details всегда присутствует (null) */
const notFound = (msg: string) => ({ error: { code: 'NOT_FOUND', message: msg, details: null } });
const badRequest = (code: string, msg: string) => ({ error: { code, message: msg, details: null } });

/** GET /purchase-requests?status=&page=&pageSize= — FindAll */
function findAllRequests(params: URLSearchParams) {
  let page = atoi(params.get('page'));
  if (page < 1) page = 1;
  let pageSize = atoi(params.get('pageSize'));
  if (pageSize < 1) pageSize = 100;
  const status = params.get('status');
  let list = [...REQUESTS].sort((a, b) => b.createdAt - a.createdAt);
  if (status) list = list.filter((r) => r.status === status);
  const total = list.length;
  const data = list.slice((page - 1) * pageSize, page * pageSize).map(prRow);
  return { data, meta: { page, pageSize, total } };
}

/** Каталог дефицита from-order — тот же, что в orders.ts materialAvailability, чтобы
 *  «Создать заявки» из карточки заказа создавало ровно те позиции, что показаны в дефиците */
const SHORTAGE_CATALOG = [
  { code: 'С0612', name: 'Швеллер 12У', unit: 'м', price: 14820 },
  { code: 'С0318', name: 'Труба э/с ф76х3,5 мм', unit: 'м', price: 2548 },
  { code: 'С0614', name: 'Швеллер 20П', unit: 'м', price: 11845 },
  { code: 'С0402', name: 'Уголок 50х50х5', unit: 'м', price: 1890 },
  { code: 'С0117', name: 'Лист г/к 4 мм 1500х6000', unit: 'т', price: 385000 },
  { code: 'К0243', name: 'Профнастил оц. С4 0,5х1180 мм (2,45м)', unit: 'м', price: 3255 },
  { code: 'Р0071', name: 'Сетка рабица 50х50 d2,0 (1,5х10 м)', unit: 'рул', price: 9600 },
  { code: 'Л0077', name: 'Эмаль ПФ-115 синяя', unit: 'кг', price: 1200 },
  { code: 'М0144', name: 'Болт М10х35 оц.', unit: 'кг', price: 900 },
];

/** Заказчики для заглушки заказа, пришедшего из другого модуля (orders.ts) */
const STUB_CUSTOMERS = ['Аврора Сервис, ТОО', 'Аврора 75, ТОО', 'Казахтелеком, АО', 'LVE Group, ТОО', 'IDA INTERTASCO JV, ТОО', 'Greystone Construction, ТОО'];

/** POST /purchase-requests/from-order/:orderId — FromOrder */
function fromOrder(orderId: string) {
  const seed = parseInt(orderId.slice(0, 4), 16);
  if (Number.isNaN(seed)) return notFound(`Order ${orderId} not found`);
  const known = ORD_BY_ID.get(orderId);
  // Заказ из orders.ts: номера там генерируются, поэтому собираем заглушку по тому же seed
  const order: Ord = known ?? {
    id: orderId,
    number: `Т7АА-${String(2400 + (seed % 160)).padStart(6, '0')}`,
    planned: dayISO((seed % 21) - 7),
    customer: STUB_CUSTOMERS[seed % STUB_CUSTOMERS.length],
  };
  // Дефицит — у каждого третьего заказа (тот же признак, что в orders.ts)
  if (seed % 3 !== 0 && !known) {
    return { created: 0, updated: 0, message: 'Дефицита нет — сырья хватает' };
  }
  const n = 1 + (seed % 4);
  let created = 0;
  let updated = 0;
  for (let k = 0; k < n; k++) {
    const c = SHORTAGE_CATALOG[(seed + k * 3) % SHORTAGE_CATALOG.length];
    const need = Math.round(((seed >> (k + 2)) % 80 + 12) * 10) / 10;
    const available = Math.round(need * ((seed >> k) % 6) / 10 * 10) / 10;
    const shortage = Math.round((need - available) * 1000) / 1000;
    const local = MAT_BY_CODE.get(c.code);
    const materialId = local?.id ?? `m${c.code.toLowerCase()}-${orderId.slice(9, 13)}-4a1e-8c3b-${orderId.slice(24, 36)}`;
    const existing = REQUESTS.find((r) => r.materialId === materialId && r.orderId === orderId && r.status === 'DRAFT');
    if (existing) {
      existing.requestedQty = shortage;
      existing.estimatedPrice = c.price || null;
      existing.updatedAt = NOW_MS;
      updated++;
    } else {
      REQUESTS.push({
        id: uid('purchase-request-new', `${orderId}:${c.code}`),
        materialId,
        requestedQty: shortage,
        unit: c.unit,
        estimatedPrice: c.price || null,
        orderId,
        note: `Дефицит по заказу ${order.number}`,
        requestedById: DESIGN_USER,
        status: 'DRAFT',
        bitrixDealId: null,
        bitrixSentAt: null,
        createdAt: NOW_MS + created,
        updatedAt: NOW_MS + created,
        orderStub: known ? undefined : order,
      });
      created++;
    }
  }
  return { created, updated, shortages: n };
}

/** Счётчик сделок Б24: следующая после уже отправленных */
let nextDealId = 1843;

/** POST /purchase-requests/send-to-bitrix — SendToBitrix */
function sendToBitrix(body: unknown) {
  const ids = Array.isArray((body as { ids?: unknown })?.ids) ? ((body as { ids: unknown[] }).ids.map(String)) : [];
  if (ids.length === 0) return badRequest('EMPTY_SELECTION', 'Не выбрано ни одной заявки');
  const selected = REQUESTS.filter((r) => ids.includes(r.id) && r.status === 'DRAFT');
  if (selected.length === 0) return badRequest('NOTHING_TO_SEND', 'Среди выбранных нет заявок в статусе «накоплено»');
  // Сводим по коду материала — одна строка сделки на материал
  const byMat = new Map<string, { qty: number; est: number }>();
  for (const r of selected) {
    const code = MAT_BY_ID.get(r.materialId)?.code ?? r.materialId;
    const cur = byMat.get(code);
    if (cur) {
      cur.qty += r.requestedQty;
      if (cur.est === 0) cur.est = r.estimatedPrice ?? 0;
    } else {
      byMat.set(code, { qty: r.requestedQty, est: r.estimatedPrice ?? 0 });
    }
  }
  let total = 0;
  for (const l of byMat.values()) total += l.qty * l.est;
  const dealId = String(nextDealId++);
  for (const r of selected) {
    r.status = 'APPROVED';
    r.bitrixDealId = dealId;
    r.bitrixSentAt = NOW_MS;
    r.updatedAt = NOW_MS;
  }
  return { sent: selected.length, dealId, totalEstimate: jsRound(total) };
}

/** POST /purchase-requests/:id/reject | /ordered — setStatus */
function setStatus(id: string, status: PR['status']) {
  const r = REQUESTS.find((x) => x.id === id);
  if (!r) return notFound(`Purchase request ${id} not found`);
  r.status = status;
  r.updatedAt = NOW_MS;
  return prJSON(r);
}

/** POST /purchase-requests — Create */
function createRequest(body: unknown) {
  const b = (body ?? {}) as { materialId?: unknown; requestedQty?: unknown; note?: unknown; orderId?: unknown };
  const materialId = typeof b.materialId === 'string' ? b.materialId : '';
  const qty = Number(b.requestedQty);
  if (!materialId || !(qty > 0)) return badRequest('INVALID_REQUEST', 'Нужны materialId и requestedQty > 0');
  const m = MAT_BY_ID.get(materialId);
  if (!m) return notFound(`Material ${materialId} not found`);
  const r: PR = {
    id: uid('purchase-request-created', `${materialId}:${REQUESTS.length}`),
    materialId,
    requestedQty: qty,
    unit: m.unit,
    estimatedPrice: m.price,
    orderId: typeof b.orderId === 'string' && b.orderId ? b.orderId : null,
    note: typeof b.note === 'string' && b.note ? b.note : null,
    requestedById: DESIGN_USER,
    status: 'DRAFT',
    bitrixDealId: null,
    bitrixSentAt: null,
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
  };
  REQUESTS.push(r);
  return { ...prJSON(r), material: materialJSON(m) };
}

// ───────────────────────────── маршруты ─────────────────────────────

const idFrom = (path: string, index: number): string => decodeURIComponent(path.split('/')[index] ?? '');

export const routes: FixtureRoute[] = [
  // ── Закупки: ДО из 1С ──
  { method: 'GET', match: /^\/purchases\/dashboard$/, handler: () => dashboard() },
  { method: 'GET', match: /^\/purchases\/documents$/, handler: ({ params }) => documents(params) },

  // ── Очередь на закуп: специфичные маршруты раньше общих ──
  { method: 'POST', match: /^\/purchase-requests\/from-order\/[^/]+$/, handler: ({ path }) => fromOrder(idFrom(path, 3)) },
  { method: 'POST', match: /^\/purchase-requests\/send-to-bitrix$/, handler: ({ body }) => sendToBitrix(body) },
  { method: 'POST', match: /^\/purchase-requests\/[^/]+\/reject$/, handler: ({ path }) => setStatus(idFrom(path, 2), 'REJECTED') },
  { method: 'POST', match: /^\/purchase-requests\/[^/]+\/ordered$/, handler: ({ path }) => setStatus(idFrom(path, 2), 'ORDERED') },
  { method: 'GET', match: /^\/purchase-requests$/, handler: ({ params }) => findAllRequests(params) },
  { method: 'POST', match: /^\/purchase-requests$/, handler: ({ body }) => createRequest(body) },
];
