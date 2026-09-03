import type { FixtureRoute } from './types';
import type {
  AllocationSummary, ContractorRequestsResponse, ContractorRequestStatus,
  Contractor, AllocateResult, AcceptResult, SendToBitrixResult,
  RoutingStageCode, RateTypeCode, WorkLocationCode, OrderRefShort, AllocationRow, SupplierAct,
} from '../../api/contractorRequests';

/**
 * Фикстуры подряда (03.09.2026): заявки на подряд, подрядчики, строки
 * подряда по заказам. Форма ответов — как у Go-обработчиков
 * backend-go/internal/modules/orders/contractor_{common,requests,work}.go:
 * decimal → строка в «сырых» записях (crRaw/cwRaw), float в сводках,
 * даты — PDate «2026-08-26T11:39:22.867Z».
 *
 * Заказы, БИНы подрядчиков и заказы поставщику 1С — из реальной базы;
 * заявки и разнесение — синтетика (в базе только тестовые ПОДР-001…006).
 * Арифметика разнесения (splitAmount / redistribute / allocationSummary)
 * перенесена дословно, чтобы список, карточка и приёмка сходились копейка
 * в копейку так же, как на бэкенде.
 */

type Stage = RoutingStageCode;
type RateType = RateTypeCode;
type Loc = WorkLocationCode;
type Status = ContractorRequestStatus;

const DAY = 86_400_000;
const NOW_MS = Date.UTC(2026, 8, 3, 9, 15, 0, 0); // 2026-09-03 14:15 Астана

// ---- детерминированность: seed-генератор и uuid из ключа ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260903);

function fnv(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function uuidFrom(key: string): string {
  const hex = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x7f4a7c15]
    .map((s) => fnv(key, s).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Момент N дней назад в рабочие часы (08:00–17:00 Астаны) */
function stamp(daysAgo: number): Date {
  const d = new Date(NOW_MS - daysAgo * DAY);
  d.setUTCHours(3 + Math.floor(rng() * 9), Math.floor(rng() * 60), Math.floor(rng() * 60), Math.floor(rng() * 1000));
  if (d.getTime() > NOW_MS) d.setTime(NOW_MS - Math.floor(rng() * 3_600_000));
  return d;
}
const dateOnly = (s: string | null): Date | null => (s ? new Date(`${s}T00:00:00.000Z`) : null);
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
/** decimal.Decimal → JSON-строка без хвостовых нулей («2500», «33.333») */
const dec = (n: number | null): string | null => (n == null ? null : String(n));

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const RATE_UNITS: Record<RateType, string> = { PER_HOUR: 'ч', PER_UNIT: 'шт', PER_KG: 'кг', PER_TON: 'т', FIXED: 'ед.' };
const STAGE_LABELS: Record<Stage, string> = {
  CUTTING: 'Резка',
  ASSEMBLY: 'Сборка / сварка / обшивка',
  PAINTING: 'Зачистка / покраска',
};
const STAGES: Stage[] = ['CUTTING', 'ASSEMBLY', 'PAINTING'];
const RATE_TYPES: RateType[] = ['PER_HOUR', 'PER_UNIT', 'PER_KG', 'PER_TON', 'FIXED'];
const isStage = (s: unknown): s is Stage => typeof s === 'string' && (STAGES as string[]).includes(s);
const isRateType = (s: unknown): s is RateType => typeof s === 'string' && (RATE_TYPES as string[]).includes(s);

const USER_PLANNER = '3f1c2a9e-5b74-4d1a-9c0e-2b8d7a6f5e41';
const USER_FOREMAN = '8a6e4d2c-1f39-4b7d-8e5a-6c3b2d1f0a97';

// ---- строки таблиц ----

interface ContractorRow {
  id: string; name: string; binIin: string | null; defaultRateType: RateType; defaultRate: number;
  defaultWorkLocation: Loc; isActive: boolean; notes: string | null; createdAt: Date;
}
interface OrderRow {
  id: string; orderNumber: string; status: string; plannedShipmentDate: Date | null;
  customer: string; item: string; lineId: string;
}
interface RequestRow {
  id: string; number: string; routingStage: Stage; description: string; rateType: RateType;
  plannedQty: number | null; rate: number | null; estimatedAmount: number | null; contractorId: string | null;
  workLocation: Loc; plannedHours: number | null; status: Status; bitrixDealId: string | null;
  bitrixSentAt: Date | null; actualQty: number | null; actualAmount: number | null; acceptedAt: Date | null;
  acceptedById: string | null; paymentDocumentId: string | null; createdById: string | null;
  createdAt: Date; updatedAt: Date; note: string | null;
}
interface WorkRow {
  id: string; orderId: string; orderLineId: string | null; routingStage: Stage; contractorId: string;
  share: number; rateType: RateType; rate: number; actualQty: number | null; actualWorkers: number | null;
  actualAmount: number | null; workLocation: Loc; plannedHours: number | null; requestId: string | null;
  decidedById: string | null; decidedAt: Date; reason: string | null; acceptedById: string | null;
  acceptedAt: Date | null; contractDocId: string | null; note: string | null;
}
interface PaymentDoc {
  id: string; doNumber: string; doDate: Date; totalAmount: number; bin: string; contractorName: string; orderId: string | null;
}
interface Brief { id: string; name: string; binIin: string | null }
interface OrderRef extends OrderRefShort { status?: string; plannedShipmentDate?: string | null }

// ---- подрядчики (БИНы — контрагенты из 1С, по ним матчатся акты) ----

const CONTRACTOR_SPECS: Array<[string, string | null, RateType, number, Loc, boolean, string | null, number]> = [
  ['ТОО «СварМонтаж Астана»', '111240003404', 'PER_HOUR', 2500, 'OUR_SHOP', true, 'Сварщики NAKS в наш цех, оплата по часам', 13],
  ['СтальЦинк, ТОО', '070740003913', 'PER_TON', 185000, 'CONTRACTOR_SITE', true, 'Горячее цинкование, ванна 12 м. Минимальная партия 2 т', 12],
  ['ТОО "NATIONAL COATING"', '710907301136', 'PER_KG', 95, 'CONTRACTOR_SITE', true, 'Порошковая покраска, RAL по каталогу. Забирают сами', 12],
  ['Welding Company TOO', '070940026088', 'PER_HOUR', 3200, 'OUR_SHOP', true, 'Бригада 4 сварщика, полуавтомат свой', 11],
  ['Касимов, ИП', '700707302600', 'PER_TON', 130000, 'CONTRACTOR_SITE', true, 'Сборка и сварка ферм на площадке в Косшы', 10],
  ['Нурдаулет, ИП', '880326451510', 'PER_UNIT', 18000, 'OUR_SHOP', true, 'Обшивка контейнеров сэндвич-панелью, за панель', 9],
  ['Малдыбаев, ИП', '850219300394', 'PER_UNIT', 350, 'CONTRACTOR_SITE', true, 'Плазма до 40 мм, лазер до 12 мм. Ставка за рез', 8],
  ['Бисен Азамат Мырзаханұлы', 'C-BF3CDEB8F2', 'PER_UNIT', 4500, 'OUR_SHOP', true, 'Зачистка и покраска в нашем цеху, оплата за штуку', 6],
  ['ТОО СварМонтаж (проверка)', null, 'PER_TON', 100000, 'CONTRACTOR_SITE', false, null, 1],
];
const CONTRACTORS: ContractorRow[] = CONTRACTOR_SPECS.map(([name, binIin, rt, rate, loc, active, notes, weeks]) => ({
  id: uuidFrom(`contractor-${name}`), name, binIin, defaultRateType: rt, defaultRate: rate,
  defaultWorkLocation: loc, isActive: active, notes, createdAt: stamp(weeks * 7 + 3),
}));
const ct = (i: number) => CONTRACTORS[i];
const ctById = (id: string | null) => (id ? CONTRACTORS.find((c) => c.id === id) ?? null : null);
const brief = (c: ContractorRow | null): Brief | null => (c ? { id: c.id, name: c.name, binIin: c.binIin } : null);

// ---- заказы (реальные: id, номер, отгрузка, первая позиция) ----

const ORDER_SPECS: Array<[string, string, string, string | null, string, string, string]> = [
  ['fe559184-40df-4632-a88a-9a72e9b7dfb6', 'Т7АА-002558', 'CONFIRMED', '2026-09-24', 'Дельта Казстрой, ТОО', 'Остановочный комплекс', '0a4f84bd-c283-4473-aff0-361b55f425f0'],
  ['e505757c-a52f-439e-8935-940ae3e028f1', 'Т7АА-002557', 'IN_PRODUCTION', '2026-08-25', 'Аврора 75, ТОО', 'Контейнер технологический - Шелтор 0123 (2х2)', '0de0ba34-ec5e-477a-a5a8-c7bb961e7c35'],
  ['df852138-d881-46fb-823e-d51904644fb0', 'Т7АА-002555', 'IN_PRODUCTION', '2026-08-24', 'Аврора 75, ТОО', 'Мачта М25м на пространственной раме (секция 2м) рама в сборе ГЦ', '06351722-ca1c-459a-9528-c95e6686c07d'],
  ['5da07110-985f-4c64-aef0-50fb158eb137', 'Т7АА-002554', 'CONFIRMED', '2026-08-24', 'Аврора 75, ТОО', 'U-болт под трубу ф76мм', '0d4867cb-d1bd-4a0f-96cb-70e079b113b1'],
  ['364fa797-4ee4-4c2b-b254-e5645fd5453b', 'Т7АА-002553', 'CONFIRMED', '2026-09-20', 'КазДаму Invest', 'Изготовление навес (Южная сторона)', '9ed86111-8bda-421f-99e5-9d8daa6acc19'],
  ['b171b296-bbae-4842-a825-3a317f01bc9a', 'Т7АА-002551', 'CONFIRMED', '2026-09-03', 'Аврора Сервис, ТОО', 'Антивандальное ограждение Outdoor 1300х1120х2530', 'a9d36e69-c793-4ff9-936c-b7e681c2fca6'],
  ['c0ca51a3-5bce-4454-a187-6b281be8811d', 'Т7АА-002549', 'CONFIRMED', '2026-09-17', 'Аврора Сервис, ТОО', 'Мангальная зона', '48ef1ad8-801b-45de-b2d8-f3672ae2de6f'],
  ['f3ebb25b-f013-4169-b696-c197c4a30688', 'Т7АА-002544', 'CONFIRMED', '2026-08-13', 'Аврора 75, ТОО', 'Швеллерная пояс L400 mm под трубу ф300мм', '0215d1f1-bf00-4ac9-ab3f-1039709a3c2a'],
  ['36eee01e-689f-4df7-b195-12dfcbfc2ac0', 'Т7АА-002542', 'CONFIRMED', '2026-09-10', 'ТОО «GravIX Urban»', 'Монтаж сендвича', '0ee9bbf8-c323-4b4a-9569-85a265c4d60b'],
  ['9b918428-55ff-454a-ace8-2edcb7d8b5cc', 'Т7АА-002541', 'CONFIRMED', '2026-09-09', 'Central Build, ТОО', 'Изготовление и монтаж металлоконструкций А+ Бизнес парк', '05d2cdc0-adc9-46b4-9223-810b7b951b71'],
  ['913d67ff-cf79-4e1b-a193-641ec67d0d69', 'Т7АА-002538', 'IN_PRODUCTION', '2026-09-05', 'НУР АСТАНА КУРЫЛЫС ТОО', 'Изготовление каркасов зенитных фонарей в кол-ве 5шт', '27d9bc49-fa4e-422e-822a-59f071ca2674'],
  ['78704234-3e58-41b4-8783-1acc7f9d54b3', 'Т7АА-002536', 'CONFIRMED', '2026-09-05', 'IDA INTERTASCO JV, ТОО', 'Изготовление доп. металлоконструкций платформы, пожарной лестницы здания №4', '10df38c8-c7da-4d1a-acc4-d1591b4057aa'],
  ['aec99a0a-3f39-4e33-a1b1-303f5910e97e', 'Т7АА-002534', 'READY_TO_SHIP', '2026-08-05', 'Аврора 75, ТОО', 'Пластина крепежная 100х100х6мм', '2c1f3f6f-97db-4ef8-89ba-15bcac77fc99'],
  ['c73e9113-b30c-409b-bb72-ca2aefccefd6', 'Т7АА-002531', 'CONFIRMED', '2026-08-09', 'Аврора 75, ТОО', 'Крепление к уголковой мачте L-300мм', '02802861-3317-4493-993c-9e83d9880e35'],
  ['e7020ed2-9f80-4359-b402-dcaa9d873614', 'Т7АА-002530', 'CONFIRMED', '2026-09-03', 'BI URBAN CONSTRUCTION, ТОО', 'Реконструкция здания, инженерных и технологических систем объекта', '80cf374d-e4ea-41b6-b3ab-a0c078d6fc01'],
  ['cd92a829-9b7f-4fdf-9982-1b77615ac995', 'Т7АА-002529', 'CONFIRMED', '2026-09-02', 'IDA INTERTASCO JV, ТОО', 'Изготовление и монтаж металлоконструкций для обьекта Carlsberg', '7efe4a2d-9daf-4e04-867e-559ad9a6c667'],
  ['36b1e150-4e84-45ce-a086-797a63a09a55', 'Т7АА-002528', 'IN_PRODUCTION', '2026-08-03', 'Аврора 75, ТОО', 'Мачта М25м на пространственной раме (секция 2м) в сборе', '0909cb8e-995e-45fb-ac75-4e1068d94cfe'],
  ['d0dd0229-62fe-470a-9e5d-bc2b16f54f86', 'Т7АА-002525', 'CONFIRMED', '2026-09-02', 'ТОО «GravIX Urban»', 'Монтаж кровавельной сэндвич панели 120мм', '17a4729a-48e1-4064-98c6-b35273c8a533'],
  ['074ce3b0-d942-442c-81c6-ef564641d19c', 'Т7АА-002523', 'CONFIRMED', '2026-09-01', 'IDA INTERTASCO JV, ТОО', 'Пластины для восстановления существующих колонн, 61шт', '05b9be0f-f168-44dc-bf63-bf11597421f6'],
  ['4248868b-7d62-461d-9b6c-1d81cc3c2106', 'Т7АА-002519', 'CONFIRMED', '2026-08-29', 'КазДаму Invest', 'изготовление  и монтаж металлоконструкций', '55f01249-c462-4e34-a6d3-44c832592667'],
  ['46c8b3ff-c20b-4741-b28c-29b136ce74d2', 'Т7АА-002518', 'IN_PRODUCTION', '2026-08-29', 'Greystone Construction, ТОО', 'Контейнер технологический - Шелтор 0123 (2х2)', '19ef95ec-5311-4dc7-9b94-f1362c66ec53'],
  ['32e5a76c-c1c4-4ea9-9e53-ef15b0c78368', 'Т7АА-002517', 'CONFIRMED', '2026-08-28', 'Qonay Stroy, ТОО', 'Резка пластин 1100х3000х20мм', '370c9d7f-6929-4a83-a1cc-1a7711990390'],
  ['c2fb827d-065d-4ee7-a791-cf9587ea34c2', 'Т7АА-002512', 'CONFIRMED', '2026-08-25', 'Greystone Construction, ТОО', 'Контейнер технологический - Шелтор 0123 (1х2)', 'f281d9a1-9e1f-444c-b269-55507f8bc29f'],
  ['72059f17-0554-45dd-bf8f-c5992947c239', 'Т7АА-002510', 'CONFIRMED', '2026-08-21', 'Китайская Компания по строительству и развитию Синьсин в РК, Филиал ТОО', 'Остановочный павильон', '71a1e853-5dd5-4897-8c47-e61f45518204'],
  ['577e38e6-33c9-43de-861d-8c768afe3dfd', 'Т7АА-002509', 'CONFIRMED', '2026-08-21', 'КазДаму Invest', 'Изготовление металлоконструкций', '58eaf72b-7c10-43be-ae2d-a84448da3b5b'],
  ['35de5464-d000-451e-bdd3-1223ab032e84', 'Т7АА-002506', 'CONFIRMED', '2026-08-18', 'IDA INTERTASCO JV, ТОО', 'Пластина 200х96х6мм, 28шт', '03bdc53c-7caf-4421-b144-277fb6c11700'],
  ['b32a1b90-092e-4234-a7ac-ad9e87199739', 'Т7АА-002499', 'IN_PRODUCTION', '2026-08-14', 'Аврора Сервис, ТОО', 'Телекоммуникационный контейнер 10,5х3х2,7м', '4f57d6c6-ed81-4186-8b2a-b85fc97499ed'],
  ['63a8ac44-1740-449e-a722-f9337b639edd', 'Т7АА-002496', 'CONFIRMED', '2026-08-08', 'НУР АСТАНА КУРЫЛЫС ТОО', 'Усиление базы существующей металлической колонны К5', 'a504ab83-92cd-498f-925a-7c3602e7f10c'],
  ['f21d4905-7608-449c-be5d-3fd916c8c827', 'Т7АА-002492', 'CONFIRMED', '2026-08-06', 'КазДаму Invest', 'Изготовление гнутого швеллера 220х140х4, L-6000мм, 5шт', '9d718279-a45d-42ce-8124-2134f347cf3a'],
  ['174a4c35-f664-42e6-b255-7a736251b44a', 'Т7АА-002491', 'IN_PRODUCTION', null, 'Аврора 75, ТОО', 'Мачта М25м на пространственной раме (секция 2м) в сборе', '00339b82-9622-4607-a68f-db2d12135ed8'],
  ['96fabec1-b08f-4060-b2a2-8d228b3b777f', 'Т7АА-002484', 'CONFIRMED', '2026-07-30', 'НУР АСТАНА КУРЫЛЫС ТОО', 'Изготовление и монтаж каркаса под зенитный фонарь 6х6м блока 1,2', '17bfc399-a9d9-4325-b6e4-3c8c2fd136fd'],
  ['2f64b9b6-d243-4f06-ac23-eb374a6c725f', 'Т7АА-002479', 'IN_PRODUCTION', '2026-07-22', 'Greystone Construction, ТОО', 'Контейнер технологический - Шелтор 0123 (2х2)', '101ca45c-e3ef-4896-aebb-b114ae1cf6b1'],
  ['6193d0bc-b006-4423-87c9-848c06c5aa17', 'Т7АА-002478', 'CONFIRMED', '2026-07-22', 'Greystone Construction, ТОО', 'Ограждение 6000х6000мм (круг ф12) L63 под квадропод (UK5485)', '3cf68438-c9e3-4658-af9c-d00cb8b7fa0c'],
];
const ORDERS: OrderRow[] = ORDER_SPECS.map(([id, orderNumber, status, ship, customer, item, lineId]) => ({
  id, orderNumber, status, plannedShipmentDate: dateOnly(ship), customer, item, lineId,
}));
const orderById = (id: string) => ORDERS.find((o) => o.id === id) ?? null;
const orderRefShort = (o: OrderRow): OrderRef => ({ id: o.id, orderNumber: o.orderNumber });
const orderRefFull = (o: OrderRow): OrderRef => ({
  id: o.id, orderNumber: o.orderNumber, status: o.status, plannedShipmentDate: iso(o.plannedShipmentDate),
});

// ---- заказы поставщику 1С (реальные, контрагент — по БИН) ----

const PD_SPECS: Array<[string, string, string, number, string, string]> = [
  ['b5ceeed9-c5d1-42d9-9696-4874cb00691f', 'Т7АА-000876', '2026-08-19', 3596160, '070740003913', 'СтальЦинк, ТОО'],
  ['d515044f-cac5-4aa3-8ad3-cf620c18206b', 'Т7АА-000837', '2026-08-11', 6416640, '070740003913', 'СтальЦинк, ТОО'],
  ['583c2f1a-ce27-406f-acd7-565c56aa48a1', 'Т7АА-000804', '2026-07-29', 1245750, '710907301136', 'ТОО "NATIONAL COATING"'],
  ['4a1a53fc-bac6-46a9-bbb2-91b611101633', 'Т7АА-000746', '2026-07-15', 1645000, '710907301136', 'ТОО "NATIONAL COATING"'],
  ['334ab3c9-1348-4fde-8a8e-5eb7f4bb0563', 'Т7АА-000175', '2026-04-02', 1681528, '710907301136', 'ТОО "NATIONAL COATING"'],
  ['30de1bd5-6e93-4b6b-b154-b169e3d2d477', 'Т7АА-000374', '2025-10-15', 6817440, '710907301136', 'ТОО "NATIONAL COATING"'],
  ['deb77fa5-15da-4e75-a59e-f8e330664c3a', 'Т7АА-000702', '2026-07-08', 8840, '070940026088', 'Welding Company TOO'],
  ['b296070a-7c11-48d8-8caf-8d9954076c25', 'Т7АА-000379', '2025-10-08', 2510700, '070940026088', 'Welding Company TOO'],
  ['f203e706-6c04-4bdd-a3a9-cbcc6a58251a', 'Т7АА-000286', '2025-08-29', 24534, '070940026088', 'Welding Company TOO'],
  ['e82b4e74-3322-428a-bdfe-13a5afe52c48', 'Т7АА-000288', '2025-08-28', 505666, '070940026088', 'Welding Company TOO'],
  ['ee820624-d44d-4f1b-aae2-3f644f4a3e9d', 'Т7АА-000843', '2026-08-12', 780000, '700707302600', 'Касимов, ИП'],
  ['cfcae913-45bb-4151-ad77-fc316ef4fdcb', 'Т7АА-000615', '2026-06-19', 3300000, '700707302600', 'Касимов, ИП'],
  ['71a6e0bc-d041-4cc0-ad9c-18cd3ddd9be2', 'Т7АА-000554', '2026-06-11', 26390000, '700707302600', 'Касимов, ИП'],
  ['0a13963a-fed2-45e6-a02c-cdca695f23e2', 'Т7АА-000868', '2026-08-18', 2088000, '850219300394', 'Малдыбаев, ИП'],
  ['a02afd64-a13e-4c3b-a156-dea77b3e79a9', 'Т7АА-000778', '2026-07-23', 6034000, '880326451510', 'Нурдаулет, ИП'],
  ['68bd04a3-0365-461b-9df1-ddb7245a140a', 'Т7АА-000647', '2026-06-26', 1870400, '880326451510', 'Нурдаулет, ИП'],
  ['4560d3f7-bb0d-41ac-a3e7-2e468b2260ef', 'Т7АА-000625', '2026-06-22', 1320000, '880326451510', 'Нурдаулет, ИП'],
  ['e83db246-cf0f-41d8-b32a-d9985c376471', 'Т7АА-000898', '2026-08-21', 131600, 'C-BF3CDEB8F2', 'Бисен Азамат Мырзаханұлы'],
  ['817ab5ba-27a2-479b-86a4-4a3c9c1de13d', 'Т7АА-000875', '2026-08-19', 15000, 'C-BF3CDEB8F2', 'Бисен Азамат Мырзаханұлы'],
  ['9f02cbec-6575-46de-8b56-b77efe269f08', 'Т7АА-000874', '2026-08-19', 98000, 'C-BF3CDEB8F2', 'Бисен Азамат Мырзаханұлы'],
];
const PAYMENT_DOCS: PaymentDoc[] = PD_SPECS.map(([id, doNumber, date, totalAmount, bin, contractorName]) => ({
  id, doNumber, doDate: dateOnly(date) as Date, totalAmount, bin, contractorName, orderId: null,
}));
const pdByNumber = (n: string) => PAYMENT_DOCS.find((d) => d.doNumber === n) ?? null;

// ---- заявки на подряд: партия → Б24 → разнесение → акт ----

interface AllocSpec { o: number; qty: number; share?: number; decided: number; line?: boolean }
interface ReqSpec {
  stage: Stage; desc: string; rt: RateType;
  qty: number | null; rate: number | null; est?: number;
  ct: number | null; loc: Loc; hours?: number;
  status: Status; created: number;
  sent?: number; deal?: string;
  accepted?: number; aQty?: number; aAmt?: number; pd?: string;
  alloc?: AllocSpec[]; note?: string;
}

// Порядок — от старой к новой: номер ПОДР-NNN = индекс + 1
const REQ_SPECS: ReqSpec[] = [
  { stage: 'ASSEMBLY', desc: 'Сборка и сварка рам мачт М25м, секции 2 м — партия июль', rt: 'PER_TON', qty: 22, rate: 130000, ct: 4, loc: 'CONTRACTOR_SITE',
    status: 'ALLOCATED', created: 75, sent: 73, deal: '4097', accepted: 50, aQty: 21.6, aAmt: 2808000,
    alloc: [{ o: 16, qty: 12.4, share: 0.6, decided: 56 }, { o: 29, qty: 9.2, decided: 53 }] },
  { stage: 'CUTTING', desc: 'Резка пластин 1100×3000×20 мм — плазма (Qonay Stroy)', rt: 'FIXED', qty: 1, rate: null, est: 480000, ct: 6, loc: 'CONTRACTOR_SITE',
    status: 'ALLOCATED', created: 64, sent: 63, deal: '4101', accepted: 55, aQty: 1, aAmt: 480000,
    alloc: [{ o: 21, qty: 1, decided: 58 }] },
  { stage: 'PAINTING', desc: 'Порошковая покраска ограждений Outdoor RAL 7016', rt: 'PER_KG', qty: 1850, rate: 95, ct: 2, loc: 'CONTRACTOR_SITE',
    status: 'ALLOCATED', created: 60, sent: 59, deal: '4133', accepted: 36, aQty: 1830, aAmt: 173850,
    alloc: [{ o: 5, qty: 1100, decided: 41 }, { o: 32, qty: 730, decided: 39 }] },
  { stage: 'ASSEMBLY', desc: 'Обшивка контейнеров Шелтор 0123 (2×2) сэндвич-панелью', rt: 'PER_UNIT', qty: 48, rate: 18000, ct: 5, loc: 'OUR_SHOP', hours: 190,
    status: 'ALLOCATED', created: 58, sent: 56, deal: '4140', accepted: 40, aQty: 48, aAmt: 864000,
    alloc: [{ o: 20, qty: 24, decided: 45, line: true }, { o: 31, qty: 24, decided: 43 }] },
  { stage: 'CUTTING', desc: 'Резка швеллера 12У в размер — крепления к уголковой мачте', rt: 'PER_UNIT', qty: 640, rate: 350, ct: 6, loc: 'CONTRACTOR_SITE',
    status: 'ALLOCATED', created: 52, sent: 51, deal: '4152', accepted: 44, aQty: 640, aAmt: 224000,
    alloc: [{ o: 13, qty: 640, decided: 46 }] },
  { stage: 'PAINTING', desc: 'Горячее цинкование креплений и U-болтов', rt: 'PER_TON', qty: 2.4, rate: 185000, ct: 1, loc: 'CONTRACTOR_SITE',
    status: 'ALLOCATED', created: 47, sent: 46, deal: '4160', accepted: 30, aQty: 2.62, aAmt: 484700,
    alloc: [{ o: 3, qty: 1.42, decided: 33 }, { o: 13, qty: 1.2, decided: 32 }] },
  { stage: 'ASSEMBLY', desc: 'Сварщики в наш цех — усиление бригады на мачтах (август)', rt: 'PER_HOUR', qty: 320, rate: 2500, ct: 0, loc: 'OUR_SHOP',
    status: 'ALLOCATED', created: 45, sent: 44, deal: '4171', accepted: 20, aQty: 336, aAmt: 840000,
    alloc: [{ o: 16, qty: 180, share: 0.4, decided: 24 }, { o: 2, qty: 156, share: 0.4, decided: 22 }] },
  { stage: 'PAINTING', desc: 'Пескоструй и грунт колонн К5', rt: 'PER_UNIT', qty: 6, rate: 42000, ct: 7, loc: 'CONTRACTOR_SITE',
    status: 'ALLOCATED', created: 42, sent: 41, deal: '4180', accepted: 33, aQty: 6, aAmt: 252000,
    alloc: [{ o: 27, qty: 6, decided: 35 }] },
  { stage: 'CUTTING', desc: 'Гильотина: лист 4 мм на заготовки контейнеров Шелтор', rt: 'PER_UNIT', qty: 380, rate: 420, ct: 6, loc: 'CONTRACTOR_SITE',
    status: 'ALLOCATED', created: 40, sent: 39, deal: '4188', accepted: 31, aQty: 380, aAmt: 159600,
    alloc: [{ o: 20, qty: 190, decided: 34 }, { o: 22, qty: 95, decided: 34 }, { o: 31, qty: 95, decided: 33 }] },
  { stage: 'PAINTING', desc: 'Порошковая покраска каркасов зенитных фонарей RAL 9003', rt: 'PER_KG', qty: 3100, rate: 95, ct: 2, loc: 'CONTRACTOR_SITE',
    status: 'SENT', created: 38, sent: 37, deal: '4192',
    alloc: [{ o: 10, qty: 1400, decided: 30 }] },
  { stage: 'ASSEMBLY', desc: 'Сварка ферм навеса — южная сторона (КазДаму)', rt: 'PER_TON', qty: 9.5, rate: 140000, ct: 4, loc: 'CONTRACTOR_SITE',
    status: 'ALLOCATED', created: 36, sent: 35, deal: '4195', accepted: 12, aQty: 9.8, aAmt: 1372000,
    alloc: [{ o: 4, qty: 9.8, decided: 14 }] },
  { stage: 'ASSEMBLY', desc: 'Сварка ферм навеса — дубль ПОДР-011', rt: 'PER_TON', qty: 10, rate: 140000, ct: 4, loc: 'CONTRACTOR_SITE',
    status: 'CANCELLED', created: 35, sent: 34, deal: '4195', note: 'Завели дважды, оставили ПОДР-011' },
  { stage: 'PAINTING', desc: 'Горячее цинкование рам мачт М25 (ГЦ) — партия август', rt: 'PER_TON', qty: 34, rate: 185000, ct: 1, loc: 'CONTRACTOR_SITE',
    status: 'ALLOCATED', created: 35, sent: 34, deal: '4200', accepted: 22, aQty: 34.68, aAmt: 6416640, pd: 'Т7АА-000837',
    alloc: [{ o: 16, qty: 14.2, decided: 27 }, { o: 29, qty: 12.5, decided: 26 }, { o: 2, qty: 7.98, share: 0.6, decided: 25, line: true }] },
  { stage: 'PAINTING', desc: 'Горячее цинкование рам мачт М25 (ГЦ) — партия август-2', rt: 'PER_TON', qty: 19, rate: 185000, ct: 1, loc: 'CONTRACTOR_SITE',
    status: 'ACCEPTED', created: 30, sent: 29, deal: '4210', accepted: 15, aQty: 19.44, aAmt: 3596160, pd: 'Т7АА-000876',
    alloc: [{ o: 2, qty: 8.1, share: 0.4, decided: 13 }] },
  { stage: 'ASSEMBLY', desc: 'Сборка платформы и пожарной лестницы здания №4', rt: 'PER_TON', qty: 6.2, rate: 125000, ct: 4, loc: 'CONTRACTOR_SITE',
    status: 'ACCEPTED', created: 26, sent: 25, deal: '4221', accepted: 22, aQty: 6.24, aAmt: 780000, pd: 'Т7АА-000843' },
  { stage: 'CUTTING', desc: 'Резка пластин 200×96×6 — заказчик отменил партию', rt: 'PER_UNIT', qty: 300, rate: 350, ct: 6, loc: 'CONTRACTOR_SITE',
    status: 'CANCELLED', created: 22 },
  { stage: 'CUTTING', desc: 'Плазменная резка пластин 20 мм под фланцы мачт М25', rt: 'FIXED', qty: 1, rate: null, est: 2088000, ct: 6, loc: 'CONTRACTOR_SITE',
    status: 'ACCEPTED', created: 20, sent: 19, deal: '4230', accepted: 16, aQty: 1, aAmt: 2088000, pd: 'Т7АА-000868' },
  { stage: 'PAINTING', desc: 'Порошковая покраска панелей контейнеров Шелтор', rt: 'PER_KG', qty: 2400, rate: 95, ct: 2, loc: 'CONTRACTOR_SITE',
    status: 'ACCEPTED', created: 19, sent: 18, deal: '4236', accepted: 9, aQty: 2380, aAmt: 226100,
    alloc: [{ o: 20, qty: 1200, decided: 11 }] },
  { stage: 'CUTTING', desc: 'Резка трубы ф76 под U-болты, 1 200 резов', rt: 'PER_UNIT', qty: 1200, rate: 180, ct: 6, loc: 'CONTRACTOR_SITE',
    status: 'ACCEPTED', created: 16, sent: 15, deal: '4240', accepted: 8, aQty: 1200, aAmt: 216000,
    alloc: [{ o: 3, qty: 700, decided: 10 }] },
  { stage: 'PAINTING', desc: 'Зачистка и грунт ПФ-115 балок с площадки KZ-ALM_Dudar', rt: 'PER_UNIT', qty: 120, rate: 4500, ct: 7, loc: 'OUR_SHOP', hours: 96,
    status: 'ACCEPTED', created: 14, sent: 13, deal: '4244', accepted: 5, aQty: 118, aAmt: 531000,
    alloc: [{ o: 7, qty: 40, decided: 7 }] },
  { stage: 'ASSEMBLY', desc: 'Сварка колонн К5 — усиление базы', rt: 'PER_HOUR', qty: 64, rate: 3200, ct: 3, loc: 'OUR_SHOP',
    status: 'ACCEPTED', created: 12, sent: 11, deal: '4250', accepted: 3, aQty: 60, aAmt: 192000 },
  { stage: 'ASSEMBLY', desc: 'Обшивка телеком-контейнера 10,5×3×2,7 м', rt: 'PER_UNIT', qty: 60, rate: 18000, ct: 5, loc: 'OUR_SHOP', hours: 240,
    status: 'ACCEPTED', created: 11, sent: 10, deal: '4255', accepted: 1, aQty: 60, aAmt: 1080000 },
  { stage: 'ASSEMBLY', desc: 'Сборка каркасов зенитных фонарей 6×6 м, 5 шт', rt: 'PER_UNIT', qty: 5, rate: 260000, ct: 4, loc: 'CONTRACTOR_SITE',
    status: 'SENT', created: 10, sent: 9, deal: '4258' },
  { stage: 'PAINTING', desc: 'Цинкование рам — перенесли в ПОДР-025', rt: 'PER_TON', qty: 4, rate: 185000, ct: 1, loc: 'CONTRACTOR_SITE',
    status: 'CANCELLED', created: 9, sent: 8, deal: '4262' },
  { stage: 'PAINTING', desc: 'Горячее цинкование рам мачт М25 (ГЦ) — партия сентябрь', rt: 'PER_TON', qty: 21, rate: 185000, ct: 1, loc: 'CONTRACTOR_SITE',
    status: 'SENT', created: 8, sent: 7, deal: '4262' },
  { stage: 'PAINTING', desc: 'Покраска — проверка пересчёта нормы', rt: 'PER_UNIT', qty: 10, rate: 4000, ct: 0, loc: 'CONTRACTOR_SITE',
    status: 'CANCELLED', created: 8 },
  { stage: 'CUTTING', desc: 'Лазерная резка косынок 8 мм по DXF', rt: 'PER_UNIT', qty: 920, rate: 260, ct: null, loc: 'CONTRACTOR_SITE',
    status: 'SENT', created: 7, sent: 5, deal: '4266' },
  { stage: 'ASSEMBLY', desc: 'Сварщики в наш цех — усиление бригады на мачтах (сентябрь)', rt: 'PER_HOUR', qty: 400, rate: 2500, ct: 0, loc: 'OUR_SHOP',
    status: 'SENT', created: 6, sent: 5, deal: '4266' },
  { stage: 'PAINTING', desc: 'Покраска ферм навеса эмалью ПФ-115 серая', rt: 'PER_UNIT', qty: 24, rate: 9500, ct: 7, loc: 'OUR_SHOP', hours: 72,
    status: 'SENT', created: 6, sent: 5, deal: '4266' },
  { stage: 'ASSEMBLY', desc: 'Сварка антивандальных ограждений Outdoor 1300×1120, 40 шт', rt: 'PER_UNIT', qty: 40, rate: 32000, ct: 4, loc: 'CONTRACTOR_SITE',
    status: 'SENT', created: 5, sent: 4, deal: '4270' },
  { stage: 'PAINTING', desc: 'Цинкование крепёжных пластин 100×100×6', rt: 'PER_TON', qty: 1.1, rate: 185000, ct: 1, loc: 'CONTRACTOR_SITE',
    status: 'SENT', created: 4, sent: 4, deal: '4270' },
  { stage: 'ASSEMBLY', desc: 'Сборка остановочного павильона, 2 шт (Синьсин)', rt: 'PER_TON', qty: 5.6, rate: 135000, ct: null, loc: 'CONTRACTOR_SITE',
    status: 'SENT', created: 3, sent: 2, deal: '4274' },
  { stage: 'CUTTING', desc: 'Резка листа 10 мм на полосы 100×3000', rt: 'PER_UNIT', qty: 210, rate: 600, ct: 6, loc: 'CONTRACTOR_SITE',
    status: 'SENT', created: 3, sent: 2, deal: '4274' },
  { stage: 'ASSEMBLY', desc: 'Сборка остановочного комплекса (Дельта Казстрой)', rt: 'PER_TON', qty: 7.2, rate: 135000, ct: null, loc: 'CONTRACTOR_SITE',
    status: 'DRAFT', created: 2 },
  { stage: 'PAINTING', desc: 'Горячее цинкование ограждения 6000×6000 под квадропод', rt: 'PER_TON', qty: 3.4, rate: 185000, ct: 1, loc: 'CONTRACTOR_SITE',
    status: 'DRAFT', created: 2 },
  { stage: 'CUTTING', desc: 'Резка уголка 63×5 под крепления к мачте', rt: 'PER_UNIT', qty: 480, rate: 300, ct: null, loc: 'CONTRACTOR_SITE',
    status: 'DRAFT', created: 1 },
  { stage: 'ASSEMBLY', desc: 'Сварка мангальной зоны по эскизу заказчика', rt: 'FIXED', qty: null, rate: null, est: 180000, ct: null, loc: 'CONTRACTOR_SITE',
    status: 'DRAFT', created: 1 },
  { stage: 'PAINTING', desc: 'Зачистка сварных швов остановочного комплекса', rt: 'PER_HOUR', qty: 48, rate: 2200, ct: 7, loc: 'OUR_SHOP',
    status: 'DRAFT', created: 1 },
  { stage: 'ASSEMBLY', desc: 'Сборка гнутого швеллера 220×140×4 в раму, 5 шт', rt: 'PER_UNIT', qty: 5, rate: 45000, ct: 5, loc: 'OUR_SHOP', hours: 40,
    status: 'DRAFT', created: 0 },
  { stage: 'CUTTING', desc: 'Плазменная резка косынок для мачт М25 — партия сентябрь', rt: 'FIXED', qty: null, rate: null, est: 640000, ct: 6, loc: 'CONTRACTOR_SITE',
    status: 'DRAFT', created: 0 },
  { stage: 'PAINTING', desc: 'Порошковая покраска ограждений (Greystone) RAL 7016', rt: 'PER_KG', qty: 1600, rate: 95, ct: 2, loc: 'CONTRACTOR_SITE',
    status: 'DRAFT', created: 0, note: 'Ждём подтверждения цвета от заказчика' },
  { stage: 'ASSEMBLY', desc: 'Монтаж сэндвич-панелей — бригада на объект GravIX', rt: 'PER_UNIT', qty: 120, rate: 6500, ct: null, loc: 'CONTRACTOR_SITE',
    status: 'DRAFT', created: 0 },
];

// ---- подряд по заказу напрямую (без заявки): POST /orders/:id/stages/:stage/contractor ----

interface WorkSpec {
  o: number; stage: Stage; ct: number; share: number; rt: RateType; rate: number; loc: Loc; hours?: number;
  decided: number; accepted?: number; aQty?: number; aAmt?: number; workers?: number; reason?: string; note?: string; line?: boolean;
}
const WORK_SPECS: WorkSpec[] = [
  { o: 1, stage: 'ASSEMBLY', ct: 5, share: 0.5, rt: 'PER_UNIT', rate: 18000, loc: 'OUR_SHOP', hours: 80, decided: 20, accepted: 6, aQty: 21, reason: 'Свои сборщики заняты мачтами' },
  { o: 0, stage: 'CUTTING', ct: 6, share: 1, rt: 'FIXED', rate: 350000, loc: 'CONTRACTOR_SITE', decided: 3, reason: 'Плазма в ремонте до 10.09' },
  { o: 4, stage: 'PAINTING', ct: 7, share: 1, rt: 'PER_UNIT', rate: 9500, loc: 'OUR_SHOP', hours: 60, decided: 9, reason: 'Маляр в отпуске' },
  { o: 6, stage: 'PAINTING', ct: 2, share: 1, rt: 'PER_KG', rate: 95, loc: 'CONTRACTOR_SITE', decided: 12, accepted: 2, aQty: 640 },
  { o: 9, stage: 'ASSEMBLY', ct: 4, share: 0.6, rt: 'PER_TON', rate: 130000, loc: 'CONTRACTOR_SITE', decided: 15, reason: 'Объём выше мощности цеха' },
  { o: 9, stage: 'ASSEMBLY', ct: 3, share: 0.4, rt: 'PER_HOUR', rate: 3200, loc: 'OUR_SHOP', decided: 15, reason: 'Объём выше мощности цеха' },
  { o: 11, stage: 'PAINTING', ct: 1, share: 1, rt: 'PER_TON', rate: 185000, loc: 'CONTRACTOR_SITE', decided: 18, accepted: 4, aQty: 6.2 },
  { o: 14, stage: 'ASSEMBLY', ct: 4, share: 1, rt: 'PER_TON', rate: 125000, loc: 'CONTRACTOR_SITE', decided: 25, accepted: 10, aQty: 14.6, aAmt: 1825000, note: 'Сумма по акту 1С' },
  { o: 15, stage: 'CUTTING', ct: 6, share: 1, rt: 'PER_UNIT', rate: 320, loc: 'CONTRACTOR_SITE', decided: 22, accepted: 14, aQty: 860 },
  { o: 17, stage: 'ASSEMBLY', ct: 5, share: 1, rt: 'PER_UNIT', rate: 6500, loc: 'CONTRACTOR_SITE', decided: 6, reason: 'Монтаж на объекте — своих монтажников нет' },
  { o: 18, stage: 'CUTTING', ct: 6, share: 1, rt: 'PER_UNIT', rate: 300, loc: 'CONTRACTOR_SITE', decided: 11, accepted: 5, aQty: 61, line: true },
  { o: 23, stage: 'PAINTING', ct: 2, share: 1, rt: 'PER_KG', rate: 95, loc: 'CONTRACTOR_SITE', decided: 16, reason: 'Заказчик требует порошковую' },
  { o: 26, stage: 'PAINTING', ct: 7, share: 0.5, rt: 'PER_HOUR', rate: 2200, loc: 'OUR_SHOP', decided: 19, accepted: 7, aQty: 36, workers: 2 },
  { o: 28, stage: 'CUTTING', ct: 6, share: 1, rt: 'FIXED', rate: 90000, loc: 'CONTRACTOR_SITE', decided: 27, accepted: 24, aQty: 1 },
  { o: 30, stage: 'ASSEMBLY', ct: 0, share: 0.3, rt: 'PER_HOUR', rate: 2500, loc: 'OUR_SHOP', decided: 34, accepted: 28, aQty: 96, workers: 2, reason: 'Срок отгрузки — усиление бригады' },
  { o: 24, stage: 'PAINTING', ct: 1, share: 1, rt: 'PER_TON', rate: 185000, loc: 'CONTRACTOR_SITE', decided: 2, reason: 'Цинкование — только у подрядчика' },
];

// ---- арифметика разнесения: перенос contractor_common.go ----

function splitAmount(total: number, qtys: number[]): number[] {
  const sum = qtys.reduce((s, q) => s + Math.max(0, q), 0);
  const parts = qtys.map(() => 0);
  if (!(sum > 0)) return parts;
  qtys.forEach((q, i) => { parts[i] = round2((total * Math.max(0, q)) / sum); });
  let lastIdx = -1;
  for (let i = qtys.length - 1; i >= 0; i--) if (qtys[i] > 0) { lastIdx = i; break; }
  if (lastIdx >= 0) {
    const others = parts.reduce((s, p, i) => (i === lastIdx ? s : s + p), 0);
    parts[lastIdx] = round2(total - others);
  }
  return parts;
}
function splitProportional(total: number, qtys: number[]): number[] {
  const sum = qtys.reduce((s, q) => s + Math.max(0, q), 0);
  if (!(sum > 0)) return qtys.map(() => 0);
  return qtys.map((q) => round3((total * Math.max(0, q)) / sum));
}

function workAmount(w: WorkRow): number | null {
  if (w.actualAmount != null) return w.actualAmount;
  if (w.rateType === 'FIXED') return w.rate;
  if (w.actualQty != null) return w.actualQty * w.rate;
  return null;
}

const REQUESTS: RequestRow[] = [];
const WORKS: WorkRow[] = [];
const reqById = (id: string) => REQUESTS.find((r) => r.id === id) ?? null;
const worksOf = (requestId: string) => WORKS.filter((w) => w.requestId === requestId);

/** Пересчёт долей по всем строкам заявки; знаменатель — принятый объём */
function redistribute(requestId: string): number {
  const req = reqById(requestId);
  if (!req) return 0;
  const rows = worksOf(requestId).sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());
  if (rows.length === 0) return 0;
  const qtys = rows.map((w) => w.actualQty ?? 0);
  const total = qtys.reduce((s, q) => s + q, 0);
  if (!(total > 0)) return 0;
  const denomQty = Math.max(total, req.actualQty ?? 0);
  const tail = round3(Math.max(0, denomQty - total));
  const withTail = tail > 1e-9 ? [...qtys, tail] : qtys;
  const n = qtys.length;
  const amounts = req.actualAmount != null ? splitAmount(req.actualAmount, withTail).slice(0, n) : null;
  const hours = req.plannedHours != null ? splitProportional(req.plannedHours, withTail).slice(0, n) : null;
  const fixedRates = req.rateType === 'FIXED' && req.estimatedAmount != null ? splitAmount(req.estimatedAmount, withTail).slice(0, n) : null;
  rows.forEach((w, i) => {
    if (amounts) w.actualAmount = amounts[i];
    if (hours) w.plannedHours = round3(hours[i]);
    if (fixedRates) w.rate = amounts ? amounts[i] : fixedRates[i];
  });
  return n;
}

REQ_SPECS.forEach((s, i) => {
  const number = `ПОДР-${String(i + 1).padStart(3, '0')}`;
  const id = uuidFrom(`cr-${number}`);
  const createdAt = stamp(s.created);
  const sentAt = s.sent != null ? stamp(s.sent) : null;
  const acceptedAt = s.accepted != null ? stamp(s.accepted) : null;
  const pd = s.pd ? pdByNumber(s.pd) : null;
  const contractorId = s.ct != null ? ct(s.ct).id : null;
  REQUESTS.push({
    id, number, routingStage: s.stage, description: s.desc, rateType: s.rt,
    plannedQty: s.qty, rate: s.rate, estimatedAmount: s.est ?? null, contractorId,
    workLocation: s.loc, plannedHours: s.hours ?? null, status: s.status,
    bitrixDealId: s.deal ?? null, bitrixSentAt: sentAt,
    actualQty: s.aQty ?? null, actualAmount: s.aAmt ?? null, acceptedAt,
    acceptedById: acceptedAt ? USER_PLANNER : null, paymentDocumentId: pd?.id ?? null,
    createdById: USER_PLANNER, createdAt, updatedAt: acceptedAt ?? sentAt ?? createdAt, note: s.note ?? null,
  });
  (s.alloc ?? []).forEach((a, j) => {
    const order = ORDERS[a.o];
    const decidedAt = stamp(a.decided);
    // Приёмка заявки помечает уже разнесённые строки; разнесение после
    // акта строку не помечает (так на бэкенде)
    const accepted = acceptedAt != null && decidedAt.getTime() <= acceptedAt.getTime();
    WORKS.push({
      id: uuidFrom(`cw-${number}-${j}`), orderId: order.id, orderLineId: a.line ? order.lineId : null,
      routingStage: s.stage, contractorId: contractorId as string, share: a.share ?? 1, rateType: s.rt,
      rate: s.rt === 'FIXED' ? 0 : (s.rate ?? 0), actualQty: a.qty, actualWorkers: null, actualAmount: null,
      workLocation: s.loc, plannedHours: null, requestId: id, decidedById: USER_FOREMAN, decidedAt,
      reason: `Заявка на подряд ${number}`, acceptedById: accepted ? USER_PLANNER : null,
      acceptedAt: accepted ? acceptedAt : null, contractDocId: null, note: null,
    });
  });
  redistribute(id);
});

WORK_SPECS.forEach((s, i) => {
  const order = ORDERS[s.o];
  const acceptedAt = s.accepted != null ? stamp(s.accepted) : null;
  const aQty = s.aQty ?? null;
  let amount: number | null = null;
  if (acceptedAt) amount = s.aAmt ?? (s.rt === 'FIXED' ? s.rate : round2((aQty ?? 0) * s.rate));
  WORKS.push({
    id: uuidFrom(`cw-direct-${i}`), orderId: order.id, orderLineId: s.line ? order.lineId : null,
    routingStage: s.stage, contractorId: ct(s.ct).id, share: s.share, rateType: s.rt, rate: s.rate,
    actualQty: acceptedAt ? aQty : null, actualWorkers: s.workers ?? null, actualAmount: amount,
    workLocation: s.loc, plannedHours: s.hours ?? null, requestId: null, decidedById: USER_FOREMAN,
    decidedAt: stamp(s.decided), reason: s.reason ?? null, acceptedById: acceptedAt ? USER_FOREMAN : null,
    acceptedAt, contractDocId: null, note: s.note ?? null,
  });
});

// ---- сериализация как у Go ----

function contractorJson(c: ContractorRow): Contractor & { createdAt: string } {
  return {
    id: c.id, name: c.name, binIin: c.binIin, defaultRateType: c.defaultRateType, defaultRate: dec(c.defaultRate) as string,
    defaultWorkLocation: c.defaultWorkLocation, isActive: c.isActive, notes: c.notes, createdAt: c.createdAt.toISOString(),
  };
}

/** Запись contractor_works без include — Decimal строками (cwRaw) */
function cwRaw(w: WorkRow): Record<string, unknown> {
  return {
    id: w.id, orderId: w.orderId, orderLineId: w.orderLineId, routingStage: w.routingStage, contractorId: w.contractorId,
    share: dec(w.share), rateType: w.rateType, rate: dec(w.rate), actualQty: dec(w.actualQty), actualWorkers: w.actualWorkers,
    actualAmount: dec(w.actualAmount), workLocation: w.workLocation, plannedHours: dec(w.plannedHours), requestId: w.requestId,
    decidedById: w.decidedById, decidedAt: iso(w.decidedAt), reason: w.reason, acceptedById: w.acceptedById,
    acceptedAt: iso(w.acceptedAt), contractDocId: w.contractDocId, note: w.note,
  };
}

/** Запись contractor_requests без include (crRaw) */
function crRaw(r: RequestRow): Record<string, unknown> {
  return {
    id: r.id, number: r.number, routingStage: r.routingStage, description: r.description, rateType: r.rateType,
    plannedQty: dec(r.plannedQty), rate: dec(r.rate), estimatedAmount: dec(r.estimatedAmount), contractorId: r.contractorId,
    workLocation: r.workLocation, plannedHours: dec(r.plannedHours), status: r.status, bitrixDealId: r.bitrixDealId,
    bitrixSentAt: iso(r.bitrixSentAt), actualQty: dec(r.actualQty), actualAmount: dec(r.actualAmount), acceptedAt: iso(r.acceptedAt),
    acceptedById: r.acceptedById, paymentDocumentId: r.paymentDocumentId, createdById: r.createdById,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), note: r.note,
  };
}
function withContractor(r: RequestRow): Record<string, unknown> {
  const c = ctById(r.contractorId);
  return { ...crRaw(r), contractor: c ? { id: c.id, name: c.name } : null };
}

type SummaryBase = Omit<AllocationSummary, 'supplierDoc' | 'candidateDoc' | 'orders'> & {
  orders: OrderRef[]; amountUnknown: boolean;
};

/** Строка списка заявок — перенос allocationSummary() один в один */
function allocationSummary(r: RequestRow, works: WorkRow[], orderJson: (o: OrderRow) => OrderRef, nowMs: number): SummaryBase {
  const STALE_DAYS = 7;
  let allocatedQty = 0;
  let allocatedAmount = 0;
  for (const w of works) {
    allocatedQty += w.actualQty ?? 0;
    allocatedAmount += w.actualAmount ?? 0;
  }
  const actualQty = r.actualQty;
  const actualAmount = r.actualAmount;
  const plannedQty = r.plannedQty;
  const rate = r.rate;
  const estimatedAmount = r.estimatedAmount;

  let totalAmount: number | null = null;
  if (actualAmount != null) totalAmount = actualAmount;
  else if (estimatedAmount != null) totalAmount = estimatedAmount;
  else if (plannedQty != null && rate != null) totalAmount = round2(plannedQty * rate);

  const targetQty = actualQty ?? plannedQty;
  const unallocatedQty = targetQty != null ? round3(Math.max(0, targetQty - allocatedQty)) : null;
  const daysSinceAccepted = r.acceptedAt ? Math.floor((nowMs - r.acceptedAt.getTime()) / DAY) : null;

  let unallocatedAmount: number | null = null;
  if (totalAmount != null) {
    if (targetQty != null && targetQty > 0 && unallocatedQty != null) unallocatedAmount = round2((totalAmount * unallocatedQty) / targetQty);
    else if (works.length === 0) unallocatedAmount = round2(totalAmount);
    else unallocatedAmount = round2(Math.max(0, totalAmount - allocatedAmount));
  }

  const hasUnallocated = r.status !== 'CANCELLED' && (works.length === 0
    || (unallocatedQty != null && unallocatedQty > 1e-6)
    || (unallocatedAmount != null && unallocatedAmount > 0.005));

  const seen = new Set<string>();
  const orders: OrderRef[] = [];
  for (const w of works) {
    const o = orderById(w.orderId);
    if (!o || seen.has(o.id)) continue;
    seen.add(o.id);
    orders.push(orderJson(o));
  }
  const days = daysSinceAccepted ?? 0;
  const accepted = r.acceptedAt != null;
  return {
    id: r.id, number: r.number, routingStage: r.routingStage, stageLabel: STAGE_LABELS[r.routingStage],
    status: r.status, rateType: r.rateType, unit: RATE_UNITS[r.rateType],
    rate, plannedQty, estimatedAmount, actualQty, actualAmount,
    totalAmount, workLocation: r.workLocation, plannedHours: r.plannedHours,
    contractor: brief(ctById(r.contractorId)), bitrixDealId: r.bitrixDealId, bitrixSentAt: iso(r.bitrixSentAt),
    acceptedAt: iso(r.acceptedAt), createdAt: r.createdAt.toISOString(), daysSinceAccepted,
    ordersCount: orders.length, orders,
    allocatedQty: round3(allocatedQty), allocatedAmount: round2(allocatedAmount),
    unallocatedQty, unallocatedAmount: unallocatedAmount ?? 0,
    amountUnknown: totalAmount == null,
    needsAllocation: accepted && hasUnallocated,
    isStale: accepted && hasUnallocated && days >= STALE_DAYS,
  };
}

// ---- разбор запроса ----

type Body = Record<string, unknown>;
const bodyOf = (b: unknown): Body => (b && typeof b === 'object' ? (b as Body) : {});
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const seg = (path: string, i: number) => path.split('/')[i] ?? '';

let seq = 0;
const nextId = (prefix: string) => uuidFrom(`${prefix}-new-${++seq}`);
let nextDeal = 4281;

function nextNumber(): string {
  const max = REQUESTS.reduce((m, r) => Math.max(m, Number(r.number.replace('ПОДР-', '')) || 0), 0);
  return `ПОДР-${String(max + 1).padStart(3, '0')}`;
}

/** Уже отдано по переделу: заказ-уровень + самая занятая позиция */
function takenShare(orderId: string, stage: Stage, excludeId: string | null, orderLineId: string | null): number {
  let orderLevel = 0;
  const byLine = new Map<string, number>();
  for (const w of WORKS) {
    if (w.orderId !== orderId || w.routingStage !== stage || w.id === excludeId) continue;
    if (w.orderLineId == null) orderLevel += w.share;
    else byLine.set(w.orderLineId, (byLine.get(w.orderLineId) ?? 0) + w.share);
  }
  if (orderLineId != null) return orderLevel + (byLine.get(orderLineId) ?? 0);
  return orderLevel + Math.max(0, ...byLine.values());
}

/** Норма часов по переделу заказа — для laborImpact (детерминированно от индекса заказа) */
function normHours(orderIdx: number, stage: Stage): number {
  if (orderIdx < 0) return 0;
  switch (stage) {
    case 'CUTTING': return 18 + ((orderIdx * 7) % 64);
    case 'ASSEMBLY': return 96 + ((orderIdx * 37) % 420);
    default: return 32 + ((orderIdx * 13) % 128);
  }
}
/** Акты 1С, привязанные к заказу — в базе их нет, пара строк для сверки */
const ORDER_ACTS: Record<string, number> = { '14:4': 1825000, '15:6': 260000 };

// ---- маршруты ----

export const routes: FixtureRoute[] = [
  // GET /contractors?activeOnly=false
  {
    method: 'GET', match: /^\/contractors$/,
    handler: ({ params }) => {
      const all = params.get('activeOnly') === 'false';
      return CONTRACTORS.filter((c) => all || c.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        .map(contractorJson);
    },
  },
  // POST /contractors
  {
    method: 'POST', match: /^\/contractors$/,
    handler: ({ body }) => {
      const b = bodyOf(body);
      const rt = isRateType(b.defaultRateType) ? b.defaultRateType : 'PER_UNIT';
      const rate = num(b.defaultRate);
      const row: ContractorRow = {
        id: nextId('contractor'), name: str(b.name) ?? 'Новый подрядчик', binIin: str(b.binIin),
        defaultRateType: rt, defaultRate: rate != null && rate > 0 ? rate : 0,
        defaultWorkLocation: b.defaultWorkLocation === 'OUR_SHOP' ? 'OUR_SHOP' : 'CONTRACTOR_SITE',
        isActive: true, notes: str(b.notes), createdAt: new Date(NOW_MS),
      };
      CONTRACTORS.push(row);
      return contractorJson(row);
    },
  },

  // GET /contractor-work?contractorId=&onlyOpen=true — экран «Подряд»
  {
    method: 'GET', match: /^\/contractor-work$/,
    handler: ({ params }) => {
      const cid = params.get('contractorId');
      const onlyOpen = params.get('onlyOpen') === 'true';
      const rows = WORKS
        .filter((w) => (!cid || w.contractorId === cid) && (!onlyOpen || w.acceptedAt == null))
        .sort((a, b) => {
          // accepted_at ASC NULLS FIRST, decided_at DESC
          const aa = a.acceptedAt?.getTime() ?? -1;
          const ba = b.acceptedAt?.getTime() ?? -1;
          if (aa !== ba) return aa - ba;
          return b.decidedAt.getTime() - a.decidedAt.getTime();
        })
        .slice(0, 300);
      const byContractor = new Map<string, { id: string; name: string; open: number; accepted: number; amount: number }>();
      const data = rows.map((w) => {
        const o = orderById(w.orderId) as OrderRow;
        const c = ctById(w.contractorId) as ContractorRow;
        const req = w.requestId ? reqById(w.requestId) : null;
        const amount = workAmount(w);
        const isAccepted = w.acceptedAt != null;
        let acc = byContractor.get(c.id);
        if (!acc) {
          acc = { id: c.id, name: c.name, open: 0, accepted: 0, amount: 0 };
          byContractor.set(c.id, acc);
        }
        if (isAccepted) {
          acc.accepted++;
          if (amount != null) acc.amount += amount;
        } else {
          acc.open++;
        }
        return {
          id: w.id,
          order: orderRefFull(o),
          contractor: brief(c), request: req ? { id: req.id, number: req.number } : null, routingStage: w.routingStage,
          share: w.share, rateType: w.rateType, rate: w.rate,
          actualQty: w.actualQty, amount, workLocation: w.workLocation,
          isAccepted, acceptedAt: iso(w.acceptedAt), decidedAt: iso(w.decidedAt), reason: w.reason,
        };
      });
      return { data, byContractor: [...byContractor.values()], total: data.length };
    },
  },

  // PATCH /contractor-work/:id/accept — принять работу (замораживает сумму)
  {
    method: 'PATCH', match: /^\/contractor-work\/([^/]+)\/accept$/,
    handler: ({ path, body }) => {
      const w = WORKS.find((x) => x.id === seg(path, 2)) ?? WORKS[0];
      const b = bodyOf(body);
      const qty = Math.max(0, num(b.actualQty) ?? 0);
      const given = num(b.actualAmount);
      w.actualQty = qty;
      w.actualWorkers = num(b.actualWorkers) != null ? Math.round(num(b.actualWorkers) as number) : w.actualWorkers;
      w.actualAmount = given ?? (w.rateType === 'FIXED' ? w.rate : round2(qty * w.rate));
      w.acceptedAt = new Date(NOW_MS);
      w.acceptedById = USER_FOREMAN;
      w.note = str(b.note) ?? w.note;
      return cwRaw(w);
    },
  },
  // DELETE /contractor-work/:id — объём возвращается штату
  {
    method: 'DELETE', match: /^\/contractor-work\/([^/]+)$/,
    handler: ({ path }) => {
      const idx = WORKS.findIndex((x) => x.id === seg(path, 2));
      if (idx >= 0) WORKS.splice(idx, 1);
      return { deleted: true };
    },
  },

  // GET /orders/:id/contractor-work — подряд по заказу, сверка с актами, влияние на норму
  {
    method: 'GET', match: /^\/orders\/([^/]+)\/contractor-work$/,
    handler: ({ path }) => {
      const orderId = seg(path, 2);
      const orderIdx = ORDERS.findIndex((o) => o.id === orderId);
      const works = WORKS.filter((w) => w.orderId === orderId).sort((a, b) => {
        if (a.routingStage !== b.routingStage) return STAGES.indexOf(a.routingStage) - STAGES.indexOf(b.routingStage);
        return b.decidedAt.getTime() - a.decidedAt.getTime();
      });
      const amountOf = (w: WorkRow) => workAmount(w) ?? 0;

      const recon = new Map<string, { contractorId: string; name: string; logged: number; acted: number }>();
      for (const w of works) {
        const c = ctById(w.contractorId) as ContractorRow;
        let r = recon.get(c.id);
        if (!r) {
          const ctIdx = CONTRACTORS.indexOf(c);
          r = { contractorId: c.id, name: c.name, logged: 0, acted: ORDER_ACTS[`${orderIdx}:${ctIdx}`] ?? 0 };
          recon.set(c.id, r);
        }
        r.logged += amountOf(w);
      }
      const reconciliation = [...recon.values()].map((r) => ({
        contractorId: r.contractorId, name: r.name, logged: round2(r.logged), acted: r.acted,
        delta: round2(r.logged - r.acted),
        status: r.acted === 0 ? 'WAITING_ACT' : Math.abs(r.logged - r.acted) < 0.01 ? 'MATCHED' : 'MISMATCH',
      }));

      const laborImpact: Array<Record<string, unknown>> = [];
      const totals = { normHours: 0, staffHours: 0, contractorHours: 0, contractorAmount: 0 };
      for (const stage of STAGES) {
        const norm = normHours(orderIdx, stage);
        let shareSum = 0;
        let contractorAmount = 0;
        const contractors: Array<{ name: string; sharePct: number }> = [];
        for (const w of works) {
          if (w.routingStage !== stage) continue;
          shareSum += w.share;
          contractorAmount += amountOf(w);
          contractors.push({ name: (ctById(w.contractorId) as ContractorRow).name, sharePct: Math.round(w.share * 100) });
        }
        const share = Math.min(1, shareSum);
        const row = {
          stage, stageLabel: STAGE_LABELS[stage],
          normHours: round2(norm), contractorSharePct: Math.round(share * 100),
          staffHours: round2(norm * (1 - share)), contractorHours: round2(norm * share),
          contractorAmount: round2(contractorAmount), contractors,
        };
        if (!(row.normHours > 0 || row.contractorSharePct > 0)) continue;
        laborImpact.push(row);
        totals.normHours += row.normHours;
        totals.staffHours += row.staffHours;
        totals.contractorHours += row.contractorHours;
        totals.contractorAmount += row.contractorAmount;
      }

      const data = works.map((w) => ({
        ...cwRaw(w),
        contractor: brief(ctById(w.contractorId)),
        share: w.share, rate: w.rate, actualQty: w.actualQty, actualAmount: w.actualAmount,
        amount: amountOf(w), isAccepted: w.acceptedAt != null,
      }));
      return {
        laborImpact,
        laborTotals: {
          normHours: round2(totals.normHours), staffHours: round2(totals.staffHours),
          contractorHours: round2(totals.contractorHours), contractorAmount: round2(totals.contractorAmount),
        },
        data,
        reconciliation,
      };
    },
  },
  // POST /orders/:id/stages/:stage/contractor — отдать передел подрядчику
  {
    method: 'POST', match: /^\/orders\/([^/]+)\/stages\/([^/]+)\/contractor$/,
    handler: ({ path, body }) => {
      const orderId = seg(path, 2);
      const stageRaw = seg(path, 4);
      const stage: Stage = isStage(stageRaw) ? stageRaw : 'ASSEMBLY';
      const b = bodyOf(body);
      const contractor = ctById(str(b.contractorId)) ?? ct(0);
      const lineId = str(b.orderLineId);
      const existing = WORKS.find((w) => w.orderId === orderId && w.orderLineId === lineId && w.routingStage === stage && w.contractorId === contractor.id) ?? null;
      const share = num(b.share) ?? 1;
      const rateType = isRateType(b.rateType) ? b.rateType : contractor.defaultRateType;
      const workLocation: Loc = b.workLocation === 'OUR_SHOP' || b.workLocation === 'CONTRACTOR_SITE' ? b.workLocation : contractor.defaultWorkLocation;
      const rate = num(b.rate) ?? contractor.defaultRate;
      const hours = num(b.plannedHours);
      if (existing) {
        Object.assign(existing, { share, rateType, rate, workLocation, plannedHours: hours, reason: str(b.reason), note: str(b.note), decidedById: USER_FOREMAN });
        return cwRaw(existing);
      }
      const row: WorkRow = {
        id: nextId('cw'), orderId, orderLineId: lineId, routingStage: stage, contractorId: contractor.id,
        share, rateType, rate, actualQty: null, actualWorkers: null, actualAmount: null, workLocation, plannedHours: hours,
        requestId: null, decidedById: USER_FOREMAN, decidedAt: new Date(NOW_MS), reason: str(b.reason),
        acceptedById: null, acceptedAt: null, contractDocId: null, note: str(b.note),
      };
      WORKS.push(row);
      return cwRaw(row);
    },
  },

  // GET /contractor-requests?status=&stage=&contractorId=
  {
    method: 'GET', match: /^\/contractor-requests$/,
    handler: ({ params }): ContractorRequestsResponse => {
      const status = params.get('status');
      const stage = params.get('stage');
      const cid = params.get('contractorId');
      const list = REQUESTS
        .filter((r) => (!status || r.status === status) && (!stage || !isStage(stage) || r.routingStage === stage) && (!cid || r.contractorId === cid))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 300);

      const linked = new Set(REQUESTS.map((r) => r.paymentDocumentId).filter((x): x is string => x != null));
      const fresh = PAYMENT_DOCS.filter((d) => !linked.has(d.id)).sort((a, b) => b.doDate.getTime() - a.doDate.getTime());

      let unallocReq = 0;
      let unallocAmount = 0;
      const data: AllocationSummary[] = list.map((r) => {
        const c = ctById(r.contractorId);
        const m = allocationSummary(r, worksOf(r.id), orderRefShort, NOW_MS);
        const pd = r.paymentDocumentId ? PAYMENT_DOCS.find((d) => d.id === r.paymentDocumentId) ?? null : null;
        let candidateDoc: AllocationSummary['candidateDoc'] = null;
        // Заявка ушла в Б24, ДО ещё не привязан — ищем свежий ДО этого подрядчика
        if (r.bitrixSentAt && !r.paymentDocumentId && c?.binIin) {
          const sentMs = r.bitrixSentAt.getTime();
          const d = fresh.find((x) => x.bin === c.binIin && x.doDate.getTime() >= sentMs - DAY);
          if (d) candidateDoc = { doNumber: d.doNumber, totalAmount: d.totalAmount };
        }
        if (m.needsAllocation) {
          unallocReq++;
          unallocAmount += m.unallocatedAmount;
        }
        return { ...m, supplierDoc: pd ? { doNumber: pd.doNumber, totalAmount: pd.totalAmount } : null, candidateDoc };
      });
      return { data, unallocated: { requests: unallocReq, amount: round2(unallocAmount) }, total: data.length };
    },
  },
  // POST /contractor-requests/send-to-bitrix — пачка → одна сделка «Заказ на Работы»
  {
    method: 'POST', match: /^\/contractor-requests\/send-to-bitrix$/,
    handler: ({ body }): SendToBitrixResult => {
      const ids = (bodyOf(body).ids as unknown[] | undefined) ?? [];
      const drafts = REQUESTS.filter((r) => ids.includes(r.id) && r.status === 'DRAFT');
      let total = 0;
      for (const r of drafts) {
        if (r.estimatedAmount != null) total += r.estimatedAmount;
        else if (r.plannedQty != null && r.rate != null) total += r.plannedQty * r.rate;
      }
      const dealId = String(nextDeal++);
      const now = new Date(NOW_MS);
      for (const r of drafts) {
        r.status = 'SENT';
        r.bitrixDealId = dealId;
        r.bitrixSentAt = now;
        r.updatedAt = now;
      }
      return { sent: drafts.length, dealId, totalEstimate: Math.round(total) };
    },
  },
  // POST /contractor-requests — заявка партией, заказ и подрядчик ещё не известны
  {
    method: 'POST', match: /^\/contractor-requests$/,
    handler: ({ body }) => {
      const b = bodyOf(body);
      const pos = (v: unknown) => { const n = num(v); return n != null && n > 0 ? n : null; };
      const now = new Date(NOW_MS);
      const row: RequestRow = {
        id: nextId('cr'), number: nextNumber(), routingStage: isStage(b.routingStage) ? b.routingStage : 'ASSEMBLY',
        description: str(b.description) ?? 'Новая заявка', rateType: isRateType(b.rateType) ? b.rateType : 'PER_UNIT',
        plannedQty: pos(b.plannedQty), rate: pos(b.rate), estimatedAmount: pos(b.estimatedAmount),
        contractorId: ctById(str(b.contractorId))?.id ?? null,
        workLocation: b.workLocation === 'OUR_SHOP' ? 'OUR_SHOP' : 'CONTRACTOR_SITE', plannedHours: pos(b.plannedHours),
        status: 'DRAFT', bitrixDealId: null, bitrixSentAt: null, actualQty: null, actualAmount: null, acceptedAt: null,
        acceptedById: null, paymentDocumentId: null, createdById: USER_PLANNER, createdAt: now, updatedAt: now, note: str(b.note),
      };
      REQUESTS.push(row);
      return withContractor(row);
    },
  },
  // GET /contractor-requests/:id — со строками разнесения и актами подрядчика
  {
    method: 'GET', match: /^\/contractor-requests\/([^/]+)$/,
    handler: ({ path }) => {
      const r = reqById(seg(path, 2)) ?? REQUESTS[13];
      const c = ctById(r.contractorId);
      const works = worksOf(r.id).sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());
      const pd = r.paymentDocumentId ? PAYMENT_DOCS.find((d) => d.id === r.paymentDocumentId) ?? null : null;
      const rows: AllocationRow[] = works.map((w) => {
        const o = orderById(w.orderId);
        return {
          id: w.id,
          order: o ? { id: o.id, orderNumber: o.orderNumber, status: o.status, plannedShipmentDate: iso(o.plannedShipmentDate) } : null,
          share: w.share, qty: w.actualQty, amount: w.actualAmount, plannedHours: w.plannedHours,
          decidedAt: w.decidedAt.toISOString(), acceptedAt: iso(w.acceptedAt),
        };
      });
      const acts: SupplierAct[] = c?.binIin
        ? PAYMENT_DOCS.filter((d) => d.bin === c.binIin)
          .sort((a, b) => b.doDate.getTime() - a.doDate.getTime())
          .slice(0, 20)
          .map((d) => {
            const owner = REQUESTS.find((x) => x.paymentDocumentId === d.id);
            return {
              id: d.id, doNumber: d.doNumber, doDate: d.doDate.toISOString(), totalAmount: d.totalAmount, orderId: d.orderId,
              linkedRequestNumber: owner && owner.id !== r.id ? owner.number : null,
            };
          })
        : [];
      return {
        ...allocationSummary(r, works, orderRefFull, NOW_MS),
        supplierDoc: pd ? { id: pd.id, doNumber: pd.doNumber, doDate: pd.doDate.toISOString(), totalAmount: pd.totalAmount } : null,
        description: r.description,
        note: r.note,
        works: rows,
        supplierActs: acts,
      };
    },
  },
  // PATCH /contractor-requests/:id — подрядчик и ставка (назвали в Б24)
  {
    method: 'PATCH', match: /^\/contractor-requests\/([^/]+)$/,
    handler: ({ path, body }) => {
      const r = reqById(seg(path, 2)) ?? REQUESTS[0];
      const b = bodyOf(body);
      const pos = (v: unknown) => { const n = num(v); return n != null && n > 0 ? n : null; };
      if ('contractorId' in b) r.contractorId = ctById(str(b.contractorId))?.id ?? null;
      if ('rate' in b) r.rate = pos(b.rate);
      if (isRateType(b.rateType)) r.rateType = b.rateType;
      if ('plannedQty' in b) r.plannedQty = pos(b.plannedQty);
      if ('estimatedAmount' in b) r.estimatedAmount = pos(b.estimatedAmount);
      if ('plannedHours' in b) r.plannedHours = pos(b.plannedHours);
      if (str(b.description)) r.description = str(b.description) as string;
      if ('note' in b) r.note = str(b.note);
      if (b.workLocation === 'OUR_SHOP' || b.workLocation === 'CONTRACTOR_SITE') r.workLocation = b.workLocation;
      r.updatedAt = new Date(NOW_MS);
      const works = worksOf(r.id);
      if (works.length > 0) {
        for (const w of works) {
          if (r.contractorId) w.contractorId = r.contractorId;
          if ('rate' in b && r.rate != null && r.rateType !== 'FIXED') w.rate = r.rate;
          w.workLocation = r.workLocation;
        }
        redistribute(r.id);
      }
      return withContractor(r);
    },
  },
  // POST /contractor-requests/:id/allocate — «из ПОДР-007 на этот заказ ушло 3,2 т»
  {
    method: 'POST', match: /^\/contractor-requests\/([^/]+)\/allocate$/,
    handler: ({ path, body }): AllocateResult => {
      const r = reqById(seg(path, 2)) ?? REQUESTS[13];
      const b = bodyOf(body);
      const order = orderById(str(b.orderId) ?? '') ?? ORDERS[2];
      const lineKey = str(b.orderLineId);
      const qty = Math.max(0.001, num(b.qty) ?? 1);
      const share = num(b.share) ?? 1;
      const existing = worksOf(r.id).find((w) => w.orderId === order.id && w.orderLineId === lineKey) ?? null;
      const contractorId = r.contractorId ?? ct(0).id;
      const rate = r.rateType === 'FIXED' ? 0 : (r.rate ?? 0);
      let workId: string;
      if (existing) {
        Object.assign(existing, { share, rateType: r.rateType, rate, workLocation: r.workLocation, contractorId, actualQty: qty, note: str(b.note), decidedAt: new Date(NOW_MS) });
        workId = existing.id;
      } else {
        workId = nextId('cw');
        WORKS.push({
          id: workId, orderId: order.id, orderLineId: lineKey, routingStage: r.routingStage, contractorId,
          share, rateType: r.rateType, rate, actualQty: qty, actualWorkers: null, actualAmount: null,
          workLocation: r.workLocation, plannedHours: null, requestId: r.id, decidedById: USER_FOREMAN,
          decidedAt: new Date(NOW_MS), reason: `Заявка на подряд ${r.number}`, acceptedById: null, acceptedAt: null,
          contractDocId: null, note: str(b.note),
        });
      }
      const rowsN = redistribute(r.id);
      if (r.status === 'DRAFT' || r.status === 'SENT' || r.status === 'ACCEPTED') {
        if (r.acceptedAt) r.status = 'ALLOCATED';
        r.updatedAt = new Date(NOW_MS);
      }
      const allocated = worksOf(r.id).reduce((s, w) => s + (w.actualQty ?? 0), 0);
      const base = r.actualQty ?? r.plannedQty;
      return {
        workId, orderNumber: order.orderNumber, qty, unit: RATE_UNITS[r.rateType],
        stageLabel: STAGE_LABELS[r.routingStage], recalculatedRows: rowsN > 1 ? rowsN : 0,
        remainingQty: base != null ? round3(base - allocated) : null,
      };
    },
  },
  // DELETE /contractor-requests/:id/allocations/:workId
  {
    method: 'DELETE', match: /^\/contractor-requests\/([^/]+)\/allocations\/([^/]+)$/,
    handler: ({ path }) => {
      const reqId = seg(path, 2);
      const idx = WORKS.findIndex((w) => w.id === seg(path, 4) && w.requestId === reqId);
      if (idx >= 0) WORKS.splice(idx, 1);
      return { deleted: true, recalculatedRows: redistribute(reqId) };
    },
  },
  // POST /contractor-requests/:id/accept — приёмка партии: сумма делится по объёму
  {
    method: 'POST', match: /^\/contractor-requests\/([^/]+)\/accept$/,
    handler: ({ path, body }): AcceptResult => {
      const r = reqById(seg(path, 2)) ?? REQUESTS[21];
      const b = bodyOf(body);
      const qty = Math.max(0.001, num(b.actualQty) ?? r.plannedQty ?? 1);
      const doc = str(b.paymentDocumentId) ? PAYMENT_DOCS.find((d) => d.id === str(b.paymentDocumentId)) ?? null : null;
      const amount = num(b.actualAmount) ?? doc?.totalAmount ?? (r.estimatedAmount ?? round2(qty * (r.rate ?? 0)));
      const works = worksOf(r.id);
      const allocated = works.reduce((s, w) => s + (w.actualQty ?? 0), 0);
      const now = new Date(NOW_MS);
      r.actualQty = qty;
      r.actualAmount = amount;
      r.acceptedAt = now;
      r.acceptedById = USER_PLANNER;
      r.status = works.length > 0 && allocated >= qty - 1e-6 ? 'ALLOCATED' : 'ACCEPTED';
      r.updatedAt = now;
      if ('paymentDocumentId' in b) r.paymentDocumentId = doc?.id ?? null;
      if (str(b.note)) r.note = str(b.note);
      for (const w of works) {
        w.acceptedAt = now;
        w.acceptedById = USER_PLANNER;
      }
      const rowsN = redistribute(r.id);
      const split = worksOf(r.id).map((w) => ({
        orderNumber: orderById(w.orderId)?.orderNumber ?? '', qty: w.actualQty ?? 0, amount: w.actualAmount ?? 0,
      }));
      return {
        accepted: true, actualQty: qty, actualAmount: amount, supplierDocNumber: doc?.doNumber ?? null,
        allocatedRows: rowsN, split, unallocatedQty: round3(qty - allocated),
      };
    },
  },
  // POST /contractor-requests/:id/cancel
  {
    method: 'POST', match: /^\/contractor-requests\/([^/]+)\/cancel$/,
    handler: ({ path }) => {
      const r = reqById(seg(path, 2)) ?? REQUESTS[0];
      if (worksOf(r.id).length === 0) {
        r.status = 'CANCELLED';
        r.updatedAt = new Date(NOW_MS);
      }
      return crRaw(r);
    },
  },
];
