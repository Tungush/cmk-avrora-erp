import type { FixtureRoute } from './types';

/**
 * Фикстуры модуля «Финансы» для режима дизайна (03.09.2026).
 *
 * Форма ответов повторяет Go-обработчики байт-в-байт:
 *   backend-go/internal/modules/finance/payment_documents.go — ДО: список, карточка,
 *       дебиторка по заказчикам, receivables, сверка, создание, оплата
 *   backend-go/internal/modules/finance/acceptance_acts.go   — акты приёма-передачи
 *   backend-go/internal/modules/finance/credit_lines.go      — кредитные линии ДАМУ
 *
 * Правила сериализации Go, которые здесь воспроизведены:
 *   • decimal.Decimal → строка без хвостовых нулей: "6371072.1" (ДО, строки ДО,
 *     платежи, партии, nextPayment у ДАМУ);
 *   • float64 → число (customer-debts, receivables, reconciliation, акты,
 *     лимиты и факт погашений ДАМУ);
 *   • common.PDate → "2026-08-25T00:00:00.000Z" или null;
 *   • статус ДО — API-код (UNPAID / PARTIALLY_PAID / PAID / EXECUTED);
 *   • docWithIncludes: список и карточка несут contractor и order, POST
 *     /payment-documents — только contractor, POST …/payments — ни того, ни другого.
 *
 * Данные — реестр «19.20-7п» ЦМК Аврора: 306 заказов поставщику на ≈663 млн ₸,
 * 212 не закрыты оплатой, 17 привязаны к заказу на продажу, ≈900 строк «что
 * заказано» (≈¼ металла с amountMismatch — цена за тонну при количестве в метрах).
 * Поставщики, заказчики и БИН — из базы; размножено детерминированным
 * генератором, без Math.random и Date.now — всё считается от 2026-09-03.
 */

// ───────────────────────────── время и генератор ─────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
/** «Сегодня» режима дизайна — 2026-09-03 00:00 UTC */
const TODAY = Date.UTC(2026, 8, 3);

const iso = (ms: number): string => new Date(ms).toISOString();
/** Полночь UTC через offset дней от «сегодня» — как date-колонки 1С */
const dayISO = (offsetDays: number): string => iso(TODAY + Math.round(offsetDays) * DAY);
const dayMs = (offsetDays: number): number => TODAY + Math.round(offsetDays) * DAY;
/** «25.08.2026» — как 1С пишет даты в сырых колонках */
function ruDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

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

const rnd = mulberry32(20260903 ^ 0xf1a);
const int = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const chance = (p: number): boolean => rnd() < p;
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** UUID v4-подобный, стабильный между перезагрузками (свой генератор) */
const idRng = mulberry32(0x5eed2);
function uuid(): string {
  const hex = () => Math.floor(idRng() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${(8 + Math.floor(idRng() * 4)).toString(16)}${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

/** djb2 — стабильный хеш строки (чтобы чужие id заказов давали один и тот же ответ) */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/** decimal.Decimal → JSON-строка без хвостовых нулей ("6371072.1") */
const dec = (n: number): string => String(Math.round(n * 1000) / 1000);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const ruMoney = (n: number): string => n.toFixed(2).replace('.', ',');

// ───────────────────────────── контрагенты ─────────────────────────────

type CustKind = 'telecom' | 'metal' | 'retail';
type SupKind = 'metal' | 'hardware' | 'paint' | 'welding' | 'tools' | 'components' | 'smr' | 'transport' | 'galvan' | 'other';

interface Contragent {
  id: string; name: string; binIin: string; region: string | null; customerType: 'INSIDE' | 'OUTSIDE';
}

/** models.Customer — как отдаёт catalog.ScanCustomer */
const contragentJSON = (c: Contragent) => ({
  id: c.id, name: c.name, binIin: c.binIin, region: c.region, customerType: c.customerType,
});

/** Единый реестр контрагентов: компании группы бывают и заказчиком, и поставщиком */
const REGISTRY = new Map<string, Contragent>();
function contragent(name: string, bin: string, type: 'INSIDE' | 'OUTSIDE'): Contragent {
  const have = REGISTRY.get(name);
  if (have) return have;
  const c: Contragent = { id: uuid(), name, binIin: bin, region: null, customerType: type };
  REGISTRY.set(name, c);
  return c;
}

interface CustomerSeed { name: string; bin: string; type: 'INSIDE' | 'OUTSIDE'; w: number; kind: CustKind }

/** Заказчики из базы (те же, что в orders.ts); w — доля в потоке заказов */
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
];

interface SupplierSeed { name: string; bin: string; type: 'INSIDE' | 'OUTSIDE'; kind: SupKind }

/** Поставщики из реестра «19.20-7п» и партий склада */
const SUPPLIER_SEEDS: readonly SupplierSeed[] = [
  { name: 'Металлобаза Астана, ТОО', bin: '090340012345', type: 'OUTSIDE', kind: 'metal' },
  { name: 'Модуль сталь, ТОО', bin: '120140004871', type: 'OUTSIDE', kind: 'metal' },
  { name: 'Торговый дом "Алаш", ТОО', bin: '050940002311', type: 'OUTSIDE', kind: 'metal' },
  { name: 'Фирма "А -Профиль" ТОО', bin: '980440001267', type: 'OUTSIDE', kind: 'metal' },
  { name: 'Avrora Global trade, ТОО', bin: '141140010115', type: 'INSIDE', kind: 'metal' },
  { name: 'IRON TRADE COMPANY, ТОО', bin: '180840020464', type: 'OUTSIDE', kind: 'metal' },
  { name: 'КазМеталлПрофиль, ТОО', bin: '130240009118', type: 'OUTSIDE', kind: 'metal' },
  { name: 'Bugel Алматы, ТОО', bin: '170140023500', type: 'OUTSIDE', kind: 'hardware' },
  { name: 'ТОО "КРЕПЁЖНАЯ ЗАСТАВА"', bin: '160340027712', type: 'OUTSIDE', kind: 'hardware' },
  { name: 'Тукор ТОО', bin: '040540008832', type: 'OUTSIDE', kind: 'hardware' },
  { name: 'МАЙ ТОО', bin: '030140004410', type: 'OUTSIDE', kind: 'paint' },
  { name: 'ТОО "ASIAN PAINTS"', bin: '181140012208', type: 'OUTSIDE', kind: 'paint' },
  { name: 'ТОО "NATIONAL COATING"', bin: '200540019751', type: 'OUTSIDE', kind: 'paint' },
  { name: 'Welding Company TOO', bin: '150940021403', type: 'OUTSIDE', kind: 'welding' },
  { name: 'ЛАМЭД ТОО', bin: '070840013315', type: 'OUTSIDE', kind: 'welding' },
  { name: 'PromGazProduct, ТОО', bin: '180540030450', type: 'OUTSIDE', kind: 'welding' },
  { name: 'КАЛИБР KZ, ТОО', bin: '110640002187', type: 'OUTSIDE', kind: 'tools' },
  { name: '220 VOLT, ТОО', bin: '130140016690', type: 'OUTSIDE', kind: 'tools' },
  { name: 'ТОО "PROEXPERT.KZ"', bin: '210740031154', type: 'OUTSIDE', kind: 'tools' },
  { name: 'AKS KAZAKHSTAN (АКС Казахстан) ТОО', bin: '100340009927', type: 'OUTSIDE', kind: 'components' },
  { name: 'ТОО "ТЕХНОСИСТЕМА МР"', bin: '140240018476', type: 'OUTSIDE', kind: 'components' },
  { name: 'ВИП СИСТЕМЫ, ТОО', bin: '060940007731', type: 'OUTSIDE', kind: 'components' },
  { name: 'ТОО "KAZ PROVIDER"', bin: '190440024580', type: 'OUTSIDE', kind: 'components' },
  { name: 'AVRORA ELECTRIC, ТОО', bin: '100240000832', type: 'INSIDE', kind: 'components' },
  { name: 'LVE Group, ТОО', bin: '191140005579', type: 'INSIDE', kind: 'smr' },
  { name: 'Аврора 77, ТОО', bin: '201040028925', type: 'INSIDE', kind: 'smr' },
  { name: 'ТОО "МонтажСтройСервис"', bin: '120840011290', type: 'OUTSIDE', kind: 'smr' },
  { name: 'ИП Сейтказин Р.Т.', bin: '850612300471', type: 'OUTSIDE', kind: 'smr' },
  { name: 'ТОО "Автотранс Логистик"', bin: '170940026019', type: 'OUTSIDE', kind: 'transport' },
  { name: 'Focus Logistics', bin: '230340008736', type: 'OUTSIDE', kind: 'transport' },
  { name: 'Завод горячего цинкования "Астана-Цинк", ТОО', bin: '110240015542', type: 'OUTSIDE', kind: 'galvan' },
  { name: 'Кастинг, ТОО', bin: '000340001876', type: 'OUTSIDE', kind: 'galvan' },
  { name: 'Аврора Сервис, ТОО', bin: '080840010555', type: 'INSIDE', kind: 'other' },
  { name: 'Казахтелеком, АО', bin: '941240000193', type: 'OUTSIDE', kind: 'other' },
  { name: 'АО "Астана-РЭК"', bin: '970240000728', type: 'OUTSIDE', kind: 'other' },
];

// сначала заказчики (их id совпадают по порядку с orders.ts по духу), потом поставщики
const CUSTOMERS = CUSTOMER_SEEDS.map((s) => ({ c: contragent(s.name, s.bin, s.type), seed: s }));
const SUPPLIERS = SUPPLIER_SEEDS.map((s) => ({ c: contragent(s.name, s.bin, s.type), seed: s }));
const byKind = (k: SupKind) => SUPPLIERS.filter((s) => s.seed.kind === k);

// ───────────────────────────── справочники ─────────────────────────────

const MANAGERS: readonly string[] = [
  '21652 - Сұлтанмұратқызы Гүлнұр', '20781 - Бисен Азамат Мырзақанұлы', '21396 - Нармагамбетов Санат Алибекович',
  '20652 - Султангалиева Айнура Жаксыгалеевна', '20687 - Ахметов Алитет Аркенович',
];
/** Снабженцы — авторы заказов поставщику */
const BUYERS: readonly string[] = [
  '20873 - Мусин Ержан Болатович', '20873 - Мусин Ержан Болатович', '21102 - Каиров Дамир Серикович', '20431 - Ибраева Акерке Талгатовна',
];
const APPROVERS: readonly string[] = ['10021 - Оспанов Бауыржан Абаевич', '10021 - Оспанов Бауыржан Абаевич', '10034 - Жумабеков Ерлан Сакенович'];
const DIVISIONS: readonly string[] = ['Цех металлоконструкций', 'Цех металлоконструкций', 'Цех металлоконструкций', 'ЦМК-2', 'Отдел снабжения'];
const WAREHOUSES: readonly string[] = ['ЦМК', 'ЦМК', 'ЦМК', '74п_Кладовая_ЦМК', 'ЦМК-2'];
const PROJECTS: readonly (string | null)[] = [
  'KZ-0237-ЦМК-1', 'KZ-0237-ЦМК-1', 'KZ-0237-ЦМК-2', 'KZ-Административные_расходы', 'БС 4G Карагандинская обл.',
  'А+ Бизнес парк', 'Цех ЦМК-2 (реконструкция)', null, null,
];

const COST_CATEGORY: Record<SupKind, string> = {
  metal: 'Сырье и материалы (металл)', hardware: 'Сырье и материалы (метизы)', paint: 'Сырье и материалы (ЛКМ)',
  welding: 'Сырье и материалы (сварочные)', tools: 'Инструмент и инвентарь', components: 'Комплектующие',
  smr: 'Услуги производственного характера (СМР)', transport: 'Транспортные расходы',
  galvan: 'Услуги производственного характера (оцинкование)', other: 'Общехозяйственные расходы',
};
const EXPENSE_ITEM: Record<SupKind, string> = {
  metal: 'Сырье и материалы', hardware: 'Сырье и материалы', paint: 'Сырье и материалы', welding: 'Сырье и материалы',
  tools: 'Инструмент', components: 'Комплектующие', smr: 'Услуги сторонних организаций', transport: 'Транспортные расходы',
  galvan: 'Услуги сторонних организаций', other: 'Общехозяйственные расходы',
};
/** Сумма одного ДО по виду закупа, ₸ — так 306 ДО дают ≈663 млн */
const AMOUNT: Record<SupKind, [number, number]> = {
  metal: [900_000, 12_000_000], hardware: [150_000, 1_800_000], paint: [200_000, 2_400_000], welding: [150_000, 1_500_000],
  tools: [80_000, 1_000_000], components: [200_000, 4_000_000], smr: [1_200_000, 9_000_000], transport: [100_000, 900_000],
  galvan: [600_000, 6_000_000], other: [80_000, 2_000_000],
};
/** Сколько ДО каждого вида среди 306 */
const KIND_COUNT: Record<SupKind, number> = {
  metal: 80, hardware: 30, paint: 22, welding: 18, tools: 14, components: 30, smr: 30, transport: 30, galvan: 18, other: 34,
};

type MatCat = 'METAL' | 'HARDWARE' | 'CONSUMABLES' | 'INSTRUMENTS' | 'COMPONENTS';
interface Item { code: string | null; name: string; unit: string; price: [number, number]; cat: MatCat | null; weightKg: number; id: string | null }

/** Реальные uuid ключевых материалов — те же, что в warehouse.ts */
const REAL_IDS: Record<string, string> = {
  'С0604': '22fa6aaa-4aad-4bce-b5a3-816d0b70fb2c', 'С0605': 'c2a62075-e81a-487b-8278-00da09d622b6', 'С0603': 'ced04fe9-d713-4b63-9e4d-9d96cd0970a5',
  'С0508': '5584fa86-bcdc-4f8f-a305-7a13da0af124', 'С0509': '7bb1d9b4-eefa-46a3-bb7d-d78b35a20581', 'С0507': '09e31129-acc6-40dc-ad1c-b0cca048ada3',
  'С0513': '35628187-dacf-44bc-a776-a5aa4b493c7d', 'С0406': '3212700a-dc7c-4308-bb40-474166e70fa1', 'С0412': '5a93d3c4-3c55-45e2-a3fc-f54ba8999c33',
  'С0103': 'babd4c07-ab52-48c1-a879-736d7573c7da', 'С0104': '10e8201a-e922-4478-9992-89fdb26c49ac', 'С0106': '0d5e7f0c-e562-4c72-9721-d4a6330c5dc8',
  'С0113': '6572b801-4f6d-478b-8f2e-ad9fc8f9bc3f', 'С0202': '72903e4a-751d-45f3-8c03-047d17b57ad6', 'С0210': 'd0826a0c-cd7b-4526-8b18-a19656e1fb59',
  'С0308': '1d65137d-9e24-4f69-81e4-d4545cf621b2', 'С0318': '1367b3bc-6f89-4412-b650-100523c80ff8', 'М0104': '6ac80540-7977-4b75-a759-4c03b6c8cb25',
  'М0119': '7ebe96fe-5175-4360-8d5b-cb4199182808', 'М0139': 'f2840f6d-6773-430c-adb8-215e86a01fd7', 'М0201': '7bca9d1d-2189-4ac4-87b0-6911326c99da',
  'Л0003': 'd278e45d-5c20-4b2d-be3f-1ce351858334', 'Л0006': '6dc0cad6-ada7-4e66-81c3-a993ca467175',
};

function mat(code: string, cat: MatCat, name: string, unit: string, lo: number, hi: number, weightKg = 0): Item {
  return { code, name, unit, price: [lo, hi], cat, weightKg, id: REAL_IDS[code] ?? uuid() };
}
const svc = (name: string, unit: string, lo: number, hi: number): Item => ({ code: null, name, unit, price: [lo, hi], cat: null, weightKg: 0, id: null });

const ITEMS: Record<SupKind, readonly Item[]> = {
  metal: [
    mat('С0604', 'METAL', 'Швеллер 12У', 'м', 6900, 7600, 10.4), mat('С0605', 'METAL', 'Швеллер 14У', 'м', 8100, 8900, 12.3),
    mat('С0603', 'METAL', 'Швеллер 10У', 'м', 5600, 6200, 8.59), mat('С0508', 'METAL', 'Уголок 50х50х4 мм', 'м', 2000, 2300, 3.05),
    mat('С0509', 'METAL', 'Уголок 50х50х5 мм', 'м', 2450, 2750, 3.77), mat('С0507', 'METAL', 'Уголок 45х45х4 мм', 'м', 1750, 1980, 2.73),
    mat('С0513', 'METAL', 'Уголок 63х63х5 мм', 'м', 3100, 3500, 4.81), mat('С0406', 'METAL', 'Труба профильная 120х120х4 мм', 'м', 9200, 10400, 14.4),
    mat('С0412', 'METAL', 'Труба профильная 20х20х1,5 мм', 'м', 560, 640, 0.84), mat('С0103', 'METAL', 'Круг ф 10 мм', 'м', 360, 420, 0.617),
    mat('С0104', 'METAL', 'Круг ф 12 мм', 'м', 520, 600, 0.888), mat('С0106', 'METAL', 'Круг ф 16 мм', 'м', 930, 1050, 1.58),
    mat('С0113', 'METAL', 'Круг ф 6,5 мм', 'м', 160, 190, 0.26), mat('С0208', 'METAL', 'Лист горячекатанный 1500х6000х4', 'м2', 8600, 9600, 31.4),
    mat('С0210', 'METAL', 'Лист горячекатанный 1500х6000х6', 'м2', 12800, 14200, 47.1), mat('С0202', 'METAL', 'Лист горячекатанный 1500х6000х10', 'м2', 21500, 23500, 78.5),
    mat('С0308', 'METAL', 'Труба э/с ф102х4 мм', 'м', 3500, 3900, 9.67), mat('С0318', 'METAL', 'Труба э/с ф76х3,5 мм', 'м', 2300, 2600, 6.26),
    mat('С0213', 'METAL', 'Лист ПВЛ 1000х2500х4', 'м2', 9500, 10500, 18), mat('С0802', 'METAL', 'Сетка рабица 30х30х2,5 мм оц.', 'м2', 2300, 2600, 3.1),
  ],
  hardware: [
    mat('М0104', 'HARDWARE', 'Болт М10х35 оц.', 'кг', 880, 960), mat('М0119', 'HARDWARE', 'Болт М16х60 оц.', 'кг', 780, 860),
    mat('М0139', 'HARDWARE', 'Болт М24х120 оц. 10,9', 'кг', 1050, 1200), mat('М0201', 'HARDWARE', 'Гайка M10 оц.', 'кг', 760, 830),
    mat('М0005', 'HARDWARE', 'Анкерный болт М10х12х150', 'шт', 98, 112), mat('М0009', 'HARDWARE', 'Шпилька резьбовая М16х1000', 'шт', 1750, 1950),
    mat('М0304', 'HARDWARE', 'Шайба плоская М12 оц.', 'кг', 740, 790),
  ],
  paint: [
    mat('Л0003', 'CONSUMABLES', 'Грунтовка ГФ-021 красно-кор.', 'кг', 650, 720), mat('Л0006', 'CONSUMABLES', 'Эмаль ПФ-115 серая', 'кг', 1100, 1250),
    mat('Л0077', 'CONSUMABLES', 'Эмаль ПФ-115 синяя', 'кг', 1150, 1280), mat('Л0020', 'CONSUMABLES', 'Растворитель 646', 'л', 1100, 1250),
    mat('Л0031', 'CONSUMABLES', 'Грунт-эмаль 3 в 1 по ржавчине, серая', 'кг', 1900, 2150),
  ],
  welding: [
    mat('Р0030', 'CONSUMABLES', 'Электроды МР-3 ф3 мм', 'кг', 165, 185), mat('Р0031', 'CONSUMABLES', 'Проволока сварочная СВ-08Г2С ф1,2', 'кг', 980, 1100),
    mat('Р0040', 'CONSUMABLES', 'Пропан (баллон 50 л)', 'шт', 9500, 11000), mat('Р0041', 'CONSUMABLES', 'Кислород технический (баллон 40 л)', 'шт', 2400, 2900),
    mat('Р0050', 'CONSUMABLES', 'Круг отрезной 230х2,5', 'шт', 520, 600), mat('Р0042', 'CONSUMABLES', 'Углекислота (баллон 40 л)', 'шт', 3800, 4300),
  ],
  tools: [
    mat('И0102', 'INSTRUMENTS', 'Углошлифовальная машина Makita GA9020', 'шт', 68000, 75000), mat('И0118', 'INSTRUMENTS', 'Сверло по металлу ф12 HSS', 'шт', 1650, 1900),
    mat('И0210', 'INSTRUMENTS', 'Сварочный аппарат Ресанта САИ-250', 'шт', 84000, 92000), mat('И0305', 'INSTRUMENTS', 'Рулетка 5 м', 'шт', 1800, 2200),
    mat('И0311', 'INSTRUMENTS', 'Струбцина F-образная 300 мм', 'шт', 4200, 4800),
  ],
  components: [
    mat('К0918', 'COMPONENTS', 'Кабель ВВГ нг LS 5х6', 'м', 1400, 1500), mat('К0238', 'COMPONENTS', 'Профнастил оц. С8 0,45х1150 мм (2,63м)', 'шт', 6700, 7100),
    mat('К0301', 'COMPONENTS', 'Дверь металлическая 2050х900 утеплённая', 'шт', 112000, 124000), mat('К0410', 'COMPONENTS', 'Утеплитель минераловатный 100 мм (плита 1200х600)', 'м2', 1780, 1920),
    mat('К0520', 'COMPONENTS', 'Автоматический выключатель ВА47-29 C16', 'шт', 1600, 1700), mat('К0614', 'COMPONENTS', 'Хомут трубный ф76 с гайкой', 'шт', 740, 820),
    mat('К0522', 'COMPONENTS', 'Светильник ЛПО 2х36 IP54', 'шт', 9400, 10200),
  ],
  smr: [
    svc('Монтаж мачты М25 на пространственной раме (KZ-0237-ЦМК-1)', 'усл', 2_400_000, 4_800_000),
    svc('Сборка секций мачты М25м (услуги подряда)', 'усл', 1_200_000, 3_600_000),
    svc('Сварочные работы по каркасу шелтора 0123 (2х2)', 'усл', 600_000, 1_900_000),
    svc('Покраска металлоконструкций (подряд), тн', 'тн', 48_000, 62_000),
    svc('Монтаж ограждения периметра БС', 'усл', 700_000, 2_100_000),
  ],
  transport: [
    svc('Перевозка металлоконструкций Астана — Караганда (20 т)', 'усл', 380_000, 520_000),
    svc('Доставка металлопроката (Металлобаза Астана → ЦМК)', 'усл', 90_000, 160_000),
    svc('Автокран 25 т, смена', 'смена', 120_000, 150_000),
    svc('Перевозка мачты М25 (негабарит) Астана — Павлодар', 'усл', 540_000, 760_000),
  ],
  galvan: [
    svc('Горячее цинкование металлоконструкций', 'тн', 420_000, 470_000),
    svc('Горячее цинкование метизов', 'кг', 520, 580),
  ],
  other: [
    svc('Аренда цеха ЦМК-2, август 2026', 'усл', 1_200_000, 1_800_000),
    svc('Электроэнергия, июль 2026', 'усл', 480_000, 940_000),
    svc('Услуги связи и интернет', 'усл', 60_000, 95_000),
    svc('Спецодежда (комплект сварщика)', 'шт', 28_000, 36_000),
    svc('Канцтовары и расходные материалы для офиса', 'усл', 40_000, 120_000),
  ],
};

/** Порядок количества по единице — чтобы qty были похожи на реестр */
function qtyFor(unit: string, amount: number, price: number): number {
  if (unit === 'усл') return 1;
  if (unit === 'смена') return int(1, 4);
  const raw = amount / price;
  if (unit === 'шт') return Math.max(1, Math.round(raw));
  return Math.max(0.5, round3(raw));
}

/** models.Material — как отдаёт catalog.ScanMaterial (decimal → строка) */
function materialJSON(it: Item, unitPrice: number, receiptISO: string) {
  return {
    id: it.id, materialCode: it.code, category: it.cat, name: it.name, unit: it.unit,
    unitWeightKg: dec(it.weightKg), purchasePrice: dec(unitPrice), purchasePriceUpdatedAt: receiptISO,
    lastPurchasePrice: dec(unitPrice), lastPurchaseDate: receiptISO,
    priceListPrice: dec(round2(unitPrice * (0.9 + (it.weightKg % 0.2)))), stockQty: dec(round3(it.weightKg ? 40 + it.weightKg * 12 : 120)),
  };
}

// ───────────────────────────── заказы на продажу (17 ДО с привязкой) ─────────────────────────────

interface StubOrder { id: string; orderNumber: string; customer: Contragent; totalAmount: number; paidAmount: number | null; requestMs: number; status: string; site: string }

const TELECOM_SITES = ['KZ-0237-ЦМК-1', 'KZ-0237-ЦМК-2', 'БС 4G Карагандинская обл.', 'А+ Бизнес парк', 'KZ-0237-ЦМК-1'];
const STUB_ORDERS: StubOrder[] = Array.from({ length: 9 }, (_, i) => {
  const cust = CUSTOMERS[[0, 1, 0, 3, 1, 0, 5, 2, 0][i]].c;
  const total = round2(int(28, 96) * 100_000);
  const known = i !== 4;
  return {
    id: uuid(), orderNumber: `Т7АА-00${2408 + i * 17}`, customer: cust, totalAmount: total,
    paidAmount: known ? round2(total * [0, 0.3, 1, 0.5, 0, 0.7, 0, 1, 0.4][i]) : null,
    requestMs: dayMs(-int(20, 210)), status: ['IN_PRODUCTION', 'SHIPPED', 'CLOSED', 'IN_PRODUCTION', 'CONFIRMED', 'SHIPPED', 'IN_PRODUCTION', 'CLOSED', 'READY_TO_SHIP'][i],
    site: TELECOM_SITES[i % TELECOM_SITES.length],
  };
});

/** models.Order — все поля, как orders.ScanOrder (rawColumns здесь null: в карточке ДО заказ не раскрывают) */
function orderJSON(o: StubOrder): Record<string, unknown> {
  const req = iso(o.requestMs);
  return {
    id: o.id, orderNumber: o.orderNumber, customerId: o.customer.id, region: 'Акмолинская область', managerId: 'f2d5a7c1-6b0e-4d46-8b9a-15c0e3f7a2b8',
    orderType: 'FZ', bitrixDealId: null, bitrixStage: null, status: o.status,
    plannedShipmentDate: iso(o.requestMs + 35 * DAY), actualShipmentDate: o.status === 'SHIPPED' || o.status === 'CLOSED' ? iso(o.requestMs + 33 * DAY) : null,
    overdueDays: 0, stageTrackingMode: 'ORDER', acceptedAt: iso(o.requestMs + 2 * DAY), acceptedById: 'f2d5a7c1-6b0e-4d46-8b9a-15c0e3f7a2b8', isArchived: false,
    requestDate: req, createdAt: req, updatedAt: iso(o.requestMs + 3 * DAY), onecNum: o.orderNumber, onecStatus: 'К обеспечению',
    onecApprovalStatus: 'Согласован', onecTotalAmount: dec(o.totalAmount), onecPaidAmount: o.paidAmount == null ? null : dec(o.paidAmount),
    finalCustomer: 'КаР-Тел, ТОО', customerOrderNum: null, projectGroup: 'Телеком', projectSite: o.site, divisionCode: 'ЦМК',
    clientAgreement: 'Договор поставки № 12/2026', onecSyncedAt: iso(Date.UTC(2026, 8, 2, 23, 40, 12)), productionDocNumber: null, productionDocDate: null,
    sourceSheet: null, sourceRowNumber: null, rawColumns: null,
  };
}

// ───────────────────────────── документы-основания (ДО) ─────────────────────────────

type DocStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'EXECUTED';
const STATUS_RU: Record<DocStatus, string> = { UNPAID: 'Не оплачен', PARTIALLY_PAID: 'Частично оплачен', PAID: 'Оплачено', EXECUTED: 'Исполнен' };

interface DocLine {
  id: string; lineNo: number; item: Item; qty: number; unitPrice: number; amount: number; vatRate: string | null;
  packaging: string | null; expenseItem: string; purpose: string | null; customerOrderNum: string | null; materialId: string | null; amountMismatch: boolean;
}
interface DocPayment { id: string; amount: number; dateMs: number; paymentType: string | null; reference: string | null; createdMs: number }
interface Batch { id: string; line: DocLine; receiptMs: number; unitPrice: number; qtyReceived: number; qtyRemaining: number; priceAnomaly: boolean; anomalyFactor: number | null }

interface Doc {
  id: string; doNumber: string; dateMs: number; contractor: Contragent; kind: SupKind; currency: string;
  totalAmount: number; paidAmount: number; unpaidAmount: number; category: string | null; status: DocStatus; order: StubOrder | null;
  businessDirection: string; projectName: string | null; division: string; warehouseName: string; costCategory: string;
  author: string; managerName: string | null; approvedMs: number | null; approver: string | null;
  supplierDocNumber: string | null; supplierDocMs: number | null;
  lines: DocLine[]; payments: DocPayment[]; batches: Batch[];
}

function makeLines(kind: SupKind, target: number, order: StubOrder | null): DocLine[] {
  const pool = ITEMS[kind];
  const n = kind === 'smr' || kind === 'other' || kind === 'transport' ? int(1, 2) : kind === 'galvan' ? 1 : kind === 'metal' ? int(2, 7) : int(1, 6);
  const weights = Array.from({ length: n }, () => 0.4 + rnd());
  const wsum = weights.reduce((s, w) => s + w, 0);
  const used = new Set<Item>();
  const out: DocLine[] = [];
  for (let i = 0; i < n; i++) {
    let it = pick(pool);
    if (used.has(it) && pool.length > n) { while (used.has(it)) it = pick(pool); }
    used.add(it);
    const share = target * (weights[i] / wsum);
    const perUnit = round2(it.price[0] + rnd() * (it.price[1] - it.price[0]));
    const qty = qtyFor(it.unit, share, perUnit);
    const amount = round2(qty * perUnit);
    // «Количество × Цена ≠ Сумма» — цена за тонну при количестве в метрах (¼ строк реестра)
    const mismatch = kind === 'metal' && it.weightKg > 0 && chance(0.34);
    const unitPrice = mismatch ? round2((perUnit / it.weightKg) * 1000) : perUnit;
    out.push({
      id: uuid(), lineNo: i + 1, item: it, qty, unitPrice, amount,
      vatRate: chance(0.9) ? '16%' : null,
      packaging: it.unit === 'кг' ? (chance(0.5) ? 'мешок 25 кг' : null) : it.unit === 'л' ? 'канистра 10 л' : null,
      expenseItem: EXPENSE_ITEM[kind], purpose: order ? `Заказ ${order.orderNumber} · ${order.site}` : chance(0.25) ? pick(['Мачта М25 KZ-0237', 'Шелторы 0123 (2х2)', 'Ограждение БС', 'Ремонт цеха']) : null,
      customerOrderNum: order && chance(0.5) ? `${order.orderNumber}-К` : null,
      materialId: it.id, amountMismatch: mismatch,
    });
  }
  return out;
}

function makePayments(doc: { dateMs: number; paidAmount: number; status: DocStatus }): DocPayment[] {
  if (doc.paidAmount <= 0) return [];
  const n = doc.status === 'PARTIALLY_PAID' ? int(1, 2) : chance(0.7) ? 1 : 2;
  const latest = Math.min(TODAY - DAY, doc.dateMs + 95 * DAY);
  const out: DocPayment[] = [];
  let left = doc.paidAmount;
  for (let i = 0; i < n; i++) {
    const amount = i === n - 1 ? round2(left) : round2(left * (0.3 + rnd() * 0.4));
    left = round2(left - amount);
    const span = Math.max(1, Math.floor((latest - doc.dateMs) / DAY));
    const dateMs = doc.dateMs + int(1, span) * DAY;
    out.push({ id: uuid(), amount, dateMs, paymentType: chance(0.7) ? 'Платежное поручение исходящее' : null, reference: `ПП-${String(int(1, 9999)).padStart(6, '0')}`, createdMs: dateMs + 9 * 3600 * 1000 });
  }
  return out.sort((a, b) => b.dateMs - a.dateMs);
}

function makeBatches(doc: { dateMs: number; kind: SupKind; lines: DocLine[]; contractor: Contragent; doNumber: string }): Batch[] {
  if (!['metal', 'hardware', 'paint', 'welding'].includes(doc.kind) || !chance(0.58)) return [];
  const out: Batch[] = [];
  for (const l of doc.lines) {
    if (!l.materialId) continue;
    const perUnit = l.amountMismatch ? round2(l.amount / l.qty) : l.unitPrice;
    const anomaly = chance(0.07);
    out.push({
      id: uuid(), line: l, receiptMs: doc.dateMs + int(0, 6) * DAY, unitPrice: anomaly ? round2(perUnit * 3.4) : perUnit,
      qtyReceived: l.qty, qtyRemaining: round3(l.qty * rnd() * 0.9), priceAnomaly: anomaly, anomalyFactor: anomaly ? 3.4 : null,
    });
  }
  return out.sort((a, b) => b.receiptMs - a.receiptMs);
}

function buildDocs(): Doc[] {
  const kinds: SupKind[] = [];
  (Object.keys(KIND_COUNT) as SupKind[]).forEach((k) => { for (let i = 0; i < KIND_COUNT[k]; i++) kinds.push(k); });
  shuffle(kinds);
  // 94 оплачено, 55 частично, 7 исполнено, 150 не оплачено → 212 не закрыты
  const statuses: DocStatus[] = [];
  const push = (s: DocStatus, n: number) => { for (let i = 0; i < n; i++) statuses.push(s); };
  push('PAID', 94); push('PARTIALLY_PAID', 55); push('EXECUTED', 7); push('UNPAID', 150);
  shuffle(statuses);

  // 17 из 306 привязаны к заказу на продажу — только «заказные» виды закупа
  const LINKABLE: readonly SupKind[] = ['metal', 'smr', 'galvan', 'components', 'transport'];
  const candidates = kinds.map((k, i) => (LINKABLE.includes(k) ? i : -1)).filter((i) => i >= 0);
  const linked = new Set<number>();
  while (linked.size < 17) linked.add(pick(candidates));

  const drafts = kinds.map((kind, i) => {
    // дата: последние 400 дней, гуще к сегодняшнему
    const dateMs = dayMs(-Math.floor(400 * Math.pow(rnd(), 1.4)));
    return { kind, i, dateMs, status: statuses[i] };
  }).sort((a, b) => a.dateMs - b.dateMs);

  const docs: Doc[] = [];
  drafts.forEach((d, rank) => {
    const supplier = pick(byKind(d.kind));
    const order = linked.has(d.i) ? STUB_ORDERS[hash(String(d.i)) % STUB_ORDERS.length] : null;
    const [lo, hi] = AMOUNT[d.kind];
    const target = lo + (hi - lo) * Math.pow(rnd(), 2);
    const lines = makeLines(d.kind, target, order);
    const totalAmount = round2(lines.reduce((s, l) => s + l.amount, 0));
    const paidAmount = d.status === 'PAID' || d.status === 'EXECUTED' ? totalAmount
      : d.status === 'PARTIALLY_PAID' ? round2(totalAmount * (0.15 + rnd() * 0.65)) : 0;
    const unpaidAmount = round2(Math.max(0, totalAmount - paidAmount));
    // номера сквозные по дате; шесть — с годом (в выгрузке номер сбрасывается по годам)
    const base = `00АА-0${String(65900 + rank).padStart(5, '0')}`;
    const doNumber = rank % 51 === 7 ? `${base}/2025` : base;
    const hasSupplierDoc = chance(0.9);
    const backdated = hasSupplierDoc && chance(0.92);
    const approved = chance(0.82);
    const isTelecom = order ? true : chance(0.65);
    const doc: Doc = {
      id: uuid(), doNumber, dateMs: d.dateMs, contractor: supplier.c, kind: d.kind, currency: 'KZT',
      totalAmount, paidAmount, unpaidAmount, category: null, status: d.status, order,
      businessDirection: isTelecom ? 'ЦМК Телекоммуникации' : 'ЦМК Другие',
      projectName: order ? order.site : pick(PROJECTS), division: pick(DIVISIONS), warehouseName: pick(WAREHOUSES),
      costCategory: COST_CATEGORY[d.kind], author: pick(BUYERS), managerName: chance(0.7) ? pick(MANAGERS) : null,
      approvedMs: approved ? d.dateMs + int(0, 3) * DAY : null, approver: approved ? pick(APPROVERS) : null,
      supplierDocNumber: hasSupplierDoc ? (['smr', 'transport', 'galvan', 'other'].includes(d.kind) ? `АВР-${int(100, 9800)}` : `СФ-${String(int(1, 99999)).padStart(7, '0')}`) : null,
      supplierDocMs: hasSupplierDoc ? d.dateMs - (backdated ? int(0, 12) : -int(1, 4)) * DAY : null,
      lines, payments: [], batches: [],
    };
    doc.payments = makePayments(doc);
    doc.batches = makeBatches(doc);
    docs.push(doc);
  });
  // список 1С — по дате убыванию
  return docs.sort((a, b) => b.dateMs - a.dateMs || b.doNumber.localeCompare(a.doNumber));
}

const DOCS: Doc[] = buildDocs();
const docById = (id: string): Doc | undefined => DOCS.find((d) => d.id === id);

// ───────────────────────────── сериализация ДО ─────────────────────────────

/** Сырой ряд «19.20-7п» — как payment_documents.raw_columns */
function docRaw(d: Doc): Record<string, string> {
  return {
    'Автор': d.author, 'БанковскийСчетПоставщика': 'KZ86722S000001234567', 'Валюта': d.currency,
    'Дата': `${ruDate(d.dateMs)} ${int(9, 18)}:${String(int(0, 59)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}`,
    'ДатаПоДаннымПоставщика': d.supplierDocMs == null ? '' : ruDate(d.supplierDocMs), 'ДатаСогласования': d.approvedMs == null ? '' : ruDate(d.approvedMs),
    'Договор': `Договор поставки № ${int(1, 240)}/${d.dateMs < Date.UTC(2026, 0, 1) ? '2025' : '2026'}`, 'ЗакупкаПодДеятельность': d.businessDirection,
    'Категория': '', 'КатегорияЗатрат': d.costCategory, 'КодНазначенияПлатежа': '710', 'Контрагент': d.contractor.name, 'Менеджер': d.managerName ?? '',
    'Налогообложение': 'Закупка облагается НДС', 'НаправлениеДеятельности': d.businessDirection, 'Номер': d.doNumber.replace(/\/\d{4}$/, ''),
    'НомерЗаказаНаПродажу': d.order?.orderNumber ?? '', 'НомерПоДаннымПоставщика': d.supplierDocNumber ?? '', 'Организация': 'Аврора 77, ТОО',
    'Партнер': d.contractor.name, 'Подразделение': d.division, 'ПоступлениеОднойДатой': 'Да', 'Приоритет': 'Средний', 'Проведен': 'Да',
    'Проект': d.projectName ?? '', 'Склад': d.warehouseName, 'Статус': STATUS_RU[d.status], 'СуммаДокумента': ruMoney(d.totalAmount),
    'Тип': 'Поставщику', 'Утвердитель': d.approver ?? '', 'ХозОперация': 'Закупка у поставщика', 'ЦенаВключаетНДС': 'Да',
  };
}

/** Сырой ряд строки — payment_document_lines.raw_columns */
function lineRaw(d: Doc, l: DocLine): Record<string, string> {
  return {
    'Номер': d.doNumber.replace(/\/\d{4}$/, ''), 'НомерСтроки': String(l.lineNo), 'Номенклатура': l.item.name, 'Количество': String(l.qty).replace('.', ','),
    'ЕдиницаИзмерения': l.item.unit, 'Цена': ruMoney(l.unitPrice), 'Сумма': ruMoney(l.amount), 'СтавкаНДС': l.vatRate ?? '', 'Упаковка': l.packaging ?? '',
    'СтатьяРасходов': l.expenseItem, 'Назначение': l.purpose ?? '', 'НомерЗаказаКлиента': l.customerOrderNum ?? '',
  };
}

/** docWithIncludes: базовые поля + contractor (если cust != nil) + order (если ord != nil) */
function docJSON(d: Doc, withContractor: boolean, withOrder: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: d.id, doNumber: d.doNumber, doDate: iso(d.dateMs), contractorId: d.contractor.id, currency: d.currency,
    totalAmount: dec(d.totalAmount), paidAmount: dec(d.paidAmount), unpaidAmount: dec(d.unpaidAmount), category: d.category,
    status: d.status, orderId: d.order?.id ?? null, rawColumns: docRaw(d), businessDirection: d.businessDirection,
    projectName: d.projectName, division: d.division, warehouseName: d.warehouseName, costCategory: d.costCategory,
    author: d.author, managerName: d.managerName, approvedAt: d.approvedMs == null ? null : iso(d.approvedMs), approver: d.approver,
    supplierDocNumber: d.supplierDocNumber, supplierDocDate: d.supplierDocMs == null ? null : iso(d.supplierDocMs),
    salesOrderNumber: d.order?.orderNumber ?? null,
  };
  if (withContractor) out.contractor = contragentJSON(d.contractor);
  if (withOrder) out.order = d.order ? orderJSON(d.order) : null;
  return out;
}

/** models.PaymentDocumentLine — *decimal → строка или null */
const lineJSON = (d: Doc, l: DocLine) => ({
  id: l.id, paymentDocumentId: d.id, lineNo: l.lineNo, itemName: l.item.name, qty: dec(l.qty), unitPrice: dec(l.unitPrice), amount: dec(l.amount),
  vatRate: l.vatRate, packaging: l.packaging, expenseItem: l.expenseItem, purpose: l.purpose, customerOrderNum: l.customerOrderNum,
  materialId: l.materialId, amountMismatch: l.amountMismatch, rawColumns: lineRaw(d, l),
});

/** models.Payment */
const paymentJSON = (d: Doc, p: DocPayment) => ({
  id: p.id, paymentDocumentId: d.id, amount: dec(p.amount), paymentDate: iso(p.dateMs), paymentType: p.paymentType, reference: p.reference, createdAt: iso(p.createdMs),
});

/** Партия из FindOne: ключи gin.H + material (catalog.ScanMaterial) */
function batchJSON(d: Doc, b: Batch) {
  const receipt = iso(b.receiptMs);
  return {
    id: b.id, materialId: b.line.materialId, warehouseId: null, receiptDate: receipt, unitPrice: dec(b.unitPrice),
    qtyReceived: dec(b.qtyReceived), qtyRemaining: dec(b.qtyRemaining), supplierName: d.contractor.name, documentNumber: d.doNumber,
    sourceMovementId: null, paymentDocumentId: d.id, origin: 'ONEC', externalId: `1c:${d.doNumber}:${b.line.lineNo}`, batchType: 'OWN', ownerOrderId: d.order?.id ?? null,
    priceAnomaly: b.priceAnomaly, anomalyFactor: b.anomalyFactor == null ? null : dec(b.anomalyFactor), anomalyClearedAt: null, anomalyClearedById: null,
    createdAt: iso(b.receiptMs + 10 * 3600 * 1000), material: materialJSON(b.line.item, b.unitPrice, receipt),
  };
}

function findOne(d: Doc) {
  const out = docJSON(d, true, true);
  out.batches = d.batches.map((b) => batchJSON(d, b));
  out.lines = d.lines.map((l) => lineJSON(d, l));
  out.payments = d.payments.map((p) => paymentJSON(d, p));
  return out;
}

const notFound = (msg: string) => ({ error: { code: 'NOT_FOUND', message: msg } });
const badRequest = (code: string, msg: string) => ({ error: { code, message: msg } });

function paginate<T>(rows: T[], params: URLSearchParams, defaultSize: number) {
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const pageSize = Math.max(1, Number(params.get('pageSize') ?? defaultSize) || defaultSize);
  return { page, pageSize, slice: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
}

/** GET /payment-documents — фильтры как в FindAll: status (API-код), customerId */
function listDocs(params: URLSearchParams) {
  let rows = DOCS;
  const status = params.get('status');
  if (status) rows = rows.filter((d) => d.status === status);
  const customerId = params.get('customerId');
  if (customerId) rows = rows.filter((d) => d.contractor.id === customerId);
  const { page, pageSize, slice, total } = paginate(rows, params, 50);
  return { data: slice.map((d) => docJSON(d, true, true)), meta: { page, pageSize, total } };
}

/** GET /payment-documents/receivables — status <> PAID, ORDER BY id, LIMIT 100; суммы float64 */
function receivables() {
  return DOCS.filter((d) => d.status !== 'PAID').sort((a, b) => a.id.localeCompare(b.id)).slice(0, 100).map((d) => ({
    id: d.id, customer: d.contractor.name, docNumber: d.doNumber, totalAmount: d.totalAmount, paidAmount: d.paidAmount,
    balanceDue: round2(d.totalAmount - d.paidAmount), status: d.status, doDate: iso(d.dateMs),
  }));
}

// ───────────────────────────── дебиторка по заказчикам ─────────────────────────────

interface DebtRow { c: Contragent; kind: CustKind; orders: number; unknownOrders: number; contracted: number; paid: number; debt: number; unknownAmount: number }

/** 384 активных заказа, разложенных по заказчикам пропорционально их доле в потоке */
function buildDebts(): DebtRow[] {
  const wsum = CUSTOMER_SEEDS.reduce((s, c) => s + c.w, 0);
  const counts = CUSTOMER_SEEDS.map((s) => Math.max(1, Math.round((384 * s.w) / wsum)));
  let diff = 384 - counts.reduce((s, n) => s + n, 0);
  counts[0] += diff; // остаток — на крупнейшего заказчика
  const rows: DebtRow[] = [];
  CUSTOMERS.forEach(({ c, seed }, idx) => {
    const r: DebtRow = { c, kind: seed.kind, orders: counts[idx], unknownOrders: 0, contracted: 0, paid: 0, debt: 0, unknownAmount: 0 };
    for (let i = 0; i < r.orders; i++) {
      const total = seed.kind === 'telecom' ? int(25, 95) * 100_000 : seed.kind === 'metal' ? int(30, 250) * 100_000 : int(2, 15) * 100_000;
      r.contracted += total;
      if (chance(0.16)) { r.unknownOrders++; r.unknownAmount += total; continue; }
      const ratio = chance(0.28) ? 1 : chance(0.42) ? 0.2 + rnd() * 0.5 : 0;
      const paid = round2(total * ratio);
      r.paid += paid;
      r.debt += Math.max(0, total - paid);
    }
    r.contracted = round2(r.contracted); r.paid = round2(r.paid); r.debt = round2(r.debt); r.unknownAmount = round2(r.unknownAmount);
    rows.push(r);
  });
  diff = 0;
  return rows.sort((a, b) => (b.debt - a.debt) || (b.unknownAmount - a.unknownAmount));
}

const DEBTS: DebtRow[] = buildDebts();

function customerDebts() {
  const t = { customers: DEBTS.length, orders: 0, contracted: 0, paid: 0, debt: 0, unknownOrders: 0, unknownAmount: 0 };
  const customers = DEBTS.map((r) => {
    t.orders += r.orders; t.contracted += r.contracted; t.paid += r.paid; t.debt += r.debt; t.unknownOrders += r.unknownOrders; t.unknownAmount += r.unknownAmount;
    return { customerId: r.c.id, customerName: r.c.name, orders: r.orders, contracted: r.contracted, paid: r.paid, debt: r.debt, unknownOrders: r.unknownOrders, unknownAmount: r.unknownAmount };
  });
  return { customers, totals: { ...t, contracted: round2(t.contracted), paid: round2(t.paid), debt: round2(t.debt), unknownAmount: round2(t.unknownAmount) } };
}

/** GET /payment-documents/reconciliation — встречные долги: заказы против ДО по одному контрагенту */
function reconciliation() {
  interface Acc { c: Contragent; ordersCount: number; paymentDocsCount: number; balanceDueOrders: number; unknownAmount: number; unpaidByDo: number; paidByDo: number }
  const accs = new Map<string, Acc>();
  const get = (c: Contragent): Acc => {
    let a = accs.get(c.id);
    if (!a) { a = { c, ordersCount: 0, paymentDocsCount: 0, balanceDueOrders: 0, unknownAmount: 0, unpaidByDo: 0, paidByDo: 0 }; accs.set(c.id, a); }
    return a;
  };
  for (const r of DEBTS) { const a = get(r.c); a.ordersCount += r.orders; a.balanceDueOrders += r.debt; a.unknownAmount += r.unknownAmount; }
  for (const d of DOCS) { const a = get(d.contractor); a.paymentDocsCount++; a.unpaidByDo += d.unpaidAmount; a.paidByDo += d.paidAmount; }
  const list = [...accs.values()]
    .filter((a) => a.balanceDueOrders > 0 || a.unpaidByDo > 0 || a.unknownAmount > 0)
    .map((a) => ({
      customerId: a.c.id, customerName: a.c.name, ordersCount: a.ordersCount, paymentDocsCount: a.paymentDocsCount,
      balanceDueOrders: round2(a.balanceDueOrders), unknownAmount: round2(a.unknownAmount), unpaidByDo: round2(a.unpaidByDo), paidByDo: round2(a.paidByDo),
      discrepancy: round2(a.balanceDueOrders - a.unpaidByDo),
    }))
    .sort((x, y) => Math.abs(y.discrepancy) - Math.abs(x.discrepancy));

  const byOrder = new Map<string, { o: StubOrder; total: number; unpaid: number; count: number }>();
  for (const d of DOCS) {
    if (!d.order) continue;
    const r = byOrder.get(d.order.id) ?? { o: d.order, total: 0, unpaid: 0, count: 0 };
    r.total += d.totalAmount; r.unpaid += d.unpaidAmount; r.count++;
    byOrder.set(d.order.id, r);
  }
  const orders = [...byOrder.values()]
    .sort((a, b) => (b.unpaid - a.unpaid) || (b.total - a.total)).slice(0, 20)
    .map((r) => ({ orderId: r.o.id, orderNumber: r.o.orderNumber, customerName: r.o.customer.name, orderTotal: r.o.totalAmount,
      procurementTotal: round2(r.total), procurementUnpaid: round2(r.unpaid), docsCount: r.count }));

  const balSum = list.reduce((s, r) => s + r.balanceDueOrders, 0);
  return {
    customers: list.slice(0, 50), orders,
    totals: {
      customersWithDebt: list.length, balanceDueOrders: round2(balSum),
      unpaidByDo: round2(DOCS.reduce((s, d) => s + d.unpaidAmount, 0)), procurementTotal: round2(DOCS.reduce((s, d) => s + d.totalAmount, 0)),
      docsCount: DOCS.length, shippedWithoutDo: 161, docsWithoutOrder: DOCS.filter((d) => !d.order).length,
    },
  };
}

// ───────────────────────────── мутации ДО ─────────────────────────────

let createdDocs = 0;

/** POST /payment-documents — body any; ответ docWithIncludes(d, cust, nil): contractor есть, order — нет */
function createDoc(body: any) {
  const b = body ?? {};
  const str = (...keys: string[]): string | null => { for (const k of keys) { const v = b[k]; if (typeof v === 'string' && v !== '') return v; } return null; };
  const contractorId = str('contractorId', 'customerId');
  const contractor = [...REGISTRY.values()].find((c) => c.id === contractorId);
  const dateMs = (() => { const s = str('doDate'); const t = s ? Date.parse(s) : NaN; return Number.isNaN(t) ? TODAY : Math.floor(t / DAY) * DAY; })();
  const total = round2(Number(b.totalAmount ?? 0) || 0);
  const orderId = str('orderId');
  const doc: Doc = {
    id: uuid(), doNumber: str('doNumber', 'docNumber') ?? `00АА-0${66300 + ++createdDocs}`, dateMs,
    contractor: contractor ?? { id: contractorId ?? uuid(), name: 'контрагент', binIin: '', region: null, customerType: 'OUTSIDE' },
    kind: 'other', currency: 'KZT', totalAmount: total, paidAmount: 0, unpaidAmount: total, category: str('category'), status: 'UNPAID',
    order: STUB_ORDERS.find((o) => o.id === orderId) ?? null, businessDirection: 'ЦМК Другие', projectName: null, division: 'Отдел снабжения',
    warehouseName: 'ЦМК', costCategory: 'Общехозяйственные расходы', author: BUYERS[0], managerName: null, approvedMs: null, approver: null,
    supplierDocNumber: null, supplierDocMs: null, lines: [], payments: [], batches: [],
  };
  DOCS.unshift(doc);
  const out = docJSON(doc, true, false);
  // созданный в сервисе ДО сырого ряда 1С не имеет
  out.rawColumns = null;
  if (!contractor) out.contractor = null;
  return out;
}

/** POST /payment-documents/:id/payments — {amount, paidAt?, reference?}; ответ: ДО без contractor/order + payment */
function addPayment(d: Doc, body: any) {
  const amount = Number(body?.amount ?? 0);
  if (!(amount > 0)) return badRequest('INVALID_AMOUNT', 'Сумма оплаты должна быть больше нуля');
  let dateMs = TODAY;
  if (typeof body?.paidAt === 'string' && body.paidAt !== '') {
    const t = Date.parse(body.paidAt);
    if (Number.isNaN(t)) return badRequest('INVALID_DATE', 'Дата оплаты не распознана');
    dateMs = t;
  }
  const reference = typeof body?.reference === 'string' && body.reference.trim() !== '' ? body.reference.trim() : null;
  const p: DocPayment = { id: uuid(), amount: round2(amount), dateMs, paymentType: null, reference, createdMs: TODAY + 9 * 3600 * 1000 };
  d.payments.unshift(p);
  d.paidAmount = round2(d.paidAmount + amount);
  d.unpaidAmount = round2(Math.max(0, d.totalAmount - d.paidAmount));
  d.status = d.paidAmount >= d.totalAmount ? 'PAID' : 'PARTIALLY_PAID';
  const out = docJSON(d, false, false);
  out.payment = paymentJSON(d, p);
  return out;
}

// ───────────────────────────── акты приёма-передачи ─────────────────────────────

interface ArticleSeed { code: string; name: string; unit: string; price: number }
const ARTICLES: readonly ArticleSeed[] = [
  { code: 'm-035', name: 'Мачта М25м на пространственной раме (секция 2м) в сборе', unit: 'шт', price: 3918000 },
  { code: 'm-040', name: 'Мачта М20 на пространственной раме (секция 2м) в сборе', unit: 'шт', price: 3120000 },
  { code: 'b-016', name: 'Контейнер технологический - Шелтор 0123 (2х2)', unit: 'шт', price: 1298000 },
  { code: 'b-017', name: 'Контейнер технологический - Шелтор 0123 (1х2)', unit: 'шт', price: 907250 },
  { code: 'b-007', name: 'Лестница с площадкой для Шелтора 0321', unit: 'шт', price: 75895 },
  { code: 'b-012', name: 'Полоса заземления 40х4мм, L-2м', unit: 'шт', price: 2000 },
  { code: 'n-039', name: 'Очаг заземления уголок 50 2000мм', unit: 'шт', price: 5700 },
  { code: 'k-013', name: 'Молниеприемник приварной', unit: 'шт', price: 2280 },
  { code: 'n-019', name: 'Кабельный мост 2,0м (без трубостойки)', unit: 'шт', price: 50100 },
  { code: 'k-028', name: 'Швеллерная балка L500 mm под трубу Ф76-76', unit: 'шт', price: 7750 },
  { code: 'k-019', name: 'Трубостойка ф76 L3000 mm', unit: 'шт', price: 14700 },
  { code: 'a-011', name: 'Стойка ограждения ф76 мм 3400 мм', unit: 'шт', price: 16500 },
  { code: 'a-013', name: 'Секция ограждения 2500х1820мм (сетка рабица)', unit: 'шт', price: 42600 },
  { code: 'a-018', name: 'Секция ограждения 2000х900мм (сетка рабица) калитка', unit: 'шт', price: 34800 },
  { code: 'a-001', name: 'Антивандальное ограждение Outdoor 1400х1300х2350', unit: 'шт', price: 357930 },
  { code: 'z-412', name: 'Лестничный марш ЛМ-1 с ограждением', unit: 'шт', price: 486000 },
  { code: 'z-388', name: 'Навес над входом 6х3 м (профнастил)', unit: 'шт', price: 1240000 },
  { code: 'z-901', name: 'Металлоконструкции каркаса (балки, колонны, связи)', unit: 'тонн', price: 640000 },
];
const ARTICLE_IDS = new Map(ARTICLES.map((a) => [a.code, uuid()] as const));

interface ActLine { id: string; lineNo: number; itemName: string; articleId: string | null; qty: number; unitPrice: number; amount: number; vatRate: string | null; orderNumber: string | null }
interface Act {
  id: string; appNumber: string; customer: Contragent; orderId: string | null; orderNumber: string | null; dateMs: number; totalAmount: number;
  warehouse: string | null; division: string | null; businessDirection: string | null; managerName: string | null; managerId: string | null;
  status: string | null; isPosted: boolean; raw: Record<string, string> | null; createdMs: number; lines: ActLine[];
}

const MANAGER_ID = 'f2d5a7c1-6b0e-4d46-8b9a-15c0e3f7a2b8';

function buildActs(): Act[] {
  const out: Act[] = [];
  const telecomCustomers = CUSTOMERS.filter((c) => c.seed.kind === 'telecom');
  const metalCustomers = CUSTOMERS.filter((c) => c.seed.kind === 'metal' && c.seed.w >= 5);
  for (let i = 0; i < 58; i++) {
    const telecom = chance(0.78);
    const cust = telecom ? pick(telecomCustomers).c : pick(metalCustomers).c;
    const stub = chance(0.35) ? STUB_ORDERS[i % STUB_ORDERS.length] : null;
    const orderNumber = stub ? stub.orderNumber : `Т7АА-00${2300 + int(0, 260)}`;
    const dateMs = dayMs(-Math.floor(330 * Math.pow(rnd(), 1.3)));
    const n = telecom ? int(2, 7) : int(1, 3);
    const lines: ActLine[] = [];
    const usedCodes = new Set<string>();
    for (let k = 0; k < n; k++) {
      let a = telecom ? ARTICLES[int(0, 13)] : ARTICLES[int(13, ARTICLES.length - 1)];
      while (usedCodes.has(a.code)) a = ARTICLES[int(0, ARTICLES.length - 1)];
      usedCodes.add(a.code);
      const qty = a.unit === 'тонн' ? round3(int(12, 80) / 10) : a.price > 800_000 ? int(1, 3) : int(2, 24);
      const unitPrice = round2(a.price * (0.96 + rnd() * 0.08));
      lines.push({ id: uuid(), lineNo: k + 1, itemName: a.name, articleId: ARTICLE_IDS.get(a.code) ?? null, qty, unitPrice, amount: round2(qty * unitPrice), vatRate: chance(0.85) ? '16%' : null, orderNumber });
    }
    const totalAmount = round2(lines.reduce((s, l) => s + l.amount, 0));
    const manager = pick(MANAGERS);
    out.push({
      id: uuid(), appNumber: `Т7АА-00${2600 + i * 3}`, customer: cust, orderId: stub?.id ?? null, orderNumber, dateMs, totalAmount,
      warehouse: telecom ? '74п_Склад ГП' : '74п_ЦМК2_Склад ГП', division: 'ЦМК', businessDirection: telecom ? 'ЦМК Телекоммуникации' : 'ЦМК Другие',
      managerName: manager, managerId: chance(0.8) ? MANAGER_ID : null, status: 'Проведен', isPosted: true,
      raw: {
        'Номер': `Т7АА-00${2600 + i * 3}`, 'Дата': `${ruDate(dateMs)} ${int(9, 18)}:${String(int(0, 59)).padStart(2, '0')}:00`, 'Контрагент': cust.name,
        'ЗаказКлиента': orderNumber, 'Склад': telecom ? '74п_Склад ГП' : '74п_ЦМК2_Склад ГП', 'Подразделение': 'ЦМК', 'Менеджер': manager,
        'НаправлениеДеятельности': telecom ? 'ЦМК Телекоммуникации' : 'ЦМК Другие', 'СуммаДокумента': ruMoney(totalAmount), 'Проведен': 'Да', 'ХозОперация': 'Реализация',
      },
      createdMs: dateMs + 14 * 3600 * 1000, lines,
    });
  }
  // шесть актов, оформленных уже в сервисе
  for (let i = 0; i < 6; i++) {
    const stub = STUB_ORDERS[(i * 2) % STUB_ORDERS.length];
    const dateMs = dayMs(-int(1, 40));
    const a = ARTICLES[int(0, 8)];
    const qty = a.price > 800_000 ? 1 : int(2, 10);
    const lines: ActLine[] = [{ id: uuid(), lineNo: 1, itemName: a.name, articleId: ARTICLE_IDS.get(a.code) ?? null, qty, unitPrice: a.price, amount: round2(qty * a.price), vatRate: null, orderNumber: stub.orderNumber }];
    out.push({
      id: uuid(), appNumber: `АПП-${String(i + 1).padStart(3, '0')}`, customer: stub.customer, orderId: stub.id, orderNumber: stub.orderNumber, dateMs,
      totalAmount: lines[0].amount, warehouse: null, division: null, businessDirection: null, managerName: MANAGERS[0], managerId: MANAGER_ID,
      status: 'Оформлен в сервисе', isPosted: true, raw: null, createdMs: dateMs + 11 * 3600 * 1000, lines,
    });
  }
  return out.sort((a, b) => b.dateMs - a.dateMs);
}

const ACTS: Act[] = buildActs();
let nextActNo = 7;

const actLineJSON = (a: Act, l: ActLine) => ({
  id: l.id, actId: a.id, lineNo: l.lineNo, itemName: l.itemName, articleId: l.articleId, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount, vatRate: l.vatRate, orderNumber: l.orderNumber,
});

/** actBase — float64 → числа, rawColumns → объект или null */
function actJSON(a: Act): Record<string, unknown> {
  return {
    id: a.id, appNumber: a.appNumber, customerId: a.customer.id, orderId: a.orderId, actDate: iso(a.dateMs), totalAmount: a.totalAmount,
    warehouse: a.warehouse, division: a.division, businessDirection: a.businessDirection, managerName: a.managerName, managerId: a.managerId,
    status: a.status, isPosted: a.isPosted, rawColumns: a.raw, createdAt: iso(a.createdMs),
  };
}

function actListJSON(a: Act) {
  const out = actJSON(a);
  out.customer = { id: a.customer.id, name: a.customer.name, binIin: a.customer.binIin };
  out.order = a.orderId ? { id: a.orderId, orderNumber: a.orderNumber } : null;
  out.lines = a.lines.map((l) => actLineJSON(a, l));
  return out;
}

/**
 * Заказы режима дизайна живут в orders.ts со своими id — сюда они не доходят.
 * Чтобы шторка «Акты» не была всегда пустой, для чужого orderId детерминированно
 * (по хешу id) подбираем 0–3 акта из пула и перевешиваем их на этот заказ.
 */
function actsForForeignOrder(orderId: string): Act[] {
  const h = hash(orderId);
  const r = mulberry32(h)();
  const count = r < 0.4 ? 0 : r < 0.75 ? 1 : r < 0.92 ? 2 : 3;
  const out: Act[] = [];
  for (let i = 0; i < count; i++) {
    const src = ACTS[(h + i * 7) % ACTS.length];
    out.push({ ...src, id: `${src.id.slice(0, 24)}${h.toString(16).padStart(8, '0').slice(0, 8)}${String(i).padStart(4, '0')}`, orderId, lines: src.lines });
  }
  return out;
}

function listActs(params: URLSearchParams) {
  let rows = ACTS;
  const orderId = params.get('orderId');
  if (orderId) {
    rows = rows.filter((a) => a.orderId === orderId);
    if (rows.length === 0 && !STUB_ORDERS.some((o) => o.id === orderId)) rows = actsForForeignOrder(orderId);
  }
  const customerId = params.get('customerId');
  if (customerId) rows = rows.filter((a) => a.customer.id === customerId);
  const { page, pageSize, slice, total } = paginate(rows, params, 50);
  return { data: slice.map(actListJSON), meta: { page, pageSize, total } };
}

/** POST /acceptance-acts — {orderId, actDate?, appNumber?, lines:[{orderLineId?, itemName?, qty, unitPrice}]} */
function createAct(body: any) {
  const orderId: string = typeof body?.orderId === 'string' ? body.orderId : '';
  const bodyLines: any[] = Array.isArray(body?.lines) ? body.lines : [];
  if (bodyLines.length === 0) return badRequest('EMPTY_ACT', 'В акте нет ни одной позиции');
  const stub = STUB_ORDERS.find((o) => o.id === orderId) ?? null;
  // чужой заказ (из orders.ts) — заказчика и номер выводим детерминированно из id
  const h = hash(orderId);
  const customer = stub ? stub.customer : CUSTOMERS[h % 5].c;
  const orderNumber = stub ? stub.orderNumber : `Т7АА-00${2300 + (h % 260)}`;
  const lines: ActLine[] = [];
  let total = 0;
  for (let i = 0; i < bodyLines.length; i++) {
    const l = bodyLines[i];
    const qty = Number(l?.qty ?? 0);
    const unitPrice = Number(l?.unitPrice ?? 0);
    if (!(qty > 0)) return badRequest('INVALID_QTY', `Количество в строке ${i + 1} должно быть больше нуля`);
    if (!(unitPrice >= 0)) return badRequest('INVALID_PRICE', `Цена в строке ${i + 1} не может быть отрицательной`);
    const named = typeof l?.itemName === 'string' && l.itemName.trim() !== '' ? l.itemName.trim() : null;
    const fallback = ARTICLES[(h + i * 3) % 14];
    const amount = round2(qty * unitPrice);
    total += amount;
    lines.push({ id: uuid(), lineNo: i + 1, itemName: named ?? fallback.name, articleId: named ? null : ARTICLE_IDS.get(fallback.code) ?? null, qty, unitPrice, amount, vatRate: null, orderNumber });
  }
  const appNumber = typeof body?.appNumber === 'string' && body.appNumber.trim() !== '' ? body.appNumber.trim() : `АПП-${String(nextActNo++).padStart(3, '0')}`;
  if (ACTS.some((a) => a.appNumber === appNumber)) return { error: { code: 'NUMBER_TAKEN', message: `Акт с номером ${appNumber} уже существует` } };
  let dateMs = TODAY;
  if (typeof body?.actDate === 'string' && body.actDate !== '') {
    const t = Date.parse(body.actDate);
    if (Number.isNaN(t)) return badRequest('INVALID_DATE', 'Дата акта не распознана');
    dateMs = t;
  }
  const act: Act = {
    id: uuid(), appNumber, customer, orderId, orderNumber, dateMs, totalAmount: round2(total), warehouse: null, division: null, businessDirection: null,
    managerName: MANAGERS[0], managerId: MANAGER_ID, status: 'Оформлен в сервисе', isPosted: true, raw: null, createdMs: TODAY + 10 * 3600 * 1000, lines,
  };
  ACTS.unshift(act);
  const out = actJSON(act);
  out.lines = act.lines.map((l) => actLineJSON(act, l));
  out.customer = { name: customer.name };
  return out;
}

// ───────────────────────────── кредитные линии ДАМУ ─────────────────────────────

interface Sched { id: string; trancheId: string; dueMs: number; total: number; principal: number; interest: number; contract: string }

interface CreditLine {
  id: string; name: string; contractNumber: string; limitAmount: number; usedAmount: number; availableAmount: number; interestRatePct: number;
  asOfMs: number; sourceFile: string; tranchesCount: number; schedule: Sched[]; recent: Array<{ dateMs: number; total: number; principal: number; interest: number; status: string }>;
}

/** Аннуитет по траншу: банк расписал ОД/% на каждую дату вперёд */
function schedule(trancheId: string, contract: string, amount: number, startMs: number, months: number, ratePct: number): Sched[] {
  const r = ratePct / 100 / 12;
  const pay = round2((amount * r) / (1 - Math.pow(1 + r, -months)));
  const out: Sched[] = [];
  let rest = amount;
  for (let m = 1; m <= months; m++) {
    const interest = round2(rest * r);
    const principal = m === months ? round2(rest) : round2(pay - interest);
    rest = round2(rest - principal);
    const d = new Date(startMs);
    out.push({ id: uuid(), trancheId, dueMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, 15), total: round2(principal + interest), principal, interest, contract });
  }
  return out;
}

function buildCreditLines(): CreditLine[] {
  const mk = (name: string, contract: string, limit: number, used: number, rate: number, asOfMs: number, sourceFile: string, tranches: Array<[number, number, number]>): CreditLine => {
    const sched: Sched[] = [];
    tranches.forEach(([amount, startOffsetDays, months], i) => {
      sched.push(...schedule(uuid(), `${contract}-Т${i + 1}`, amount, dayMs(startOffsetDays), months, rate));
    });
    // факт погашений — прошедшие даты графика, банк подписывает «Оплачено»
    const past = sched.filter((s) => s.dueMs < TODAY).sort((a, b) => b.dueMs - a.dueMs);
    const byDate = new Map<number, { dateMs: number; total: number; principal: number; interest: number; status: string }>();
    for (const s of past) {
      const r = byDate.get(s.dueMs) ?? { dateMs: s.dueMs, total: 0, principal: 0, interest: 0, status: 'Оплачено' };
      r.total = round2(r.total + s.total); r.principal = round2(r.principal + s.principal); r.interest = round2(r.interest + s.interest);
      byDate.set(s.dueMs, r);
    }
    const recent = [...byDate.values()].sort((a, b) => b.dateMs - a.dateMs).slice(0, 12);
    return { id: uuid(), name, contractNumber: contract, limitAmount: limit, usedAmount: used, availableAmount: round2(limit - used), interestRatePct: rate, asOfMs, sourceFile, tranchesCount: tranches.length, schedule: sched, recent };
  };
  return [
    mk('ДАМУ 6% А77 — 100 млн · график 2024', 'AG2/2023/U/S/005736', 100_000_000, 87_400_000, 6, dayMs(-6), 'Кредит ДАМУ А77 08.2026.xlsx',
      [[25_000_000, -610, 36], [22_400_000, -480, 36], [20_000_000, -330, 36], [20_000_000, -170, 36]]),
    mk('ДАМУ 6% ЦМК — 250 млн · график 2025', 'AG2/2025/U/S/007412', 250_000_000, 163_000_000, 6, dayMs(-6), 'Кредит ДАМУ ЦМК 08.2026.xlsx',
      [[60_000_000, -400, 60], [55_000_000, -250, 60], [48_000_000, -95, 60]]),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

const CREDIT_LINES: CreditLine[] = buildCreditLines();

/** GET /credit-lines — nextPayment несёт decimal-строки, всё остальное — числа */
function creditLines() {
  return CREDIT_LINES.map((l) => {
    const upcoming = l.schedule.filter((s) => s.dueMs >= TODAY).sort((a, b) => a.dueMs - b.dueMs);
    const next = upcoming[0];
    return {
      id: l.id, name: l.name, contractNumber: l.contractNumber, limitAmount: l.limitAmount, usedAmount: l.usedAmount, availableAmount: l.availableAmount,
      interestRatePct: l.interestRatePct, asOfDate: iso(l.asOfMs), sourceFile: l.sourceFile, tranchesCount: l.tranchesCount,
      nextPayment: next ? { id: next.id, trancheId: next.trancheId, dueDate: iso(next.dueMs), totalAmount: dec(next.total), principalAmount: dec(next.principal), interestAmount: dec(next.interest), trancheContract: next.contract } : null,
      upcomingTotal: round2(upcoming.reduce((s, x) => s + x.total, 0)),
      recentPayments: l.recent.map((p) => ({ paymentDate: iso(p.dateMs), totalAmount: p.total, principalAmount: p.principal, interestAmount: p.interest, status: p.status })),
    };
  });
}

// ───────────────────────────── маршруты ─────────────────────────────

const docByPath = (path: string): Doc | undefined => docById(path.split('/')[2] ?? '');

export const routes: FixtureRoute[] = [
  // специфичные маршруты — выше /payment-documents/:id
  { method: 'GET', match: /^\/payment-documents\/customer-debts$/, handler: () => customerDebts() },
  { method: 'GET', match: /^\/payment-documents\/receivables$/, handler: () => receivables() },
  { method: 'GET', match: /^\/payment-documents\/reconciliation$/, handler: () => reconciliation() },
  { method: 'GET', match: /^\/payment-documents$/, handler: ({ params }) => listDocs(params) },
  { method: 'POST', match: /^\/payment-documents$/, handler: ({ body }) => createDoc(body) },
  {
    method: 'GET', match: /^\/payment-documents\/([^/]+)$/,
    handler: ({ path }) => { const d = docByPath(path); return d ? findOne(d) : notFound(`Payment document ${path.split('/')[2]} not found`); },
  },
  {
    method: 'POST', match: /^\/payment-documents\/([^/]+)\/payments$/,
    handler: ({ path, body }) => { const d = docByPath(path); return d ? addPayment(d, body) : notFound(`Payment document ${path.split('/')[2]} not found`); },
  },
  { method: 'GET', match: /^\/acceptance-acts$/, handler: ({ params }) => listActs(params) },
  { method: 'POST', match: /^\/acceptance-acts$/, handler: ({ body }) => createAct(body) },
  { method: 'GET', match: /^\/credit-lines$/, handler: () => creditLines() },
];
