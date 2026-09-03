import type { FixtureRoute } from './types';

/**
 * Фикстуры модуля «Производство» — режим дизайна (03.09.2026).
 *
 * Формы ответов один в один как у Go-обработчиков:
 *   backend-go/internal/modules/orders/production_plan.go — ProductionPlanHandler
 *   backend-go/internal/modules/catalog/routing.go        — WorkCentersHandler
 * decimal.Decimal → строка («1268.92»), common.PDate → «2026-08-22T00:00:00.000Z»,
 * enum → API-коды (PRODUCTION / CUTTING / DONE) — как на границе Prisma.
 *
 * Данные: заказчики, изделия и составы заказов взяты из реальной базы ЦМК
 * Аврора (например Т7АА-002528 — площадка с мачтой М25, Т7АА-002479 —
 * шелтор, Т7АА-002461 — квадропод без спецификации) и размножены
 * детерминированным генератором: без Math.random и Date.now, при каждой
 * загрузке те же 84 заказа. Цех, список этапов, матрица и недели считаются
 * из ОДНОГО набора заказов — цифры на разных экранах сходятся.
 */

const TODAY = '2026-09-03';
const YEAR = 2026;

// ---------- детерминированность ----------

/** mulberry32 — маленький seed-генератор: один seed → одна и та же выборка */
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
const rnd = mulberry32(20260903);
const between = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
const chance = (p: number): boolean => rnd() < p;
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}
function pickWeighted<T extends { w: number }>(items: readonly T[]): T {
  const total = items.reduce((s, it) => s + it.w, 0);
  let r = rnd() * total;
  for (const it of items) {
    r -= it.w;
    if (r < 0) return it;
  }
  return items[items.length - 1];
}

/** FNV-1a: стабильный UUID из имени — id не меняются между перезагрузками */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function uuid(...parts: Array<string | number>): string {
  const key = parts.join(':');
  const hex = [0, 1, 2, 3].map((k) => fnv(`${key}#${k}`).toString(16).padStart(8, '0')).join('');
  const variant = (8 + (parseInt(hex[16], 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ---------- даты и числа как у Go ----------

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => ymd(new Date(toDate(s).getTime() + n * DAY));
const daysBetween = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY);
/** Понедельник ISO-недели — date_trunc('week', …) */
function mondayOf(s: string): string {
  const dow = toDate(s).getUTCDay();
  return addDays(s, -((dow + 6) % 7));
}
/** common.PDate для @db.Date: полночь UTC с миллисекундами */
const pdate = (s: string | null): string | null => (s ? `${s}T00:00:00.000Z` : null);
/** common.PDate для timestamp'ов (created_at, completed_at) */
const stamp = (s: string, h: number, m: number, sec: number, ms: number) =>
  `${s}T${pad(h)}:${pad(m)}:${pad(sec)}.${String(ms).padStart(3, '0')}Z`;
/** Рабочее время дня в UTC (Астана = UTC+5 → 11:00–18:00), детерминированно от seed */
const workStamp = (s: string) => stamp(s, between(6, 13), between(0, 59), between(0, 59), between(0, 999));
/** shopspring decimal.Decimal → JSON-строка без хвостовых нулей: «1696», «0.039» */
const dec = (n: number): string => String(Math.round(n * 1000) / 1000);
/** round3 модуля orders: common.JsRound(n*1000)/1000 */
const round3 = (n: number) => Math.floor(n * 1000 + 0.5) / 1000;
const round1 = (n: number) => Math.floor(n * 10 + 0.5) / 10;
const jsRound = (n: number) => Math.floor(n + 0.5);
const max0 = (n: number) => (n < 0 ? 0 : n);
const monthsOf = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}`);

// ---------- справочники (из реальной базы) ----------

type RoutingStage = 'CUTTING' | 'ASSEMBLY' | 'PAINTING';
type StageCode = 'DESIGN' | 'SUPPLY' | 'PRODUCTION';
type LineStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE';
type OrderStatus = 'CONFIRMED' | 'IN_PRODUCTION' | 'READY_TO_SHIP';

interface Customer {
  id: string;
  name: string;
  binIin: string;
  region: string | null;
  customerType: 'OUTSIDE' | 'INSIDE';
}
const mkCustomer = (name: string, binIin: string, region: string | null, customerType: 'OUTSIDE' | 'INSIDE'): Customer =>
  ({ id: uuid('customer', name), name, binIin, region, customerType });

/** Заказчики телеком-площадок: мачты, шелторы, ограждения БС */
const TELECOM_CUSTOMERS: Customer[] = [
  mkCustomer('Аврора 75, ТОО', '090940003281', 'Алматы', 'INSIDE'),
  mkCustomer('Казахтелеком, АО', '941240000193', 'Астана', 'OUTSIDE'),
  mkCustomer('Аврора Сервис, ТОО', '120540011736', 'Алматы', 'INSIDE'),
  mkCustomer('Аврора 77, ТОО', '070240004615', 'Алматы', 'INSIDE'),
];
/** Строители и прочие: металлоконструкции, площадки, лестницы */
const OTHER_CUSTOMERS: Customer[] = [
  mkCustomer('Greystone Construction, ТОО', '170340012390', 'Алматы', 'OUTSIDE'),
  mkCustomer('КазДаму Invest', '150140009822', 'Астана', 'OUTSIDE'),
  mkCustomer('НУР АСТАНА КУРЫЛЫС ТОО', '081040007751', 'Астана', 'OUTSIDE'),
  mkCustomer('IDA INTERTASCO JV, ТОО', '190840021207', 'Алматы', 'OUTSIDE'),
  mkCustomer('Qonay Stroy, ТОО', '200440018331', 'Шымкент', 'OUTSIDE'),
  mkCustomer('M2 Solutions, ТОО', '181140002914', 'Алматы', 'OUTSIDE'),
  mkCustomer('BI URBAN CONSTRUCTION, ТОО', '160240013579', 'Астана', 'OUTSIDE'),
  mkCustomer('LVE Group, ТОО', '140640007702', 'Алматы', 'OUTSIDE'),
  mkCustomer('Аврора Холдинг, ТОО', '050940002468', 'Алматы', 'INSIDE'),
  mkCustomer('PLANING Construction (ПЛАНИНГ Констракшн), ТОО', '110340015520', 'Караганда', 'OUTSIDE'),
  mkCustomer('ТОО "Densaulyq Life"', '210940030117', 'Алматы', 'OUTSIDE'),
];
const CUSTOMER_BY_ID = new Map<string, Customer>([...TELECOM_CUSTOMERS, ...OTHER_CUSTOMERS].map((c) => [c.id, c]));

interface Art {
  id: string;
  code: string;
  name: string;
  unit: string;
  resale: boolean;
  /** Строк состава / операций маршрута; ноль — «без спецификации», цех отметить не может */
  bom: number;
  ops: number;
  /** Σ workers × hours_per_unit по маршруту — нормо-часы на единицу */
  norm: number;
  price: number;
  weightKg: number;
  legacy: string | null;
}
const P = (code: string, name: string, unit: string, bom: number, ops: number, norm: number, price: number, weightKg: number, legacy: string | null = null): Art =>
  ({ id: uuid('article', code), code, name, unit, resale: false, bom, ops, norm, price, weightKg, legacy });
const M = (code: string, name: string, unit: string, price: number): Art =>
  ({ id: uuid('article', code), code, name, unit, resale: true, bom: 0, ops: 0, norm: 0, price, weightKg: 0, legacy: null });

const ARTICLES: Art[] = [
  // --- изделия с составом и нормами ---
  P('m-035', 'Мачта М25м на пространственной раме (секция 2м) в сборе', 'шт', 46, 2, 96, 3439000, 1850),
  P('b-016', 'Контейнер технологический - Шелтор 0123 (2х2)', 'шт', 37, 2, 64, 1140000, 1150),
  P('b-015', 'Контейнер технологический - Шелтор 0123 (3х2)', 'шт', 41, 2, 82, 1480000, 1620),
  P('b-007', 'Лестница с площадкой для Шелтора 0321', 'шт', 13, 3, 9.5, 75895, 72, 'w-058'),
  P('a-001', 'Антивандальное ограждение Outdoor 1400х1300х2350', 'шт', 20, 3, 14, 357930, 346, 'w-050'),
  P('a-011', 'Стойка ограждения ф76 мм 3400 мм', 'шт', 9, 2, 1.2, 17000, 23, 'w-022'),
  P('a-013', 'Секция ограждения 2500х1820мм (сетка рабица)', 'шт', 12, 2, 2.4, 31500, 41),
  P('a-014', 'Секция ограждения 2500х1520мм (сетка рабица)', 'шт', 12, 2, 2.2, 28900, 37),
  P('a-015', 'Секция ограждения 2500х1320мм (сетка рабица)', 'шт', 12, 2, 2, 26400, 33),
  P('a-016', 'Секция ограждения 2500х820мм (сетка рабица)', 'шт', 12, 2, 1.6, 19800, 24),
  P('a-017', 'Секция ограждения 390х820мм (сетка рабица)', 'шт', 12, 2, 0.8, 8600, 9),
  P('a-018', 'Секция ограждения 2000х900мм (сетка рабица) калитка', 'шт', 15, 2, 3.1, 42300, 31),
  P('k-019', 'Трубостойка ф76 L3000 mm', 'шт', 7, 3, 1.5, 18000, 20, 'w-030'),
  P('k-028', 'Швеллерная балка L500 mm под трубу Ф76-76', 'шт', 6, 3, 0.9, 5705, 6, 'w-038'),
  P('k-013', 'Молниеприемник приварной', 'шт', 6, 2, 0.6, 2165, 2, 'w-044'),
  P('k-017', 'Стягивающая рама для плит 500х500x100', 'шт', 11, 3, 1.8, 14660, 11, 'w-049'),
  P('k-010', 'Кабельный мост 1м', 'шт', 9, 3, 2.6, 27500, 18),
  P('n-019', 'Кабельный мост 2,0м (без трубостойки)', 'шт', 12, 3, 4.2, 44000, 30),
  P('n-039', 'Очаг заземления уголок 50 2000мм', 'шт', 3, 1, 0.5, 8050, 8),
  P('b-012', 'Полоса заземления 40х4мм, L-2м', 'шт', 2, 1, 0.15, 2000, 3, 'w-048'),
  P('b-013', 'Шина Т-образная', 'шт', 6, 2, 0.35, 1100, 1.5, 'w-042'),
  P('n-706', 'Пластина крепежная 100х100х6мм', 'шт', 4, 2, 0.12, 499, 0.5),
  P('n-1277', 'Усиление АМС-21м_51131HELIOS', 'компл', 24, 3, 38, 612000, 940),
  P('BS-001', 'Базовая станция "Калина-М"', 'шт', 28, 3, 120, 1200000, 2400, 'БС-Калина'),
  P('z-476', 'Изготовление лаборатория', 'тонн', 6, 3, 52, 985000, 1000),
  P('z-431', 'Пластина 374х96х10мм, 14шт', 'тонна', 1, 1, 6, 620000, 1000),
  P('z-434', 'Пластина 530х115х16мм, 2шт', 'тонна', 1, 1, 6, 620000, 1000),
  P('z-438', 'Шайба 120х120х40мм, 8шт', 'тонна', 1, 1, 8, 640000, 1000),
  P('z-412', 'Демпфер Дф-2, Дф-3, 27шт', 'тонн', 1, 1, 10, 700000, 1000),
  // --- без спецификации: состава и норм нет, цех отметить не может ---
  P('m-063', 'Квадропод 15м (Рама Р40.40)', 'шт', 0, 0, 0, 0, 0),
  P('z-452', 'Квадрапод 18м (UK5130) оцинк.', 'шт', 0, 0, 0, 0, 0),
  P('z-450', 'АМС Б25 (PA5234) оцинк.', 'шт', 0, 0, 0, 0, 0),
  P('z-459', 'Ограждение 6000х6000мм (круг ф12) L50 под квадропод (KS5392)', 'компл', 0, 0, 0, 0, 0),
  P('z-467', 'Очаг заземления уголок 50 2000мм (KS5394)', 'шт', 0, 0, 0, 0, 0),
  P('z-468', 'Полоса заземления 40х4мм, L-2м оцинк. (KS5392)', 'шт', 0, 0, 0, 0, 0),
  P('z-447', 'БМК 6.0х2.4х2.7м', 'шт', 0, 0, 0, 0, 0),
  P('z-449', 'Изготовление винтовой лестницы', 'тонн', 0, 0, 0, 0, 0),
  P('z-479', 'Изготовление и монтаж каркаса под зенитный фонарь 6х6м блока 1,2', 'тонна', 0, 0, 0, 0, 0),
  P('z-445', 'Изготовление пожарной лестницы здания №1 и №2', 'Одна услуг', 0, 0, 0, 0, 0),
  // --- ТМЦ и услуги: перепродажа, цех не изготавливает ---
  M('Л0078', 'Эмаль ПФ-115 черная', 'кг', 1850),
  M('Л0077', 'Эмаль ПФ-115 синяя', 'кг', 1850),
  M('Л0079', 'Эмаль ПФ-115 серый', 'кг', 1850),
  M('Л0004', 'Грунтовка ГФ-021 серая', 'кг', 1420),
  M('Л0020', 'Растворитель 646', 'л', 980),
  M('TLCM007779', 'Трубный хомут ф76', 'шт', 640),
  M('К0502', 'Трос 14 мм', 'м', 1150),
  M('К0712', 'Швеллер 12У', 'т', 415000),
  M('АА-00027135', 'Сдача металлалома', 'Одна услуг', 85000),
  M('АА-00027866', 'Монтаж пожарной лестницы', 'Одна услуг', 450000),
];
const ART = new Map<string, Art>(ARTICLES.map((a) => [a.code, a]));
const ART_BY_ID = new Map<string, Art>(ARTICLES.map((a) => [a.id, a]));
const art = (code: string): Art => {
  const a = ART.get(code);
  if (!a) throw new Error(`fixture: нет изделия ${code}`);
  return a;
};

/** Площадки телеком-заказов — по одной на заказ, как в реальных заявках */
const SITES = [
  'KZ-ALM_Dudar', 'KZ-ALM_Kaskelen', 'KZ-ALM_Talgar', 'KZ-AST_Koktal', 'KZ-AST_Koyandy',
  'KZ-KRG_Saran', 'KZ-SHM_Kazygurt', 'KZ-PVL_Aksu', 'KZ-AKT_Zhetybai', 'KZ-UKO_Turkestan',
  'KZ-KST_Rudny', 'KZ-ZKO_Aksai', 'KZ-VKO_Ridder', 'KZ-ATY_Kulsary', 'KZ-KZO_Aral',
];

/** Составы заказов — реальные (номер в комментарии) и типовые */
const KITS: Array<{ w: number; tele: boolean; lines: Array<[string, number]> }> = [
  { w: 3, tele: true, lines: [['m-035', 1], ['a-011', 12], ['a-013', 6], ['a-014', 4], ['a-016', 1], ['a-017', 1], ['a-018', 1], ['k-019', 4], ['k-013', 4], ['n-019', 1], ['b-012', 22], ['n-039', 3], ['b-013', 2], ['k-028', 8], ['b-016', 1], ['Л0079', 2], ['Л0077', 2], ['TLCM007779', 32], ['К0502', 4], ['Л0020', 2]] }, // площадка с мачтой (Т7АА-002528)
  { w: 6, tele: true, lines: [['b-016', 1], ['b-007', 1]] }, // шелтор (Т7АА-002479)
  { w: 2, tele: true, lines: [['b-015', 1], ['b-007', 1], ['k-019', 2], ['b-012', 10]] },
  { w: 3, tele: true, lines: [['z-452', 1], ['z-459', 1], ['z-467', 4], ['z-468', 23], ['z-450', 1]] }, // квадропод без спецификации (Т7АА-002461)
  { w: 5, tele: true, lines: [['a-011', 24], ['a-013', 10], ['a-015', 6], ['a-018', 2], ['Л0078', 5]] }, // ограждение БС
  { w: 3, tele: false, lines: [['a-001', 12]] },
  { w: 4, tele: true, lines: [['k-017', 17], ['n-706', 17], ['Л0004', 20]] }, // рамы для плит (Т7АА-002534)
  { w: 2, tele: false, lines: [['z-431', 0.039], ['z-434', 0.015], ['z-438', 0.036], ['z-412', 0.05]] }, // пластины (Т7АА-002444)
  { w: 2, tele: false, lines: [['z-447', 3]] }, // БМК (Т7АА-002458)
  { w: 1, tele: false, lines: [['z-476', 6.212]] }, // лаборатория (Т7АА-002483)
  { w: 2, tele: true, lines: [['BS-001', 2], ['k-019', 2], ['b-012', 10]] },
  { w: 4, tele: true, lines: [['b-012', 57], ['n-039', 3], ['b-013', 40], ['k-013', 10]] }, // заземление
  { w: 3, tele: true, lines: [['n-019', 6], ['k-019', 12], ['k-028', 24], ['К0712', 1.2]] }, // кабельные мосты
  { w: 2, tele: true, lines: [['n-1277', 4], ['m-063', 2]] },
  { w: 2, tele: false, lines: [['z-449', 3.06], ['АА-00027866', 1]] }, // винтовая лестница (Т7АА-002460)
  { w: 2, tele: false, lines: [['АА-00027135', 40]] }, // только услуга — цех такой заказ не видит
  { w: 1, tele: false, lines: [['z-479', 0.531]] },
  { w: 1, tele: false, lines: [['z-445', 16.88], ['Л0004', 60]] },
];

const MANAGERS = [uuid('user', 'bisen'), uuid('user', 'bolatova'), uuid('user', 'serikbay')];
const FOREMAN = uuid('user', 'foreman');
const CONTRACTOR_WELD = 'ТОО «СварМонтаж Астана»';
const CONTRACTOR_PAINT = 'ТОО «Кокше Металл Сервис»';
const CONTRACTOR_CUT = 'ИП Абдрахманов Е.С.';

// ---------- генерация заказов, позиций и этапов ----------

interface Line {
  id: string;
  orderId: string;
  art: Art;
  qty: number;
  siteCode: string | null;
  unitPrice: number;
  reservedQty: number;
  shippedQty: number;
}
interface ContractorWork {
  name: string;
  stage: RoutingStage;
  share: number;
  accepted: boolean;
}
interface Ord {
  id: string;
  number: string;
  customer: Customer;
  tele: boolean;
  createdAt: string;
  requestDate: string;
  planned: string | null;
  status: OrderStatus;
  overdueDays: number;
  trackingMode: 'ORDER' | 'LINE';
  managerId: string;
  bitrixDealId: string | null;
  paidShare: number;
  onecStatus: string;
  clientAgreement: string;
  productionDoc: { number: string; date: string } | null;
  lines: Line[];
  contractors: ContractorWork[];
}
/** Строка production_stages как её отдаёт stageRawJSON */
interface Stage {
  id: string;
  orderId: string;
  orderLineId: string | null;
  stageCode: StageCode;
  routingStage: RoutingStage | null;
  status: LineStatus;
  actualWorkers: number | null;
  actualHours: number | null;
  legacyStageCode: string | null;
  completedAt: string | null;
  completedById: string | null;
  defectPhotoUrl: string | null;
}

/** Статус изделия с оглядкой на срок: просроченные в основном готовы, дальние — не начаты */
function rollStatus(blocked: boolean, daysLeft: number | null): LineStatus {
  if (blocked) return 'NOT_STARTED';
  const r = rnd();
  if (daysLeft === null) return r < 0.1 ? 'DONE' : r < 0.3 ? 'IN_PROGRESS' : 'NOT_STARTED';
  if (daysLeft < -20) return r < 0.75 ? 'DONE' : r < 0.9 ? 'IN_PROGRESS' : 'NOT_STARTED';
  if (daysLeft < 0) return r < 0.45 ? 'DONE' : r < 0.75 ? 'IN_PROGRESS' : 'NOT_STARTED';
  if (daysLeft < 14) return r < 0.2 ? 'DONE' : r < 0.55 ? 'IN_PROGRESS' : 'NOT_STARTED';
  return r < 0.05 ? 'DONE' : r < 0.2 ? 'IN_PROGRESS' : 'NOT_STARTED';
}

const ORDERS: Ord[] = [];
const STAGES: Stage[] = [];
const ORDER_COUNT = 84;
let orderNum = 2402;
let productionDocNum = 731;

for (let i = 0; i < ORDER_COUNT; i++) {
  orderNum += between(1, 3);
  const kit = pickWeighted(KITS);
  const tele = kit.tele;
  const customer = tele ? pick(TELECOM_CUSTOMERS) : pick(OTHER_CUSTOMERS);
  const id = uuid('order', orderNum);
  const number = `Т7АА-${String(orderNum).padStart(6, '0')}`;
  // Заказы заведены с 8 июня по 2 сентября, план вывоза через 3–8 недель:
  // часть уже просрочена, часть — на ближайшие недели
  const createdAt = addDays('2026-06-08', Math.floor((i * 86) / ORDER_COUNT) + between(0, 2));
  const requestDate = addDays(createdAt, -between(1, 12));
  const planned = chance(0.06) ? null : addDays(createdAt, between(18, 55));
  const daysLeft = planned ? daysBetween(TODAY, planned) : null;
  const siteCode = tele && chance(0.8) ? pick(SITES) : null;
  const trackingMode: 'ORDER' | 'LINE' = chance(0.2) ? 'ORDER' : 'LINE';
  const paidShare = pick([0, 0, 0.5, 1]);

  const lines: Line[] = kit.lines.map(([code, qty], j) => {
    const a = art(code);
    return {
      id: uuid('line', orderNum, j), orderId: id, art: a, qty,
      siteCode: a.resale ? null : siteCode,
      unitPrice: a.price || between(520, 980) * 1000,
      reservedQty: 0, shippedQty: 0,
    };
  });

  const statuses: LineStatus[] = [];
  for (const l of lines) {
    if (l.art.resale) continue;
    const blocked = l.art.bom === 0 || l.art.ops === 0;
    const status = rollStatus(blocked, daysLeft);
    statuses.push(status);
    if (status === 'NOT_STARTED') continue;
    const normTotal = l.art.norm * l.qty;
    const hours = status === 'DONE'
      ? (chance(0.6) ? round1(normTotal * (0.85 + rnd() * 0.45)) : null)
      : (chance(0.5) ? round1(normTotal * rnd() * 0.6) : null);
    const doneDate = addDays(createdAt, between(1, Math.max(1, Math.min(40, daysBetween(createdAt, TODAY)))));
    STAGES.push({
      id: uuid('stage', l.id), orderId: id, orderLineId: l.id, stageCode: 'PRODUCTION', routingStage: null,
      status, actualWorkers: hours != null ? between(2, 4) : null, actualHours: hours, legacyStageCode: null,
      completedAt: status === 'DONE' ? workStamp(doneDate) : null,
      completedById: status === 'DONE' && chance(0.7) ? FOREMAN : null,
      defectPhotoUrl: null,
    });
    if (status === 'DONE' && chance(0.35)) l.reservedQty = l.qty;
  }

  const status: OrderStatus = statuses.length > 0 && statuses.every((s) => s === 'DONE')
    ? 'READY_TO_SHIP'
    : statuses.some((s) => s !== 'NOT_STARTED') ? 'IN_PRODUCTION' : 'CONFIRMED';
  if (status === 'READY_TO_SHIP' && chance(0.3)) {
    for (const l of lines) if (!l.art.resale && chance(0.5)) l.shippedQty = l.qty;
  }

  // Вехи заказа целиком — режим ORDER (заказ без разбивки по позициям)
  if (trackingMode === 'ORDER') {
    const routing: RoutingStage[] = ['CUTTING', 'ASSEMBLY', 'PAINTING'];
    const doneUpTo = status === 'READY_TO_SHIP' ? 3 : status === 'IN_PRODUCTION' ? between(0, 2) : 0;
    const vehi: Array<[StageCode, RoutingStage | null, LineStatus]> = [
      ['DESIGN', null, 'DONE'],
      ['SUPPLY', null, status === 'CONFIRMED' && chance(0.5) ? 'IN_PROGRESS' : 'DONE'],
      ...routing.map((r, k): [StageCode, RoutingStage | null, LineStatus] =>
        ['PRODUCTION', r, k < doneUpTo ? 'DONE' : k === doneUpTo && status === 'IN_PRODUCTION' ? 'IN_PROGRESS' : 'NOT_STARTED']),
    ];
    vehi.forEach(([stageCode, routingStage, st], k) => {
      STAGES.push({
        id: uuid('stage', id, stageCode, routingStage ?? '-'), orderId: id, orderLineId: null, stageCode, routingStage,
        status: st, actualWorkers: null, actualHours: null, legacyStageCode: null,
        completedAt: st === 'DONE' ? workStamp(addDays(createdAt, 2 + k * 4)) : null,
        completedById: st === 'DONE' ? FOREMAN : null, defectPhotoUrl: null,
      });
    });
  }

  const contractors: ContractorWork[] = [];
  if (chance(0.18)) {
    contractors.push({ name: CONTRACTOR_WELD, stage: 'ASSEMBLY', share: pick([1, 0.4, 0.6]), accepted: chance(0.6) });
    if (chance(0.3)) contractors.push({ name: CONTRACTOR_PAINT, stage: 'PAINTING', share: 1, accepted: false });
  }

  ORDERS.push({
    id, number, customer, tele, createdAt, requestDate, planned, status,
    overdueDays: planned && planned < TODAY ? daysBetween(planned, TODAY) : 0,
    trackingMode, managerId: pick(MANAGERS),
    bitrixDealId: tele || chance(0.4) ? `ID заявки:${1837000 + between(100, 9000)}` : null,
    paidShare,
    onecStatus: status === 'READY_TO_SHIP' ? 'К отгрузке' : status === 'IN_PRODUCTION' ? 'К выполнению / В резерве' : pick(['К обеспечению', 'К выполнению / В резерве']),
    clientAgreement: pick(['0/100', '50/50', '100/0']),
    productionDoc: status === 'READY_TO_SHIP' ? { number: `Т7АА-${String(productionDocNum++).padStart(6, '0')}`, date: addDays(TODAY, -between(0, 9)) } : null,
    lines, contractors,
  });
}

const ORDER_BY_ID = new Map<string, Ord>(ORDERS.map((o) => [o.id, o]));
/** Порядок цеха: ORDER BY planned_shipment_date ASC (NULLS LAST), created_at DESC */
const ORDERS_BY_SHIPMENT: Ord[] = [...ORDERS].sort((a, b) => {
  if (a.planned === b.planned) return b.createdAt.localeCompare(a.createdAt);
  if (!a.planned) return 1;
  if (!b.planned) return -1;
  return a.planned.localeCompare(b.planned);
});

/** Статус позиции по этапам: DONE важнее IN_PROGRESS — одна закрывающая отметка решает */
function lineStatuses(): { statusByLine: Map<string, LineStatus>; hoursByLine: Map<string, number> } {
  const statusByLine = new Map<string, LineStatus>();
  const hoursByLine = new Map<string, number>();
  for (const s of STAGES) {
    if (!s.orderLineId) continue;
    if (s.status === 'DONE' || !statusByLine.has(s.orderLineId)) statusByLine.set(s.orderLineId, s.status);
    if (s.actualHours != null) hoursByLine.set(s.orderLineId, s.actualHours);
  }
  return { statusByLine, hoursByLine };
}

// ---------- сериализация как у Go ----------

function stageJSON(s: Stage) {
  return {
    id: s.id, orderId: s.orderId, orderLineId: s.orderLineId, stageCode: s.stageCode, routingStage: s.routingStage,
    status: s.status,
    actualWorkers: s.actualWorkers == null ? null : dec(s.actualWorkers),
    actualHours: s.actualHours == null ? null : dec(s.actualHours),
    legacyStageCode: s.legacyStageCode, completedAt: s.completedAt, completedById: s.completedById, defectPhotoUrl: s.defectPhotoUrl,
  };
}

const lineTotal = (l: Line) => Math.round(l.qty * l.unitPrice * 100) / 100;
const orderTotal = (o: Ord) => o.lines.reduce((s, l) => s + lineTotal(l), 0);

/** orderRawJSON — заказ целиком, как Prisma без include */
function orderRaw(o: Ord) {
  const total = orderTotal(o);
  return {
    id: o.id, orderNumber: o.number, customerId: o.customer.id, region: o.customer.region, managerId: o.managerId,
    orderType: 'FZ', bitrixDealId: o.bitrixDealId, bitrixStage: null, status: o.status,
    plannedShipmentDate: pdate(o.planned), actualShipmentDate: null, overdueDays: o.overdueDays,
    stageTrackingMode: o.trackingMode, acceptedAt: null, acceptedById: null, isArchived: false,
    requestDate: pdate(o.requestDate),
    createdAt: stamp(o.createdAt, 11, 42, 12, 116), updatedAt: stamp(TODAY, 6, 7, 15, 588),
    onecNum: o.number, onecStatus: o.onecStatus, onecApprovalStatus: null,
    onecTotalAmount: dec(total), onecPaidAmount: dec(total * o.paidShare),
    finalCustomer: null, customerOrderNum: null,
    projectGroup: '74-0245 -Аврора 77, ТОО-02-2021', projectSite: 'KZ-Металлоконструкция',
    divisionCode: o.tele ? '74п_Телеком' : '74п_ЦМК', clientAgreement: o.clientAgreement,
    onecSyncedAt: stamp(TODAY, 3, 0, 4, 21),
    productionDocNumber: o.productionDoc?.number ?? null, productionDocDate: pdate(o.productionDoc?.date ?? null),
    sourceSheet: null, sourceRowNumber: null, rawColumns: null,
  };
}

function articleRaw(a: Art) {
  return {
    id: a.id, articleCode: a.code, legacyCode: a.legacy, name: a.name, weightKg: dec(a.weightKg), series: null, description: null,
    approvedPrice: dec(a.price), isMaterialResale: a.resale, specPrice: '0', priceDeviationPct: '0', leadTimeDays: '0',
    palletCapacity: '0', isActive: true, createdAt: '2026-08-21T21:17:29.657Z', updatedAt: '2026-08-21T21:17:29.657Z',
  };
}

/** lineRawJSON — позиция с вложенным изделием */
function lineRaw(l: Line, o: Ord) {
  const total = lineTotal(l);
  const prepayment = Math.round(total * o.paidShare * 100) / 100;
  return {
    id: l.id, orderId: l.orderId, articleId: l.art.id, qty: dec(l.qty), unit: l.art.unit,
    unitPrice: dec(l.unitPrice), lineTotalVat: dec(total), prepayment: dec(prepayment),
    postPayment1: '0', postPayment2: '0', penalty: '0', balanceDue: dec(total - prepayment),
    reservedQty: dec(l.reservedQty), shippedQty: dec(l.shippedQty),
    siteCode: l.siteCode, sourceSheet: null, sourceRowNumber: null,
    articleCodeRaw: null, productNameRaw: null, rawColumns: null,
    article: articleRaw(l.art),
  };
}

const fail = (statusCode: number, code: string, message: string) => ({ statusCode, error: { code, message } });
const notFound = (message: string) => fail(404, 'NOT_FOUND', message);

// ---------- цех ----------

function shopFloor(search: string) {
  const q = search.trim().toLowerCase();
  const { statusByLine, hoursByLine } = lineStatuses();
  const rows: unknown[] = [];
  let totalProducts = 0;
  let doneProducts = 0;
  let blockedProducts = 0;

  for (const o of ORDERS_BY_SHIPMENT) {
    const productLines = o.lines.filter((l) => !l.art.resale);
    const resaleCount = o.lines.length - productLines.length;
    if (productLines.length === 0) continue;
    const codeSeen = new Map<string, number>();
    for (const l of productLines) codeSeen.set(l.art.code, (codeSeen.get(l.art.code) ?? 0) + 1);
    const contractors = o.contractors.map((w) => ({ name: w.name, sharePct: jsRound(w.share * 100), isAccepted: w.accepted }));

    let matches = q === '' || o.number.toLowerCase().includes(q) || o.customer.name.toLowerCase().includes(q);
    let done = 0;
    let blocked = 0;
    const products = productLines.map((l, idx) => {
      const status = statusByLine.get(l.id) ?? 'NOT_STARTED';
      const hours = hoursByLine.get(l.id);
      const missingBom = l.art.bom === 0;
      const missingNorms = l.art.ops === 0;
      if (status === 'DONE') done++;
      if (missingBom || missingNorms) blocked++;
      if (!matches && (l.art.code.toLowerCase().includes(q) || l.art.name.toLowerCase().includes(q))) matches = true;
      return {
        id: l.id, lineNo: idx + 1, isDuplicateCode: (codeSeen.get(l.art.code) ?? 0) > 1,
        articleId: l.art.id, articleCode: l.art.code, articleName: l.art.name, siteCode: l.siteCode,
        missingBom, missingNorms,
        qty: l.qty, unit: l.art.unit, status,
        normHours: round3(l.art.norm * l.qty), actualHours: hours ?? null,
        contractors,
      };
    });
    if (!matches) continue;

    rows.push({
      id: o.id, orderNumber: o.number, customerName: o.customer.name, status: o.status,
      plannedShipmentDate: pdate(o.planned), overdueDays: o.overdueDays, products,
      doneCount: done, totalProducts: products.length, blockedCount: blocked, resaleCount,
    });
    totalProducts += products.length;
    doneProducts += done;
    blockedProducts += blocked;
  }

  // Открытые заявки на подряд — к заказу заранее не привязаны, мастер разносит сам
  const openRequests = [
    { id: uuid('request', 'ПОДР-006'), number: 'ПОДР-006', routingStage: 'ASSEMBLY', description: 'Сварка каркасов Шелтор 0123 (2х2) — партия 6 шт', contractorName: CONTRACTOR_WELD, rateType: 'PER_UNIT', unit: 'шт', allocatedQty: 2, targetQty: 6, remainingQty: 4, isAccepted: true },
    { id: uuid('request', 'ПОДР-007'), number: 'ПОДР-007', routingStage: 'PAINTING', description: 'Покраска секций ограждения (сетка рабица), эмаль ПФ-115', contractorName: CONTRACTOR_PAINT, rateType: 'PER_KG', unit: 'кг', allocatedQty: 0, targetQty: 1840, remainingQty: 1840, isAccepted: false },
    { id: uuid('request', 'ПОДР-008'), number: 'ПОДР-008', routingStage: 'CUTTING', description: 'Резка швеллера 12У на трубостойки ф76 L3000', contractorName: CONTRACTOR_CUT, rateType: 'PER_TON', unit: 'т', allocatedQty: 1.2, targetQty: 3.5, remainingQty: 2.3, isAccepted: true },
    { id: uuid('request', 'ПОДР-009'), number: 'ПОДР-009', routingStage: 'ASSEMBLY', description: 'Сборка мачты М25м на пространственной раме — секции 2 м', contractorName: CONTRACTOR_WELD, rateType: 'PER_HOUR', unit: 'ч', allocatedQty: 36, targetQty: null, remainingQty: null, isAccepted: false },
  ];

  return {
    orders: rows, total: rows.length, totalProducts, doneProducts,
    waitingProducts: totalProducts - doneProducts, blockedProducts, openRequests,
  };
}

// ---------- матрица «изделие × месяц» ----------

/** Типовой месячный объём — база для плана и факта прошлых месяцев */
const PLAN_BASE: Array<[string, number]> = [
  ['a-011', 120], ['a-013', 60], ['a-014', 24], ['a-015', 30], ['a-016', 12], ['a-017', 12], ['a-018', 8],
  ['k-019', 48], ['k-028', 40], ['b-012', 80], ['b-013', 200], ['b-016', 6], ['b-007', 6], ['n-019', 8],
  ['k-013', 20], ['k-017', 24], ['m-035', 2], ['BS-001', 3], ['n-706', 40],
];

/** План — единственное, что хранится (production_plan_items); правится PATCH'ем */
const PLAN = new Map<string, number>();
const planKey = (articleId: string, periodKey: string) => `${articleId}|${periodKey}`;
for (const [code, base] of PLAN_BASE) {
  for (let m = 1; m <= 12; m++) {
    if (!chance(0.85)) continue;
    PLAN.set(planKey(art(code).id, `${YEAR}-${pad(m)}`), Math.max(1, jsRound(base * (0.7 + rnd() * 0.6))));
  }
}

/** Факт выпуска: январь–февраль — реальные движения ГП, дальше — генератор + отметки цеха */
const FACT: Array<{ key: string; art: Art; qty: number }> = [];
const FACT_REAL: Array<[string, string, number]> = [
  ['2026-01', 'b-007', 2], ['2026-01', 'b-012', 57], ['2026-01', 'n-039', 3],
  ['2026-02', 'a-001', 12], ['2026-02', 'a-011', 164], ['2026-02', 'a-013', 61], ['2026-02', 'a-014', 15],
  ['2026-02', 'a-015', 47], ['2026-02', 'a-016', 14], ['2026-02', 'a-017', 14], ['2026-02', 'a-018', 7],
  ['2026-02', 'b-007', 8], ['2026-02', 'b-012', 70], ['2026-02', 'b-013', 235], ['2026-02', 'b-015', 4],
  ['2026-02', 'b-016', 9], ['2026-02', 'k-010', 3], ['2026-02', 'k-019', 50], ['2026-02', 'k-028', 46],
  ['2026-02', 'm-063', 2], ['2026-02', 'n-019', 2], ['2026-02', 'n-1277', 4],
];
for (const [key, code, qty] of FACT_REAL) FACT.push({ key, art: art(code), qty });
for (const [code, base] of PLAN_BASE) {
  for (let m = 3; m <= 8; m++) {
    if (!chance(0.75)) continue;
    FACT.push({ key: `${YEAR}-${pad(m)}`, art: art(code), qty: Math.max(1, jsRound(base * (0.55 + rnd() * 0.6))) });
  }
}
for (const s of STAGES) {
  if (s.status !== 'DONE' || !s.orderLineId || !s.completedAt) continue;
  const o = ORDER_BY_ID.get(s.orderId);
  const l = o?.lines.find((x) => x.id === s.orderLineId);
  if (l) FACT.push({ key: s.completedAt.slice(0, 7), art: l.art, qty: l.qty });
}

interface MatrixArticle { id: string; articleCode: string; name: string; isMaterialResale?: boolean }
interface MatrixCell { plan: number; fact: number; demand: number }

function matrix(year: number) {
  const months = monthsOf(year);
  const rows = new Map<string, { article: MatrixArticle; cells: Record<string, MatrixCell> }>();
  const order: string[] = [];
  // Объект article — той выборки, которая создала строку: из потребности
  // заказов приходит ещё isMaterialResale (select оригинала различается)
  const rowFor = (a: Art, fromDemand: boolean) => {
    let r = rows.get(a.id);
    if (!r) {
      const article: MatrixArticle = { id: a.id, articleCode: a.code, name: a.name };
      if (fromDemand) article.isMaterialResale = false;
      const cells: Record<string, MatrixCell> = {};
      for (const m of months) cells[m] = { plan: 0, fact: 0, demand: 0 };
      r = { article, cells };
      rows.set(a.id, r);
      order.push(a.id);
    }
    return r;
  };
  for (const [key, qty] of PLAN) {
    const [articleId, periodKey] = key.split('|');
    const a = ART_BY_ID.get(articleId);
    if (!a || !months.includes(periodKey)) continue;
    rowFor(a, false).cells[periodKey].plan = qty;
  }
  for (const f of FACT) {
    if (!months.includes(f.key)) continue;
    rowFor(f.art, false).cells[f.key].fact += f.qty;
  }
  for (const o of ORDERS) {
    if (!o.planned) continue;
    const key = o.planned.slice(0, 7);
    if (!months.includes(key)) continue;
    for (const l of o.lines) {
      if (l.art.resale) continue;
      rowFor(l.art, true).cells[key].demand += l.qty;
    }
  }
  order.sort((a, b) => rows.get(a)!.article.articleCode.localeCompare(rows.get(b)!.article.articleCode));
  const data = order.map((id) => {
    const r = rows.get(id)!;
    const cells: Record<string, MatrixCell> = {};
    for (const m of months) {
      const c = r.cells[m];
      cells[m] = { plan: round3(c.plan), fact: round3(c.fact), demand: round3(c.demand) };
    }
    return { article: r.article, cells };
  });
  return { year, months, data };
}

// ---------- по неделям ----------

function weekly() {
  interface Bucket { orders: number; total: number; reserved: number; shipped: number }
  const buckets = new Map<string | null, Bucket>();
  for (const o of ORDERS) {
    const key = o.planned ? mondayOf(o.planned) : null;
    let b = buckets.get(key);
    if (!b) {
      b = { orders: 0, total: 0, reserved: 0, shipped: 0 };
      buckets.set(key, b);
    }
    b.orders++;
    for (const l of o.lines) {
      b.total += l.qty;
      b.reserved += l.reservedQty;
      b.shipped += l.shippedQty;
    }
  }
  const row = (key: string | null, b: Bucket) => ({
    weekStart: pdate(key), ordersCount: b.orders,
    totalQty: round3(b.total), reservedQty: round3(b.reserved), shippedQty: round3(b.shipped),
    toProduce: round3(max0(b.total - b.reserved - b.shipped)),
  });
  const weeks = [...buckets.entries()]
    .filter((e): e is [string, Bucket] => e[0] !== null)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, b]) => row(k, b));
  const nd = buckets.get(null);
  return { weeks, noDate: nd ? row(null, nd) : null };
}

// ---------- участки ----------

const WORK_CENTERS = [
  { id: uuid('wc', 'ASM-1'), code: 'ASM-1', name: 'Сварка-1', stage: 'ASSEMBLY', hourlyRate: '1268.92', capacityPerDay: '24', isActive: true },
  { id: uuid('wc', 'ASM-2'), code: 'ASM-2', name: 'Сварка-2', stage: 'ASSEMBLY', hourlyRate: '1268.92', capacityPerDay: '24', isActive: true },
  { id: uuid('wc', 'CUT-1'), code: 'CUT-1', name: 'Резка-1', stage: 'CUTTING', hourlyRate: '1268.92', capacityPerDay: '16', isActive: true },
  { id: uuid('wc', 'PNT-1'), code: 'PNT-1', name: 'Покраска-1', stage: 'PAINTING', hourlyRate: '1268.92', capacityPerDay: '16', isActive: true },
];

// ---------- маршруты ----------

const asStr = (v: unknown): string | null => (v == null ? null : String(v));
const asNum = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

export const routes: FixtureRoute[] = [
  // GET /production-plan?orderId=&status=&page=&pageSize= — этапы с вложенным заказом и заказчиком
  {
    method: 'GET',
    match: /^\/production-plan$/,
    handler: ({ params }) => {
      const page = Math.max(1, Number(params.get('page')) || 1);
      const pageSize = Math.max(1, Number(params.get('pageSize')) || 50);
      const orderId = params.get('orderId');
      const status = params.get('status')?.toUpperCase();
      const list = STAGES
        .filter((s) => (!orderId || s.orderId === orderId) && (!status || s.status === status))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // Prisma take без orderBy → ORDER BY id
      const data = list.slice((page - 1) * pageSize, page * pageSize).map((s) => {
        const o = ORDER_BY_ID.get(s.orderId)!;
        return { ...stageJSON(s), order: { ...orderRaw(o), customer: o.customer } };
      });
      return { data, meta: { page, pageSize, total: list.length } };
    },
  },

  // GET /production-plan/shop-floor?search= — цех: заказы в производстве по изделиям
  {
    method: 'GET',
    match: /^\/production-plan\/shop-floor$/,
    handler: ({ params }) => shopFloor(params.get('search') ?? ''),
  },

  // GET /production-plan/matrix?year= — план / факт / потребность по месяцам
  {
    method: 'GET',
    match: /^\/production-plan\/matrix$/,
    handler: ({ params }) => matrix(Number(params.get('year')) || YEAR),
  },

  // PATCH /production-plan/matrix {articleId, periodKey, qty} — ноль стирает запись
  {
    method: 'PATCH',
    match: /^\/production-plan\/matrix$/,
    handler: ({ body }) => {
      const b = (body ?? {}) as { articleId?: unknown; periodKey?: unknown; qty?: unknown };
      const periodKey = String(b.periodKey ?? '');
      if (!/^\d{4}-\d{2}$/.test(periodKey)) return fail(400, 'INVALID_PERIOD', 'Период — в формате ГГГГ-ММ');
      const a = ART_BY_ID.get(String(b.articleId ?? ''));
      if (!a) return notFound(`Article ${String(b.articleId)} not found`);
      const qty = Number(b.qty);
      if (!(qty >= 0)) return fail(400, 'INVALID_QTY', 'План не может быть отрицательным');
      if (qty === 0) {
        PLAN.delete(planKey(a.id, periodKey));
        return { articleCode: a.code, periodKey, qty: 0, cleared: true };
      }
      PLAN.set(planKey(a.id, periodKey), qty);
      return { articleCode: a.code, periodKey, qty };
    },
  },

  // GET /production-plan/weekly — агрегат активных заказов по ISO-неделе плана вывоза
  {
    method: 'GET',
    match: /^\/production-plan\/weekly$/,
    handler: () => weekly(),
  },

  // POST /production-plan/recalc и GET /production-plan/jobs/:id — в Go не зарегистрированы;
  // форма взята из frontend/src/api/orders.ts (productionApi), экранами не используется
  {
    method: 'POST',
    match: /^\/production-plan\/recalc$/,
    handler: () => ({ jobId: uuid('job', 'recalc', TODAY) }),
  },
  {
    method: 'GET',
    match: /^\/production-plan\/jobs\/[^/]+$/,
    handler: ({ path }) => ({
      status: 'completed',
      result: { jobId: path.split('/')[3], periodKey: TODAY.slice(0, 7), itemsRecalculated: PLAN.size, finishedAt: stamp(TODAY, 4, 12, 40, 311) },
    }),
  },

  // GET /production-plan/:id — этап с заказом, заказчиком и позициями
  {
    method: 'GET',
    match: /^\/production-plan\/(?!shop-floor$|matrix$|weekly$|recalc$)[^/]+$/,
    handler: ({ path }) => {
      const id = path.split('/')[2];
      const s = STAGES.find((x) => x.id === id);
      if (!s) return notFound(`Production stage ${id} not found`);
      const o = ORDER_BY_ID.get(s.orderId)!;
      return {
        ...stageJSON(s),
        order: { ...orderRaw(o), customer: o.customer, orderLines: o.lines.map((l) => lineRaw(l, o)) },
      };
    },
  },

  // POST /production-plan — создать этап (prisma.productionStage.create({data: body}))
  {
    method: 'POST',
    match: /^\/production-plan$/,
    handler: ({ body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const o = ORDER_BY_ID.get(String(b.orderId ?? '')) ?? ORDERS[0];
      const s: Stage = {
        id: uuid('stage', 'new', STAGES.length),
        orderId: o.id,
        orderLineId: asStr(b.orderLineId),
        stageCode: (asStr(b.stageCode) as StageCode | null) ?? 'PRODUCTION',
        routingStage: asStr(b.routingStage) as RoutingStage | null,
        status: ((asStr(b.status) ?? 'NOT_STARTED').toUpperCase() as LineStatus),
        actualWorkers: asNum(b.actualWorkers),
        actualHours: asNum(b.actualHours),
        legacyStageCode: asStr(b.legacyStageCode),
        completedAt: asStr(b.completedAt),
        completedById: asStr(b.completedById),
        defectPhotoUrl: asStr(b.defectPhotoUrl),
      };
      STAGES.push(s);
      return { ...stageJSON(s), order: orderRaw(o) };
    },
  },

  // PATCH /production-plan/:id/status {status} — только статус, без заказа
  {
    method: 'PATCH',
    match: /^\/production-plan\/[^/]+\/status$/,
    handler: ({ path, body }) => {
      const id = path.split('/')[2];
      const s = STAGES.find((x) => x.id === id);
      if (!s) return notFound(`Stage ${id} not found`);
      const b = (body ?? {}) as { status?: unknown };
      const next = String(b.status ?? '').toUpperCase();
      if (next === 'NOT_STARTED' || next === 'IN_PROGRESS' || next === 'DONE') s.status = next;
      return stageJSON(s);
    },
  },

  // GET /work-centers — участки со ставками (активные, по коду)
  {
    method: 'GET',
    match: /^\/work-centers$/,
    handler: () => WORK_CENTERS,
  },
];
