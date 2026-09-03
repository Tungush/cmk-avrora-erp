import type { FixtureRoute } from './types';

/**
 * Фикстуры модуля «Продажи» (воронка / прогноз спроса) для режима дизайна (03.09.2026).
 *
 * Форма ответов повторяет Go-обработчик backend-go/internal/modules/sales/deals.go:
 *   GET    /deals?source=&status=&page=&pageSize=  — {data, meta:{page,pageSize,total}}, pageSize по умолчанию 50,
 *                                                    ORDER BY shipment_date DESC (Postgres: NULLS FIRST — прогнозы
 *                                                    без даты сверху), amount_ordered DESC
 *   POST   /deals                                   — 201, сделка с включениями customer / article / manager
 *   PATCH  /deals/:id                               — сделка с включениями
 *   PATCH  /deals/:id/status                        — сделка БЕЗ включений (dealJSON)
 *   DELETE /deals/:id                               — {ok:true}
 *
 * Сериализация Go: decimal.Decimal → строка без хвостовых нулей ("3918000", "1.5");
 * common.PDate → "2026-08-25T00:00:00.000Z" или null. customer / article — полные записи
 * models.Customer / models.Article; manager — всегда null: именных учёток не заводим
 * (решение 24.08.2026), кто ведёт — текстом в managerName.
 * shipment_date — колонка date (@db.Date): в ответе всегда полночь UTC, время отбрасывается.
 * Ошибки — конверт common.APIError: {error:{code, message, details:null}}.
 *
 * Контрагенты (/customers) здесь не дублируются — они живут в orders.ts.
 * Данные — лист Excel «Планируемое без заявок» (396 строк, ≈₸415 млн): прогноз спроса
 * телекома до формальной заявки в 1С плюс «Другие проекты» (металлоконструкции),
 * размноженный детерминированным генератором от 2026-09-03. Без Math.random и Date.now.
 */

// ───────────────────────────── время и генератор ─────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
/** «Сегодня» режима дизайна — 2026-09-03 00:00 UTC */
const TODAY = Date.UTC(2026, 8, 3);

const iso = (ms: number): string => new Date(ms).toISOString();
/** Полночь UTC через offset дней от «сегодня» — как date-колонка shipment_date */
const dayMs = (offsetDays: number): number => TODAY + Math.round(offsetDays) * DAY;

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

const rnd = mulberry32(20260903 ^ 0x5a1e5);
const int = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
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

/** UUID v4-подобный, стабильный между перезагрузками (свой генератор, отдельный seed от orders.ts) */
const idRng = mulberry32(0x5eed5a1e);
function uuid(): string {
  const hex = () => Math.floor(idRng() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${(8 + Math.floor(idRng() * 4)).toString(16)}${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

/** decimal.Decimal → JSON-строка без хвостовых нулей ("6371072.1") */
const dec = (n: number): string => String(Math.round(n * 1000) / 1000);
/** numeric(12,2)/(14,2) (deals.qty_*, amount_*, цены изделий): Postgres хранит 2 знака, Go отдаёт без хвостовых нулей */
const dec2 = (n: number): string => String(Math.round(n * 100) / 100);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** period_key вида «2026-W36» — ISO-неделя даты отгрузки */
function isoWeek(ms: number): string {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'] as const;
const monthName = (ms: number): string => MONTHS[new Date(ms).getUTCMonth()];

/**
 * Аналог dlCode() из deals.go: код для контрагента/изделия, заведённого «с колёс»
 * по имени. В Go это sha1 → "DL-" + 10 hex; здесь FNV-1a + murmur-подобный хвост —
 * тоже стабильно по имени, без async crypto.
 */
function dlCode(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let g = 0x9747b28c;
  for (let i = name.length - 1; i >= 0; i--) {
    g ^= name.charCodeAt(i);
    g = Math.imul(g, 0x5bd1e995) >>> 0;
  }
  return 'DL-' + (h.toString(16).padStart(8, '0') + g.toString(16).padStart(8, '0')).slice(0, 10).toUpperCase();
}

// ───────────────────────────── справочники ─────────────────────────────

interface Customer { id: string; name: string; binIin: string; region: string | null; customerType: 'INSIDE' | 'OUTSIDE' }

/** Заказчики прогноза: телеком (операторы и башенные компании) и «другие проекты». БИН — реальные, как в orders.ts */
const TELECOM_CUSTOMERS: ReadonlyArray<{ name: string; bin: string; type: 'INSIDE' | 'OUTSIDE'; w: number }> = [
  { name: 'КаР-Тел, ТОО', bin: '990140000593', type: 'OUTSIDE', w: 34 },
  { name: 'Казахтелеком, АО', bin: '941240000193', type: 'OUTSIDE', w: 22 },
  { name: 'Kazakhstan Tower Company (Казахстан Тауэр Компани), ТОО', bin: '190240015482', type: 'OUTSIDE', w: 18 },
  { name: 'Аврора Сервис, ТОО', bin: '080840010555', type: 'INSIDE', w: 12 },
  { name: 'Аврора 75, ТОО', bin: '210940010392', type: 'INSIDE', w: 9 },
  { name: 'Компании Холдинга АВХ', bin: '100940005678', type: 'INSIDE', w: 5 },
];

const OTHER_CUSTOMERS: ReadonlyArray<{ name: string; bin: string; type: 'INSIDE' | 'OUTSIDE'; w: number }> = [
  { name: 'LVE Group, ТОО', bin: '191140005579', type: 'INSIDE', w: 16 },
  { name: 'IDA INTERTASCO JV, ТОО', bin: '060340010781', type: 'OUTSIDE', w: 11 },
  { name: 'Greystone Construction, ТОО', bin: '120440014424', type: 'OUTSIDE', w: 9 },
  { name: 'КазДаму Invest', bin: '150340008216', type: 'OUTSIDE', w: 8 },
  { name: 'НУР АСТАНА КУРЫЛЫС ТОО', bin: '070240004731', type: 'OUTSIDE', w: 6 },
  { name: 'BI URBAN CONSTRUCTION, ТОО', bin: '050440003532', type: 'OUTSIDE', w: 5 },
  { name: 'Дельта Казстрой, ТОО', bin: '220240027437', type: 'OUTSIDE', w: 4 },
  { name: 'ТОО «GravIX Urban»', bin: '230940021178', type: 'OUTSIDE', w: 4 },
  { name: 'Qonay Stroy, ТОО', bin: '250540002004', type: 'OUTSIDE', w: 3 },
  { name: 'M2 Solutions, ТОО', bin: '160640018104', type: 'OUTSIDE', w: 3 },
  { name: 'Central Build, ТОО', bin: '061040017809', type: 'OUTSIDE', w: 2 },
  { name: 'Focus Logistics', bin: '230340008736', type: 'OUTSIDE', w: 2 },
  { name: 'AVRORA ELECTRIC, ТОО', bin: '100240000832', type: 'INSIDE', w: 2 },
];

const CUSTOMERS: Customer[] = [...TELECOM_CUSTOMERS, ...OTHER_CUSTOMERS].map((s) => ({
  id: uuid(), name: s.name, binIin: s.bin, region: null, customerType: s.type,
}));
const customerByName = (name: string): Customer | undefined => CUSTOMERS.find((c) => c.name === name);
const TELECOM_POOL = TELECOM_CUSTOMERS.map((s) => ({ c: customerByName(s.name)!, w: s.w }));
const OTHER_POOL = OTHER_CUSTOMERS.map((s) => ({ c: customerByName(s.name)!, w: s.w }));

/** models.Customer */
const customerJSON = (c: Customer) => ({
  id: c.id, name: c.name, binIin: c.binIin, region: c.region, customerType: c.customerType,
});

interface Article {
  id: string; articleCode: string; name: string; unit: string; price: number; weightKg: number;
  isMaterialResale: boolean; leadTimeDays: number; series: string | null;
  /** У заведённых «с колёс» (resolveArticle) — сегодня; у справочных — константы ниже */
  createdAt?: string; updatedAt?: string;
}
interface ArticleSeed { code: string; name: string; unit?: string; price: number; weight: number; lead?: number; series?: string }

/** Изделия ЦМК (артикул, цена по прайсу без НДС, вес т) — те же, что в orders.ts */
const ARTICLE_SEEDS: readonly ArticleSeed[] = [
  { code: 'm-035', name: 'Мачта М25м на пространственной раме (секция 2м) в сборе', price: 3918000, weight: 2.84, lead: 21, series: 'Мачты' },
  { code: 'm-040', name: 'Мачта М20 на пространственной раме (секция 2м) в сборе', price: 3120000, weight: 2.31, lead: 18, series: 'Мачты' },
  { code: 'm-073', name: 'Мачта М25м на пространственной раме (секция 2м) рама в сборе ГЦ', price: 5068000, weight: 2.9, lead: 28, series: 'Мачты' },
  { code: 'm-018', name: 'Мачта М18м на пространственной раме (секция 2м) в сборе', price: 2760000, weight: 2.05, lead: 18, series: 'Мачты' },
  { code: 'b-016', name: 'Контейнер технологический - Шелтор 0123 (2х2)', price: 1298000, weight: 1.15, lead: 14, series: 'Шелторы' },
  { code: 'b-017', name: 'Контейнер технологический - Шелтор 0123 (1х2)', price: 907250, weight: 0.72, lead: 12, series: 'Шелторы' },
  { code: 'b-015', name: 'Контейнер технологический - Шелтор 0123 (3х2)', price: 1453500, weight: 1.57, lead: 16, series: 'Шелторы' },
  { code: 'b-007', name: 'Лестница с площадкой для Шелтора 0321', price: 75895, weight: 0.072 },
  { code: 'a-013', name: 'Секция ограждения 2500х1820мм (сетка рабица)', price: 42600, weight: 0.031, series: 'Ограждения' },
  { code: 'a-014', name: 'Секция ограждения 2500х1520мм (сетка рабица)', price: 39000, weight: 0.027, series: 'Ограждения' },
  { code: 'a-011', name: 'Стойка ограждения ф76 мм 3400 мм', price: 16500, weight: 0.023, series: 'Ограждения' },
  { code: 'a-018', name: 'Секция ограждения 2000х900мм (сетка рабица) калитка', price: 34800, weight: 0.025, series: 'Ограждения' },
  { code: 'a-001', name: 'Антивандальное ограждение Outdoor 1400х1300х2350', price: 357930, weight: 0.346, lead: 7, series: 'Ограждения' },
  { code: 'n-628', name: 'Антивандальное ограждение Outdoor 1300х1120х2530', price: 387500, weight: 0.36, lead: 7, series: 'Ограждения' },
  { code: 'a-005', name: 'Ограждение 6000х4400мм (сетка рабица)', price: 700000, weight: 0.6, lead: 10, series: 'Ограждения' },
  { code: 'n-019', name: 'Кабельный мост 2,0м (без трубостойки)', price: 50100, weight: 0.046 },
  { code: 'k-010', name: 'Кабельный мост 1м', price: 41680, weight: 0.043 },
  { code: 'k-019', name: 'Трубостойка ф76 L3000 mm', price: 14700, weight: 0.02 },
  { code: 'k-018', name: 'Трубостойка ф102 L3000 mm', price: 19210, weight: 0.032 },
  { code: 'z-901', name: 'Металлоконструкции каркаса (балки, колонны, связи)', unit: 'тонн', price: 640000, weight: 1, lead: 30 },
  { code: 'z-902', name: 'Фермы покрытия пролёт 18 м', unit: 'тонн', price: 690000, weight: 1, lead: 30 },
  { code: 'z-388', name: 'Навес над входом 6х3 м (профнастил)', price: 1240000, weight: 0.95, lead: 14 },
  { code: 'z-412', name: 'Лестничный марш ЛМ-1 с ограждением', price: 486000, weight: 0.38, lead: 10 },
  { code: 'z-535', name: 'Мангальная зона', price: 714000, weight: 0.42, lead: 12 },
];

const ARTICLES: Article[] = ARTICLE_SEEDS.map((s) => ({
  id: uuid(), articleCode: s.code, name: s.name, unit: s.unit ?? 'шт', price: s.price, weightKg: s.weight,
  isMaterialResale: false, leadTimeDays: s.lead ?? 0, series: s.series ?? null,
}));
const byCode = (code: string): Article => ARTICLES.find((a) => a.articleCode === code)!;

const ARTICLE_CREATED = iso(Date.UTC(2026, 7, 18, 9, 12, 44));
const ARTICLE_UPDATED = iso(Date.UTC(2026, 8, 1, 14, 3, 5));

/** models.Article — все decimal как строки, PDate как ISO */
const articleJSON = (a: Article) => ({
  id: a.id, articleCode: a.articleCode, legacyCode: null, name: a.name, weightKg: dec(a.weightKg),
  series: a.series, description: null, approvedPrice: dec2(a.price), isMaterialResale: a.isMaterialResale,
  specPrice: dec2(a.isMaterialResale ? 0 : a.price * 0.63), priceDeviationPct: dec(0),
  leadTimeDays: dec2(a.leadTimeDays), palletCapacity: dec2(0), isActive: true,
  createdAt: a.createdAt ?? ARTICLE_CREATED, updatedAt: a.updatedAt ?? ARTICLE_UPDATED,
});

/** Объекты телекома: код сайта + регион (как в листе «Планируемое без заявок») */
const TELECOM_SITES: ReadonlyArray<{ site: string; region: string; w: number }> = [
  { site: 'ALM_Dala', region: 'Алматинская область', w: 6 },
  { site: 'KZ-ALM_Dudar', region: 'Алматинская область', w: 4 },
  { site: 'KZ-ALM_Egentower', region: 'Алматы', w: 3 },
  { site: 'KZ-ALM_HIGHTECH', region: 'Алматы', w: 2 },
  { site: 'KZ-ALM_KOSHKEN', region: 'Алматинская область', w: 2 },
  { site: 'KZ-ALM_Karum(NEW349)', region: 'Алматы', w: 3 },
  { site: 'KZ-ALM_Khanzada(NEW301)', region: 'Алматы', w: 2 },
  { site: 'KZ-ALM_Kommutator', region: 'Алматы', w: 2 },
  { site: 'KZ-ALM_Koskumbez', region: 'Алматинская область', w: 1 },
  { site: 'KZ-ALM_Magnum7', region: 'Алматы', w: 1 },
  { site: 'KZ-ALM_Ungurtas', region: 'Алматинская область', w: 1 },
  { site: 'KZ-ALM_Khairam', region: 'Алматинская область', w: 1 },
  { site: 'KZ-EKB_Hill', region: 'Восточно-Казахстанская область', w: 3 },
  { site: 'KZ-EKB_Belagash', region: 'Восточно-Казахстанская область', w: 2 },
  { site: 'KZ-OSK_Hunter', region: 'Восточно-Казахстанская область', w: 2 },
  { site: 'KZ-KOS_Volodar', region: 'Костанайская область', w: 2 },
  { site: 'KZ-KZL_Uchebka', region: 'Кызылординская область', w: 2 },
  { site: 'KZL_Sits', region: 'Кызылординская область', w: 1 },
  { site: 'KZL_Agro-two', region: 'Кызылординская область', w: 1 },
  { site: 'KZ-TLD_BASKUNSHI', region: 'Жетысуская область', w: 1 },
  { site: 'KZ-TLD_ESEBULATOV', region: 'Жетысуская область', w: 1 },
  { site: 'SEM_Mirnyi', region: 'Абайская область', w: 2 },
  { site: 'SEM_Galeto', region: 'Абайская область', w: 1 },
  { site: 'AKT_QAZCEMENT', region: 'Актюбинская область', w: 2 },
  { site: 'AKT_Kandyagash-2', region: 'Актюбинская область', w: 1 },
  { site: 'ALM_Camry', region: 'Алматы', w: 1 },
  { site: 'PVL_Ekibastuz-3', region: 'Павлодарская область', w: 2 },
  { site: 'PVL_Aksu-Sever', region: 'Павлодарская область', w: 1 },
  { site: 'KRG_Temirtau-Sever', region: 'Карагандинская область', w: 2 },
  { site: 'KRG_Saran', region: 'Карагандинская область', w: 1 },
  { site: 'AST_Koyandy', region: 'Акмолинская область', w: 2 },
  { site: 'AST_Kosshy-2', region: 'Акмолинская область', w: 1 },
  { site: 'SHM_Saryagash', region: 'Туркестанская область', w: 2 },
  { site: 'SHM_Kentau', region: 'Туркестанская область', w: 1 },
  { site: 'ATR_Kulsary', region: 'Атырауская область', w: 1 },
  { site: 'UK7062', region: 'Западно-Казахстанская область', w: 1 },
  { site: 'MNG_Zhanaozen', region: 'Мангистауская область', w: 1 },
];

/** «Другие проекты»: объект может быть не назван (null) */
const OTHER_SITES: ReadonlyArray<{ site: string | null; region: string | null; w: number }> = [
  { site: null, region: null, w: 14 },
  { site: 'KZ-Металлоконструкция', region: 'Алматы', w: 10 },
  { site: 'KZ-0237-ЦМК-1', region: 'Алматы', w: 6 },
  { site: 'KZ-0237-ЦМК-2', region: 'Алматы', w: 2 },
  { site: 'А+ Бизнес парк', region: 'Алматы', w: 2 },
  { site: 'Театр им. М.Ауэзова', region: 'Алматы', w: 1 },
  { site: 'ЖК Nova City', region: 'Астана', w: 2 },
  { site: 'Склад Focus Logistics', region: 'Алматинская область', w: 1 },
  { site: 'Цех №2 Темиртау', region: 'Карагандинская область', w: 1 },
  { site: 'ТРЦ Shymkent Plaza', region: 'Шымкент', w: 1 },
];

/** Кто ведёт сделку — текстом (Pipeline: колонка «Ведёт») */
const MANAGERS: ReadonlyArray<{ name: string | null; w: number }> = [
  { name: 'Акерке', w: 38 },
  { name: 'Гүлнұр', w: 24 },
  { name: 'Азамат', w: 14 },
  { name: 'Санат', w: 9 },
  { name: 'Айнура', w: 6 },
  { name: null, w: 5 },
];

/** Статусы deals.status (varchar(30)): «прогноз» — по умолчанию у Create, «отгружено» — каскад в ГП */
const STATUSES: ReadonlyArray<{ s: string; w: number }> = [
  { s: 'прогноз', w: 54 },
  { s: 'в работе', w: 26 },
  { s: 'отгружено', w: 15 },
  { s: 'закрыт', w: 5 },
];

const MAST_CODES = ['m-035', 'm-040', 'm-018', 'm-073'] as const;
const SHELTER_CODES = ['b-016', 'b-017', 'b-015'] as const;
const FENCE_CODES = ['a-013', 'a-014', 'a-011', 'a-018', 'a-001', 'n-628'] as const;
const SMALL_CODES = ['n-019', 'k-010', 'k-019', 'k-018', 'b-007'] as const;
const OTHER_CODES = ['z-901', 'z-902', 'z-388', 'z-412', 'z-535', 'a-005'] as const;

// ───────────────────────────── сделки ─────────────────────────────

interface Deal {
  id: string;
  source: string;
  customer: Customer;
  article: Article | null;
  qtyOrdered: number;
  qtyShipped: number;
  amountOrdered: number;
  amountPaid: number;
  status: string;
  periodKey: string | null;
  /** ISO-строка полуночи UTC или null (PDate) */
  shipmentDate: string | null;
  siteCode: string | null;
  region: string | null;
  managerName: string | null;
  plannedDispatchMonth: string | null;
  hasFormalRequest: boolean;
}

/** НДС 12 % — суммы в прогнозе «с НДС» (форма Pipeline: «Сумма с НДС») */
const VAT = 1.12;

function makeDeal(): Deal {
  const telecom = chance(0.8);
  const source = telecom ? 'Telecom' : 'Other';
  const customer = weighted(telecom ? TELECOM_POOL : OTHER_POOL).c;

  // Изделие и количество
  let article: Article | null = null;
  let qty = 1;
  let unitPrice = 0;
  if (telecom) {
    const r = rnd();
    if (r < 0.12) { article = byCode(pick(MAST_CODES)); qty = weighted([{ q: 1, w: 76 }, { q: 2, w: 18 }, { q: 3, w: 5 }, { q: 4, w: 1 }]).q; }
    else if (r < 0.24) { article = byCode(pick(SHELTER_CODES)); qty = weighted([{ q: 1, w: 70 }, { q: 2, w: 25 }, { q: 3, w: 5 }]).q; }
    else if (r < 0.56) { article = byCode(pick(FENCE_CODES)); qty = article.price > 300000 ? int(1, 2) : int(4, 36); }
    else if (r < 0.88) { article = byCode(pick(SMALL_CODES)); qty = int(4, 40); }
    else { article = null; qty = int(1, 2); unitPrice = int(35, 180) * 10000; }
  } else {
    const r = rnd();
    if (r < 0.82) {
      article = byCode(pick(OTHER_CODES));
      qty = article.unit === 'тонн' ? int(3, 18) / 2 : int(1, 2);
    } else { article = null; qty = int(1, 2); unitPrice = int(60, 240) * 10000; }
  }
  if (article) unitPrice = article.price;
  const amountOrdered = round2(qty * unitPrice * VAT);

  // Объект и регион
  let siteCode: string | null;
  let region: string | null;
  if (telecom) {
    const s = weighted(TELECOM_SITES);
    siteCode = s.site;
    region = s.region;
    if (chance(0.08)) siteCode = null;
  } else {
    const s = weighted(OTHER_SITES);
    siteCode = s.site;
    region = s.region;
  }

  // Статус, даты, оплата
  const status = weighted(STATUSES).s;
  let shipmentDate: string | null = null;
  let plannedDispatchMonth: string | null = null;
  let hasFormalRequest = false;
  let qtyShipped = 0;
  let amountPaid = 0;
  switch (status) {
    case 'прогноз': {
      hasFormalRequest = chance(0.12);
      plannedDispatchMonth = chance(0.78) ? weighted([
        { m: 'сентябрь', w: 30 }, { m: 'октябрь', w: 28 }, { m: 'ноябрь', w: 18 }, { m: 'декабрь', w: 12 }, { m: 'январь', w: 5 }, { m: 'февраль', w: 3 },
      ]).m : null;
      if (chance(0.15)) shipmentDate = iso(dayMs(int(12, 95)));
      break;
    }
    case 'в работе': {
      hasFormalRequest = chance(0.72);
      const ms = dayMs(int(3, 60));
      shipmentDate = chance(0.7) ? iso(ms) : null;
      plannedDispatchMonth = chance(0.9) ? monthName(ms) : null;
      if (chance(0.45)) amountPaid = round2(amountOrdered * pick([0.3, 0.5, 0.5, 0.7]));
      break;
    }
    case 'отгружено': {
      hasFormalRequest = chance(0.9);
      const ms = dayMs(-int(1, 90));
      shipmentDate = iso(ms);
      plannedDispatchMonth = monthName(ms);
      qtyShipped = qty;
      amountPaid = chance(0.65) ? amountOrdered : round2(amountOrdered * pick([0.5, 0.7]));
      break;
    }
    default: { // закрыт
      hasFormalRequest = true;
      const ms = dayMs(-int(60, 240));
      shipmentDate = iso(ms);
      plannedDispatchMonth = monthName(ms);
      qtyShipped = qty;
      amountPaid = amountOrdered;
    }
  }
  const periodKey = shipmentDate ? isoWeek(Date.parse(shipmentDate)) : null;

  return {
    id: uuid(), source, customer, article, qtyOrdered: qty, qtyShipped, amountOrdered, amountPaid, status,
    periodKey, shipmentDate, siteCode, region, managerName: weighted(MANAGERS).name, plannedDispatchMonth, hasFormalRequest,
  };
}

/** 396 строк — как в листе «Планируемое без заявок» */
const DEALS: Deal[] = Array.from({ length: 396 }, makeDeal);

/** ORDER BY shipment_date DESC (NULLS FIRST), amount_ordered DESC — как в FindAll */
function sorted(rows: Deal[]): Deal[] {
  return [...rows].sort((a, b) => {
    if (a.shipmentDate !== b.shipmentDate) {
      if (a.shipmentDate === null) return -1;
      if (b.shipmentDate === null) return 1;
      return a.shipmentDate < b.shipmentDate ? 1 : -1;
    }
    return b.amountOrdered - a.amountOrdered;
  });
}

const dealById = (id: string): Deal | undefined => DEALS.find((d) => d.id === id);

/** models.Deal через json.Marshal — без включений (ответ PATCH /deals/:id/status) */
function dealJSON(d: Deal): Record<string, unknown> {
  return {
    id: d.id,
    source: d.source,
    customerId: d.customer.id,
    articleId: d.article ? d.article.id : null,
    managerId: null,
    qtyOrdered: dec2(d.qtyOrdered),
    qtyShipped: dec2(d.qtyShipped),
    amountOrdered: dec2(d.amountOrdered),
    amountPaid: dec2(d.amountPaid),
    status: d.status,
    periodKey: d.periodKey,
    shipmentDate: d.shipmentDate,
    siteCode: d.siteCode,
    region: d.region,
    managerName: d.managerName,
    plannedDispatchMonth: d.plannedDispatchMonth,
    hasFormalRequest: d.hasFormalRequest,
  };
}

/** withIncludes: + customer / article / manager (manager всегда null — учёток нет) */
function dealFull(d: Deal): Record<string, unknown> {
  return {
    ...dealJSON(d),
    customer: customerJSON(d.customer),
    article: d.article ? articleJSON(d.article) : null,
    manager: null,
  };
}

// ───────────────────────────── разбор тела (как в deals.go) ─────────────────────────────

type Body = Record<string, unknown>;

/** str(): nil → "", float → без хвоста, остальное — fmt.Sprint */
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
/** truthy(): nil/false/0/"" → false */
const truthy = (v: unknown): boolean => !(v === null || v === undefined || v === false || v === 0 || v === '');
/** num(): число, строка-число, bool → float64 */
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v) || 0; // strconv.ParseFloat: «12abc» → ошибка → 0
  if (v === true) return 1;
  return 0;
}
const optStr = (v: unknown): string | null => (truthy(v) ? str(v) : null);
/**
 * parseDate(): RFC3339 / "2006-01-02T15:04:05" / "2006-01-02" → UTC; иначе null.
 * shipment_date — колонка date (@db.Date): Go пишет t.UTC(), Postgres оставляет только
 * дату, обратно читается полночь UTC — поэтому время здесь отбрасывается.
 */
function parseDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s) ? `${s}Z` : s);
  return Number.isNaN(ms) ? null : iso(Math.floor(ms / DAY) * DAY);
}

/** common.APIError — конверт {error:{code,message,details}}; у Fail() details всегда null */
interface ApiFail { error: { code: string; message: string; details: null } }
const fail = (code: string, message: string): ApiFail => ({ error: { code, message, details: null } });
const notFound = (msg: string) => fail('NOT_FOUND', msg);
const dbError = () => fail('INTERNAL_SERVER_ERROR', 'Ошибка базы данных');

/** strconv.Atoi: не целое → 0 */
const atoi = (s: string | null): number => (s !== null && /^[+-]?\d+$/.test(s) ? Number(s) : 0);
/** Как в FindAll: page < 1 → 1, pageSize < 1 → 50 */
function paginate<T>(rows: T[], params: URLSearchParams, defaultSize: number) {
  let page = atoi(params.get('page'));
  if (page < 1) page = 1;
  let pageSize = atoi(params.get('pageSize'));
  if (pageSize < 1) pageSize = defaultSize;
  return { page, pageSize, slice: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
}

/** resolveCustomer: customerId → по id; иначе customerName → найти по имени без регистра или завести (БИН = dlCode) */
function resolveCustomer(b: Body): Customer | ApiFail {
  if (truthy(b.customerId)) {
    const c = CUSTOMERS.find((x) => x.id === str(b.customerId));
    return c ?? dbError();
  }
  const name = str(b.customerName).trim();
  if (!name) return fail('INVALID_INPUT', 'Нужен заказчик: customerId или customerName');
  const found = CUSTOMERS.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  const c: Customer = { id: uuid(), name, binIin: dlCode(name), region: null, customerType: 'OUTSIDE' };
  CUSTOMERS.push(c);
  return c;
}

/** resolveArticle: articleId → по id; articleName → найти или завести (код = dlCode); пусто → null */
function resolveArticle(b: Body): Article | null | ApiFail {
  if (truthy(b.articleId)) {
    const a = ARTICLES.find((x) => x.id === str(b.articleId));
    return a ?? dbError();
  }
  const name = str(b.articleName).trim();
  if (!name) return null;
  const found = ARTICLES.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  const a: Article = {
    id: uuid(), articleCode: dlCode(name), name, unit: 'шт', price: 0, weightKg: 0,
    isMaterialResale: false, leadTimeDays: 0, series: null,
    createdAt: iso(TODAY), updatedAt: iso(TODAY), // INSERT … updated_at = now(), created_at по умолчанию
  };
  ARTICLES.push(a);
  return a;
}

const isErr = (v: unknown): v is ApiFail =>
  typeof v === 'object' && v !== null && 'error' in v;

const idFromPath = (path: string): string => path.split('/')[2] ?? '';

// ───────────────────────────── маршруты ─────────────────────────────

export const routes: FixtureRoute[] = [
  // ── GET /deals?source=&status=&page=&pageSize= ──
  {
    method: 'GET', match: /^\/deals$/,
    handler: ({ params }) => {
      const source = params.get('source') ?? '';
      const status = params.get('status') ?? '';
      let rows = sorted(DEALS);
      if (source) rows = rows.filter((d) => d.source === source);
      if (status) rows = rows.filter((d) => d.status === status);
      const { page, pageSize, slice, total } = paginate(rows, params, 50);
      return { data: slice.map(dealFull), meta: { page, pageSize, total } };
    },
  },

  // ── POST /deals ──
  {
    method: 'POST', match: /^\/deals$/,
    handler: ({ body }) => {
      const b = (body ?? {}) as Body;
      const customer = resolveCustomer(b);
      if (isErr(customer)) return customer;
      const article = resolveArticle(b);
      if (isErr(article)) return article;
      const d: Deal = {
        id: uuid(),
        source: truthy(b.source) ? str(b.source) : 'Telecom',
        customer,
        article,
        qtyOrdered: num(b.qtyOrdered),
        qtyShipped: num(b.qtyShipped),
        amountOrdered: num(b.amountOrdered),
        amountPaid: num(b.amountPaid),
        status: truthy(b.status) ? str(b.status) : 'прогноз',
        periodKey: optStr(b.periodKey),
        shipmentDate: parseDate(b.shipmentDate),
        siteCode: optStr(b.siteCode),
        region: optStr(b.region),
        managerName: optStr(b.managerName),
        plannedDispatchMonth: optStr(b.plannedDispatchMonth),
        hasFormalRequest: truthy(b.hasFormalRequest),
      };
      DEALS.push(d);
      return dealFull(d);
    },
  },

  // ── PATCH /deals/:id/status — раньше общего PATCH /deals/:id ──
  {
    method: 'PATCH', match: /^\/deals\/[^/]+\/status$/,
    handler: ({ path, body }) => {
      const id = idFromPath(path);
      const d = dealById(id);
      if (!d) return notFound(`Deal ${id} not found`);
      const b = (body ?? {}) as { status?: string; shipmentDate?: string | null; amountPaid?: number | null; qtyShipped?: number | null };
      const nextQty = b.qtyShipped !== null && b.qtyShipped !== undefined ? b.qtyShipped : d.qtyOrdered;
      let nextDate: string = iso(TODAY);
      if (b.shipmentDate) {
        nextDate = parseDate(b.shipmentDate) ?? nextDate;
      } else if (d.shipmentDate) {
        nextDate = d.shipmentDate;
      }
      d.status = str(b.status);
      d.shipmentDate = nextDate;
      d.qtyShipped = nextQty;
      if (b.amountPaid !== null && b.amountPaid !== undefined) d.amountPaid = b.amountPaid;
      // В Go при «отгружено» ещё пишется расход ГП (finished_goods_movements) и audit_log — здесь без побочных эффектов
      return dealJSON(d);
    },
  },

  // ── PATCH /deals/:id ──
  {
    method: 'PATCH', match: /^\/deals\/[^/]+$/,
    handler: ({ path, body }) => {
      const id = idFromPath(path);
      const d = dealById(id);
      if (!d) return notFound(`Deal ${id} not found`);
      const b = (body ?? {}) as Body;
      // Один UPDATE: source/customer_id NOT NULL, customer_id/article_id — FK. Нарушение → 500, ничего не меняется
      const nextSource = 'source' in b ? optStr(b.source) : d.source;
      const nextCustomer = 'customerId' in b ? CUSTOMERS.find((x) => x.id === optStr(b.customerId)) : d.customer;
      const nextArticle = 'articleId' in b ? (truthy(b.articleId) ? ARTICLES.find((x) => x.id === str(b.articleId)) : null) : d.article;
      if (nextSource === null || !nextCustomer || nextArticle === undefined) return dbError();
      d.source = nextSource;
      d.customer = nextCustomer;
      d.article = nextArticle;
      if ('siteCode' in b) d.siteCode = optStr(b.siteCode);
      if ('region' in b) d.region = optStr(b.region);
      if ('managerName' in b) d.managerName = optStr(b.managerName);
      if ('plannedDispatchMonth' in b) d.plannedDispatchMonth = optStr(b.plannedDispatchMonth);
      if ('periodKey' in b) d.periodKey = optStr(b.periodKey);
      if ('qtyOrdered' in b) d.qtyOrdered = num(b.qtyOrdered);
      if ('qtyShipped' in b) d.qtyShipped = num(b.qtyShipped);
      if ('amountOrdered' in b) d.amountOrdered = num(b.amountOrdered);
      if ('amountPaid' in b) d.amountPaid = num(b.amountPaid);
      if ('hasFormalRequest' in b) d.hasFormalRequest = truthy(b.hasFormalRequest);
      if ('shipmentDate' in b) d.shipmentDate = parseDate(b.shipmentDate);
      return dealFull(d);
    },
  },

  // ── DELETE /deals/:id ──
  {
    method: 'DELETE', match: /^\/deals\/[^/]+$/,
    handler: ({ path }) => {
      const id = idFromPath(path);
      const i = DEALS.findIndex((d) => d.id === id);
      // В Go несуществующий id → 500 «Ошибка базы данных» (наследие P2025)
      if (i < 0) return dbError();
      DEALS.splice(i, 1);
      return { ok: true };
    },
  },
];
