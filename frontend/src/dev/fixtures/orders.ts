import type { FixtureRoute } from './types';

/**
 * Фикстуры модуля «Заказы» для режима дизайна (03.09.2026).
 *
 * Форма ответов повторяет Go-обработчики байт-в-байт:
 *   backend-go/internal/modules/orders/orders.go          — список, инбокс, карточка, этапы, PATCH
 *   backend-go/internal/modules/orders/sites.go           — объекты (базовые станции)
 *   backend-go/internal/modules/orders/orders_dashboard.go — дашборд заказов
 *   backend-go/internal/modules/catalog/customers.go      — контрагенты
 *   backend-go/internal/modules/finance/customer_payments.go — оплаты заказчика
 *   backend-go/internal/warehouse/service.go              — обеспеченность сырьём
 *
 * Правила сериализации Go, которые здесь воспроизведены:
 *   • decimal.Decimal → строка без хвостовых нулей: "6371072.1", "0.003";
 *   • common.PDate    → "2026-08-25T00:00:00.000Z" или null;
 *   • float64          → число (дашборд, оплаты, обеспеченность);
 *   • findAll вырезает КЛЮЧ rawColumns у заказа и у каждой позиции,
 *     inbox и findOne — оставляют (режим дизайна = admin, права есть).
 *
 * Данные — выборка из реальной базы ЦМК Аврора (заказчики, БИН, изделия,
 * площадки, менеджеры из 1С), размноженная детерминированным генератором:
 * 384 заказа, ~2150 позиций, ~35 площадок. Без Math.random и Date.now —
 * всё считается от 2026-09-03.
 */

// ───────────────────────────── время и генератор ─────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
/** «Сегодня» режима дизайна — 2026-09-03 00:00 UTC */
const TODAY = Date.UTC(2026, 8, 3);

const iso = (ms: number): string => new Date(ms).toISOString();
/** Полночь UTC через offset дней от «сегодня» — как date-колонки 1С */
const dayISO = (offsetDays: number): string => iso(TODAY + Math.round(offsetDays) * DAY);
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

const rnd = mulberry32(20260903);
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

/** UUID v4-подобный, стабильный между перезагрузками (свой генератор) */
const idRng = mulberry32(0x5eed1);
function uuid(): string {
  const hex = () => Math.floor(idRng() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${(8 + Math.floor(idRng() * 4)).toString(16)}${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

/** decimal.Decimal → JSON-строка без хвостовых нулей ("6371072.1") */
const dec = (n: number): string => String(Math.round(n * 1000) / 1000);
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ───────────────────────────── справочники ─────────────────────────────

type Kind = 'telecom' | 'metal' | 'retail';

interface CustomerSeed { name: string; bin: string; type: 'INSIDE' | 'OUTSIDE'; w: number; kind: Kind }

/** Реальные контрагенты и БИН из базы; w — доля в потоке заказов */
const CUSTOMER_SEEDS: readonly CustomerSeed[] = [
  { name: 'Аврора Сервис, ТОО', bin: '080840010555', type: 'INSIDE', w: 150, kind: 'telecom' },
  { name: 'Аврора 75, ТОО', bin: '210940010392', type: 'INSIDE', w: 90, kind: 'telecom' },
  { name: 'Казахтелеком, АО', bin: '941240000193', type: 'OUTSIDE', w: 9, kind: 'telecom' },
  { name: 'Kazakhstan Tower Company (Казахстан Тауэр Компани), ТОО', bin: '190240015482', type: 'OUTSIDE', w: 6, kind: 'telecom' },
  { name: 'КаР-Тел, ТОО', bin: '990140000593', type: 'OUTSIDE', w: 4, kind: 'telecom' },
  { name: 'LVE Group, ТОО', bin: '191140005579', type: 'INSIDE', w: 16, kind: 'metal' },
  { name: 'IDA INTERTASCO JV, ТОО', bin: '060340010781', type: 'OUTSIDE', w: 10, kind: 'metal' },
  { name: 'Greystone Construction, ТОО', bin: '120440014424', type: 'OUTSIDE', w: 9, kind: 'metal' },
  { name: 'КазДаму Invest', bin: '150340008216', type: 'OUTSIDE', w: 8, kind: 'metal' },
  { name: 'НУР АСТАНА КУРЫЛЫС ТОО', bin: '070240004731', type: 'OUTSIDE', w: 5, kind: 'metal' },
  { name: 'Физическое лицо Купи-Продай', bin: '', type: 'OUTSIDE', w: 12, kind: 'retail' },
  { name: 'BI URBAN CONSTRUCTION, ТОО', bin: '050440003532', type: 'OUTSIDE', w: 2, kind: 'metal' },
  { name: 'Central Build, ТОО', bin: '061040017809', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'M2 Solutions, ТОО', bin: '160640018104', type: 'OUTSIDE', w: 2, kind: 'metal' },
  { name: 'Qonay Stroy, ТОО', bin: '250540002004', type: 'OUTSIDE', w: 2, kind: 'metal' },
  { name: 'Дельта Казстрой, ТОО', bin: '220240027437', type: 'OUTSIDE', w: 2, kind: 'metal' },
  { name: 'ТОО «GravIX Urban»', bin: '230940021178', type: 'OUTSIDE', w: 2, kind: 'metal' },
  { name: 'PLANING Construction  (ПЛАНИНГ Констракшн), ТОО', bin: '140940023376', type: 'OUTSIDE', w: 2, kind: 'metal' },
  { name: 'Focus Logistics', bin: '230340008736', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'Китайская Компания по строительству и развитию Синьсин в РК, Филиал ТОО', bin: '170741021356', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'ТОО "Densaulyq Life"', bin: '210140026607', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'AVRORA ELECTRIC, ТОО', bin: '100240000832', type: 'INSIDE', w: 3, kind: 'metal' },
  { name: 'Аврора Холдинг, ТОО', bin: '100940005678', type: 'INSIDE', w: 2, kind: 'metal' },
  { name: 'Аврора 77, ТОО', bin: '201040028925', type: 'INSIDE', w: 2, kind: 'metal' },
  { name: 'Avrora Global trade, ТОО', bin: '141140010115', type: 'INSIDE', w: 1, kind: 'metal' },
  { name: 'ANTARES ENGINEERING, ТОО', bin: '090540010873', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'BI Stroy, ТОО', bin: '050240020654', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'BMK Integration Service ТОО', bin: '110440005700', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'Bugel Алматы, ТОО', bin: '170140023500', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'CleanHouse, ТОО', bin: '140440008661', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'E-STOCK, ТОО', bin: '250640031408', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'G-GAS-PRO,ТОО', bin: '111240004242', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'INTERCOM ENGINEERING, ТОО', bin: '100240011459', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'IRON TRADE COMPANY, ТОО', bin: '180840020464', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'JAMBYL TAZALYK, ИП', bin: '601112300255', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'Kazgid IT Technology, ТОО', bin: '230640038223', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'Long Partners, ТОО', bin: '170540006129', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'PromGazProduct, ТОО', bin: '180540030450', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'RESMA.KZ, ТОО', bin: '250640000537', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'SAFA Trade, ТОО', bin: '171040026603', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'SENSATA INVEST GROUP, ТОО', bin: '230140012717', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'Safety construction, ТОО', bin: '201140011964', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'Sinooil, Алматинский филиал ТОО', bin: '090541018646', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'TECHNO POWER, ТОО', bin: '200940016604', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'Toolsmart, ТОО', bin: '130940001363', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'Welding Company TOO', bin: '070940026088', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'Zenith invest, ТОО', bin: '161140027940', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'АМАНАТ К, ТОО', bin: '220340003298', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'АФД-Снаб,ТОО', bin: '240140024564', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: 'Алматерм, ИП', bin: '560820301577', type: 'OUTSIDE', w: 1, kind: 'metal' },
  { name: '"Керемет-07", ТОО', bin: '061040004808', type: 'OUTSIDE', w: 0, kind: 'metal' },
  { name: '220 VOLT, ТОО', bin: '050540006372', type: 'OUTSIDE', w: 0, kind: 'metal' },
  { name: 'AKS KAZAKHSTAN (АКС Казахстан) ТОО', bin: '101040004312', type: 'OUTSIDE', w: 0, kind: 'metal' },
  { name: 'Anirise, ТОО', bin: '160240025519', type: 'OUTSIDE', w: 0, kind: 'metal' },
  { name: 'HEFA STEEL GROUP Co.,LTD', bin: 'C-D39ABDD14F', type: 'OUTSIDE', w: 0, kind: 'metal' },
  { name: 'Optomir, ИП', bin: '930305300765', type: 'OUTSIDE', w: 0, kind: 'metal' },
  { name: 'STROYKA, ИП', bin: '810405302057', type: 'OUTSIDE', w: 0, kind: 'metal' },
  { name: 'Алмаросметиз ИП Парыгин Сергей Петрович', bin: '610320302112', type: 'OUTSIDE', w: 0, kind: 'metal' },
];

interface Customer { id: string; name: string; binIin: string; region: string | null; customerType: 'INSIDE' | 'OUTSIDE'; kind: Kind; w: number }

const CUSTOMERS: Customer[] = CUSTOMER_SEEDS.map((s) => ({
  id: uuid(), name: s.name, binIin: s.bin, region: null, customerType: s.type, kind: s.kind, w: s.w,
}));

const customerJSON = (c: Customer) => ({
  id: c.id, name: c.name, binIin: c.binIin, region: c.region, customerType: c.customerType,
});

interface ArticleSeed { code: string; name: string; unit: string; price: number; weight: number; resale?: boolean; lead?: number; series?: string }

/** Изделия ЦМК из базы (артикул, цена по прайсу, вес т) */
const ARTICLE_SEEDS: readonly ArticleSeed[] = [
  { code: 'm-035', name: 'Мачта М25м на пространственной раме (секция 2м) в сборе', unit: 'шт', price: 3918000, weight: 2.84, lead: 21, series: 'Мачты' },
  { code: 'm-040', name: 'Мачта М20 на пространственной раме (секция 2м) в сборе', unit: 'шт', price: 3120000, weight: 2.31, lead: 18, series: 'Мачты' },
  { code: 'm-073', name: 'Мачта М25м на пространственной раме (секция 2м) рама в сборе ГЦ', unit: 'шт', price: 5068000, weight: 2.9, lead: 28, series: 'Мачты' },
  { code: 'b-016', name: 'Контейнер технологический - Шелтор 0123 (2х2)', unit: 'шт', price: 1298000, weight: 1.15, lead: 14, series: 'Шелторы' },
  { code: 'b-017', name: 'Контейнер технологический - Шелтор 0123 (1х2)', unit: 'шт', price: 907250, weight: 0.72, lead: 12, series: 'Шелторы' },
  { code: 'b-015', name: 'Контейнер технологический - Шелтор 0123 (3х2)', unit: 'шт', price: 1453500, weight: 1.57, lead: 16, series: 'Шелторы' },
  { code: 'b-007', name: 'Лестница с площадкой для Шелтора 0321', unit: 'шт', price: 75895, weight: 0.072 },
  { code: 'b-012', name: 'Полоса заземления 40х4мм, L-2м', unit: 'шт', price: 2000, weight: 0.003 },
  { code: 'b-013', name: 'Шина Т-образная', unit: 'шт', price: 1080, weight: 0.0011 },
  { code: 'n-039', name: 'Очаг заземления уголок 50 2000мм', unit: 'шт', price: 5700, weight: 0.0075 },
  { code: 'k-013', name: 'Молниеприемник приварной', unit: 'шт', price: 2280, weight: 0.002 },
  { code: 'n-019', name: 'Кабельный мост 2,0м (без трубостойки)', unit: 'шт', price: 50100, weight: 0.046 },
  { code: 'k-010', name: 'Кабельный мост 1м', unit: 'шт', price: 41680, weight: 0.043 },
  { code: 'k-028', name: 'Швеллерная балка L500 mm под трубу Ф76-76', unit: 'шт', price: 7750, weight: 0.006 },
  { code: 'k-001', name: 'U-болт под трубу ф76мм', unit: 'шт', price: 1200, weight: 0.0004 },
  { code: 'k-019', name: 'Трубостойка ф76 L3000 mm', unit: 'шт', price: 14700, weight: 0.02 },
  { code: 'k-018', name: 'Трубостойка ф102 L3000 mm', unit: 'шт', price: 19210, weight: 0.032 },
  { code: 'a-011', name: 'Стойка ограждения ф76 мм 3400 мм', unit: 'шт', price: 16500, weight: 0.023 },
  { code: 'a-013', name: 'Секция ограждения 2500х1820мм (сетка рабица)', unit: 'шт', price: 42600, weight: 0.031 },
  { code: 'a-014', name: 'Секция ограждения 2500х1520мм (сетка рабица)', unit: 'шт', price: 39000, weight: 0.027 },
  { code: 'a-016', name: 'Секция ограждения 2500х820мм (сетка рабица)', unit: 'шт', price: 30200, weight: 0.018 },
  { code: 'a-017', name: 'Секция ограждения 390х820мм (сетка рабица)', unit: 'шт', price: 16000, weight: 0.006 },
  { code: 'a-018', name: 'Секция ограждения 2000х900мм (сетка рабица) калитка', unit: 'шт', price: 34800, weight: 0.022 },
  { code: 'a-001', name: 'Антивандальное ограждение Outdoor 1400х1300х2350', unit: 'шт', price: 357930, weight: 0.346, lead: 7 },
  { code: 'n-628', name: 'Антивандальное ограждение Outdoor 1300х1120х2530', unit: 'шт', price: 387500, weight: 0.36, lead: 7 },
  { code: 'a-005', name: 'Ограждение 6000х4400мм (сетка рабица)', unit: 'шт', price: 700000, weight: 0.6, lead: 10 },
  { code: 'n-560', name: 'Конструкция крепления наборных плит 500х500, h=262мм', unit: 'шт', price: 17773, weight: 0.012 },
  { code: 'n-1109', name: 'Закладная пластина для ЖБ плит 480х200х4мм', unit: 'шт', price: 3400, weight: 0.003 },
  { code: 'z-535', name: 'Мангальная зона', unit: 'шт', price: 714000, weight: 0.42, lead: 12 },
  { code: 'z-412', name: 'Лестничный марш ЛМ-1 с ограждением', unit: 'шт', price: 486000, weight: 0.38, lead: 10 },
  { code: 'z-388', name: 'Навес над входом 6х3 м (профнастил)', unit: 'шт', price: 1240000, weight: 0.95, lead: 14 },
  { code: 'z-901', name: 'Металлоконструкции каркаса (балки, колонны, связи)', unit: 'тонн', price: 640000, weight: 1, lead: 30 },
  { code: 'z-902', name: 'Фермы покрытия пролёт 18 м', unit: 'тонн', price: 690000, weight: 1, lead: 30 },
  { code: 'АА-00029282', name: 'Остановочный комплекс', unit: 'шт.', price: 1100000, weight: 0, resale: true },
  { code: 'АА-00029234', name: 'Изготовление навес (Южная сторона)', unit: 'тонн', price: 400000, weight: 0, resale: true },
  { code: 'АА-00029069', name: 'Сдача металлалома ЦМК (74п) 2 ой категории', unit: 'Одна услуг', price: 8800, weight: 0, resale: true },
  { code: 'Л0077', name: 'Эмаль ПФ-115 синяя', unit: 'кг', price: 1200, weight: 0, resale: true },
  { code: 'Л0078', name: 'Эмаль ПФ-115 черная', unit: 'кг', price: 1200, weight: 0, resale: true },
  { code: 'Л0020', name: 'Растворитель 646', unit: 'л', price: 1200, weight: 0, resale: true },
  { code: 'К0502', name: 'Трос 14 мм', unit: 'м', price: 800, weight: 0, resale: true },
  { code: 'TLCM007779', name: 'Трубный хомут ф76', unit: 'шт', price: 460, weight: 0, resale: true },
  { code: 'М0144', name: 'Болт М10х35 оц.', unit: 'кг', price: 900, weight: 0, resale: true },
  { code: 'АА-00021010', name: 'Гайка М10 оц..', unit: 'кг', price: 1060, weight: 0, resale: true },
];

interface Article {
  id: string; articleCode: string; name: string; unit: string; price: number; weightKg: number;
  isMaterialResale: boolean; leadTimeDays: number; series: string | null; hasBom: boolean; hasNorms: boolean;
}

const ARTICLES: Article[] = ARTICLE_SEEDS.map((s, i) => ({
  id: uuid(), articleCode: s.code, name: s.name, unit: s.unit, price: s.price, weightKg: s.weight,
  isMaterialResale: !!s.resale, leadTimeDays: s.lead ?? 0, series: s.series ?? null,
  // У части изделий состав и нормы не заведены — ровно та дыра, которую показывает инбокс
  hasBom: !s.resale && i % 7 !== 3, hasNorms: !s.resale && i % 5 !== 2,
}));
const byCode = (code: string): Article => ARTICLES.find((a) => a.articleCode === code)!;

const ARTICLE_CREATED = iso(Date.UTC(2026, 7, 18, 9, 12, 44));
const ARTICLE_UPDATED = iso(Date.UTC(2026, 8, 1, 14, 3, 5));

/** models.Article — все decimal как строки, PDate как ISO */
const articleJSON = (a: Article) => ({
  id: a.id, articleCode: a.articleCode, legacyCode: null, name: a.name, weightKg: dec(a.weightKg),
  series: a.series, description: null, approvedPrice: dec(a.price), isMaterialResale: a.isMaterialResale,
  specPrice: dec(a.isMaterialResale ? 0 : a.price * 0.63), priceDeviationPct: dec(0),
  leadTimeDays: dec(a.leadTimeDays), palletCapacity: dec(0), isActive: true,
  createdAt: ARTICLE_CREATED, updatedAt: ARTICLE_UPDATED,
});

/** Площадки телекома (orders.project_site из 1С); w — сколько заказов туда идёт */
const TELECOM_SITES: ReadonlyArray<{ site: string; w: number; region: string }> = [
  { site: 'KZ-Телеком', w: 30, region: 'Алматы' },
  { site: 'KZ-Телеком-2026', w: 3, region: 'Акмолинская область' },
  { site: 'KZ-ALM_Dudar', w: 4, region: 'Алматинская область' },
  { site: 'KZ-ALM_Egentower', w: 3, region: 'Алматы' },
  { site: 'KZ-ALM_HIGHTECH', w: 2, region: 'Алматы' },
  { site: 'KZ-ALM_KOSHKEN', w: 2, region: 'Алматинская область' },
  { site: 'KZ-ALM_Karum(NEW349)', w: 3, region: 'Алматы' },
  { site: 'KZ-ALM_Khanzada(NEW301)', w: 2, region: 'Алматы' },
  { site: 'KZ-ALM_Kommutator', w: 2, region: 'Алматы' },
  { site: 'KZ-ALM_Koskumbez', w: 1, region: 'Алматинская область' },
  { site: 'KZ-ALM_Magnum7', w: 1, region: 'Алматы' },
  { site: 'KZ-ALM_Ungurtas', w: 1, region: 'Алматинская область' },
  { site: 'KZ-ALM_Khairam', w: 1, region: 'Алматинская область' },
  { site: 'KZ-EKB_Hill', w: 3, region: 'Восточно-Казахстанская область' },
  { site: 'KZ-EKB_Belagash', w: 2, region: 'Восточно-Казахстанская область' },
  { site: 'KZ-KOS_Volodar', w: 2, region: 'Костанайская область' },
  { site: 'KZ-KZL_Uchebka', w: 2, region: 'Кызылординская область' },
  { site: 'KZL_Sits', w: 1, region: 'Кызылординская область' },
  { site: 'KZL_Agro-two/KZL_Agrotwo', w: 1, region: 'Кызылординская область' },
  { site: 'KZ-OSK_Hunter', w: 2, region: 'Восточно-Казахстанская область' },
  { site: 'KZ-TLD_BASKUNSHI', w: 1, region: 'Жетысуская область' },
  { site: 'KZ-TLD_ESEBULATOV', w: 1, region: 'Жетысуская область' },
  { site: 'SEM_Mirnyi', w: 2, region: 'Абайская область' },
  { site: 'SEM_Galeto', w: 1, region: 'Абайская область' },
  { site: 'AKT_QAZCEMENT', w: 2, region: 'Актюбинская область' },
  { site: 'ALM_Camry', w: 1, region: 'Алматы' },
  { site: 'PVL_Ekibastuz-3', w: 2, region: 'Павлодарская область' },
  { site: 'KRG_Temirtau-Sever', w: 2, region: 'Карагандинская область' },
  { site: 'UK7062', w: 1, region: 'Западно-Казахстанская область' },
  { site: 'Общий', w: 4, region: 'Алматы' },
];

const METAL_SITES: ReadonlyArray<{ site: string | null; w: number }> = [
  { site: 'KZ-Металлоконструкция', w: 40 },
  { site: null, w: 30 },
  { site: 'Театр им. М.Ауэзова', w: 1 },
  { site: 'А+ Бизнес парк', w: 1 },
  { site: 'KZ-0237-ЦМК-1', w: 6 },
  { site: 'KZ-0237-ЦМК-2', w: 2 },
  { site: 'KZ-Административные_расходы', w: 4 },
];

const MANAGERS: ReadonlyArray<{ name: string; w: number }> = [
  { name: '21652 - Сұлтанмұратқызы Гүлнұр', w: 78 },
  { name: '20781 - Бисен Азамат Мырзақанұлы', w: 12 },
  { name: '21396 - Нармагамбетов Санат Алибекович', w: 7 },
  { name: '20652 - Султангалиева Айнура Жаксыгалеевна', w: 2 },
  { name: '20687 - Ахметов Алитет Аркенович', w: 1 },
];

const WAREHOUSES: ReadonlyArray<{ name: string; w: number }> = [
  { name: 'ЦМК', w: 78 }, { name: '74п_Кладовая_ЦМК', w: 10 }, { name: '74п_Склад ГП', w: 6 },
  { name: '74п_ЦМК2_Склад ГП', w: 4 }, { name: 'ЦМК-2', w: 2 },
];

const FINAL_CUSTOMERS = ['КаР-Тел, ТОО', 'КаР-Тел, ТОО', 'Kazakhstan Tower Company (Казахстан Тауэр Компани), ТОО', 'Компании Холдинга АВХ'] as const;

/** Типовые комплекты телекома: мачта + шелтор + ограждение + заземление */
const MAST_KIT = ['m-035', 'b-016', 'a-011', 'a-013', 'a-014', 'a-016', 'a-017', 'a-018', 'b-012', 'n-039', 'k-013', 'k-028', 'k-001', 'k-019', 'n-019', 'b-013', 'К0502', 'TLCM007779', 'Л0077', 'Л0020'] as const;
const SMALL_TELECOM = ['b-012', 'n-039', 'k-013', 'k-001', 'k-019', 'a-011', 'a-013', 'n-019', 'k-010', 'b-007', 'b-013', 'Л0077', 'Л0078', 'Л0020', 'М0144', 'АА-00021010', 'a-001', 'n-628', 'n-560', 'n-1109'] as const;
const METAL_ITEMS = ['z-901', 'z-902', 'z-388', 'z-412', 'z-535', 'a-005', 'АА-00029282', 'АА-00029234', 'a-001', 'b-016', 'b-017', 'b-015'] as const;
const RETAIL_ITEMS = ['АА-00029069', 'z-535', 'z-412', 'Л0077', 'М0144', 'a-005'] as const;

const UNRESOLVED_NAMES = [
  'Ограждение периметра БС по эскизу заказчика 12х8 м',
  'Площадка обслуживания под антенну (нестандарт)',
  'Кронштейн крепления РРЛ ф600 усиленный',
  'Хомут для мачты М30 (пара)',
] as const;

// ───────────────────────────── модель заказа ─────────────────────────────

type Status = 'NEW' | 'CONFIRMED' | 'IN_PRODUCTION' | 'READY_TO_SHIP' | 'SHIPPED' | 'CLOSED' | 'CANCELLED';
type StageCode = 'DESIGN' | 'SUPPLY' | 'PRODUCTION';
type RoutingStage = 'CUTTING' | 'ASSEMBLY' | 'PAINTING';
type StageStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE';

interface Line {
  id: string; orderId: string; article: Article | null; qty: number; unit: string; unitPrice: number;
  lineTotalVat: number; prepayment: number; postPayment1: number; postPayment2: number; penalty: number;
  balanceDue: number; reservedQty: number; shippedQty: number; siteCode: string | null;
  sourceSheet: string | null; sourceRowNumber: number | null; articleCodeRaw: string | null; productNameRaw: string | null;
}

interface Stage {
  id: string; orderId: string; orderLineId: string | null; stageCode: StageCode; routingStage: RoutingStage | null;
  status: StageStatus; actualWorkers: number | null; actualHours: number | null; completedAt: string | null;
  completedById: string | null; defectPhotoUrl: string | null;
}

interface Payment {
  id: string; orderId: string; amount: number; paidAt: string; source: 'ONEC' | 'MANUAL';
  reference: string | null; note: string | null; createdById: string | null; createdAt: string;
}

interface Ord {
  id: string; orderNumber: string; customer: Customer; kind: Kind; region: string | null; managerId: string | null;
  status: Status; plannedShipmentDate: string | null; actualShipmentDate: string | null; overdueDays: number;
  stageTrackingMode: 'ORDER' | 'LINE'; acceptedAt: string | null; acceptedById: string | null;
  requestDate: string; requestMs: number; createdAt: string; updatedAt: string;
  onecNum: string; onecStatus: string; onecApprovalStatus: string | null; onecTotalAmount: number; onecPaidAmount: number | null;
  finalCustomer: string | null; customerOrderNum: string | null; projectGroup: string | null; projectSite: string | null;
  divisionCode: string; clientAgreement: string; onecSyncedAt: string; productionDocNumber: string | null; productionDocDate: string | null;
  bitrixDealId: string | null; direction: string; manager: string; warehouse: string;
  lines: Line[]; stages: Stage[]; payments: Payment[];
}

const EMPLOYEE_FOREMAN = '3e0a5b4c-7d21-4f4e-9b31-6a2c8f0d1e77';
const EMPLOYEE_PLANNER = '9c41f2aa-0b6e-4d0c-8a7f-2f5e6b9d3c10';
const SYNCED_AT = iso(Date.UTC(2026, 8, 2, 23, 40, 12));

function statusFor(i: number, ageDays: number): Status {
  if (i < 9) return 'NEW';
  if (ageDays < 45) return weighted([
    { s: 'CONFIRMED' as Status, w: 62 }, { s: 'IN_PRODUCTION' as Status, w: 30 }, { s: 'READY_TO_SHIP' as Status, w: 5 }, { s: 'CANCELLED' as Status, w: 3 },
  ]).s;
  if (ageDays < 110) return weighted([
    { s: 'CONFIRMED' as Status, w: 24 }, { s: 'IN_PRODUCTION' as Status, w: 22 }, { s: 'READY_TO_SHIP' as Status, w: 10 },
    { s: 'SHIPPED' as Status, w: 16 }, { s: 'CLOSED' as Status, w: 26 }, { s: 'CANCELLED' as Status, w: 2 },
  ]).s;
  return weighted([
    { s: 'CLOSED' as Status, w: 80 }, { s: 'SHIPPED' as Status, w: 8 }, { s: 'CONFIRMED' as Status, w: 9 }, { s: 'CANCELLED' as Status, w: 3 },
  ]).s;
}

function makeLine(order: Ord, article: Article | null, qty: number, rawName: string | null): Line {
  const base = article ? article.price : int(40, 380) * 1000;
  const unitPrice = article && !article.isMaterialResale && chance(0.35) ? Math.round(base * (0.9 + rnd() * 0.2)) : base;
  const total = round2(qty * unitPrice);
  const shipped = order.status === 'SHIPPED' || order.status === 'CLOSED' ? qty : 0;
  const reserved = order.status === 'IN_PRODUCTION' && chance(0.6) ? qty : 0;
  return {
    id: uuid(), orderId: order.id, article, qty, unit: article ? article.unit : 'шт', unitPrice, lineTotalVat: total,
    prepayment: 0, postPayment1: 0, postPayment2: 0, penalty: 0, balanceDue: 0, reservedQty: reserved, shippedQty: shipped,
    siteCode: order.kind === 'telecom' && order.projectSite && chance(0.25) ? order.projectSite : null,
    sourceSheet: null, sourceRowNumber: null,
    articleCodeRaw: article ? null : `АА-000${int(29100, 29400)}`,
    productNameRaw: rawName ?? (article ? article.name : null),
  };
}

function makeLines(order: Ord): Line[] {
  const lines: Line[] = [];
  if (order.kind === 'telecom') {
    const roll = rnd();
    if (roll < 0.32) {
      // Полный комплект под мачту
      const n = int(8, MAST_KIT.length);
      const codes = [...MAST_KIT].sort(() => rnd() - 0.5).slice(0, n);
      if (!codes.includes('m-035')) codes.unshift('m-035');
      for (const code of codes) {
        const a = byCode(code);
        const qty = code.startsWith('m-') || code.startsWith('b-01') ? 1 : code === 'b-012' ? int(18, 24) : code === 'k-001' ? 32 : int(1, 12);
        lines.push(makeLine(order, a, qty, null));
      }
    } else if (roll < 0.72) {
      const n = int(2, 6);
      for (let k = 0; k < n; k++) {
        const a = byCode(pick(SMALL_TELECOM));
        lines.push(makeLine(order, a, a.unit === 'шт' ? int(1, 10) : int(1, 4), null));
      }
    } else {
      const a = byCode(pick(SMALL_TELECOM));
      lines.push(makeLine(order, a, int(1, 6), null));
    }
  } else if (order.kind === 'metal') {
    const n = chance(0.7) ? 1 : int(2, 4);
    for (let k = 0; k < n; k++) {
      const a = byCode(pick(METAL_ITEMS));
      const qty = a.unit === 'тонн' ? round2(int(3, 90) + rnd()) : int(1, 4);
      lines.push(makeLine(order, a, qty, null));
    }
  } else {
    const a = byCode(pick(RETAIL_ITEMS));
    lines.push(makeLine(order, a, a.unit === 'Одна услуг' ? int(20, 60) : int(1, 3), null));
  }
  // Часть строк 1С не сопоставлена с артикулом — блокер приёма в инбоксе
  if ((order.status === 'NEW' && chance(0.3)) || chance(0.03)) {
    lines.push(makeLine(order, null, int(1, 4), pick(UNRESOLVED_NAMES)));
  }
  return lines;
}

function makeStages(order: Ord): Stage[] {
  const stages: Stage[] = [];
  const started = ['IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'CLOSED'].includes(order.status);
  if (!started) return stages;
  const allDone = order.status !== 'IN_PRODUCTION';
  const doneAt = (offset: number) => iso(order.requestMs + offset * DAY + int(8, 17) * 3600_000 + int(0, 59) * 60_000);
  stages.push({ id: uuid(), orderId: order.id, orderLineId: null, stageCode: 'DESIGN', routingStage: null, status: 'DONE',
    actualWorkers: null, actualHours: null, completedAt: doneAt(2), completedById: EMPLOYEE_PLANNER, defectPhotoUrl: null });
  stages.push({ id: uuid(), orderId: order.id, orderLineId: null, stageCode: 'SUPPLY', routingStage: null, status: allDone || chance(0.7) ? 'DONE' : 'IN_PRODUCTION' === order.status ? 'IN_PROGRESS' : 'DONE',
    actualWorkers: null, actualHours: null, completedAt: doneAt(5), completedById: EMPLOYEE_PLANNER, defectPhotoUrl: null });
  const produced = order.lines.filter((l) => l.article && !l.article.isMaterialResale);
  produced.forEach((l, idx) => {
    let status: StageStatus = 'DONE';
    if (!allDone) status = idx < produced.length * 0.4 ? 'DONE' : idx < produced.length * 0.6 ? 'IN_PROGRESS' : 'NOT_STARTED';
    stages.push({ id: uuid(), orderId: order.id, orderLineId: l.id, stageCode: 'PRODUCTION', routingStage: null, status,
      actualWorkers: status === 'DONE' ? int(2, 4) : null, actualHours: status === 'DONE' ? int(6, 40) : null,
      completedAt: status === 'DONE' ? doneAt(int(6, 20)) : null, completedById: status === 'DONE' ? EMPLOYEE_FOREMAN : null, defectPhotoUrl: null });
  });
  // В режиме отметки «по заказу» цех пишет часы на переделы — их раскладывает hours-allocation
  if (order.stageTrackingMode === 'ORDER' && order.status === 'IN_PRODUCTION') {
    const rs: RoutingStage[] = ['CUTTING', 'ASSEMBLY', 'PAINTING'];
    rs.forEach((r, k) => {
      const status: StageStatus = k === 0 ? 'DONE' : k === 1 ? 'IN_PROGRESS' : 'NOT_STARTED';
      stages.push({ id: uuid(), orderId: order.id, orderLineId: null, stageCode: 'PRODUCTION', routingStage: r, status,
        actualWorkers: status === 'NOT_STARTED' ? null : int(2, 5), actualHours: status === 'NOT_STARTED' ? null : int(12, 96),
        completedAt: status === 'DONE' ? doneAt(9) : null, completedById: status === 'DONE' ? EMPLOYEE_FOREMAN : null, defectPhotoUrl: null });
    });
  }
  return stages;
}

function makePayments(order: Ord): Payment[] {
  if (order.onecPaidAmount == null || order.onecPaidAmount <= 0) return [];
  const out: Payment[] = [];
  const parts = order.onecPaidAmount === order.onecTotalAmount && chance(0.5) ? 1 : int(1, 3);
  let left = order.onecPaidAmount;
  for (let k = 0; k < parts; k++) {
    const amount = k === parts - 1 ? round2(left) : round2(Math.floor(left / (parts - k) / 1000) * 1000);
    left -= amount;
    const paidMs = order.requestMs + (k + 1) * int(3, 18) * DAY;
    out.push({
      id: uuid(), orderId: order.id, amount, paidAt: iso(paidMs), source: 'ONEC',
      reference: `${int(100, 999)}`, note: null, createdById: null, createdAt: iso(paidMs + 9 * 3600_000),
    });
  }
  return out.sort((a, b) => (a.paidAt < b.paidAt ? 1 : -1));
}

function buildOrders(): Ord[] {
  const out: Ord[] = [];
  let num = 2558;
  for (let i = 0; i < 384; i++) {
    if (i > 0 && chance(0.12)) num -= 1;
    num -= 1;
    const customer = weighted(CUSTOMERS.filter((c) => c.w > 0));
    const kind = customer.kind;
    const ageDays = i < 9 ? i * 0.6 : 6 + (i - 9) * 0.955 + rnd() * 1.4;
    const requestMs = dayMs(-ageDays);
    const status = statusFor(i, ageDays);
    const telecomSite = kind === 'telecom' ? weighted(TELECOM_SITES) : null;
    const metalSite = kind !== 'telecom' ? weighted(METAL_SITES) : null;
    const projectSite = telecomSite ? telecomSite.site : metalSite ? metalSite.site : null;
    const region = telecomSite ? telecomSite.region : chance(0.3) ? null : pick(['Алматы', 'Алматы', 'Алматы', 'Алматинская область', 'Астана']);
    const planOffset = kind === 'telecom' ? int(-1, 6) : int(14, 40);
    const planned = chance(0.15) ? null : dayISO(-ageDays + planOffset);
    const plannedMs = planned ? Date.parse(planned) : null;
    const active = !['CLOSED', 'CANCELLED', 'SHIPPED'].includes(status);
    const overdueDays = active && plannedMs != null && plannedMs < TODAY ? Math.floor((TODAY - plannedMs) / DAY) : 0;
    const shipped = status === 'SHIPPED' || status === 'CLOSED';
    const actual = shipped ? dayISO(-ageDays + planOffset + int(-2, 6)) : null;
    const createdMs = requestMs + int(9, 18) * 3600_000 + int(0, 59) * 60_000 + int(0, 59) * 1000 + int(0, 999);
    const orderNumber = `Т7АА-${String(num).padStart(6, '0')}`;
    const accepted = status !== 'NEW' && status !== 'CONFIRMED' && status !== 'CANCELLED';
    const order: Ord = {
      id: uuid(), orderNumber, customer, kind, region,
      managerId: chance(0.85) ? 'f2d5a7c1-6b0e-4d46-8b9a-15c0e3f7a2b8' : null,
      status, plannedShipmentDate: planned, actualShipmentDate: actual, overdueDays,
      stageTrackingMode: status === 'IN_PRODUCTION' && chance(0.45) ? 'LINE' : 'ORDER',
      acceptedAt: accepted ? iso(requestMs + DAY + 10 * 3600_000 + int(0, 3000) * 1000) : null,
      acceptedById: accepted ? EMPLOYEE_PLANNER : null,
      requestDate: iso(requestMs), requestMs, createdAt: iso(createdMs),
      updatedAt: iso(Math.min(createdMs + int(1, 40) * DAY, TODAY - int(1, 30) * 3600_000)),
      onecNum: orderNumber,
      onecStatus: status === 'CLOSED' ? 'Закрыт' : status === 'CANCELLED' ? 'Отменен' : status === 'SHIPPED' ? 'Отгружен' : 'К выполнению / В резерве',
      onecApprovalStatus: null, onecTotalAmount: 0, onecPaidAmount: null,
      finalCustomer: kind === 'telecom' ? pick(FINAL_CUSTOMERS) : null,
      customerOrderNum: kind === 'telecom' && chance(0.7) ? `Т2АА-00${int(1000, 3600)}_${pick([2024, 2025, 2026, 2026])}` : null,
      projectGroup: kind === 'telecom' ? '74-0237 -Аврора Сервис, ТОО-03-2020 ЦМК' : projectSite ? '74-0245 -Аврора 77, ТОО-02-2021' : chance(0.5) ? '74-0245 -Аврора 77, ТОО-02-2021' : null,
      projectSite, divisionCode: '74п_Телеком',
      clientAgreement: kind === 'telecom' ? '74П 0/100, б/д' : pick(['0/100', '0/100 б/д', '0/100', '50/50', '30/70']),
      onecSyncedAt: SYNCED_AT,
      productionDocNumber: shipped && kind !== 'retail' ? `ПР-${String(int(4100, 4700)).padStart(6, '0')}` : null,
      productionDocDate: null,
      bitrixDealId: kind === 'telecom' ? `${int(122000, 128000)}-56` : chance(0.8) ? `ID заявки:${int(1840000, 1865000)}` : null,
      direction: kind === 'telecom' ? 'ЦМК Телекоммуникации' : 'ЦМК Другие',
      manager: weighted(MANAGERS).name, warehouse: weighted(WAREHOUSES).name,
      lines: [], stages: [], payments: [],
    };
    if (order.productionDocNumber) order.productionDocDate = dayISO(-ageDays + planOffset - 1);
    order.lines = makeLines(order);
    order.onecTotalAmount = round2(order.lines.reduce((s, l) => s + l.lineTotalVat, 0));
    // Оплата известна по ~1/5 заказов — остальные «слепая зона», как в 1С
    if (chance(0.21) || status === 'CLOSED' && chance(0.15)) {
      const r = rnd();
      order.onecPaidAmount = r < 0.55 ? order.onecTotalAmount : r < 0.9 ? round2(order.onecTotalAmount * pick([0.3, 0.5, 0.5, 0.7])) : 0;
    }
    order.stages = makeStages(order);
    order.payments = makePayments(order);
    out.push(order);
  }
  return out;
}

/** 384 заказа, отсортированы по created_at DESC — как отдаёт Go */
const ORDERS: Ord[] = buildOrders().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
const orderById = (id: string): Ord | undefined => ORDERS.find((o) => o.id === id);

// ───────────────────────────── сериализация ─────────────────────────────

/** Сырой ряд 1С — только у заказа, как в orders.raw_columns */
function rawColumns(o: Ord): Record<string, string> {
  const d = new Date(o.requestMs);
  const dd = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
  return {
    'Автор': o.manager, 'БанковскийСчетПоставщика': '', 'Валюта': 'KZT',
    'ГруппаПроектов': o.projectGroup ?? '', 'Дата': `${dd} ${int(9, 18)}:${String(int(0, 59)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}`,
    'ДатаПоДаннымПоставщика': '', 'ДатаСогласования': '', 'Договор': '', 'ЗакупкаПодДеятельность': '', 'Категория': '',
    'КатегорияЗатрат': '', 'КодНазначенияПлатежа': '', 'КонечныйЗаказчик': o.finalCustomer ?? '', 'КонечныйЗаказчикКонтрагент': '',
    'Контрагент': o.customer.name, 'Менеджер': o.manager, 'Налогообложение': 'Продажа облагается НДС',
    'НаправлениеДеятельности': o.direction, 'Номер': o.orderNumber, 'НомерЗаказаCRM': '',
    'НомерЗаказаБитрикс': o.bitrixDealId?.replace(/\D/g, '') ?? '', 'НомерЗаказаКлиента': o.customerOrderNum ?? '',
    'НомерЗаказаНаПродажу': '', 'НомерПоДаннымПоставщика': '', 'Организация': 'Аврора 77, ТОО', 'ОтгружатьОднойДатой': 'Да',
    'Партнер': o.customer.name, 'ПланВывоза': '', 'Подразделение': o.divisionCode, 'ПоступлениеОднойДатой': '',
    'Приоритет': 'Средний', 'Проведен': 'Да', 'Проект': o.projectSite ?? '', 'ПроектКлиента': '', 'Регион': o.region ?? '',
    'Склад': o.warehouse, 'Соглашение': o.clientAgreement, 'Статус': o.onecStatus,
    'СуммаДокумента': o.onecTotalAmount.toFixed(2).replace('.', ','), 'Тип': 'Клиенту', 'ТипЗаказа': '',
    'Утвердитель': '', 'ХозОперация': 'Реализация', 'ЦенаВключаетНДС': 'Да',
  };
}

/** models.Order — поля заказа без вложений; withRaw=false вырезает КЛЮЧ rawColumns (findAll) */
function orderJSON(o: Ord, withRaw: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: o.id, orderNumber: o.orderNumber, customerId: o.customer.id, region: o.region, managerId: o.managerId,
    orderType: 'FZ', bitrixDealId: o.bitrixDealId, bitrixStage: null, status: o.status,
    plannedShipmentDate: o.plannedShipmentDate, actualShipmentDate: o.actualShipmentDate, overdueDays: o.overdueDays,
    stageTrackingMode: o.stageTrackingMode, acceptedAt: o.acceptedAt, acceptedById: o.acceptedById, isArchived: false,
    requestDate: o.requestDate, createdAt: o.createdAt, updatedAt: o.updatedAt, onecNum: o.onecNum, onecStatus: o.onecStatus,
    onecApprovalStatus: o.onecApprovalStatus, onecTotalAmount: dec(o.onecTotalAmount),
    onecPaidAmount: o.onecPaidAmount == null ? null : dec(o.onecPaidAmount),
    finalCustomer: o.finalCustomer, customerOrderNum: o.customerOrderNum, projectGroup: o.projectGroup, projectSite: o.projectSite,
    divisionCode: o.divisionCode, clientAgreement: o.clientAgreement, onecSyncedAt: o.onecSyncedAt,
    productionDocNumber: o.productionDocNumber, productionDocDate: o.productionDocDate, sourceSheet: null, sourceRowNumber: null,
  };
  if (withRaw) out.rawColumns = rawColumns(o);
  return out;
}

type ArticleMode = 'full' | 'inbox';

/** models.OrderLine + article; withRaw=false вырезает ключ rawColumns (findAll) */
function lineJSON(l: Line, mode: ArticleMode, withRaw: boolean): Record<string, unknown> {
  const article = l.article == null ? null
    : mode === 'inbox' ? { id: l.article.id, articleCode: l.article.articleCode, name: l.article.name }
      : articleJSON(l.article);
  const out: Record<string, unknown> = {
    id: l.id, orderId: l.orderId, articleId: l.article?.id ?? null, qty: dec(l.qty), unit: l.unit,
    unitPrice: dec(l.unitPrice), lineTotalVat: dec(l.lineTotalVat), prepayment: dec(l.prepayment),
    postPayment1: dec(l.postPayment1), postPayment2: dec(l.postPayment2), penalty: dec(l.penalty),
    balanceDue: dec(l.balanceDue), reservedQty: dec(l.reservedQty), shippedQty: dec(l.shippedQty),
    siteCode: l.siteCode, sourceSheet: l.sourceSheet, sourceRowNumber: l.sourceRowNumber,
    articleCodeRaw: l.articleCodeRaw, productNameRaw: l.productNameRaw,
  };
  if (withRaw) out.rawColumns = null;
  out.article = article;
  return out;
}

const stageJSON = (s: Stage) => ({
  id: s.id, orderId: s.orderId, orderLineId: s.orderLineId, stageCode: s.stageCode, routingStage: s.routingStage,
  status: s.status, actualWorkers: s.actualWorkers, actualHours: s.actualHours, legacyStageCode: null,
  completedAt: s.completedAt, completedById: s.completedById, defectPhotoUrl: s.defectPhotoUrl,
});

const paymentJSON = (p: Payment) => ({
  id: p.id, orderId: p.orderId, amount: p.amount, paidAt: p.paidAt, source: p.source,
  reference: p.reference, note: p.note, createdById: p.createdById, createdAt: p.createdAt,
});

/** Документы оплаты по заказу в карточке — краткая проекция {id, unpaidAmount, status} */
function paymentDocsJSON(o: Ord): Array<{ id: string; unpaidAmount: number; status: string }> {
  if (o.onecPaidAmount == null || o.kind === 'retail') return [];
  const unpaid = round2(Math.max(0, o.onecTotalAmount - o.onecPaidAmount));
  const status = unpaid <= 0 ? 'Оплачено' : o.onecPaidAmount > 0 ? 'Частично оплачен' : 'Не оплачен';
  return [{ id: `d0c${o.id.slice(3)}`, unpaidAmount: unpaid, status }];
}

const DESIGN_USER = '00000000-0000-4000-8000-000000000001';

function auditJSON(o: Ord, before: string, after: string, comment: string | null) {
  return {
    entityType: 'Order', entityId: o.id, action: 'status_change',
    before: { status: before }, after: { status: after },
    userId: DESIGN_USER, userRole: 'admin', comment, timestamp: iso(TODAY + 10 * 3600_000 + 17 * 60_000),
  };
}

// ───────────────────────────── обработчики ─────────────────────────────

const notFound = (msg: string) => ({ error: { code: 'NOT_FOUND', message: msg } });

function paginate<T>(rows: T[], params: URLSearchParams, defaultSize: number) {
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const pageSize = Math.max(1, Number(params.get('pageSize') ?? defaultSize) || defaultSize);
  return { page, pageSize, slice: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
}

/** GET /orders — фильтры как в FindAll: status, customerId, overdueOnly, search (номер / заказчик / объект позиции) */
function listOrders(params: URLSearchParams) {
  let rows = ORDERS;
  const status = params.get('status');
  if (status) rows = rows.filter((o) => o.status === status);
  const customerId = params.get('customerId');
  if (customerId) rows = rows.filter((o) => o.customer.id === customerId);
  if (params.get('overdueOnly') === 'true') rows = rows.filter((o) => o.overdueDays > 0);
  const search = (params.get('search') ?? '').trim().toLowerCase();
  if (search) {
    rows = rows.filter((o) =>
      o.orderNumber.toLowerCase().includes(search)
      || o.customer.name.toLowerCase().includes(search)
      // Объект из 1С (project_site) — по нему группируется раздел «Объекты»
      || (o.projectSite ?? '').toLowerCase().includes(search)
      || o.lines.some((l) => (l.siteCode ?? '').toLowerCase().includes(search)));
  }
  const { page, pageSize, slice, total } = paginate(rows, params, 50);
  return {
    data: slice.map((o) => ({
      ...orderJSON(o, false),
      customer: customerJSON(o.customer),
      orderLines: o.lines.map((l) => lineJSON(l, 'full', false)),
    })),
    meta: { page, pageSize, total },
  };
}

/** GET /orders/inbox — NEW-заказы из 1С с блокерами приёма (created_at ASC) */
function inbox() {
  const rows = ORDERS.filter((o) => o.status === 'NEW').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const data = rows.map((o) => {
    const blockers: Array<{ code: string; message: string }> = [];
    if (o.lines.length === 0) blockers.push({ code: 'EMPTY_ORDER_LINES', message: 'Нет позиций — дождитесь синхронизации строк из 1С' });
    const unresolved = o.lines.filter((l) => !l.article);
    if (unresolved.length > 0) {
      const names = unresolved.slice(0, 3).map((l) => l.productNameRaw || l.articleCodeRaw || '—');
      blockers.push({
        code: 'UNRESOLVED_ORDER_LINES',
        message: `${unresolved.length} позиций без сопоставленного артикула: ${names.join(', ')}${unresolved.length > 3 ? '…' : ''}`,
      });
    }
    if (o.customer.binIin === '') blockers.push({ code: 'MISSING_CUSTOMER_BIN', message: 'У заказчика нет БИН/ИИН' });
    const noBom = o.lines.filter((l) => l.article && !l.article.hasBom).length;
    if (noBom > 0) blockers.push({ code: 'NO_BOM', message: `${noBom} позиций без состава изделия — калькуляция будет пустой` });
    const canAccept = blockers.every((b) => b.code === 'NO_BOM');
    return {
      ...orderJSON(o, true),
      customer: customerJSON(o.customer),
      orderLines: o.lines.map((l) => lineJSON(l, 'inbox', true)),
      blockers, canAccept,
    };
  });
  return { data, meta: { total: data.length } };
}

/** GET /orders/sites — срез по площадкам, как sitesSQL */
function sites() {
  const groups = new Map<string, Ord[]>();
  for (const o of ORDERS) {
    if (!o.projectSite) continue;
    const arr = groups.get(o.projectSite) ?? [];
    arr.push(o);
    groups.set(o.projectSite, arr);
  }
  const out: Array<Record<string, unknown> & { _maxOverdue: number; _site: string }> = [];
  let totalOrders = 0, totalLines = 0, doneLines = 0;
  for (const [site, list] of groups) {
    const lines = list.flatMap((o) => o.lines);
    const done = list.reduce((s, o) => s + new Set(o.stages.filter((st) => st.orderLineId && st.status === 'DONE').map((st) => st.orderLineId)).size, 0);
    const openDates = list.filter((o) => o.status !== 'CLOSED' && o.status !== 'CANCELLED' && o.plannedShipmentDate).map((o) => o.plannedShipmentDate!);
    const maxOverdue = Math.max(0, ...list.map((o) => o.overdueDays));
    totalOrders += list.length; totalLines += lines.length; doneLines += done;
    out.push({
      site,
      projectGroup: list.map((o) => o.projectGroup ?? '').sort().reverse()[0] ?? '',
      customerName: list.map((o) => o.customer.name).sort().reverse()[0] ?? '',
      ordersCount: list.length,
      overdueOrders: list.filter((o) => o.overdueDays > 0).length,
      linesCount: lines.length,
      doneLines: done,
      amount: dec(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)),
      nearestDate: openDates.length ? openDates.sort()[0] : null,
      maxOverdueDays: maxOverdue,
      _maxOverdue: maxOverdue, _site: site,
    });
  }
  out.sort((a, b) => b._maxOverdue - a._maxOverdue || (a._site < b._site ? -1 : 1));
  return {
    data: out.map(({ _maxOverdue, _site, ...row }) => row),
    meta: { sites: out.length, orders: totalOrders, lines: totalLines, doneLines },
  };
}

/** GET /orders/:id — карточка: заказ + контрагент + позиции + ДО + этапы (admin видит rawColumns) */
function findOne(o: Ord) {
  return {
    ...orderJSON(o, true),
    customer: customerJSON(o.customer),
    orderLines: o.lines.map((l) => lineJSON(l, 'full', true)),
    paymentDocuments: paymentDocsJSON(o),
    productionStages: o.stages.map(stageJSON),
  };
}

/** GET /orders/:id/material-availability — warehouse.OrderAvailability */
function materialAvailability(o: Ord) {
  const produced = o.lines.filter((l) => l.article && !l.article.isMaterialResale && l.article.hasBom);
  if (produced.length === 0) {
    return { ok: true, checkedMaterials: 0, shortages: [], note: 'У позиций заказа нет состава — проверять нечего' };
  }
  const checked = Math.min(14, 3 + produced.length * 2);
  // Дефицит — у каждого третьего заказа в работе, по детерминированному признаку
  const seed = parseInt(o.id.slice(0, 4), 16);
  const short = seed % 3 === 0 && (o.status === 'CONFIRMED' || o.status === 'IN_PRODUCTION' || o.status === 'NEW');
  if (!short) return { ok: true, checkedMaterials: checked, shortages: [] };
  const catalog = [
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
  const n = 1 + (seed % 4);
  const shortages = Array.from({ length: n }, (_, k) => {
    const m = catalog[(seed + k * 3) % catalog.length];
    const need = Math.round(((seed >> (k + 2)) % 80 + 12) * 10) / 10;
    const available = Math.round(need * ((seed >> k) % 6) / 10 * 10) / 10;
    return {
      materialId: `m${m.code.toLowerCase()}-${o.id.slice(9, 13)}-4a1e-8c3b-${o.id.slice(24, 36)}`,
      materialCode: m.code, name: m.name, unit: m.unit,
      need, available, shortage: Math.round((need - available) * 1000) / 1000,
      estimatedPrice: k === n - 1 && n > 2 ? 0 : m.price,
    };
  });
  shortages.sort((a, b) => b.shortage * b.estimatedPrice - a.shortage * a.estimatedPrice);
  return { ok: false, checkedMaterials: checked, shortages };
}

/** GET /orders/:id/production-stages/:code/hours-allocation?routingStage= */
function hoursAllocation(o: Ord, code: string, routingStage: string | null) {
  const stage = routingStage
    ? o.stages.find((s) => s.stageCode === code && s.routingStage === routingStage && s.orderLineId === null)
    : undefined;
  const actualHours = stage?.actualHours ?? 0;
  const norms: Record<RoutingStage, number> = { CUTTING: 3.5 * 2, ASSEMBLY: 9 * 3, PAINTING: 6 * 2 };
  const withNorm = routingStage != null && o.lines.some((l) => l.article?.hasNorms);
  const lineNorms = o.lines.map((l) => ({
    line: l,
    norm: withNorm && l.article?.hasNorms ? norms[routingStage as RoutingStage] * l.qty * (l.article.isMaterialResale ? 0 : 1) : 0,
  }));
  const totalNorm = lineNorms.reduce((s, x) => s + x.norm, 0);
  const lines = lineNorms.map(({ line, norm }) => {
    const share = totalNorm > 0 ? norm / totalNorm : 1 / Math.max(1, o.lines.length);
    return {
      orderLineId: line.id, sharePct: Math.round(share * 10000) / 100, hours: Math.round(actualHours * share * 100) / 100,
      articleCode: line.article?.articleCode ?? '', articleName: line.article?.name ?? '', qty: line.qty,
    };
  });
  return {
    stage: { code, routingStage, actualHours },
    basis: totalNorm > 0 ? 'norms' : 'equal_split',
    lines,
  };
}

/** PATCH /orders/:id/production-stages/:code — отметка изделия цехом, ответ mergeStageOut */
function updateStage(o: Ord, code: string, body: any) {
  const statusMap: Record<string, StageStatus> = {
    not_started: 'NOT_STARTED', in_progress: 'IN_PROGRESS', done: 'DONE', NOT_STARTED: 'NOT_STARTED', IN_PROGRESS: 'IN_PROGRESS', DONE: 'DONE',
  };
  const status = statusMap[String(body?.status ?? 'DONE')] ?? 'DONE';
  const orderLineId: string | null = body?.orderLineId ?? null;
  const routingStage: RoutingStage | null = body?.routingStage ?? null;
  let stage = o.stages.find((s) => s.stageCode === code && s.orderLineId === orderLineId && s.routingStage === routingStage);
  const now = iso(TODAY + 11 * 3600_000 + 24 * 60_000);
  if (!stage) {
    stage = { id: uuid(), orderId: o.id, orderLineId, stageCode: code as StageCode, routingStage, status,
      actualWorkers: null, actualHours: null, completedAt: null, completedById: null, defectPhotoUrl: null };
    o.stages.push(stage);
  }
  stage.status = status;
  stage.actualWorkers = body?.actualWorkers ?? null;
  stage.actualHours = body?.actualHours ?? null;
  stage.defectPhotoUrl = body?.defectPhotoUrl ?? null;
  stage.completedAt = status === 'DONE' ? now : null;
  stage.completedById = status === 'DONE' ? EMPLOYEE_FOREMAN : null;

  // Заказ готов, когда изготовлены все изделия; первая отметка переводит его в работу
  const produced = o.lines.filter((l) => l.article && !l.article.isMaterialResale);
  const doneLines = new Set(o.stages.filter((s) => s.stageCode === 'PRODUCTION' && s.orderLineId && s.status === 'DONE').map((s) => s.orderLineId));
  const before = o.status;
  let derived: Status | null = null;
  if (produced.length > 0 && produced.every((l) => doneLines.has(l.id))) {
    if (o.status === 'CONFIRMED' || o.status === 'IN_PRODUCTION') derived = 'READY_TO_SHIP';
  } else if (o.status === 'CONFIRMED' && status !== 'NOT_STARTED') {
    derived = 'IN_PRODUCTION';
  } else if (o.status === 'READY_TO_SHIP') {
    derived = 'IN_PRODUCTION';
  }
  if (derived) o.status = derived;
  return { ...stageJSON(stage), orderStatus: o.status, orderStatusChanged: derived != null && derived !== before };
}

function transition(o: Ord, body: any) {
  const target: string = body?.toStatus ?? body?.status ?? '';
  const before = o.status;
  if (target) o.status = target as Status;
  o.updatedAt = iso(TODAY + 10 * 3600_000 + 17 * 60_000);
  return { order: orderJSON(o, true), audit: auditJSON(o, before, o.status, body?.comment ?? null) };
}

/** GET /orders/:id/customer-payments — сводка + строки */
function customerPayments(o: Ord) {
  const paid = round2(o.payments.reduce((s, p) => s + p.amount, 0));
  return {
    orderNumber: o.orderNumber, totalAmount: o.onecTotalAmount, paidAmount: paid,
    balanceDue: round2(o.onecTotalAmount - paid), data: o.payments.map(paymentJSON),
  };
}

const findOrderByPath = (path: string): Ord | undefined => orderById(path.split('/')[2] ?? '');

export const routes: FixtureRoute[] = [
  // ── Заказы ──
  { method: 'GET', match: /^\/orders$/, handler: ({ params }) => listOrders(params) },
  { method: 'GET', match: /^\/orders\/inbox$/, handler: () => inbox() },
  { method: 'GET', match: /^\/orders\/sites$/, handler: () => sites() },
  {
    method: 'GET', match: /^\/orders\/[^/]+$/,
    handler: ({ path }) => {
      const o = findOrderByPath(path);
      return o ? findOne(o) : notFound(`Order ${path.split('/')[2]} not found`);
    },
  },
  {
    method: 'GET', match: /^\/orders\/[^/]+\/material-availability$/,
    handler: ({ path }) => {
      const o = findOrderByPath(path);
      return o ? materialAvailability(o) : notFound('Order not found');
    },
  },
  {
    method: 'GET', match: /^\/orders\/[^/]+\/production-stages\/[^/]+\/hours-allocation$/,
    handler: ({ path, params }) => {
      const o = findOrderByPath(path);
      if (!o) return notFound('Order not found');
      return hoursAllocation(o, path.split('/')[4], params.get('routingStage'));
    },
  },
  {
    method: 'PATCH', match: /^\/orders\/[^/]+\/production-stages\/[^/]+$/,
    handler: ({ path, body }) => {
      const o = findOrderByPath(path);
      return o ? updateStage(o, path.split('/')[4], body) : notFound('Order not found');
    },
  },
  {
    method: 'POST', match: /^\/orders\/[^/]+\/accept$/,
    handler: ({ path, body }) => {
      const o = findOrderByPath(path);
      if (!o) return notFound('Order not found');
      const b = body as { comment?: string } | undefined;
      const res = transition(o, { toStatus: 'CONFIRMED', comment: b?.comment || 'Принят в производство из инбокса' });
      o.acceptedAt = iso(TODAY + 10 * 3600_000 + 17 * 60_000);
      o.acceptedById = EMPLOYEE_PLANNER;
      return { order: orderJSON(o, true), audit: res.audit };
    },
  },
  {
    method: 'POST', match: /^\/orders\/[^/]+\/status$/,
    handler: ({ path, body }) => { const o = findOrderByPath(path); return o ? transition(o, body) : notFound('Order not found'); },
  },
  {
    method: 'PATCH', match: /^\/orders\/[^/]+\/status$/,
    handler: ({ path, body }) => { const o = findOrderByPath(path); return o ? transition(o, body) : notFound('Order not found'); },
  },
  {
    method: 'PATCH', match: /^\/orders\/[^/]+\/stage-tracking-mode$/,
    handler: ({ path, body }) => {
      const o = findOrderByPath(path);
      if (!o) return notFound('Order not found');
      const mode = (body as { mode?: string } | undefined)?.mode;
      if (mode === 'ORDER' || mode === 'LINE') o.stageTrackingMode = mode;
      return orderJSON(o, true);
    },
  },
  {
    method: 'PATCH', match: /^\/orders\/[^/]+\/lines\/[^/]+\/site$/,
    handler: ({ path, body }) => {
      const o = findOrderByPath(path);
      const lineId = path.split('/')[4];
      const line = o?.lines.find((l) => l.id === lineId);
      if (!line) return notFound('Позиция не найдена в этом заказе');
      const raw = (body as { siteCode?: string | null } | undefined)?.siteCode ?? null;
      line.siteCode = raw && raw.trim() ? raw.trim() : null;
      return { id: line.id, siteCode: line.siteCode };
    },
  },
  {
    method: 'PATCH', match: /^\/orders\/[^/]+$/,
    handler: ({ path, body }) => {
      const o = findOrderByPath(path);
      if (!o) return notFound('Order not found');
      const b = (body ?? {}) as Record<string, unknown>;
      if (typeof b.region === 'string') o.region = b.region;
      if (typeof b.plannedShipmentDate === 'string') o.plannedShipmentDate = iso(Date.parse(b.plannedShipmentDate));
      if (typeof b.requestDate === 'string') o.requestDate = iso(Date.parse(b.requestDate));
      if (typeof b.status === 'string') o.status = b.status as Status;
      o.updatedAt = iso(TODAY + 10 * 3600_000 + 17 * 60_000);
      return orderJSON(o, true);
    },
  },

  // ── Оплаты заказчика ──
  {
    method: 'GET', match: /^\/orders\/[^/]+\/customer-payments$/,
    handler: ({ path }) => { const o = findOrderByPath(path); return o ? customerPayments(o) : notFound('Order not found'); },
  },
  {
    method: 'POST', match: /^\/orders\/[^/]+\/customer-payments$/,
    handler: ({ path, body }) => {
      const o = findOrderByPath(path);
      if (!o) return notFound('Order not found');
      const b = (body ?? {}) as { amount?: number; paidAt?: string; reference?: string; note?: string };
      const now = iso(TODAY + 10 * 3600_000 + 17 * 60_000);
      const p: Payment = {
        id: uuid(), orderId: o.id, amount: Number(b.amount ?? 0), paidAt: b.paidAt ? iso(Date.parse(b.paidAt)) : now,
        source: 'MANUAL', reference: b.reference?.trim() || null, note: b.note?.trim() || null, createdById: null, createdAt: now,
      };
      o.payments.unshift(p);
      o.onecPaidAmount = round2(o.payments.reduce((s, x) => s + x.amount, 0));
      return { ...paymentJSON(p), orderPaidTotal: o.onecPaidAmount };
    },
  },
  {
    method: 'DELETE', match: /^\/customer-payments\/[^/]+$/,
    handler: ({ path }) => {
      const id = path.split('/')[2];
      const o = ORDERS.find((x) => x.payments.some((p) => p.id === id));
      if (!o) return notFound(`Платёж ${id} не найден`);
      o.payments = o.payments.filter((p) => p.id !== id);
      o.onecPaidAmount = round2(o.payments.reduce((s, x) => s + x.amount, 0));
      return { deleted: true, orderPaidTotal: o.onecPaidAmount };
    },
  },

  // ── Дашборд заказов ──
  { method: 'GET', match: /^\/orders-dashboard$/, handler: () => ordersDashboard() },

  // ── Контрагенты ──
  {
    method: 'GET', match: /^\/customers$/,
    handler: ({ params }) => {
      const search = (params.get('search') ?? '').trim().toLowerCase();
      let rows = [...CUSTOMERS].sort((a, b) => a.name.localeCompare(b.name));
      if (search) rows = rows.filter((c) => c.name.toLowerCase().includes(search) || c.binIin.toLowerCase().includes(search));
      const { page, pageSize, slice, total } = paginate(rows, params, 50);
      return { data: slice.map(customerJSON), meta: { page, pageSize, total } };
    },
  },
  {
    method: 'GET', match: /^\/customers\/[^/]+$/,
    handler: ({ path }) => {
      const id = path.split('/')[2];
      const c = CUSTOMERS.find((x) => x.id === id);
      return c ? customerJSON(c) : notFound(`Customer ${id} not found`);
    },
  },
  {
    method: 'POST', match: /^\/customers$/,
    handler: ({ body }) => {
      const b = (body ?? {}) as { name?: string; binIin?: string; region?: string | null; customerType?: string };
      const c: Customer = {
        id: uuid(), name: b.name ?? 'Новый контрагент', binIin: b.binIin ?? '', region: b.region ?? null,
        customerType: b.customerType === 'INSIDE' ? 'INSIDE' : 'OUTSIDE', kind: 'metal', w: 0,
      };
      CUSTOMERS.push(c);
      return customerJSON(c);
    },
  },
  {
    method: 'PATCH', match: /^\/customers\/[^/]+$/,
    handler: ({ path, body }) => {
      const id = path.split('/')[2];
      const c = CUSTOMERS.find((x) => x.id === id);
      if (!c) return notFound(`Customer ${id} not found`);
      const b = (body ?? {}) as Partial<{ name: string; binIin: string; region: string | null; customerType: string }>;
      if (typeof b.name === 'string') c.name = b.name;
      if (typeof b.binIin === 'string') c.binIin = b.binIin;
      if (b.region !== undefined) c.region = b.region;
      if (b.customerType === 'INSIDE' || b.customerType === 'OUTSIDE') c.customerType = b.customerType;
      return customerJSON(c);
    },
  },
];

// ───────────────────────────── дашборд ─────────────────────────────

/** GET /orders-dashboard — orders_dashboard.go: все суммы float64 (числа), «сегодня» = 2026-09-03 */
function ordersDashboard() {
  const nowMs = TODAY;
  const all = ORDERS;
  const sum = (list: Ord[], f: (o: Ord) => number) => round2(list.reduce((s, o) => s + f(o), 0));
  const total = (o: Ord) => o.onecTotalAmount;
  const paidOf = (o: Ord) => o.onecPaidAmount ?? 0;
  const active = all.filter((o) => o.status !== 'CLOSED' && o.status !== 'CANCELLED');
  const withPayment = all.filter((o) => o.onecPaidAmount != null);
  const debtOrders = withPayment.filter((o) => o.onecTotalAmount > paidOf(o));
  const unknownPayment = active.filter((o) => o.onecPaidAmount == null);
  const monthAgo = nowMs - 30 * DAY, prevMonth = nowMs - 60 * DAY;
  const month = all.filter((o) => o.requestMs > monthAgo && o.requestMs <= nowMs);
  const prev = all.filter((o) => o.requestMs > prevMonth && o.requestMs <= monthAgo);
  const biggestOrd = [...month].sort((a, b) => b.onecTotalAmount - a.onecTotalAmount)[0];
  const biggest = biggestOrd ? { orderNumber: biggestOrd.orderNumber, id: biggestOrd.id, amount: biggestOrd.onecTotalAmount } : null;

  const cut = (key: (o: Ord) => string | null) => {
    const m = new Map<string, { orders: number; total: number }>();
    for (const o of all) {
      const raw = key(o);
      const k = raw && raw.trim() ? raw.trim() : '__none__';
      const a = m.get(k) ?? { orders: 0, total: 0 };
      a.orders += 1; a.total += o.onecTotalAmount;
      m.set(k, a);
    }
    return [...m.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([k, a]) => ({ key: k === '__none__' ? null : k, orders: a.orders, total: round2(a.total) }));
  };

  const byCust = new Map<string, { id: string; name: string; orders: number; total: number; paid: number; debt: number; unknown: number }>();
  for (const o of all) {
    const a = byCust.get(o.customer.id) ?? { id: o.customer.id, name: o.customer.name, orders: 0, total: 0, paid: 0, debt: 0, unknown: 0 };
    a.orders += 1; a.total += o.onecTotalAmount;
    if (o.onecPaidAmount != null) { a.paid += o.onecPaidAmount; a.debt += Math.max(0, o.onecTotalAmount - o.onecPaidAmount); } else a.unknown += 1;
    byCust.set(o.customer.id, a);
  }
  const customers = [...byCust.values()]
    .sort((a, b) => b.debt - a.debt || b.total - a.total)
    .slice(0, 12)
    .map((a) => ({ ...a, total: round2(a.total), paid: round2(a.paid), debt: round2(a.debt) }));

  const ageOf = (o: Ord) => Math.floor((nowMs - o.requestMs) / DAY);
  const bucket = (label: string, from: number, to: number) => {
    const list = active.filter((o) => { const a = ageOf(o); return a >= from && a < to; });
    return { label, orders: list.length, amount: sum(list, total) };
  };

  return {
    kpi: {
      portfolio: { orders: active.length, amount: sum(active, total) },
      debt: { amount: sum(debtOrders, (o) => o.onecTotalAmount - paidOf(o)), orders: debtOrders.length, paymentKnownOrders: withPayment.length },
      unknownPayment: { amount: sum(unknownPayment, total), orders: unknownPayment.length },
      contractedMonth: { amount: sum(month, total), orders: month.length, prevAmount: sum(prev, total), biggest },
    },
    totalContracted: sum(all, total),
    dimensions: {
      direction: cut((o) => o.direction),
      manager: cut((o) => o.manager),
      warehouse: cut((o) => o.warehouse),
      customer: cut((o) => o.customer.name),
      project: cut((o) => o.projectSite),
      region: cut((o) => o.region),
      division: cut((o) => o.divisionCode),
    },
    procurementByDir: { 'ЦМК Другие': 475422898.12, 'ЦМК Телекоммуникации': 170659464.52 },
    customers,
    ageBuckets: [bucket('до 30 дней', 0, 30), bucket('30–90 дней', 30, 90), bucket('90–180 дней', 90, 180), bucket('дольше 180 дней', 180, 100000)],
    gaps: { costings: 32, approvedCostings: 7, ordersTotal: all.length, noBomArticles: 453, unknownPaymentOrders: unknownPayment.length },
  };
}
