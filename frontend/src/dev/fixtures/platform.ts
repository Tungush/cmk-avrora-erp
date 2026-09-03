import type { FixtureRoute, FixtureContext } from './types';

/**
 * Фикстуры платформы (03.09.2026): пользователи и роли, сохранённые виды,
 * общий поиск, дашборды, журнал аудита, обмен с 1С.
 *
 * Формы ответов — как у Go-обработчиков:
 *   backend-go/internal/modules/platform/users.go
 *   backend-go/internal/modules/misc/platform.go
 *   backend-go/internal/modules/dashboards/dashboards.go
 *   backend-go/internal/modules/integration/handlers.go
 * Данные — выборка из живой базы (dbq, только чтение) на 03.09.2026,
 * дополненная до объёмов, при которых видна пагинация.
 */

/* ------------------------------------------------------------------ */
/* Детерминированность                                                */
/* ------------------------------------------------------------------ */

/** Сегодня в режиме дизайна — 03.09.2026; все даты считаются от него */
const TODAY = Date.UTC(2026, 8, 3);
const DAY = 86_400_000;

/** common.PDate → "2026-08-22T10:14:29.000Z" (UTC, с миллисекундами) */
function at(daysFromToday: number, hh = 0, mm = 0, ss = 0): string {
  return new Date(TODAY + daysFromToday * DAY + ((hh * 60 + mm) * 60 + ss) * 1000).toISOString();
}
/** Колонка @db.Date → "2026-09-24T00:00:00.000Z" — так PDate отдаёт дату без времени */
function day(ymd: string | null): string | null {
  return ymd ? `${ymd}T00:00:00.000Z` : null;
}
function daysUntil(ymd: string): number {
  return Math.round((Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) - TODAY) / DAY);
}

/** mulberry32 с фиксированным seed — никакого Math.random */
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
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}
const HEX = '0123456789abcdef';
function uuid(): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += HEX[Math.floor(rnd() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20)}`;
}
/** Math.round Go-шного jsRound: половинки вверх */
const jsRound = (x: number) => Math.floor(x + 0.5);
const r1 = (x: number) => jsRound(x * 10) / 10;

/** Пользователь режима дизайна (см. ../designMode.ts) */
const ME_EMAIL = 'design@avrora.kz';

/* ------------------------------------------------------------------ */
/* Роли и пользователи                                                */
/* ------------------------------------------------------------------ */

interface Role {
  code: string;
  name: string;
  description: string | null;
  family: string | null;
  isSystem: boolean;
}

/** Справочник ролей — 11 строк, как в базе (ORDER BY family, code) */
const ROLES: Role[] = [
  { code: 'admin', name: 'Администратор системы', description: 'Permissions, Log, LogErrors', family: 'admin', isSystem: true },
  { code: 'accountant', name: 'Бухгалтер / финансист', description: '19.20-7п, реестр АПП по заказчикам, Остатки по бух.', family: 'commercial', isSystem: false },
  { code: 'director', name: 'Директор / руководство', description: 'Сводка, Сводная, Сводная по ГП', family: 'commercial', isSystem: false },
  { code: 'sales_manager', name: 'Менеджер по продажам / ПМ', description: 'Telecom, Для фиксации: «Руководитель», «ПМ»', family: 'commercial', isSystem: false },
  { code: 'engineer', name: 'Конструктор / технолог', description: 'Отчет по проектам проект, Спецификации 2022', family: 'engineering', isSystem: false },
  { code: 'planner', name: 'Плановик / ПЭО', description: 'План, Минимальные остатки, Рабочее время', family: 'engineering', isSystem: false },
  { code: 'shop_foreman', name: 'Мастер цеха', description: 'Отчет по проектам проект: этапы резки/сборки/покраски', family: 'engineering', isSystem: false },
  { code: 'procurement', name: 'Закупщик / снабженец', description: '19.20-7п: «Ответственный закупщик», лист «На закуп»', family: 'supply', isSystem: false },
  { code: 'warehouse_fg', name: 'Кладовщик (ГП)', description: 'Склад ГП, Приход ГП', family: 'supply', isSystem: false },
  { code: 'warehouse_material', name: 'Кладовщик (сырьё)', description: 'Склад ТМЦ (импорт)', family: 'supply', isSystem: false },
  { code: 'viewer', name: 'Наблюдатель', description: 'Только чтение итоговых статусов — для заказчиков и смежников', family: 'viewer', isSystem: false },
];

function roleRefs(codes: string[]): Array<{ code: string; name: string }> {
  return codes.map((code) => ({ code, name: ROLES.find((r) => r.code === code)?.name ?? code }));
}

interface User {
  id: string;
  email: string;
  isActive: boolean;
  createdAt: string;
  roles: Array<{ code: string; name: string }>;
  employee: { id: string; name: string } | null;
}

function user(email: string, roles: string[], createdAt: string, employee: string | null = null, isActive = true): User {
  return {
    id: uuid(),
    email,
    isActive,
    createdAt,
    roles: roleRefs(roles),
    employee: employee ? { id: uuid(), name: employee } : null,
  };
}

/** 12 учёток из сида + 20 персональных — чтобы список листался */
const USERS: User[] = [
  user('admin@avh.kz', ['admin'], '2026-08-21T16:25:59.424Z'),
  user('director@avh.kz', ['director'], '2026-08-21T16:25:59.662Z'),
  user('viewer@avh.kz', ['viewer'], '2026-08-21T16:26:00.194Z'),
  user('smena@avh.kz', ['accountant', 'engineer', 'planner', 'procurement', 'sales_manager', 'shop_foreman', 'warehouse_fg', 'warehouse_material'], '2026-08-24T17:27:31.989Z'),
  user('sales_manager@avh.kz', ['sales_manager'], '2026-08-26T08:02:01.736Z'),
  user('accountant@avh.kz', ['accountant'], '2026-08-26T08:02:01.812Z'),
  user('engineer@avh.kz', ['engineer'], '2026-08-26T08:02:01.958Z'),
  user('planner@avh.kz', ['planner'], '2026-08-26T08:02:02.033Z'),
  user('shop_foreman@avh.kz', ['shop_foreman'], '2026-08-26T08:02:02.103Z'),
  user('procurement@avh.kz', ['procurement'], '2026-08-26T08:02:02.174Z'),
  user('warehouse_material@avh.kz', ['warehouse_material'], '2026-08-26T08:02:02.247Z'),
  user('warehouse_fg@avh.kz', ['warehouse_fg'], '2026-08-26T08:02:02.318Z'),
  user('a.akhmetov@avh.kz', ['sales_manager'], at(-11, 9, 12, 4), 'Ахметов Алитет Аркенович'),
  user('a.bisen@avh.kz', ['shop_foreman'], at(-11, 9, 14, 51), 'Бисен Азамат Мырзақанұлы'),
  user('s.narmagambetov@avh.kz', ['engineer'], at(-11, 9, 17, 22), 'Нармагамбетов Санат Алибекович'),
  user('a.sultangaliyeva@avh.kz', ['accountant'], at(-11, 9, 20, 3), 'Султангалиева Айнура Жаксыгалеевна'),
  user('g.sultanmuratkyzy@avh.kz', ['planner'], at(-11, 9, 23, 40), 'Сұлтанмұратқызы Гүлнұр'),
  user('e.doszhanov@avh.kz', ['procurement'], at(-10, 14, 2, 17), 'Досжанов Ерлан Бауыржанович'),
  user('v.kim@avh.kz', ['sales_manager'], at(-10, 14, 6, 55), 'Ким Виктория Сергеевна'),
  user('n.ospanov@avh.kz', ['warehouse_material'], at(-10, 14, 9, 31), 'Оспанов Нурлан Серикович'),
  user('a.zhumabekov@avh.kz', ['shop_foreman'], at(-9, 8, 41, 12), 'Жумабеков Асхат Маратович'),
  user('d.ibrayeva@avh.kz', ['accountant', 'viewer'], at(-9, 8, 44, 0), 'Ибраева Динара Кайратовна'),
  user('d.tleubayev@avh.kz', ['engineer'], at(-9, 8, 47, 38), 'Тлеубаев Даурен Ерболович'),
  user('a.mussina@avh.kz', ['planner', 'engineer'], at(-8, 11, 5, 9), 'Мусина Асель Талгатовна'),
  user('b.seitkazy@avh.kz', ['warehouse_fg'], at(-8, 11, 8, 27), 'Сейтказы Бекзат'),
  user('a.petrov@avh.kz', ['engineer'], at(-7, 15, 30, 44), 'Петров Андрей Владимирович'),
  user('r.abdrakhmanov@avh.kz', ['director', 'sales_manager'], at(-7, 15, 33, 2), 'Абдрахманов Ринат Маратович'),
  user('g.kassymova@avh.kz', ['viewer'], at(-6, 10, 12, 19), 'Касымова Гульнара Ермековна', false),
  user('t.yerzhanov@avh.kz', ['procurement'], at(-5, 9, 2, 46), 'Ержанов Тимур Асхатович'),
  user('a.nurgaliyev@avh.kz', ['shop_foreman'], at(-4, 13, 58, 11), 'Нургалиев Арман Бахытович'),
  user('a.smagulova@avh.kz', ['sales_manager'], at(-3, 16, 20, 5), 'Смагулова Айгерим Сериковна'),
  user('o.bekmuratov@avh.kz', ['warehouse_material'], at(-2, 8, 15, 33), 'Бекмуратов Олжас Нурланович', false),
];

const byEmail = (a: User, b: User) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0);

/* ------------------------------------------------------------------ */
/* Заказы (активные из базы) — для поиска, директора, виджетов          */
/* ------------------------------------------------------------------ */

interface Ord {
  id: string;
  orderNumber: string;
  onecNum: string | null;
  status: string;
  planned: string | null;
  customer: string;
  finalCustomer: string | null;
  projectSite: string | null;
  customerOrderNum: string | null;
  total: number | null;
  paid: number | null;
  isArchived: boolean;
  overdueDays: number;
  /** Плановая маржа по утверждённой калькуляции; null — калькуляции нет */
  marginPct: number | null;
}

const ACTIVE = new Set(['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP']);
/** Маржа по заказам — детерминированный цикл, часть без калькуляции */
const MARGINS: Array<number | null> = [38.2, 27.4, 41.0, null, 33.6, 22.9, 36.1, 29.8, null, 44.3, 31.2, 19.7, 35.0, 26.3, 39.4, null, 34.8, 24.1, 37.5, 30.6];

let ordIdx = 0;
function ord(
  orderNumber: string, status: string, planned: string | null, customer: string,
  finalCustomer: string | null, projectSite: string | null, customerOrderNum: string | null,
  total: number | null, paid: number | null, isArchived = false,
): Ord {
  const i = ordIdx++;
  const overdue = !isArchived && ACTIVE.has(status) && planned && daysUntil(planned) < 0 ? -daysUntil(planned) : 0;
  return {
    id: uuid(), orderNumber, onecNum: orderNumber, status, planned, customer, finalCustomer, projectSite,
    customerOrderNum, total, paid, isArchived, overdueDays: overdue, marginPct: MARGINS[i % MARGINS.length],
  };
}

const A75 = 'Аврора 75, ТОО';
const ASERV = 'Аврора Сервис, ТОО';
const KARTEL = 'КаР-Тел, ТОО';
const KTC = 'Kazakhstan Tower Company (Казахстан Тауэр Компани), ТОО';
const MK = 'KZ-Металлоконструкция';
const IDA = 'IDA INTERTASCO JV, ТОО';
const KUPI = 'Физическое лицо Купи-Продай';

/** Порядок — created_at DESC, как отдаёт поиск; архивные в конце */
const ORDERS: Ord[] = [
  ord('Т7АА-002558', 'CONFIRMED', '2026-09-24', 'Дельта Казстрой, ТОО', null, MK, null, 6600000, null),
  ord('Т7АА-002557', 'CONFIRMED', '2026-08-25', A75, KARTEL, 'KZ-ALM_Dudar', 'АСАА-009459_2024', 6202280, null),
  ord('Т7АА-002555', 'CONFIRMED', '2026-08-24', A75, KTC, 'KZ-KRG_Saran', 'Т2АА-000236_2023', 6695400, null),
  ord('Т7АА-002554', 'CONFIRMED', '2026-08-24', A75, KTC, 'KZ-ALM_Dudar', 'Т2АА-003468_2026', 6202888, null),
  ord('Т7АА-002553', 'CONFIRMED', '2026-09-20', 'КазДаму Invest', null, MK, null, 6324400, null),
  ord('Т7АА-002551', 'CONFIRMED', '2026-09-03', ASERV, 'Компании Холдинга АВХ', 'KZ-Телеком', null, 387500, null),
  ord('Т7АА-002550', 'CONFIRMED', '2026-09-18', KUPI, null, 'KZ-0237-ЦМК-1', null, 440000, 440000),
  ord('Т7АА-002549', 'CONFIRMED', '2026-09-17', ASERV, null, MK, null, 714000, null),
  ord('Т7АА-002548', 'CONFIRMED', '2026-08-14', A75, KARTEL, 'KZ-Телеком', 'Т2АА-001200_2025', 19820, null),
  ord('Т7АА-002544', 'CONFIRMED', '2026-08-13', A75, KARTEL, 'KZ-AKT_Zhetybai', 'Т2АА-003529_2024', 36000, null),
  ord('Т7АА-002542', 'IN_PRODUCTION', '2026-09-10', 'ТОО «GravIX Urban»', null, MK, null, 31028362, null),
  ord('Т7АА-002541', 'IN_PRODUCTION', '2026-09-09', 'Central Build, ТОО', null, 'А+ Бизнес парк', null, 248999376, 124500000),
  ord('Т7АА-002540', 'CONFIRMED', '2026-09-09', KUPI, null, 'KZ-0237-ЦМК-1', null, 413000, 413000),
  ord('Т7АА-002538', 'CONFIRMED', '2026-09-05', 'НУР АСТАНА КУРЫЛЫС ТОО', null, MK, null, 3359505, null),
  ord('Т7АА-002537', 'CONFIRMED', '2026-09-05', 'AVRORA ELECTRIC, ТОО', null, MK, null, 325000, 325000),
  ord('Т7АА-002536', 'IN_PRODUCTION', '2026-09-05', IDA, null, MK, null, 12264005.6, null),
  ord('Т7АА-002534', 'CONFIRMED', '2026-08-05', A75, KARTEL, 'KZ-Телеком', 'Т2АА-001982_2024', 668031, null),
  ord('Т7АА-002533', 'CONFIRMED', '2026-08-05', A75, KARTEL, 'KZ-Телеком', 'Т2АА-000191_2026', 24000, null),
  ord('Т7АА-002531', 'CONFIRMED', '2026-08-09', A75, KARTEL, 'KZ-SHM_Tortkul', 'Т2АА-001384_2025', 6264604, null),
  ord('Т7АА-002530', 'IN_PRODUCTION', '2026-09-03', 'BI URBAN CONSTRUCTION, ТОО', null, 'Театр им. М.Ауэзова', null, 164763454.99, null),
  ord('Т7АА-002529', 'IN_PRODUCTION', '2026-09-02', IDA, null, MK, null, 58012922.53, null),
  ord('Т7АА-002528', 'CONFIRMED', '2026-08-03', A75, KARTEL, 'KZ-ALM_Dudar', 'АСАА-009471_2024', 6198680, null),
  ord('Т7АА-002527', 'CONFIRMED', '2026-09-02', KUPI, null, 'KZ-0237-ЦМК-1', null, 1049400, null),
  ord('Т7АА-002526', 'READY_TO_SHIP', '2026-09-02', KUPI, null, MK, null, 577500, 577500),
  ord('Т7АА-002525', 'IN_PRODUCTION', '2026-09-02', 'ТОО «GravIX Urban»', null, MK, null, 35992900, null),
  ord('Т7АА-002523', 'READY_TO_SHIP', '2026-09-01', IDA, null, MK, null, 3044827.7, 558785.3),
  ord('Т7АА-002519', 'CONFIRMED', '2026-08-29', 'КазДаму Invest', null, MK, null, 1972740, null),
  ord('Т7АА-002518', 'CONFIRMED', '2026-08-29', 'Greystone Construction, ТОО', null, MK, null, 1393000, null),
  ord('Т7АА-002517', 'READY_TO_SHIP', '2026-08-28', 'Qonay Stroy, ТОО', null, MK, null, 291200, 291200),
  ord('Т7АА-002513', 'CONFIRMED', '2026-08-25', 'Аврора Холдинг, ТОО', null, null, null, 17000000, null),
  ord('Т7АА-002512', 'CONFIRMED', '2026-08-25', 'Greystone Construction, ТОО', null, MK, null, 1050000, null),
  ord('Т7АА-002510', 'IN_PRODUCTION', '2026-08-21', 'Китайская Компания по строительству и развитию Синьсин в РК, Филиал ТОО', null, MK, null, 10400000, 5200000),
  ord('Т7АА-002509', 'CONFIRMED', '2026-08-21', 'КазДаму Invest', null, MK, null, 4404563, 2202282),
  ord('Т7АА-002507', 'IN_PRODUCTION', '2026-08-19', 'M2 Solutions, ТОО', null, MK, null, 11623000, 2375000),
  ord('Т7АА-002506', 'READY_TO_SHIP', '2026-08-18', IDA, null, MK, null, 1317986, 1317986),
  ord('Т7АА-002501', 'CONFIRMED', '2026-07-15', ASERV, KARTEL, 'KZ-Телеком', 'Т2АА-003452_2026', 2400, null),
  ord('Т7АА-002500', 'CONFIRMED', '2026-07-15', ASERV, KARTEL, 'KZ-Телеком', 'Т2АА-001200_2025', 18000, null),
  ord('Т7АА-002499', 'CONFIRMED', '2026-08-14', ASERV, 'RETN KZ, ТОО', MK, 'АСАА-028014_2026', 8900000, null),
  ord('Т7АА-002496', 'CONFIRMED', '2026-08-08', 'НУР АСТАНА КУРЫЛЫС ТОО', null, MK, null, 6446730, null),
  ord('Т7АА-002492', 'READY_TO_SHIP', '2026-08-06', 'КазДаму Invest', null, MK, null, 162750, 162750),
  ord('Т7АА-002491', 'CONFIRMED', null, A75, null, 'SEM_Mirnyi', null, 6226280, null),
  ord('Т7АА-002484', 'CONFIRMED', '2026-07-30', 'НУР АСТАНА КУРЫЛЫС ТОО', null, MK, null, 424880, null),
  ord('Т7АА-002483', 'READY_TO_SHIP', '2026-07-30', IDA, null, MK, null, 4972084.8, 4972084.8),
  ord('Т7АА-002479', 'IN_PRODUCTION', '2026-07-22', 'Greystone Construction, ТОО', null, MK, null, 1393000, 1393000),
  ord('Т7АА-002421', 'SHIPPED', '2026-08-12', 'LVE Group, ТОО', null, MK, null, 2860400, 2860400),
  ord('Т7АА-002444', 'SHIPPED', '2026-08-20', 'Avrora Global trade, ТОО', null, MK, null, 1204750, 1204750),
  ord('Т7АА-002398', 'NEW', null, 'ТОО "БУРАН БОЙЛЕР"', null, MK, null, null, null),
  ord('Т7АА-002301', 'CLOSED', '2026-05-14', A75, KARTEL, 'KZ-Телеком', 'Т2АА-000812_2025', 6194200, 6194200, true),
  ord('Т7АА-002288', 'CLOSED', '2026-04-30', 'LVE Group, ТОО', null, MK, null, 4310000, 4310000, true),
  ord('Т7АА-002247', 'CLOSED', '2026-04-02', ASERV, 'RETN KZ, ТОО', MK, 'АСАА-027431_2026', 2150000, 2150000, true),
];

const activeOrders = () => ORDERS.filter((o) => !o.isArchived && ACTIVE.has(o.status));

/* ------------------------------------------------------------------ */
/* Изделия и материалы — для поиска и виджетов                         */
/* ------------------------------------------------------------------ */

interface Article { id: string; articleCode: string; name: string; isActive: boolean }
const art = (articleCode: string, name: string, isActive = true): Article => ({ id: uuid(), articleCode, name, isActive });

const ARTICLES: Article[] = [
  art('a-018', 'Секция ограждения 2000х900мм (сетка рабица) калитка'),
  art('b-006', 'Контейнер из сэндвич панелей нестандартный'),
  art('k-041', 'Кронштейн КР-3 под антенну РРЛ'),
  art('l-012', 'Лестница ЛМ-2 с ограждением, 6 м'),
  art('m-015', 'Мачта М18м на пространственной раме (секция 6м)'),
  art('m-016', 'Мачта М22м на пространственной раме (секция 6м)'),
  art('m-017', 'Мачта М24м на пространственной раме (секция 6м)'),
  art('m-027', 'Мачта М18м на пространственной раме (секция 2м)'),
  art('m-028', 'Мачта М24м на пространственной раме (секция 2м)'),
  art('m-029', 'Мачта М25м на пространственной раме (секция 2м)'),
  art('m-032', 'Мачта М16м на пространственной раме (секция 2м) в сборе'),
  art('m-033', 'Мачта М18м на пространственной раме (секция 2м) в сборе'),
  art('m-034', 'Мачта М24м на пространственной раме (секция 2м) в сборе'),
  art('m-035', 'Мачта М25м на пространственной раме (секция 2м) в сборе'),
  art('m-041', 'Мачта М30м на пространственной раме (секция 2м) в сборе'),
  art('n-186', 'М21-Ф45.39-5.6-6.4.3'),
  art('n-201', 'Мачта М18м на пространственной раме'),
  art('n-365', 'Пригр. Опора МК 30м без корзины (реставрация) 4,5 секция'),
  art('o-052', 'Опора ОК-12 трубчатая под РРЛ'),
  art('p-017', 'Площадка обслуживания ПМ-1,5 с ограждением'),
  art('z-362', 'Пластина200х200х20мм –10шт.'),
  art('z-431', 'Пластина 374х96х10мм, 14шт'),
  art('М0605', 'Зажим канатный 13 мм'),
  art('m-009', 'Мачта М12м на трубчатой раме (снята)', false),
];

interface Material { id: string; materialCode: string; name: string; unit: string }
const mat = (materialCode: string, name: string, unit: string): Material => ({ id: uuid(), materialCode, name, unit });

const MATERIALS: Material[] = [
  mat('С0101', 'Арматура А3 14 мм', 'м'),
  mat('С0116', 'Арматура А5 12 мм', 'м'),
  mat('С0706', 'Балка 12 Б1', 'м'),
  mat('С0713', 'Балка 20 Б1', 'м'),
  mat('С0709', 'Балка 30 Ш1', 'м'),
  mat('С0904', 'Болт М16х50 оц. с гайкой и шайбой', 'шт'),
  mat('С0812', 'Грунт-эмаль ХВ-0278 серая', 'кг'),
  mat('С0805', 'Электроды МР-3 Ø3 мм', 'кг'),
  mat('z-257', 'Лист 1500х3000х4мм', 'шт'),
  mat('С0301', 'Лист г/к 4 мм', 'кг'),
  mat('С0302', 'Лист г/к 6 мм', 'кг'),
  mat('С0305', 'Лист г/к 10 мм', 'кг'),
  mat('С0219', 'Лист ПВЛ 1000х3000х4', 'м2'),
  mat('С0213', 'Лист ПВЛ 1000х2500х4', 'м2'),
  mat('С0601', 'Труба 76х4', 'м'),
  mat('С0602', 'Труба 89х4', 'м'),
  mat('С0604', 'Труба 108х4', 'м'),
  mat('С0611', 'Труба проф. 60х60х3', 'м'),
  mat('С0613', 'Труба проф. 80х80х4', 'м'),
  mat('С0505', 'Уголок 50х50х5', 'м'),
  mat('С0507', 'Уголок 63х63х5', 'м'),
  mat('С0509', 'Уголок 75х75х6', 'м'),
  mat('С0501', 'Уголок 100х100х7 мм', 'м'),
  mat('С0402', 'Швеллер 12У', 'м'),
  mat('С0404', 'Швеллер 16У', 'м'),
  mat('С0407', 'Швеллер 20П', 'м'),
  mat('n-924', 'Гнутый швеллер 65х40х4мм с перемычками', 'шт'),
];

/** Алиасы — «как называют в цеху» (material_aliases) */
const ALIASES: Array<{ alias: string; materialCode: string }> = [
  { alias: 'уголок 50х50 ст3', materialCode: 'С0501' },
  { alias: 'швеллер 12', materialCode: 'С0402' },
  { alias: 'швеллер двенадцатый', materialCode: 'С0402' },
  { alias: 'труба сотка', materialCode: 'С0604' },
  { alias: 'лист четвёрка', materialCode: 'С0301' },
  { alias: 'профиль 60', materialCode: 'С0611' },
  { alias: 'пвл', materialCode: 'С0219' },
];

/* ------------------------------------------------------------------ */
/* Сохранённые виды                                                    */
/* ------------------------------------------------------------------ */

interface SavedView {
  id: string;
  module: string;
  name: string;
  ownerEmail: string;
  config: Record<string, unknown>;
  createdAt: string;
}

const SAVED_VIEWS: SavedView[] = [
  { id: uuid(), module: 'orders', name: 'Мои просроченные', ownerEmail: ME_EMAIL, config: { search: '', status: null, overdueOnly: true, preset: 'manager' }, createdAt: at(-9, 10, 4, 17) },
  { id: uuid(), module: 'orders', name: 'Q3 Телеком', ownerEmail: ME_EMAIL, config: { search: 'Телеком', status: 'CONFIRMED', overdueOnly: false, preset: 'manager' }, createdAt: at(-9, 10, 6, 52) },
  { id: uuid(), module: 'orders', name: 'Металлоконструкция — в работе', ownerEmail: ME_EMAIL, config: { search: 'Металлоконструкция', status: 'IN_PRODUCTION', overdueOnly: false, preset: 'planner' }, createdAt: at(-6, 15, 41, 8) },
  { id: uuid(), module: 'orders', name: 'Купи-Продай', ownerEmail: ME_EMAIL, config: { search: 'Купи-Продай', status: null, overdueOnly: false, preset: 'accountant' }, createdAt: at(-2, 9, 18, 33) },
  { id: uuid(), module: 'production', name: 'Резка на неделе', ownerEmail: ME_EMAIL, config: { stage: 'CUTTING', week: 'current' }, createdAt: at(-5, 8, 2, 40) },
  { id: uuid(), module: 'warehouse', name: 'Ниже минимума', ownerEmail: ME_EMAIL, config: { belowMin: true }, createdAt: at(-4, 12, 25, 1) },
  { id: uuid(), module: 'purchases', name: 'Ждут оплаты', ownerEmail: ME_EMAIL, config: { status: 'APPROVED', unpaidOnly: true }, createdAt: at(-1, 17, 3, 29) },
];

/* ------------------------------------------------------------------ */
/* Журнал аудита                                                       */
/* ------------------------------------------------------------------ */

interface AuditEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  userId: string | null;
  userRole: string | null;
  timestamp: string;
  comment: string | null;
}

const STATUS_CHAIN: Array<[string, string, string, string | null]> = [
  ['DRAFT', 'CONFIRMED', 'sales_manager', null],
  ['CONFIRMED', 'IN_PRODUCTION', 'shop_foreman', 'Автоматически по этапам: PRODUCTION → IN_PROGRESS'],
  ['IN_PRODUCTION', 'READY_TO_SHIP', 'shop_foreman', 'Автоматически по этапам: PRODUCTION → DONE'],
  ['READY_TO_SHIP', 'SHIPPED', 'warehouse_fg', null],
  ['SHIPPED', 'CLOSED', 'accountant', null],
];

function userWithRole(code: string): User {
  return USERS.find((u) => u.isActive && u.employee && u.roles.some((r) => r.code === code)) ?? USERS[0];
}

function buildAudit(total: number): AuditEntry[] {
  const out: AuditEntry[] = [];
  let ts = TODAY + ((16 * 60 + 40) * 60) * 1000; // 03.09 16:40Z
  for (let i = 0; i < total; i++) {
    ts -= (20 + Math.floor(rnd() * 170)) * 60 * 1000;
    const timestamp = new Date(ts).toISOString();
    const k = rnd();
    let e: Omit<AuditEntry, 'id' | 'timestamp'>;
    if (k < 0.68) {
      const step = pick(STATUS_CHAIN);
      const o = pick(ORDERS);
      const u = userWithRole(step[2]);
      e = { entityType: 'Order', entityId: o.id, action: 'status_change', before: { status: step[0] }, after: { status: step[1] }, userId: u.id, userRole: step[2], comment: step[3] };
    } else if (k < 0.78) {
      const a = pick(ARTICLES);
      const u = userWithRole('director');
      const was = 900000 + Math.floor(rnd() * 40) * 12500;
      e = { entityType: 'Article', entityId: a.id, action: 'price_approved', before: { approvedPrice: was }, after: { approvedPrice: was + 62500 }, userId: u.id, userRole: 'director', comment: `Пересмотр цены: ${a.articleCode}` };
    } else if (k < 0.85) {
      const o = pick(activeOrders());
      const u = userWithRole('engineer');
      e = { entityType: 'OrderCosting', entityId: uuid(), action: 'approve', before: { status: 'DRAFT', version: 1 }, after: { status: 'APPROVED', version: 2 }, userId: u.id, userRole: 'engineer', comment: `Калькуляция по ${o.orderNumber}` };
    } else if (k < 0.91) {
      const m = pick(MATERIALS);
      const u = userWithRole('procurement');
      e = { entityType: 'PurchaseRequest', entityId: uuid(), action: 'status_change', before: { status: 'DRAFT' }, after: { status: 'APPROVED' }, userId: u.id, userRole: 'procurement', comment: `${m.name} — ${(2 + Math.floor(rnd() * 40)) * 6} ${m.unit}` };
    } else if (k < 0.96) {
      const m = pick(MATERIALS);
      const u = userWithRole('warehouse_material');
      e = { entityType: 'Material', entityId: m.id, action: 'alias_added', before: null, after: { alias: m.name.toLowerCase().split(' ').slice(0, 2).join(' ') }, userId: u.id, userRole: 'warehouse_material', comment: null };
    } else {
      const target = pick(USERS);
      const admin = USERS[0];
      e = { entityType: 'User', entityId: target.id, action: 'roles_changed', before: { roles: ['viewer'] }, after: { roles: target.roles.map((r) => r.code) }, userId: admin.id, userRole: 'admin', comment: target.email };
    }
    out.push({ id: uuid(), timestamp, ...e });
  }
  return out;
}

const AUDIT: AuditEntry[] = buildAudit(138);

/* ------------------------------------------------------------------ */
/* Обмен с 1С                                                          */
/* ------------------------------------------------------------------ */

interface OutboxMsg {
  id: string;
  system: string;
  type: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  sentAt: string | null;
}

interface InboxMsg {
  id: string;
  system: string;
  type: string;
  externalKey: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
}

function buildOutbox(): OutboxMsg[] {
  const out: OutboxMsg[] = [];
  const src = ORDERS.filter((o) => !o.isArchived && o.status !== 'NEW').slice(0, 24);
  let ts = TODAY + (11 * 60 + 27) * 60 * 1000; // 03.09 11:27Z
  src.forEach((o, i) => {
    const stageAt = new Date(ts).toISOString();
    // Ошибки доставки — у трёх сообщений ближе к середине списка
    const failed = i === 5 || i === 9 || i === 14;
    const sent = i >= 12 && !failed;
    const status = failed ? 'FAILED' : sent ? 'SENT' : 'PENDING';
    const base = {
      system: '1C', entityType: 'Order', entityId: o.id, status,
      attempts: failed ? 3 : sent ? 1 : 0,
      lastError: failed ? 'connect ECONNREFUSED 10.20.0.15:8080' : null,
      nextRetryAt: failed ? at(0, 12 + i % 4, 15) : null,
      sentAt: sent ? new Date(ts + 4200).toISOString() : null,
    };
    out.push({
      id: uuid(), type: 'production-status', createdAt: new Date(ts + 11).toISOString(),
      payload: { status: o.status === 'READY_TO_SHIP' ? 'READY_TO_SHIP' : 'IN_PRODUCTION', comment: 'автоматически по отметкам этапов', onecNum: o.onecNum, changedAt: stageAt, orderNumber: o.orderNumber },
      ...base,
    });
    out.push({
      id: uuid(), type: 'production-stage', createdAt: new Date(ts).toISOString(),
      payload: { status: o.status === 'READY_TO_SHIP' ? 'DONE' : 'IN_PROGRESS', onecNum: o.onecNum, changedAt: stageAt, stageCode: 'PRODUCTION', orderNumber: o.orderNumber, routingStage: null },
      ...base,
    });
    if (o.status === 'READY_TO_SHIP') {
      const a = pick(ARTICLES);
      out.push({
        id: uuid(), type: 'production.completed', createdAt: new Date(ts + 22).toISOString(),
        payload: { onecNum: o.onecNum, orderNumber: o.orderNumber, lines: [{ qty: 1 + (i % 3), unit: 'шт', articleCode: a.articleCode, articleName: a.name, orderLineId: uuid() }] },
        ...base,
      });
    }
    ts -= (35 + Math.floor(rnd() * 400)) * 60 * 1000;
  });
  return out;
}

function buildInbox(): InboxMsg[] {
  const out: InboxMsg[] = [];
  let ts = TODAY + (11 * 60 + 34) * 60 * 1000; // 03.09 11:34Z
  const push = (type: string, payload: Record<string, unknown>, status: string, error: string | null = null) => {
    const receivedAt = new Date(ts).toISOString();
    out.push({
      id: uuid(), system: '1C', type, externalKey: uuid(), payload, status,
      attempts: status === 'FAILED' ? 3 : status === 'PENDING' ? 0 : 1, error,
      receivedAt,
      processedAt: status === 'PENDING' ? null : new Date(ts + 80 + Math.floor(rnd() * 900)).toISOString(),
    });
    ts -= (25 + Math.floor(rnd() * 300)) * 60 * 1000;
  };
  push('production.posted', { onecNum: 'Т7АА-002483', output: [{ qty: 3, unit: 'шт', articleCode: 'm-035' }], movement: { documentNumber: 'ПОТ-000418', documentDate: '2026-09-03', warehouseFrom: '74п_Склад Сырья', warehouseTo: '74п_ЦМК2_Кладовая_ЦМК' } }, 'PENDING');
  push('payment.posted', { documentNumber: 'ПП-004512', orderNumber: 'Т7АА-002541', amount: 124500000, paidAt: '2026-09-03' }, 'PENDING');
  push('production.rejected', { onecNum: 'Т7АА-002529', orderNumber: 'Т7АА-002529', error: { code: 'INSUFFICIENT_STOCK', message: 'Не хватает материала на складе', lines: [{ need: 6, available: 2, materialCode: 'С0402' }] } }, 'PROCESSED');
  push('production.costed', { period: '2026-08', documents: [{ documentNumber: 'ПБЗ-001', finalAmount: 12345.67 }, { documentNumber: 'ПБЗ-002', finalAmount: 1893220.4 }] }, 'PROCESSED');
  push('receipt.posted', { documentNumber: 'ПТУ-000812', warehouse: '74п_Склад Сырья', supplier: 'Казметаллснаб, ТОО', lines: [{ materialCode: 'С0402', name: 'Швеллер 12У', qty: 240, unit: 'м', price: 4180 }, { materialCode: 'С0301', name: 'Лист г/к 4 мм', qty: 3200, unit: 'кг', price: 395 }] }, 'PROCESSED');
  push('nomenclature.created', { code: 'С0421', name: 'Швеллер 14У', unit: 'м', group: 'Прокат сортовой' }, 'PROCESSED');
  push('order.status_changed', { orderNumber: 'Т7АА-002444', onecNum: 'Т7АА-002444', status: 'SHIPPED', changedAt: '2026-09-01T10:14:16Z' }, 'PROCESSED');
  push('stock.snapshot', { warehouse: '74п_Склад Сырья', asOf: '2026-09-01', lines: 412 }, 'FAILED', 'Материал С0999 не найден в справочнике; строк с ошибкой: 3');
  push('purchase_order.posted', { documentNumber: 'ЗП-000377', supplier: 'Казметаллснаб, ТОО', total: 4812300, lines: 7 }, 'PROCESSED');
  push('payment.posted', { documentNumber: 'ПП-004498', orderNumber: 'Т7АА-002510', amount: 5200000, paidAt: '2026-08-31' }, 'PROCESSED');
  push('receipt.posted', { documentNumber: 'ПТУ-000809', warehouse: '74п_Склад Сырья', supplier: 'Металл-Профиль KZ, ТОО', lines: [{ materialCode: 'С0604', name: 'Труба 108х4', qty: 180, unit: 'м', price: 6920 }] }, 'PROCESSED');
  push('order.status_changed', { orderNumber: 'Т7АА-002421', onecNum: 'Т7АА-002421', status: 'SHIPPED', changedAt: '2026-08-31T10:14:29Z' }, 'PROCESSED');
  push('nomenclature.created', { code: 'С0906', name: 'Болт М20х60 оц. с гайкой и шайбой', unit: 'шт', group: 'Метизы' }, 'IGNORED');
  push('stock.snapshot', { warehouse: '74п_ЦМК2_Кладовая_ЦМК', asOf: '2026-08-30', lines: 96 }, 'PROCESSED');
  push('production.costed', { period: '2026-07', documents: [{ documentNumber: 'ПБЗ-000', finalAmount: 2210840.15 }] }, 'IGNORED');
  push('payment.posted', { documentNumber: 'ПП-004470', orderNumber: 'Т7АА-002507', amount: 2375000, paidAt: '2026-08-28' }, 'PROCESSED');
  push('purchase_order.posted', { documentNumber: 'ЗП-000371', supplier: 'ТОО «Евразия Сталь»', total: 12640000, lines: 12 }, 'PROCESSED');
  push('receipt.posted', { documentNumber: 'ПТУ-000801', warehouse: '74п_Склад Сырья', supplier: 'Казметаллснаб, ТОО', lines: [{ materialCode: 'С0713', name: 'Балка 20 Б1', qty: 96, unit: 'м', price: 11250 }] }, 'PROCESSED');
  return out;
}

const OUTBOX: OutboxMsg[] = buildOutbox();
const INBOX: InboxMsg[] = buildInbox();

function countByStatus(list: Array<{ status: string }>, extra: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = { ...extra };
  for (const m of list) out[m.status] = (out[m.status] ?? 0) + 1;
  return out;
}

/* ------------------------------------------------------------------ */
/* Дашборды                                                            */
/* ------------------------------------------------------------------ */

/** Воронка по статусам — 384 заказа, как в базе на 03.09 */
const PIPELINE = [
  { status: 'NEW', count: 7 },
  { status: 'CONFIRMED', count: 214 },
  { status: 'IN_PRODUCTION', count: 11 },
  { status: 'READY_TO_SHIP', count: 6 },
  { status: 'SHIPPED', count: 4 },
  { status: 'CLOSED', count: 142 },
];

/** Деньги — суммы из payment_documents и orders на 03.09 */
const MONEY = { totalContracted: 663079211.22, totalPaid: 567096879.96, totalUnpaid: 96944420.26 };
const RECEIVABLES = { contracted: 1932879034.17, paid: 454012614, activeOrders: 242, ordersWithoutPaymentData: 201 };
const WORKLOAD = {
  requiredHours: 2184.5,
  weeklyCapacityHours: 400, // 4 участка × 80 ч/день × 5
  byStage: [
    { stage: 'CUTTING', requiredHours: 612.4 },
    { stage: 'ASSEMBLY', requiredHours: 1128.7 },
    { stage: 'PAINTING', requiredHours: 443.4 },
  ],
  activeOrders: 242,
  ordersWithoutPlannedDate: 14,
  linesWithoutNorm: 412,
  linesTotal: 1103,
};

const overdueTop = (n: number, withPlanned: boolean) =>
  ORDERS.filter((o) => o.overdueDays > 0)
    .sort((a, b) => b.overdueDays - a.overdueDays)
    .slice(0, n)
    .map((o) => ({
      id: o.id, orderNumber: o.orderNumber, overdueDays: o.overdueDays,
      ...(withPlanned ? { plannedShipmentDate: day(o.planned) } : {}),
      customer: { name: o.customer },
    }));

const readyTop = (n: number) =>
  ORDERS.filter((o) => o.status === 'READY_TO_SHIP')
    .sort((a, b) => (a.planned ?? '').localeCompare(b.planned ?? ''))
    .slice(0, n)
    .map((o) => ({ id: o.id, orderNumber: o.orderNumber, plannedShipmentDate: day(o.planned), customer: { name: o.customer } }));

function directorDashboard() {
  const active = activeOrders();
  let tc = 0, tp = 0, tm = 0;
  const rows = active.map((o) => {
    const price = o.total ?? 1250000;
    const row: Record<string, unknown> = {
      id: o.id, orderNumber: o.orderNumber, status: o.status, plannedShipmentDate: day(o.planned),
      overdueDays: o.overdueDays, customer: { name: o.customer },
    };
    if (o.marginPct == null) {
      Object.assign(row, { totalCost: null, totalPrice: null, margin: null, marginPct: null, marginHealth: 'NO_COSTING' });
      return { row, pct: 999 };
    }
    const totalPrice = jsRound(price);
    const totalCost = jsRound(price * (1 - o.marginPct / 100));
    const margin = totalPrice - totalCost;
    tc += totalCost; tp += totalPrice; tm += margin;
    const pct = (margin / totalPrice) * 100;
    Object.assign(row, {
      totalCost, totalPrice, margin, marginPct: r1(pct),
      marginHealth: pct >= 30 ? 'OK' : pct >= 25 ? 'WARN' : 'CRITICAL',
    });
    return { row, pct };
  });
  rows.sort((a, b) => a.pct - b.pct);
  const shown = Math.min(rows.length, 50);
  return {
    margin: {
      targetPct: 35, totalPrice: jsRound(tp), totalCost: jsRound(tc), totalMargin: jsRound(tm),
      actualPct: tp > 0 ? jsRound((tm / tp) * 1000) / 10 : null,
      orders: rows.slice(0, shown).map((x) => x.row), ordersTotal: rows.length, ordersShown: shown,
    },
    needsDecision: { batchOverrides: 3, priceReviews: 4, nomenclatureStuck: 2, quarantineBatches: 119, expiringReservations: 5, inboxOrders: 7 },
    money: MONEY,
    pipeline: PIPELINE,
    overdue: overdueTop(5, false),
  };
}

function roleWidgets() {
  return {
    family: 'admin',
    widgets: {
      orderFunnel: PIPELINE,
      overdueOrders: { count: ORDERS.filter((o) => o.overdueDays > 0).length, top: overdueTop(5, true) },
      awaitingPayment: { linesCount: 137, totalDue: MONEY.totalUnpaid },
      specsWithoutNorms: {
        count: 1284,
        top: [
          { id: ARTICLES[22].id, articleCode: 'М0605', name: 'Зажим канатный 13 мм' },
          { id: ARTICLES[1].id, articleCode: 'b-006', name: 'Контейнер из сэндвич панелей нестандартный' },
          { id: ARTICLES[17].id, articleCode: 'n-365', name: 'Пригр. Опора МК 30м без корзины (реставрация) 4,5 секция' },
          { id: ARTICLES[15].id, articleCode: 'n-186', name: 'М21-Ф45.39-5.6-6.4.3' },
          { id: ARTICLES[20].id, articleCode: 'z-362', name: 'Пластина200х200х20мм –10шт.' },
        ],
      },
      priceDeviations: [
        { id: ARTICLES[13].id, articleCode: 'm-035', name: ARTICLES[13].name, approvedPrice: 6198680, specPrice: 7412300, deviationPct: 19.6 },
        { id: ARTICLES[6].id, articleCode: 'm-017', name: ARTICLES[6].name, approvedPrice: 5840000, specPrice: 4905600, deviationPct: -16 },
        { id: ARTICLES[18].id, articleCode: 'o-052', name: ARTICLES[18].name, approvedPrice: 1930000, specPrice: 2181000, deviationPct: 13 },
        { id: ARTICLES[3].id, articleCode: 'l-012', name: ARTICLES[3].name, approvedPrice: 412000, specPrice: 372000, deviationPct: -9.7 },
        { id: ARTICLES[19].id, articleCode: 'p-017', name: ARTICLES[19].name, approvedPrice: 286500, specPrice: 305300, deviationPct: 6.6 },
      ],
      procurement: [
        { status: 'DRAFT', count: 68 },
        { status: 'APPROVED', count: 12 },
        { status: 'ORDERED', count: 9 },
      ],
      readyToShip: { count: ORDERS.filter((o) => o.status === 'READY_TO_SHIP').length, top: readyTop(5) },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Помощники                                                           */
/* ------------------------------------------------------------------ */

const like = (v: string | null | undefined, q: string) => (v ?? '').toLowerCase().includes(q.toLowerCase());
const idFrom = (path: string, index: number) => path.split('/')[index] ?? '';
const bodyOf = (ctx: FixtureContext): Record<string, any> =>
  ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, any>) : {};

/* ------------------------------------------------------------------ */
/* Маршруты                                                            */
/* ------------------------------------------------------------------ */

export const routes: FixtureRoute[] = [
  // ---------- Пользователи и роли (users.go) ----------
  { method: 'GET', match: /^\/users$/, handler: () => [...USERS].sort(byEmail) },
  { method: 'GET', match: /^\/users\/roles$/, handler: () => ROLES },
  {
    method: 'POST', match: /^\/users$/,
    handler: (ctx) => {
      const b = bodyOf(ctx);
      const created = user(String(b.email ?? 'new@avh.kz').toLowerCase(), Array.isArray(b.roles) ? b.roles : ['viewer'], at(0, 9, 30));
      if (b.employeeId) created.employee = { id: String(b.employeeId), name: 'Новый сотрудник' };
      USERS.push(created);
      return created;
    },
  },
  {
    method: 'PATCH', match: /^\/users\/([^/]+)$/,
    handler: (ctx) => {
      const id = idFrom(ctx.path, 2);
      const b = bodyOf(ctx);
      const u = USERS.find((x) => x.id === id) ?? USERS[0];
      if (Array.isArray(b.roles) && b.roles.length) u.roles = roleRefs(b.roles);
      if (typeof b.isActive === 'boolean') u.isActive = b.isActive;
      if ('employeeId' in b) u.employee = b.employeeId ? { id: String(b.employeeId), name: u.employee?.name ?? 'Сотрудник' } : null;
      return u;
    },
  },
  { method: 'POST', match: /^\/users\/([^/]+)\/reset-password$/, handler: () => ({ ok: true }) },

  // ---------- Общий поиск (platform.go Search) ----------
  {
    method: 'GET', match: /^\/search$/,
    handler: ({ params }) => {
      const q = (params.get('q') ?? '').trim();
      if ([...q].length < 2) return { query: q, orders: [], articles: [], materials: [] };
      const LIMIT = 8;
      const orders = [...ORDERS]
        .sort((a, b) => Number(a.isArchived) - Number(b.isArchived))
        .filter((o) => like(o.orderNumber, q) || like(o.onecNum, q) || like(o.customer, q) || like(o.finalCustomer, q) || like(o.projectSite, q) || like(o.customerOrderNum, q))
        .slice(0, LIMIT)
        .map((o) => {
          const parts: string[] = [];
          if (o.customer) parts.push(o.customer);
          if (o.onecNum) parts.push(`1С: ${o.onecNum}`);
          return { id: o.id, orderNumber: o.orderNumber, subtitle: parts.join(' · '), status: o.status, isArchived: o.isArchived };
        });
      const articles = ARTICLES
        .filter((a) => like(a.articleCode, q) || like(a.name, q))
        .sort((a, b) => a.articleCode.localeCompare(b.articleCode))
        .slice(0, LIMIT);
      const direct = MATERIALS
        .filter((m) => like(m.materialCode, q) || like(m.name, q))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        .slice(0, LIMIT);
      const materials: Array<Material & { viaAlias: string | null }> = direct.map((m) => ({ ...m, viaAlias: null }));
      if (materials.length < LIMIT) {
        const seen = new Set(direct.map((m) => m.id));
        for (const a of ALIASES) {
          if (materials.length >= LIMIT) break;
          const m = MATERIALS.find((x) => x.materialCode === a.materialCode);
          if (!m || seen.has(m.id) || !like(a.alias, q)) continue;
          seen.add(m.id);
          materials.push({ ...m, viaAlias: a.alias });
        }
      }
      return { query: q, orders, articles, materials };
    },
  },

  // ---------- Сохранённые виды (platform.go SavedViews*) ----------
  {
    method: 'GET', match: /^\/saved-views$/,
    handler: ({ params }) => {
      const module = params.get('module') || 'orders';
      return SAVED_VIEWS.filter((v) => v.module === module && v.ownerEmail === ME_EMAIL)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  },
  {
    method: 'POST', match: /^\/saved-views$/,
    handler: (ctx) => {
      const b = bodyOf(ctx);
      const name = String(b.name ?? '').trim() || 'Без имени';
      const v: SavedView = {
        id: uuid(), module: String(b.module || 'orders'), name: [...name].slice(0, 100).join(''),
        ownerEmail: ME_EMAIL, config: b.config && typeof b.config === 'object' ? b.config : {}, createdAt: at(0, 9, 45),
      };
      SAVED_VIEWS.push(v);
      return v;
    },
  },
  {
    method: 'DELETE', match: /^\/saved-views\/([^/]+)$/,
    handler: ({ path }) => {
      const id = idFrom(path, 2);
      const i = SAVED_VIEWS.findIndex((v) => v.id === id);
      if (i >= 0) SAVED_VIEWS.splice(i, 1);
      return { deleted: true };
    },
  },

  // ---------- Журнал аудита (platform.go AuditLog) ----------
  {
    method: 'GET', match: /^\/audit-log$/,
    handler: ({ params }) => {
      const page = Math.max(1, Number(params.get('page')) || 1);
      const pageSize = Math.max(1, Number(params.get('pageSize')) || 50);
      const userId = params.get('userId');
      const entity = params.get('entity');
      const filtered = AUDIT.filter((e) => (!userId || e.userId === userId) && (!entity || e.entityType === entity));
      const data = filtered.slice((page - 1) * pageSize, page * pageSize);
      return { data, meta: { page, pageSize, total: filtered.length } };
    },
  },

  // ---------- Дашборды (dashboards.go) ----------
  { method: 'GET', match: /^\/dashboards\/role-widgets$/, handler: () => roleWidgets() },
  { method: 'GET', match: /^\/dashboards\/director$/, handler: () => directorDashboard() },
  {
    method: 'GET', match: /^\/dashboards\/monthly-series$/,
    handler: () => ({
      months: [
        { label: 'апр', ordersIn: 34, planned: 29, shipped: 27 },
        { label: 'май', ordersIn: 41, planned: 36, shipped: 33 },
        { label: 'июнь', ordersIn: 38, planned: 40, shipped: 35 },
        { label: 'июль', ordersIn: 46, planned: 39, shipped: 31 },
        { label: 'авг', ordersIn: 52, planned: 47, shipped: 38 },
        { label: 'сент', ordersIn: 9, planned: 44, shipped: 4 },
      ],
    }),
  },
  {
    method: 'GET', match: /^\/dashboards\/workload-forecast$/,
    handler: () => ({
      requiredHours: WORKLOAD.requiredHours,
      weeklyCapacityHours: WORKLOAD.weeklyCapacityHours,
      weeksOfBacklog: r1(WORKLOAD.requiredHours / WORKLOAD.weeklyCapacityHours),
      byStage: WORKLOAD.byStage,
      activeOrders: WORKLOAD.activeOrders,
      ordersWithoutPlannedDate: WORKLOAD.ordersWithoutPlannedDate,
      linesWithoutNorm: WORKLOAD.linesWithoutNorm,
      linesTotal: WORKLOAD.linesTotal,
    }),
  },
  {
    method: 'GET', match: /^\/dashboards\/cash-forecast$/,
    handler: () => ({
      receivables: { ...RECEIVABLES, owed: RECEIVABLES.contracted - RECEIVABLES.paid },
      payables: { owed: MONEY.totalUnpaid },
    }),
  },
  {
    method: 'GET', match: /^\/dashboards\/production-summary$/,
    handler: () => ({
      productionPlanFact: { planned: WORKLOAD.activeOrders, actual: 6 },
      workshopLoadHours: { used: WORKLOAD.requiredHours, total: WORKLOAD.weeklyCapacityHours },
      receivablesTotal: RECEIVABLES.contracted - RECEIVABLES.paid,
      fgStockVsNorm: { inStock: 82, norm: 100 },
    }),
  },
  { method: 'GET', match: /^\/dashboards\/finished-goods-summary$/, handler: () => ({ totalArticles: 20, totalApprovedPrice: 48213500 }) },

  // ---------- Обмен с 1С (integration/handlers.go) ----------
  {
    method: 'GET', match: /^\/integrations\/status$/,
    handler: () => ({
      configured: true,
      endpoint: 'https://1c.avh.kz/erp/hs/cmk/events',
      pull: { configured: true, baseUrl: 'https://1c.avh.kz/erp/hs/cmk', syncedOrders: 312, totalOrders: 384 },
      outbox: countByStatus(OUTBOX, { SENT: 1194 }),
      inbox: countByStatus(INBOX, { PROCESSED: 2860, IGNORED: 41 }),
    }),
  },
  {
    method: 'GET', match: /^\/integrations\/messages$/,
    handler: ({ params }) => {
      const take = Number(params.get('limit')) || 50;
      const status = params.get('status') ?? '';
      const direction = params.get('direction') ?? '';
      const outbox = direction === 'in' ? [] : OUTBOX.filter((m) => !status || m.status === status).slice(0, take);
      const inbox = direction === 'out' ? [] : INBOX.filter((m) => !status || m.status === status).slice(0, take);
      return { outbox, inbox };
    },
  },
  {
    method: 'POST', match: /^\/integrations\/outbox\/flush$/,
    handler: () => {
      const pending = OUTBOX.filter((m) => m.status === 'PENDING' || m.status === 'FAILED');
      const sentAt = at(0, 11, 41, 7);
      let failed = 0;
      pending.forEach((m, i) => {
        if (i === 0 && m.status === 'FAILED') { failed++; m.attempts++; return; }
        m.status = 'SENT'; m.attempts++; m.sentAt = sentAt; m.lastError = null; m.nextRetryAt = null;
      });
      return { skipped: false, sent: pending.length - failed, failed, processed: pending.length };
    },
  },
  {
    method: 'POST', match: /^\/integrations\/inbox\/process$/,
    handler: () => {
      const pending = INBOX.filter((m) => m.status === 'PENDING' || m.status === 'FAILED');
      const processedAt = at(0, 11, 41, 9);
      let failed = 0;
      for (const m of pending) {
        if (m.status === 'FAILED') { failed++; m.attempts++; continue; }
        m.status = 'PROCESSED'; m.attempts = 1; m.processedAt = processedAt;
      }
      return { processed: pending.length - failed, failed, ignored: 0, total: pending.length };
    },
  },
  {
    method: 'POST', match: /^\/integrations\/messages\/([^/]+)\/retry$/,
    handler: ({ path }) => {
      const id = idFrom(path, 3);
      const o = OUTBOX.find((m) => m.id === id);
      if (o) {
        o.status = 'PENDING'; o.attempts = 0; o.nextRetryAt = null; o.lastError = null;
        return { direction: 'out', requeued: true };
      }
      const i = INBOX.find((m) => m.id === id);
      if (i) { i.status = 'PENDING'; i.attempts = 0; i.error = null; }
      return { direction: 'in', requeued: true };
    },
  },
  {
    method: 'GET', match: /^\/integrations\/1c\/ping$/,
    handler: ({ params }) => ({ ok: true, message: '1С ответила за 214 мс', orderNumber: params.get('orderNumber') || 'Т7АА-002541' }),
  },
];
