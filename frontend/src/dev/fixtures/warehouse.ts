import type { FixtureRoute, FixtureContext } from './types';

/**
 * Фикстуры склада для режима дизайна (03.09.2026).
 *
 * Формы ответов один в один повторяют Go-обработчики
 * (backend-go/internal/modules/warehouse/*, catalog/materials.go,
 * misc/catalog_misc.go — min-stock):
 *   • decimal.Decimal → строка без хвостовых нулей: "4322.5", "3600";
 *   • common.PDate и time.Format(...) → "2026-08-24T00:00:00.000Z";
 *   • float64 → число.
 *
 * Данные — выборка из реальной базы ЦМК Аврора (коды С0604 «Швеллер 12У»,
 * поставщики «Bugel Алматы, ТОО», «МАЙ ТОО», документы Т7АА-000783,
 * изделия m-035 «Мачта М25м…»), дополненная детерминированным генератором:
 * без Math.random и Date.now — одна и та же картинка при каждом открытии.
 */

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

/** «Сегодня» режима дизайна */
const NOW = new Date('2026-09-03T09:00:00.000Z');
const DAY = 86_400_000;

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

/** Детерминированный псевдо-UUID (v4-подобный): одинаков при каждом запуске */
function uid(ns: string, i: number | string): string {
  const s = `${ns}:${i}`;
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const rnd = mulberry32(h);
  const hex = (n: number) => {
    let out = '';
    for (let k = 0; k < n; k++) out += Math.floor(rnd() * 16).toString(16);
    return out;
  };
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(rnd() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

/** decimal.Decimal в JSON — строка без хвостовых нулей: "4322.5", "3600", "1487.152" */
const dec = (n: number, places = 3): string => String(Number(n.toFixed(places)));
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Полночь UTC n дней назад — как movement_date/receipt_date из 1С */
function dayIso(daysAgo: number): string {
  const d = new Date(NOW);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}
/** Точка во времени со смещением в часах от NOW */
function atHours(hoursFromNow: number): string {
  return new Date(NOW.getTime() + hoursFromNow * 3_600_000).toISOString();
}

function pageOf<T>(list: T[], params: URLSearchParams, defaultSize: number): { data: T[]; page: number; pageSize: number } {
  let page = Number(params.get('page'));
  if (!(page >= 1)) page = 1;
  let pageSize = Number(params.get('pageSize'));
  if (!(pageSize >= 1)) pageSize = defaultSize;
  const start = Math.min((page - 1) * pageSize, list.length);
  return { data: list.slice(start, start + pageSize), page, pageSize };
}

const lc = (s: string) => s.toLowerCase();
const ruCompare = (a: string, b: string) => a.localeCompare(b, 'ru');
const body = (ctx: FixtureContext): Record<string, any> => (ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, any>) : {});

/** Пользователь режима дизайна (см. designMode.ts) */
const DESIGN_USER_ID = '00000000-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// Справочник материалов — ~320 позиций пяти категорий
// ---------------------------------------------------------------------------

type Cat = 'METAL' | 'HARDWARE' | 'COMPONENTS' | 'CONSUMABLES' | 'INSTRUMENTS';

interface Mat {
  id: string;
  code: string;
  cat: Cat;
  name: string;
  unit: string;
  /** учётная (средневзвешенная) цена, ₸ */
  price: number;
  /** прайсовая цена, ₸ */
  list: number;
  stock: number;
  last: number;
  lastDate: string | null;
  updatedAt: string | null;
  weight: number;
}

/** Реальные uuid ключевых материалов — чтобы ссылки из других модулей сходились */
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
  'С0202': '72903e4a-751d-45f3-8c03-047d17b57ad6',
  'С0210': 'd0826a0c-cd7b-4526-8b18-a19656e1fb59',
  'С0308': '1d65137d-9e24-4f69-81e4-d4545cf621b2',
  'С0318': '1367b3bc-6f89-4412-b650-100523c80ff8',
  'М0104': '6ac80540-7977-4b75-a759-4c03b6c8cb25',
  'М0119': '7ebe96fe-5175-4360-8d5b-cb4199182808',
  'М0139': 'f2840f6d-6773-430c-adb8-215e86a01fd7',
  'М0201': '7bca9d1d-2189-4ac4-87b0-6911326c99da',
  'Л0003': 'd278e45d-5c20-4b2d-be3f-1ce351858334',
  'Л0006': '6dc0cad6-ada7-4e66-81c3-a993ca467175',
  'Л0020': '5778c186-b0db-4775-9d45-b7dfe6ee5f3b',
  'К1203': '356f3898-e891-4097-a191-5ca02e4f3a0c',
};

const num = (s: string) => Number(s.replace(',', '.'));

function buildMaterials(): Mat[] {
  const rnd = mulberry32(20260903);
  const out: Mat[] = [];
  const seen = new Set<string>();

  const add = (code: string, cat: Cat, name: string, unit: string, price: number, stockHint: number, weight = 0) => {
    if (seen.has(code)) return;
    seen.add(code);
    const p = Math.round(price * 100) / 100;
    const zero = rnd() < 0.12;
    const stock = zero ? 0 : round3(stockHint * (0.2 + rnd() * 1.6));
    const hasLast = rnd() < 0.3;
    const lastDays = Math.floor(rnd() * 250);
    out.push({
      id: REAL_IDS[code] ?? uid('material', code),
      code, cat, name, unit,
      price: p,
      list: Math.round(p * (0.7 + rnd() * 0.6) * 100) / 100,
      stock,
      last: hasLast ? Math.round(p * (0.9 + rnd() * 0.2) * 100) / 100 : 0,
      lastDate: hasLast ? dayIso(lastDays) : null,
      updatedAt: hasLast ? dayIso(lastDays) : null,
      weight,
    });
  };

  // --- Металл ---
  const profPipe: Array<[string, string]> = [
    ['С0411', '15х15х1,5'], ['С0412', '20х20х1,5'], ['С0414', '20х20х2'], ['С0415', '25х25х2'], ['С0416', '30х30х2'],
    ['С0418', '40х20х1,5'], ['С0419', '40х20х2'], ['С0420', '40х25х2'], ['С0421', '40х40х2'], ['С0433', '40х40х3'],
    ['С0422', '50х25х2'], ['С0423', '50х50х2'], ['С0424', '50х50х3'], ['С0426', '60х30х2'], ['С0427', '60х40х3'],
    ['С0428', '60х60х3'], ['С0429', '60х60х4'], ['С0430', '80х40х3'], ['С0431', '80х80х3'], ['С0432', '80х80х4'],
    ['С0435', '100х50х4'], ['С0402', '100х100х4'], ['С0438', '100х100х5'], ['С0406', '120х120х4'], ['С0447', '120х120х5'],
    ['С0409', '140х140х4'], ['С0449', '150х100х5'], ['С0451', '160х160х5'], ['С0453', '180х180х6'], ['С0455', '200х200х6'],
    ['С0457', '250х250х6'],
  ];
  for (const [code, spec] of profPipe) {
    const [a, b, t] = spec.split('х').map(num);
    add(code, 'METAL', `Труба профильная ${spec} мм`, 'м', (a + b) * t * 4.8, a >= 100 ? 900 : 2500, ((a + b) * 2 * t * 7.85) / 1000);
  }
  const angle: Array<[string, string]> = [
    ['С0505', '25х25х3'], ['С0506', '25х25х4'], ['С0511', '32х32х4'], ['С0507', '40х40х4'], ['С0512', '40х40х5'],
    ['С0515', '45х45х4'], ['С0508', '50х50х4'], ['С0509', '50х50х5'], ['С0510', '63х63х5'], ['С0516', '63х63х6'],
    ['С0517', '70х70х5'], ['С0518', '75х75х6'], ['С0513', '80х80х6'], ['С0519', '80х80х8'], ['С0514', '90х90х6'],
    ['С0520', '100х100х7'], ['С0521', '100х100х8'], ['С0530', '125х125х8'], ['С0531', '125х125х10'], ['С0532', '140х140х9'],
    ['С0533', '160х160х10'],
  ];
  for (const [code, spec] of angle) {
    const [a, , t] = spec.split('х').map(num);
    add(code, 'METAL', `Уголок ${spec} мм`, 'м', a * t * 4.9, a >= 100 ? 600 : 4000, (2 * a * t * 7.85) / 1000);
  }
  const channel: Array<[string, string]> = [
    ['С0601', '5П'], ['С0602', '6,5П'], ['С0611', '8П'], ['С0612', '8У'], ['С0608', '10П'], ['С0609', '10У'],
    ['С0603', '12П'], ['С0604', '12У'], ['С0605', '14П'], ['С0606', '14У'], ['С0607', '16П'], ['С0610', '16У'],
    ['С0613', '18П'], ['С0615', '18У'], ['С0614', '20П'], ['С0616', '20У'], ['С0617', '22П'], ['С0618', '24П'],
    ['С0619', '27П'], ['С0620', '30П'],
  ];
  for (const [code, spec] of channel) {
    const n = num(spec.replace(/[ПУ]/, ''));
    add(code, 'METAL', `Швеллер ${spec}`, 'м', n * 360, n >= 20 ? 250 : 1500, n * 0.85);
  }
  const beam: Array<[string, string]> = [
    ['С0701', '10 Б1'], ['С0702', '12 Б1'], ['С0703', '14 Б1'], ['С0705', '16 Б1'], ['С0706', '18 Б1'], ['С0713', '20 Б1'],
    ['С0717', '20 Б2'], ['С0716', '20 К1'], ['С0714', '20 К2'], ['С0715', '25 Б1'], ['С0718', '25 Б2'], ['С0719', '25 К1'],
    ['С0711', '30 Б1'], ['С0720', '30 Б2'], ['С0704', '30 К1'], ['С0709', '30 Ш1'], ['С0708', '35 Б1'], ['С0721', '35 К1'],
    ['С0722', '40 Б1'], ['С0723', '40 К1'], ['С0712', '45 Б1'], ['С0724', '50 Б1'],
  ];
  for (const [code, spec] of beam) {
    const [n, kind] = spec.split(' ');
    const k = kind.startsWith('К') ? 1400 : kind.startsWith('Ш') ? 900 : 650;
    add(code, 'METAL', `Балка ${spec}`, 'м', num(n) * k, 500, num(n) * 1.6);
  }
  const round: Array<[string, string]> = [
    ['С0113', '6,5'], ['С0101', '8'], ['С0103', '10'], ['С0104', '12'], ['С0105', '14'], ['С0106', '16'], ['С0107', '18'],
    ['С0108', '20'], ['С0110', '22'], ['С0109', '25'], ['С0111', '28'], ['С0112', '30'], ['С0114', '32'], ['С0115', '36'],
    ['С0117', '40'], ['С0118', '50'],
  ];
  for (const [code, d] of round) add(code, 'METAL', `Круг ф ${d} мм`, 'м', num(d) ** 2 * 2, num(d) <= 16 ? 9000 : 1200, (num(d) ** 2 * 6.17) / 1000);
  for (const [code, d] of [['С0120', '8'], ['С0121', '10'], ['С0116', '12'], ['С0122', '14'], ['С0123', '16'], ['С0124', '20']]) {
    add(code, 'METAL', `Арматура А5 ${d} мм`, 'м', num(d) ** 2 * 1.9, 4000, (num(d) ** 2 * 6.17) / 1000);
  }
  for (const [code, t] of [['С0201', '2'], ['С0203', '3'], ['С0208', '4'], ['С0204', '5'], ['С0210', '6'], ['С0205', '8'], ['С0202', '10'], ['С0206', '12'], ['С0207', '14'], ['С0209', '16'], ['С0211', '20']]) {
    add(code, 'METAL', `Лист горячекатанный 1500х6000х${t}`, 'м2', num(t) * 2200, 400, num(t) * 7.85);
  }
  add('С0213', 'METAL', 'Лист ПВЛ 1000х2500х4', 'м2', 9800, 300, 18);
  add('С0214', 'METAL', 'Лист ПВЛ 1000х2500х5', 'м2', 11500, 200, 22);
  add('С0215', 'METAL', 'Лист оцинкованный 1250х2500х0,5', 'м2', 3200, 900, 4);
  add('С0216', 'METAL', 'Лист оцинкованный 1250х2500х0,7', 'м2', 4100, 700, 5.5);
  add('С0217', 'METAL', 'Лист оцинкованный 1250х2500х1,0', 'м2', 5600, 500, 7.9);
  add('С0218', 'METAL', 'Лист рифлёный 1500х6000х4', 'м2', 10400, 250, 33);
  const esPipe: Array<[string, string]> = [
    ['С0301', '57х3'], ['С0302', '57х3,5'], ['С0317', '76х3'], ['С0318', '76х3,5'], ['С0305', '89х3,5'], ['С0308', '102х4'],
    ['С0309', '108х4'], ['С0310', '114х4'], ['С0311', '133х4'], ['С0312', '159х4,5'], ['С0313', '219х6'],
  ];
  for (const [code, spec] of esPipe) {
    const [d, t] = spec.split('х').map(num);
    add(code, 'METAL', `Труба э/с ф${spec} мм`, 'м', d * t * 9, d >= 133 ? 300 : 1800, (d * t * 0.02466));
  }
  for (const [code, spec] of [['С0810', '40х4'], ['С0811', '50х5'], ['С0812', '60х6'], ['С0813', '80х8']]) {
    const [a, t] = spec.split('х').map(num);
    add(code, 'METAL', `Полоса ${spec} мм`, 'м', a * t * 4, 1500, (a * t * 7.85) / 1000);
  }
  add('С0802', 'METAL', 'Сетка рабица 30х30х2,5 мм оц.', 'м2', 2450, 6000, 3.1);
  add('С0803', 'METAL', 'Сетка рабица 50х50х2,5 мм оц.', 'м2', 1980, 3000, 2.1);
  add('С0805', 'METAL', 'Сетка сварная 50х50х4 мм (карта 2х3 м)', 'м2', 3600, 800, 5.2);

  // --- Метизы (кг, кроме анкеров) ---
  const boltCodes: Record<string, string> = {
    '12х40': 'М0104', '12х45': 'М0105', '12х50': 'М0106', '16х55': 'М0111', '16х65': 'М0113', '16х70': 'М0114',
    '20х80': 'М0119', '10х30': 'М0139', '12х35': 'М0140', '24х120': 'М0165', '16х40': 'М0167', '24х80': 'М0168',
  };
  const boltLens: Record<number, number[]> = { 6: [20, 30, 40], 8: [20, 30, 40, 60], 10: [30, 40, 50, 60, 80], 12: [35, 40, 45, 50, 60, 80, 100], 16: [40, 55, 65, 70, 80, 100, 120], 20: [60, 80, 100, 120], 24: [80, 100, 120, 150] };
  let bi = 20;
  for (const d of [6, 8, 10, 12, 16, 20, 24]) {
    for (const L of boltLens[d]) {
      const spec = `${d}х${L}`;
      const code = boltCodes[spec] ?? `М01${String(bi++).padStart(2, '0')}`;
      add(code, 'HARDWARE', `Болт М${spec} оц.${d === 24 && L === 120 ? ' 10,9' : ''}`, 'кг', 640 + d * 6 + (L > 80 ? 40 : 0), d >= 16 ? 400 : 150);
    }
  }
  for (const [code, d] of [['М0206', '6'], ['М0207', '8'], ['М0201', '10'], ['М0202', '12'], ['М0203', '16'], ['М0204', '20'], ['М0205', '24'], ['М0208', '27'], ['М0209', '30']]) {
    add(code, 'HARDWARE', `Гайка M${d} оц.`, 'кг', 700 + num(d) * 8, 120);
  }
  for (const [code, d] of [['М0301', '6'], ['М0302', '8'], ['М0303', '10'], ['М0304', '12'], ['М0305', '16'], ['М0306', '20'], ['М0309', '24'], ['М0310', '30']]) {
    add(code, 'HARDWARE', `Шайба плоская М${d} оц.`, 'кг', 720 + num(d) * 2, 80);
  }
  for (const [code, d] of [['М0311', '6'], ['М0312', '8'], ['М0315', '10'], ['М0316', '12'], ['М0317', '16'], ['М0318', '20'], ['М0321', '24'], ['М0322', '30']]) {
    add(code, 'HARDWARE', `Шайба гровер М${d} оц.`, 'кг', 800 + num(d) * 2, 60);
  }
  add('М0401', 'HARDWARE', 'Саморез 3,5х32', 'кг', 1180, 40);
  add('М0503', 'HARDWARE', 'Саморез по металлу 4,2х13', 'кг', 1125, 60);
  add('М0504', 'HARDWARE', 'Саморез по металлу 4,2х19', 'кг', 1150, 45);
  add('М0520', 'HARDWARE', 'Саморез кровельный 4,8х35', 'кг', 1320, 50);
  add('М0532', 'HARDWARE', 'Саморез кровельный 5.5х50', 'кг', 1380, 40);
  add('М0516', 'HARDWARE', 'Саморез кровельный 5.5х70', 'кг', 1420, 30);
  add('М0005', 'HARDWARE', 'Анкерный болт М10х12х150', 'шт', 105, 1200);
  add('М0006', 'HARDWARE', 'Анкерный болт М12х150', 'шт', 160, 800);
  add('М0007', 'HARDWARE', 'Анкерный болт М16х200', 'шт', 340, 500);
  add('М0008', 'HARDWARE', 'Анкер клиновой М12х120', 'шт', 210, 900);
  add('М0009', 'HARDWARE', 'Шпилька резьбовая М16х1000', 'шт', 1850, 120);
  add('М0010', 'HARDWARE', 'Шпилька резьбовая М20х1000', 'шт', 2900, 80);

  // --- Комплектующие ---
  const comps: Array<[string, string, string, number, number]> = [
    ['К1203', 'фланцы 65/16 ГОСТ 12820-80', 'шт', 3319.7, 200],
    ['К1204', 'фланцы 80/16 ГОСТ 12820-80', 'шт', 3980, 120],
    ['К1205', 'фланцы 100/16 ГОСТ 12820-80', 'шт', 4650, 80],
    ['К1004', 'Сэндвич-панель 80х1200 мм мин.плита', 'м2', 12350, 600],
    ['К1005', 'Сэндвич-панель 100х1200 мм мин.плита', 'м2', 13900, 400],
    ['К1006', 'Сэндвич-панель 150х1200 мм кровельная', 'м2', 16800, 250],
    ['К1102', 'Фанера ФСФ-21 (2440х1220)', 'м2', 17070, 120],
    ['К1103', 'Фанера ФСФ-12 (2440х1220)', 'м2', 9800, 150],
    ['К1104', 'ОСБ-3 плита 9 мм (2500х1250)', 'лист', 7400, 60],
    ['К0918', 'Кабель ВВГ нг LS 5х6', 'м', 1450, 400],
    ['К0919', 'Кабель ВВГнг-LS 3х2,5', 'м', 520, 900],
    ['Р2133', 'Кабель ВВГнг-LS 5х2,5', 'м', 780, 700],
    ['Р2130', 'Кабель ВВГнг-LS 5х25', 'м', 5200, 90],
    ['К0055', 'Металлорукав д.25 РЗЦХ10', 'м', 320, 500],
    ['К0238', 'Профнастил оц. С8 0,45х1150 мм (2,63м)', 'шт', 6900, 150],
    ['К0239', 'Профнастил оц. С21 0,5х1000 мм (6м)', 'шт', 15800, 60],
    ['К1125', 'Подвесной потолок Армстронг 8 мм', 'м2', 2100, 400],
    ['К0465', 'Плинтус напольный', 'шт', 465, 400],
    ['К0183', 'Клей для плитки 25кг', 'шт', 2400, 80],
    ['К0301', 'Дверь металлическая 2050х900 утеплённая', 'шт', 118000, 12],
    ['К0302', 'Окно ПВХ 600х600 поворотно-откидное', 'шт', 42000, 10],
    ['К0410', 'Утеплитель минераловатный 100 мм (плита 1200х600)', 'м2', 1850, 700],
    ['К0411', 'Пенополистирол ПСБ-С 25, 50 мм', 'м2', 980, 500],
    ['К0520', 'Автоматический выключатель ВА47-29 C16', 'шт', 1650, 60],
    ['К0521', 'Розетка накладная IP44', 'шт', 1250, 40],
    ['К0522', 'Светильник ЛПО 2х36 IP54', 'шт', 9800, 20],
    ['К0523', 'Вентилятор канальный ВК-125', 'шт', 27500, 8],
    ['К0610', 'Петля приварная ф20 L100', 'шт', 950, 200],
    ['К0611', 'Замок навесной 70 мм', 'шт', 5200, 30],
    ['К0612', 'Заглушка пластиковая 80х80', 'шт', 85, 1500],
    ['К0613', 'Заглушка пластиковая 40х40', 'шт', 45, 3000],
    ['К0614', 'Хомут трубный ф76 с гайкой', 'шт', 780, 400],
  ];
  for (const [code, name, unit, price, hint] of comps) add(code, 'COMPONENTS', name, unit, price, hint);

  // --- Расходники ---
  const cons: Array<[string, string, string, number, number]> = [
    ['Л0079', 'Эмаль ПФ-115 серый', 'кг', 950, 4000],
    ['Л0077', 'Эмаль ПФ-115 синяя', 'кг', 1000, 1500],
    ['Л0078', 'Эмаль ПФ-115 черная', 'кг', 1000, 1800],
    ['Л0080', 'Эмаль ПФ-115 белая', 'кг', 980, 1200],
    ['Л0081', 'Эмаль ПФ-115 красная', 'кг', 1050, 600],
    ['Л0082', 'Эмаль ПФ-115 жёлтая', 'кг', 1050, 400],
    ['Л0003', 'Грунтовка ГФ-021 красно-кор.', 'кг', 690, 12000],
    ['Л0004', 'Грунтовка ГФ-021 серая', 'кг', 710, 8000],
    ['Л0006', 'Грунт-эмаль Anticor 101 RAL 5005', 'кг', 3017, 300],
    ['Л0008', 'Грунт-эмаль Anticor 101 RAL 9005', 'кг', 3017, 400],
    ['Л0009', 'Грунт-эмаль Anticor 101 RAL 7035', 'кг', 3017, 350],
    ['Л0010', 'Грунт-эмаль Anticor 101 RAL 3020', 'кг', 3150, 120],
    ['Л0020', 'Растворитель 646', 'л', 950, 8000],
    ['Л0021', 'Растворитель 647', 'л', 980, 1500],
    ['Л0022', 'Уайт-спирит', 'л', 620, 2000],
    ['Л0030', 'Краска порошковая RAL 7035', 'кг', 2500, 600],
    ['Л0031', 'Краска порошковая RAL 9005', 'кг', 2500, 400],
    ['Л0032', 'Краска порошковая RAL 5005', 'кг', 2650, 250],
    ['Р0010', 'Электроды УОНИ-13/55 д.3 мм', 'кг', 1340, 800],
    ['Р0011', 'Электроды УОНИ-13/55 д.4 мм', 'кг', 1290, 600],
    ['Р0012', 'Электроды ОК-46 д.3 мм', 'кг', 1180, 900],
    ['Р0013', 'Электроды ОК-46 д.4 мм', 'кг', 1150, 500],
    ['Р0020', 'Проволока сварочная ER70S-6 1,2 мм (кассета 15 кг)', 'кг', 1150, 1500],
    ['Р0021', 'Проволока сварочная ER70S-6 0,8 мм (кассета 5 кг)', 'кг', 1220, 400],
    ['Р0060', 'Проволока вязальная 1,2 мм', 'кг', 857, 800],
    ['Р0030', 'Круг отрезной 125х1,2х22', 'шт', 180, 3000],
    ['Р0031', 'Круг отрезной 180х1,6х22', 'шт', 290, 1500],
    ['Р0032', 'Круг отрезной 230х2,0х22', 'шт', 420, 1200],
    ['Р0033', 'Круг зачистной 125х6х22', 'шт', 310, 800],
    ['Р0034', 'Круг зачистной 180х6х22', 'шт', 590, 500],
    ['Р0035', 'Круг лепестковый 125 P40', 'шт', 450, 600],
    ['Р0036', 'Круг лепестковый 125 P80', 'шт', 450, 400],
    ['Р0037', 'Диск пильный по металлу 355х25,4', 'шт', 18500, 12],
    ['Р0101', 'СОЖ', 'кг', 3948.33, 150],
    ['Р0110', 'Пропан (баллон 50 л)', 'балл', 7500, 20],
    ['Р0111', 'Кислород технический (баллон 40 л)', 'балл', 3200, 40],
    ['Р0112', 'Углекислота (баллон 40 л)', 'балл', 4500, 30],
    ['Р0120', 'Перчатки х/б с ПВХ', 'пара', 120, 2000],
    ['Р0121', 'Перчатки спилковые сварщика', 'пара', 1200, 150],
    ['Р0122', 'Очки защитные открытые', 'шт', 650, 100],
    ['Р0123', 'Респиратор FFP2', 'шт', 180, 500],
    ['Р0124', 'Стекло для маски сварщика 90х110', 'шт', 95, 400],
    ['Р0191', 'Маска медицинская', 'шт', 15, 2000],
    ['Р0130', 'Ветошь х/б', 'кг', 380, 300],
    ['Р0131', 'Скотч малярный 50 мм', 'шт', 420, 200],
    ['Р0132', 'Плёнка стрейч паллетная 500 мм', 'рул', 3200, 60],
    ['Р0133', 'Лента ФУМ', 'шт', 60, 300],
    ['Р0134', 'Смазка Литол-24', 'кг', 1450, 40],
    ['Р0135', 'Бумага наждачная P120 (рулон)', 'м', 210, 500],
    ['Х0014', 'Пакеты для мусора', 'шт', 186, 100],
    ['Х0011', 'Швабра с насадкой', 'компл', 1950, 6],
  ];
  for (const [code, name, unit, price, hint] of cons) add(code, 'CONSUMABLES', name, unit, price, hint);

  // --- Инструменты ---
  const tools: Array<[string, string, string, number, number]> = [
    ['И0042', 'Резак пропановый Р1П-100', 'шт', 13568, 10],
    ['Т0150', 'Фен сварочный LST 1600', 'шт', 175000, 2],
    ['P0417', 'Пила ленточная М-42 6/10-4300', 'шт', 24500, 40],
    ['Р0716', 'Фреза концевая 22', 'шт', 11673, 20],
    ['И0101', 'Сверло по металлу ф10,2 Р6М5', 'шт', 1850, 60],
    ['И0102', 'Сверло по металлу ф12 Р6М5', 'шт', 2300, 50],
    ['И0103', 'Сверло по металлу ф18 Р6М5', 'шт', 4900, 20],
    ['И0110', 'Метчик М12 комплект', 'компл', 4200, 15],
    ['И0111', 'Метчик М16 комплект', 'компл', 5800, 10],
    ['И0120', 'Углошлифовальная машина 125 мм', 'шт', 38000, 8],
    ['И0121', 'Углошлифовальная машина 230 мм', 'шт', 72000, 4],
    ['И0122', 'Дрель ударная 850 Вт', 'шт', 45000, 5],
    ['И0123', 'Полуавтомат сварочный 250 А', 'шт', 420000, 2],
    ['И0130', 'Рулетка 5 м', 'шт', 1800, 30],
    ['И0131', 'Рулетка 10 м', 'шт', 3900, 12],
    ['И0132', 'Уровень 1000 мм', 'шт', 6500, 10],
    ['И0133', 'Струбцина F 300 мм', 'шт', 4100, 25],
    ['И0134', 'Угольник магнитный сварочный', 'шт', 3200, 20],
    ['И0135', 'Штангенциркуль 150 мм', 'шт', 5900, 10],
    ['И0136', 'Молоток слесарный 800 г', 'шт', 2700, 15],
    ['И0137', 'Щётка по металлу ручная', 'шт', 450, 60],
    ['Т0089', 'Кран мостовой однобалочный подвесной электрический г/п 3,2 тн Н-10,2 м', 'шт', 9408560, 1],
  ];
  for (const [code, name, unit, price, hint] of tools) add(code, 'INSTRUMENTS', name, unit, price, hint);

  return out;
}

const MATERIALS: Mat[] = buildMaterials();
const BY_ID = new Map(MATERIALS.map((m) => [m.id, m]));
const BY_CODE = new Map(MATERIALS.map((m) => [m.code, m]));
const mat = (code: string): Mat => BY_CODE.get(code) as Mat;

/** models.Material как отдаёт Go: decimal → строка, PDate → ISO|null */
function materialJson(m: Mat) {
  return {
    id: m.id,
    materialCode: m.code,
    category: m.cat,
    name: m.name,
    unit: m.unit,
    unitWeightKg: dec(m.weight),
    purchasePrice: dec(m.price, 2),
    purchasePriceUpdatedAt: m.updatedAt,
    lastPurchasePrice: dec(m.last, 2),
    lastPurchaseDate: m.lastDate,
    priceListPrice: dec(m.list, 2),
    stockQty: dec(m.stock),
  };
}

// ---------------------------------------------------------------------------
// Изделия (реальные uuid/коды из базы) и заказы — для ГП, нормативов, резервов
// ---------------------------------------------------------------------------

interface Art { id: string; code: string; name: string; price: number }
const ARTICLES: Art[] = [
  { id: 'effbd29d-5218-4331-9cb4-f010aeb6442e', code: 'm-035', name: 'Мачта М25м на пространственной раме (секция 2м) в сборе', price: 3439000 },
  { id: '07deef03-bb17-4dc8-a0ee-77da9d121355', code: 'm-073', name: 'Мачта М25м на пространственной раме (секция 2м) рама в сборе ГЦ', price: 5068000 },
  { id: 'a3ff2eba-7eb7-4f1a-8953-a341ccfcefc2', code: 'm-034', name: 'Мачта М24м на пространственной раме (секция 2м) в сборе', price: 3372500 },
  { id: 'f40bf4a0-3cb3-4390-ac4a-943c6c70266f', code: 'b-016', name: 'Контейнер технологический - Шелтор 0123 (2х2)', price: 1140000 },
  { id: 'feb0845d-ecf8-4650-b7c7-edece20bb13f', code: 'b-015', name: 'Контейнер технологический - Шелтор 0123 (3х2)', price: 1453500 },
  { id: '3010111e-660a-4038-906b-08dbfb579934', code: 'b-017', name: 'Контейнер технологический - Шелтор 0123 (1х2)', price: 907250 },
  { id: '4aef0759-1e98-42dd-a39b-3e46ff2558f0', code: 'a-005', name: 'Ограждение 6000х4400мм (сетка рабица)', price: 700000 },
  { id: '6d97bfbf-ece3-41d8-b099-f4337a40609e', code: 'z-065', name: 'Стойка 19 дюймовая', price: 24000 },
  { id: 'b3c57999-557a-44ba-92b6-c3ec5c399135', code: 'a-001', name: 'Антивандальное ограждение Outdoor 1400х1300х2350', price: 357930 },
  { id: 'de3264a2-4d80-48ea-820e-35f845407fce', code: 'n-628', name: 'Антивандальное ограждение Outdoor 1300х1120х2530', price: 387500 },
  { id: '0858756e-795f-4de5-82f2-1d3f5cc1351b', code: 'm-046', name: 'Ствол С12-1235', price: 1662500 },
  { id: 'af6a6b18-816c-4dc8-931c-3c11488c4659', code: 'n-179', name: 'Квадропод 10м', price: 1581977 },
  { id: '47b30980-5b96-4690-a2ff-d2c936358d06', code: 'n-1165', name: 'Ограждение 10000х7000мм (сетка рабица)', price: 913570 },
  { id: '5f6b1597-17a7-4535-bbe0-ccfa3e4ddf76', code: 'm-056', name: 'Рама Р-Р40.40', price: 1235000 },
  { id: 'a6ab4224-f1e0-4702-8a9f-f07678c78d5f', code: 'n-039', name: 'Очаг заземления уголок 50 2000мм', price: 8050 },
  { id: '0d6ec3c4-94e0-4e05-bbb6-70b431bbe669', code: 'RM-001', name: 'Шкаф телекоммуникационный 42U', price: 150000 },
  { id: '71296f9d-317a-4b19-8ea6-72170d4966ad', code: 'b-007', name: 'Лестница с площадкой для Шелтора 0321', price: 75895 },
  { id: '461de817-acb8-4462-8dcc-d206b071887c', code: 'b-012', name: 'Полоса заземления 40х4мм, L-2м', price: 2000 },
  { id: 'e3527247-7d39-41a2-804c-d3cda2e5ed7a', code: 'b-013', name: 'Шина Т-образная', price: 1100 },
  { id: '6edd976a-dbd1-4124-95ee-be18c758d81f', code: 'n-019', name: 'Кабельный мост 2,0м (без трубостойки)', price: 44000 },
  { id: '5601f370-89bd-4851-8e1f-57a9d921567b', code: 'k-013', name: 'Молниеприемник приварной', price: 2165 },
  { id: '9c961d50-47d4-4a0e-9937-82dc76505df4', code: 'k-028', name: 'Швеллерная балка L500 mm под трубу Ф76-76', price: 5705 },
  { id: 'c98057ad-b5aa-4846-b072-d6f750835ad1', code: 'k-030', name: 'Трубостойка ф76 L3000 mm ГЦ', price: 23450 },
  { id: '63776037-dfa0-4d37-bce7-1698d2c584f8', code: 'k-031', name: 'Швеллерная балка L500 mm под трубу Ф76-76 ГЦ', price: 10900 },
  { id: '530f59bc-320e-456e-9211-f661c49d9e8a', code: 'k-001', name: 'U-болт под трубу ф76мм', price: 1060 },
  { id: '633e115f-8143-4ecc-89b1-ca2a86afefb2', code: 'k-019', name: 'Трубостойка ф76 L3000 mm', price: 18000 },
  { id: '3c468eb6-8930-4bdf-999b-c2a55eb5ecfe', code: 'k-018', name: 'Трубостойка ф102 L3000 mm', price: 19210 },
  { id: '000703c2-04f3-462d-9817-09efe7a8bfdb', code: 'k-017', name: 'Стягивающая рама для плит 500х500x100', price: 14660 },
  { id: 'a1217244-1726-45fa-92a1-7f3090f47965', code: 'k-011', name: 'Кабельный мост 1,5м', price: 47990 },
  { id: 'e873c1c4-6cad-4e0c-a745-5d3f5cfe26b5', code: 'k-010', name: 'Кабельный мост 1м', price: 41680 },
  { id: 'f7f6e604-ea86-4479-b204-834e0fd337f4', code: 'a-011', name: 'Стойка ограждения ф76 мм 3400 мм', price: 17000 },
  { id: '5b7d84d4-fd1e-4c3d-8d48-5372e72846f0', code: 'a-013', name: 'Секция ограждения 2500х1820мм (сетка рабица)', price: 68000 },
  { id: '9ddc0b61-ab2a-4706-a491-4bb00e8e8ced', code: 'a-014', name: 'Секция ограждения 2500х1520мм (сетка рабица)', price: 59000 },
  { id: '43dd78b7-0792-4b99-b9ef-635ccde33bbd', code: 'a-017', name: 'Секция ограждения 390х820мм (сетка рабица)', price: 12500 },
  { id: '50b7e624-b383-41e3-95bf-d97119da0097', code: 'a-018', name: 'Секция ограждения 2000х900мм (сетка рабица) калитка', price: 46000 },
  { id: '580668df-a6ae-428f-b8b9-63061c87036b', code: 'z-471', name: 'Ограждение 6000х6000мм (круг ф12) L50 под квадропод (PA6062)', price: 610000 },
  { id: 'b3d2ce41-e99c-4575-b343-16b2f9911f81', code: 'z-440', name: 'Ограждение 5000х5000мм (круг ф12) L63х5 под башню (РА5255)', price: 540000 },
  { id: 'df9a3cbf-116c-4d53-9b3f-b14ccff0ad78', code: 'n-297', name: 'Стяжной хомут ФБС блока', price: 8935 },
  { id: '6d81cf61-8e95-4ecf-a9f0-75d973268f4b', code: 'n-1237', name: 'Стремянка Стр1-1', price: 54900 },
  { id: '7e68ca48-fb3a-454a-a22a-2b9dd683fe94', code: 'n-1241', name: 'Площадка Н1-1', price: 105000 },
  { id: 'bf3b780b-1ba1-4a6f-a18e-bc6bd54bca31', code: 'n-1240', name: 'Ограждение Ог1-3', price: 35232 },
  { id: 'ec9b2c3e-a74c-4d8c-bbc7-2f7decb008cf', code: 'n-1238', name: 'Ограждение Ог1-1', price: 34000 },
  { id: 'b5f24da8-b172-42a5-81aa-36c0f00dd1e7', code: 'a-006', name: 'Ограждение 6000х6000мм (сетка рабица) L50', price: 650300 },
  { id: 'c2423d1a-55b0-4cf5-b27a-170e9d22af6b', code: 'a-004', name: 'Ограждение 6000х4000мм (сетка рабица)', price: 592500 },
  { id: '8a3ba8a1-8ef3-45a2-b782-468fb1e63c91', code: 'a-003', name: 'Ограждение 4000х4000мм (сетка рабица)', price: 530000 },
];
const ART_BY_CODE = new Map(ARTICLES.map((a) => [a.code, a]));
const art = (code: string): Art => ART_BY_CODE.get(code) as Art;

interface Ord { id: string; number: string; status: string; planned: string | null; customer: string }
const ORDERS: Ord[] = [
  { id: 'fe559184-40df-4632-a88a-9a72e9b7dfb6', number: 'Т7АА-002558', status: 'CONFIRMED', planned: dayIso(-21), customer: 'Дельта Казстрой, ТОО' },
  { id: '364fa797-4ee4-4c2b-b254-e5645fd5453b', number: 'Т7АА-002553', status: 'CONFIRMED', planned: dayIso(-17), customer: 'КазДаму Invest' },
  { id: 'e35f11cf-c1e6-4803-9b24-1ba7b3d54e12', number: 'Т7АА-002550', status: 'CONFIRMED', planned: dayIso(-15), customer: 'Физическое лицо Купи-Продай' },
  { id: 'c0ca51a3-5bce-4454-a187-6b281be8811d', number: 'Т7АА-002549', status: 'IN_PRODUCTION', planned: dayIso(-14), customer: 'Аврора Сервис, ТОО' },
  { id: '36eee01e-689f-4df7-b195-12dfcbfc2ac0', number: 'Т7АА-002542', status: 'IN_PRODUCTION', planned: dayIso(-7), customer: 'ТОО «GravIX Urban»' },
  { id: '9b918428-55ff-454a-ace8-2edcb7d8b5cc', number: 'Т7АА-002541', status: 'CONFIRMED', planned: dayIso(-6), customer: 'Central Build, ТОО' },
  { id: '85bbeae6-f157-47df-85a5-f7dca1ac98ce', number: 'Т7АА-002540', status: 'CONFIRMED', planned: dayIso(-6), customer: 'Физическое лицо Купи-Продай' },
  { id: '080aae8b-9721-405e-b41c-ef14d183bf86', number: 'Т7АА-002537', status: 'READY_TO_SHIP', planned: dayIso(-2), customer: 'AVRORA ELECTRIC, ТОО' },
  { id: '78704234-3e58-41b4-8783-1acc7f9d54b3', number: 'Т7АА-002536', status: 'CONFIRMED', planned: dayIso(-2), customer: 'IDA INTERTASCO JV, ТОО' },
  { id: '913d67ff-cf79-4e1b-a193-641ec67d0d69', number: 'Т7АА-002538', status: 'IN_PRODUCTION', planned: dayIso(-2), customer: 'НУР АСТАНА КУРЫЛЫС ТОО' },
  { id: 'e7020ed2-9f80-4359-b402-dcaa9d873614', number: 'Т7АА-002530', status: 'CONFIRMED', planned: dayIso(0), customer: 'BI URBAN CONSTRUCTION, ТОО' },
  { id: 'b171b296-bbae-4842-a825-3a317f01bc9a', number: 'Т7АА-002551', status: 'READY_TO_SHIP', planned: dayIso(0), customer: 'Аврора Сервис, ТОО' },
  { id: 'd0dd0229-62fe-470a-9e5d-bc2b16f54f86', number: 'Т7АА-002525', status: 'CONFIRMED', planned: dayIso(1), customer: 'ТОО «GravIX Urban»' },
  { id: 'cd92a829-9b7f-4fdf-9982-1b77615ac995', number: 'Т7АА-002529', status: 'IN_PRODUCTION', planned: dayIso(1), customer: 'IDA INTERTASCO JV, ТОО' },
  { id: 'bfe5317a-7aad-4b4f-a45f-1f6067d8a5ae', number: 'Т7АА-002527', status: 'CONFIRMED', planned: dayIso(1), customer: 'Физическое лицо Купи-Продай' },
  { id: '074ce3b0-d942-442c-81c6-ef564641d19c', number: 'Т7АА-002523', status: 'CONFIRMED', planned: dayIso(2), customer: 'IDA INTERTASCO JV, ТОО' },
  { id: '4248868b-7d62-461d-9b6c-1d81cc3c2106', number: 'Т7АА-002519', status: 'CONFIRMED', planned: dayIso(5), customer: 'КазДаму Invest' },
  { id: '46c8b3ff-c20b-4741-b28c-29b136ce74d2', number: 'Т7АА-002518', status: 'IN_PRODUCTION', planned: dayIso(5), customer: 'Greystone Construction, ТОО' },
  { id: '32e5a76c-c1c4-4ea9-9e53-ef15b0c78368', number: 'Т7АА-002517', status: 'CONFIRMED', planned: dayIso(6), customer: 'Qonay Stroy, ТОО' },
  { id: 'df852138-d881-46fb-823e-d51904644fb0', number: 'Т7АА-002555', status: 'CLOSED', planned: dayIso(8), customer: 'Казахтелеком, АО' },
  { id: '2596d486-b371-4e59-8145-25ed846b9b16', number: 'Т7АА-002548', status: 'CLOSED', planned: dayIso(8), customer: 'Аврора 75, ТОО' },
  { id: 'f2243360-99e4-468c-b127-683690c29f94', number: 'Т7АА-002444', status: 'CLOSED', planned: dayIso(30), customer: 'Казахтелеком, АО' },
  { id: '9899fd6d-1f51-49c8-88ba-21e8ff254953', number: 'Т7АА-002421', status: 'CLOSED', planned: dayIso(41), customer: 'Аврора 75, ТОО' },
  { id: 'b16417db-c45a-42de-9e54-4150618b0806', number: '00АА-044753', status: 'CLOSED', planned: dayIso(60), customer: 'Пепси-Кола Казахстан' },
];
const ORD_BY_NUMBER = new Map(ORDERS.map((o) => [o.number, o]));
const ord = (n: string): Ord => ORD_BY_NUMBER.get(n) as Ord;
const orderRef = (o: Ord) => ({ id: o.id, orderNumber: o.number, plannedShipmentDate: o.planned });

// ---------------------------------------------------------------------------
// Приходы (журнал) — 3 ручных + ~400 из 1С, сгруппированных по документам
// ---------------------------------------------------------------------------

interface ReceiptRow {
  id: string;
  materialId: string;
  date: string;
  qty: number;
  unitPrice: number;
  documentNumber: string | null;
  supplierName: string | null;
  origin: 'MOVEMENT' | 'ONEC';
  paymentDocumentId: string | null;
}

const SUPPLIERS: Record<string, string[]> = {
  hardware: ['Bugel Алматы, ТОО', 'ТОО "КРЕПЁЖНАЯ ЗАСТАВА"', 'Тукор ТОО'],
  paint: ['МАЙ ТОО', 'ТОО "ASIAN PAINTS"', 'ТОО "NATIONAL COATING"'],
  metal: ['Avrora Global trade, ТОО', 'Модуль сталь, ТОО', 'Торговый дом "Алаш", ТОО', 'Фирма "А -Профиль" ТОО'],
  welding: ['Welding Company TOO', 'ЛАМЭД ТОО'],
  tools: ['КАЛИБР KZ, ТОО', '220 VOLT, ТОО', 'ТОО "PROEXPERT.KZ"'],
  components: ['AKS KAZAKHSTAN (АКС Казахстан) ТОО', 'ТОО "ТЕХНОСИСТЕМА МР"', 'ВИП СИСТЕМЫ, ТОО', 'ТОО "KAZ PROVIDER"'],
};

function buildReceipts(): ReceiptRow[] {
  const rnd = mulberry32(783);
  const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)];
  const pools: Record<string, Mat[]> = {
    hardware: MATERIALS.filter((m) => m.cat === 'HARDWARE'),
    paint: MATERIALS.filter((m) => m.code.startsWith('Л')),
    metal: MATERIALS.filter((m) => m.cat === 'METAL'),
    welding: MATERIALS.filter((m) => m.cat === 'CONSUMABLES' && /Электрод|Проволок|Круг |Пропан|Кислород|Углекислота/.test(m.name)),
    tools: MATERIALS.filter((m) => m.cat === 'INSTRUMENTS' && m.price < 1_000_000),
    components: MATERIALS.filter((m) => m.cat === 'COMPONENTS'),
  };
  const kinds = ['hardware', 'paint', 'metal', 'welding', 'tools', 'components', 'hardware', 'metal', 'paint'];
  const out: ReceiptRow[] = [];

  // Ручные приходы (movement_type = 'приход') — их в базе единицы
  const manual: Array<[string, number, number, string, string, number]> = [
    ['С0421', 240, 1610, 'ТН-000412', 'Модуль сталь, ТОО', 2],
    ['Р0030', 400, 175, 'СФ-2209', 'Welding Company TOO', 4],
    ['К0614', 120, 760, 'ТН-000398', 'Тукор ТОО', 9],
  ];
  manual.forEach(([code, qty, price, doc, sup, days], i) => {
    out.push({ id: uid('mv-receipt', i), materialId: mat(code).id, date: dayIso(days), qty, unitPrice: price, documentNumber: doc, supplierName: sup, origin: 'MOVEMENT', paymentDocumentId: null });
  });

  // Партии из 1С: «Заказ поставщику» Т7АА-000xxx, 3–9 строк, один поставщик
  let docNo = 883;
  let daysAgo = 14;
  for (let j = 0; j < 72; j++) {
    const kind = kinds[j % kinds.length];
    const supplier = pick(SUPPLIERS[kind]);
    const pool = pools[kind];
    const number = `Т7АА-${String(docNo).padStart(6, '0')}`;
    const date = dayIso(daysAgo);
    const payment = rnd() < 0.85 ? uid('payment', j) : null;
    const lines = 3 + Math.floor(rnd() * 7);
    const used = new Set<string>();
    for (let k = 0; k < lines; k++) {
      const m = pick(pool);
      if (used.has(m.code)) continue;
      used.add(m.code);
      const base = m.unit === 'м' || m.unit === 'кг' || m.unit === 'л' ? 50 + Math.floor(rnd() * 950) : m.unit === 'м2' ? 20 + Math.floor(rnd() * 180) : 5 + Math.floor(rnd() * 120);
      const qty = m.cat === 'INSTRUMENTS' ? 1 + Math.floor(rnd() * 4) : base;
      out.push({
        id: uid('batch', `${j}-${k}`),
        materialId: m.id,
        date,
        qty,
        unitPrice: Math.round(m.price * (0.9 + rnd() * 0.22) * 100) / 100,
        documentNumber: number,
        supplierName: supplier,
        origin: 'ONEC',
        paymentDocumentId: payment,
      });
    }
    docNo -= 3 + Math.floor(rnd() * 15);
    daysAgo += 2 + Math.floor(rnd() * 8);
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

const RECEIPTS: ReceiptRow[] = buildReceipts();

function receiptJson(r: ReceiptRow) {
  const m = BY_ID.get(r.materialId) as Mat;
  return {
    id: r.id,
    movementDate: r.date,
    qty: dec(r.qty),
    unitPrice: dec(r.unitPrice, 2),
    documentNumber: r.documentNumber,
    supplierName: r.supplierName,
    material: { materialCode: m.code, name: m.name, unit: m.unit, category: m.cat },
    origin: r.origin,
    paymentDocumentId: r.paymentDocumentId,
  };
}

// ---------------------------------------------------------------------------
// Карантин цен: стартовые остатки, где цена оказалась в ₸/т вместо ₸/м
// ---------------------------------------------------------------------------

/** код материала → цена «стартового остатка» из инвентаризации 24.08.2026 */
const ANOMALY_PRICES: Array<[string, number]> = [
  ['Т0150', 14], ['С0113', 330000], ['С0103', 421000], ['С0412', 454000], ['С0116', 358000], ['С0104', 350000],
  ['С0105', 350000], ['С0418', 447000], ['С0506', 386000], ['С0106', 325000], ['С0421', 422000], ['С0507', 377000],
  ['С0108', 340000], ['С0423', 431000], ['С0107', 335000], ['С0508', 330000], ['С0433', 400000], ['С0509', 340000],
  ['С0109', 421787.23], ['С0424', 407000], ['С0406', 442000], ['С0604', 406000], ['С0605', 405000], ['С0611', 365000],
  ['С0427', 415000], ['С0101', 338000], ['С0110', 345000], ['С0120', 352000], ['С0121', 349000], ['С0301', 398000],
  ['С0317', 402000], ['С0505', 391000], ['С0511', 383000], ['С0510', 336000], ['С0512', 372000], ['С0601', 388000],
  ['С0602', 381000],
];
const INVENTORY_DATE = dayIso(10); // 2026-08-24

interface AnomalyRow { batchId: string; m: Mat; unitPrice: number; factor: number }
const ANOMALIES: AnomalyRow[] = ANOMALY_PRICES.map(([code, price]) => {
  const m = mat(code);
  const factor = round2(Math.max(price / m.price, m.price / price));
  return { batchId: uid('inv-batch', m.code), m, unitPrice: price, factor };
}).sort((a, b) => b.factor - a.factor);
const ANOMALY_BY_CODE = new Map(ANOMALIES.map((a) => [a.m.code, a]));
const ANOMALY_BY_BATCH = new Map(ANOMALIES.map((a) => [a.batchId, a]));
/** Партии, по которым снабжение уже подтвердило цену в этой сессии */
const clearedAnomalies = new Set<string>();

function anomalyJson(a: AnomalyRow) {
  return {
    batchId: a.batchId,
    material: { id: a.m.id, materialCode: a.m.code, name: a.m.name, unit: a.m.unit },
    receiptDate: INVENTORY_DATE,
    unitPrice: a.unitPrice,
    qtyRemaining: a.m.stock,
    anomalyFactor: a.factor,
    documentNumber: null,
    supplierName: null,
    hint: 'Похоже на разные единицы измерения в одной номенклатуре',
  };
}

/** models.MaterialBatch — партия целиком (ответ clear-anomaly) */
function batchModelJson(a: AnomalyRow, cleared: boolean) {
  return {
    id: a.batchId,
    materialId: a.m.id,
    warehouseId: null,
    receiptDate: INVENTORY_DATE,
    unitPrice: dec(a.unitPrice, 2),
    qtyReceived: dec(a.m.stock),
    qtyRemaining: dec(a.m.stock),
    supplierName: null,
    documentNumber: null,
    sourceMovementId: null,
    paymentDocumentId: null,
    origin: 'INVENTORY',
    externalId: null,
    batchType: 'OWN',
    ownerOrderId: null,
    priceAnomaly: !cleared,
    anomalyFactor: dec(a.factor, 2),
    anomalyClearedAt: cleared ? NOW.toISOString() : null,
    anomalyClearedById: cleared ? DESIGN_USER_ID : null,
    createdAt: INVENTORY_DATE,
  };
}

/** Лента движений материала: ручные движения + партии 1С + стартовый остаток */
function movementsOf(m: Mat, take: number) {
  const rows: Array<{ date: string; out: Record<string, unknown> }> = [];
  for (const r of RECEIPTS) {
    if (r.materialId !== m.id) continue;
    rows.push({
      date: r.date,
      out: {
        id: r.id, movementDate: r.date, qty: dec(r.qty), unitPrice: dec(r.unitPrice, 2),
        documentNumber: r.documentNumber, supplierName: r.supplierName, comment: null,
        origin: r.origin, priceAnomaly: false,
      },
    });
  }
  if (m.stock > 0) {
    const an = ANOMALY_BY_CODE.get(m.code);
    rows.push({
      date: INVENTORY_DATE,
      out: {
        id: uid('inv-batch', m.code), movementDate: INVENTORY_DATE, qty: dec(m.stock),
        unitPrice: dec(an ? an.unitPrice : m.price, 2), documentNumber: null, supplierName: null,
        comment: 'Стартовый остаток (инвентаризация)', origin: 'INVENTORY',
        priceAnomaly: !!an && !clearedAnomalies.has(an.batchId),
      },
    });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows.slice(0, take).map((r) => r.out);
}

// ---------------------------------------------------------------------------
// Склады (справочник 1С) — ЦМК первыми, остальные по алфавиту
// ---------------------------------------------------------------------------

const WAREHOUSES: Array<{ id: string; name: string; division: string | null }> = [
  ['74П_Склад Основной', '74п_Производство'], ['74П_ЦМК2_Склад Основной', '74п_Телеком'], ['74п_Кладовая_ЦМК', '74п_Производство'],
  ['74п_Склад ГП', '74п_Телеком'], ['74п_Склад Сырья', '74п_Телеком'], ['74п_Склад малярного цеха', '74п_Малярный участок Цеха металлоконструкций'],
  ['74п_Склад цеха заготовки', '74п_Заготовительный участок цеха металлоконструкций'], ['74п_Склад цеха сборки', '74п_Участок сборки-сварки цеха металлоконструкций'],
  ['74п_ЦМК2_Кладовая_ЦМК', '74п_Производство'], ['74п_ЦМК2_Склад ГП', '74п_Телеком'], ['74п_ЦМК2_Склад Сырья', '74п_Телеком'],
  ['Адем_Телеком', '74п_Телеком'], ['7П Склад Аврора Кселл', '7п_Телеком'], ['7П Склад Аврора ЭТЗ', '7п_Телеком'], ['7п_Основной склад', '7п_Телеком'],
  ['Контейнер 71П Ходжанова', '71п_Телеком'], ['55п Склад ГП', '55п_Производство Быт Хим и Мед'], ['55п Склад сырья', '55п_Производство Быт Хим и Мед'],
  ['55п Кладовая участка пр-ва химпродукции', 'Участок изготовления химической продукции 1'], ['55п Склад участка упаковки', 'Участок упаковывания'],
  ['55п Склад участка трафаретной печати', 'Участок трафаретной печати цеха изготовления упаковки'], ['55п Склад гп 17п', '17п_Бытовая Химия'],
  ['55п Склад гп 18п', null], ['55п Склад гп 5п', null], ['5П склад Буферный', '5п_Медицина'], ['99п Склад ГП', '99п_Энергетика ЭТЗ'],
  ['99п Склад сырья', '99п_Энергетика ЭТЗ'], ['99п Склад цеха сборки', '99п_Цех сборки'], ['Алматы Сиерра 5П', '5п_Медицина'],
  ['Астана Сиерра 5П', '5п_Медицина'], ['Актау Сиерра 5П', '5п_Медицина'], ['Актобе Сиерра 5П', '5п_Медицина'], ['Атырау Сиерра 5П', '5п_Медицина'],
  ['Караганда Сиерра 5П', '5п_Медицина'], ['Костанай Сиерра 5П', '5п_Медицина'], ['Кызылорда Сиерра 5П', '5п_Медицина'],
  ['Алматы БРЕНДС', '17п_Бытовая Химия'], ['Алматы Окта 9п', '9п_Энергетика'], ['Основной склад', '10п_Охрана'], ['Брак', '55п_Производство Быт Хим и Мед'],
].map(([name, division], i) => ({ id: uid('warehouse', i), name: name as string, division: division as string | null }));

// ---------------------------------------------------------------------------
// Склад ГП: остатки (по движениям) и журнал движений (2 083 строки)
// ---------------------------------------------------------------------------

interface FgBalance { code: string; stock: number; lastDays: number }
const FG_BALANCE: FgBalance[] = [
  { code: 'm-035', stock: 10, lastDays: 42 }, { code: 'b-016', stock: 14, lastDays: 8 }, { code: 'b-015', stock: 9, lastDays: 63 },
  { code: 'a-005', stock: 16, lastDays: 100 }, { code: 'z-065', stock: 300, lastDays: 353 }, { code: 'm-034', stock: -2, lastDays: 224 },
  { code: 'a-001', stock: 18, lastDays: 62 }, { code: 'n-628', stock: 15, lastDays: 8 }, { code: 'b-017', stock: 6, lastDays: 30 },
  { code: 'm-046', stock: 2, lastDays: 279 }, { code: 'n-179', stock: 2, lastDays: 78 }, { code: 'n-1165', stock: 3, lastDays: 296 },
  { code: 'm-056', stock: 2, lastDays: 279 }, { code: 'n-039', stock: 220, lastDays: 8 }, { code: 'RM-001', stock: 10, lastDays: 2 },
  { code: 'b-007', stock: 19, lastDays: 8 }, { code: 'a-006', stock: 2, lastDays: 295 }, { code: 'a-004', stock: 2, lastDays: 266 },
  { code: 'b-012', stock: 448, lastDays: 8 }, { code: 'n-019', stock: 13, lastDays: 8 }, { code: 'a-003', stock: 1, lastDays: 262 },
  { code: 'n-1241', stock: 5, lastDays: 321 }, { code: 'n-297', stock: 36, lastDays: 183 }, { code: 'n-1237', stock: 5, lastDays: 321 },
  { code: 'k-018', stock: 13, lastDays: 48 }, { code: 'k-017', stock: 17, lastDays: 21 }, { code: 'k-028', stock: 43, lastDays: 42 },
  { code: 'k-011', stock: 5, lastDays: 30 }, { code: 'n-1240', stock: 6, lastDays: 321 }, { code: 'n-1238', stock: 6, lastDays: 321 },
  { code: 'k-013', stock: 36, lastDays: 8 }, { code: 'a-011', stock: 12, lastDays: 3 }, { code: 'k-030', stock: 8, lastDays: 8 },
  { code: 'k-001', stock: 175, lastDays: 14 }, { code: 'k-019', stock: 22, lastDays: 35 }, { code: 'k-010', stock: 4, lastDays: 51 },
  { code: 'a-013', stock: 6, lastDays: 8 }, { code: 'a-014', stock: 4, lastDays: 8 }, { code: 'z-471', stock: 1, lastDays: 8 },
  { code: 'z-440', stock: 1, lastDays: 8 }, { code: 'b-013', stock: 66, lastDays: 8 }, { code: 'k-031', stock: 12, lastDays: 8 },
  { code: 'a-017', stock: 3, lastDays: 3 }, { code: 'a-018', stock: 2, lastDays: 3 },
];

function fgBalanceRows() {
  return FG_BALANCE.map((b) => {
    const a = art(b.code);
    const value = round2(b.stock * a.price);
    return {
      articleId: a.id, articleCode: a.code, name: a.name, stockQty: b.stock,
      approvedPrice: a.price, valueEstimate: value, lastMovementAt: dayIso(b.lastDays),
      _abs: Math.abs(value),
    };
  }).sort((x, y) => y._abs - x._abs).map(({ _abs, ...row }) => row);
}

interface FgMove { id: string; art: Art; order: Ord | null; type: string; qty: number; unitPrice: number; date: string; project: string | null }

function buildFgMovements(): FgMove[] {
  const rnd = mulberry32(2083);
  const out: FgMove[] = [];
  let t = NOW.getTime() - 2 * DAY;
  const small = ARTICLES.filter((a) => a.price < 60000);
  const big = ARTICLES.filter((a) => a.price >= 60000);
  const shipOrders = ORDERS.filter((o) => o.status === 'CLOSED' || o.status === 'READY_TO_SHIP');
  for (let i = 0; i < 2083; i++) {
    const d = new Date(t);
    d.setUTCHours(0, 0, 0, 0);
    const a = rnd() < 0.62 ? small[Math.floor(rnd() * small.length)] : big[Math.floor(rnd() * big.length)];
    const r = rnd();
    const type = r < 0.46 ? 'FROM_PRODUCTION' : r < 0.995 ? 'SHIPMENT' : 'RECEIPT';
    const qty = a.price > 500000 ? 1 + Math.floor(rnd() * 2) : a.price > 20000 ? 1 + Math.floor(rnd() * 8) : 2 + Math.floor(rnd() * 58);
    const actNo = 140 + Math.floor(rnd() * 70);
    let order: Ord | null = null;
    let project: string | null = null;
    let unitPrice = 0;
    if (type === 'SHIPMENT') {
      order = shipOrders[Math.floor(rnd() * shipOrders.length)];
      project = `1С-акт:Т7АА-${String(actNo).padStart(6, '0')}-${order.number}:${1 + Math.floor(rnd() * 8)}`;
      unitPrice = a.price;
    } else if (type === 'FROM_PRODUCTION') {
      if (rnd() < 0.6) project = `1С-выпуск:Т7АА-${String(actNo).padStart(6, '0')}`;
      else order = ORDERS[Math.floor(rnd() * ORDERS.length)];
    }
    out.push({ id: uid('fg-move', i), art: a, order, type, qty, unitPrice, date: d.toISOString(), project });
    t -= rnd() * 0.45 * DAY;
  }
  return out;
}
const FG_MOVES: FgMove[] = buildFgMovements();

function fgMoveJson(m: FgMove) {
  return {
    id: m.id,
    itemId: m.art.id,
    orderId: m.order ? m.order.id : null,
    movementType: m.type,
    qty: dec(m.qty),
    unitPrice: dec(m.unitPrice, 2),
    movementDate: m.date,
    project: m.project,
    sourceDocumentId: null,
    article: { articleCode: m.art.code, name: m.art.name },
    order: m.order ? { orderNumber: m.order.number } : null,
  };
}

// ---------------------------------------------------------------------------
// Обрезки — деловой отход: одна длина = одна строка
// ---------------------------------------------------------------------------

interface Offcut { id: string; m: Mat; lengthMm: number; widthMm: number | null; qty: number; note: string | null; createdAt: string; updatedAt: string }

const OFFCUTS: Offcut[] = ([
  ['С0104', 1850, null, 6, 'после раскроя под Т7АА-002444', 12], ['С0104', 1200, null, 14, null, 12], ['С0104', 850, null, 22, null, 9], ['С0104', 600, null, 30, 'короткие, под молниеприёмники', 5],
  ['С0106', 1400, null, 4, null, 20], ['С0106', 900, null, 11, null, 20],
  ['С0105', 2200, null, 3, null, 33], ['С0105', 750, null, 9, 'ржавые, под грунт', 33],
  ['С0509', 2400, null, 3, null, 15], ['С0509', 1800, null, 5, null, 15], ['С0509', 1150, null, 8, 'от мачты М25м', 7], ['С0509', 700, null, 12, null, 7],
  ['С0507', 1300, null, 6, null, 26], ['С0507', 900, null, 10, null, 26],
  ['С0510', 1600, null, 2, null, 40],
  ['С0604', 2100, null, 2, 'заготовка под раму Р-Р40.40', 18], ['С0604', 1400, null, 3, null, 18],
  ['С0605', 1850, null, 2, null, 44],
  ['С0421', 2800, null, 5, null, 3], ['С0421', 1500, null, 9, null, 3], ['С0421', 950, null, 15, 'секции ограждений', 1],
  ['С0427', 1750, null, 4, null, 11],
  ['С0432', 1250, null, 3, null, 29],
  ['С0406', 2400, null, 2, 'от секции 2м мачты', 6], ['С0406', 1100, null, 4, null, 6],
  ['С0318', 2600, null, 3, null, 22], ['С0318', 1300, null, 7, null, 22],
  ['С0308', 1900, null, 2, null, 37],
  ['С0202', 1200, 600, 2, 'пластины под фланцы', 16],
  ['С0210', 800, 450, 5, null, 16],
  ['С0213', 700, 500, 3, 'ПВЛ, под площадки', 24],
  ['С0810', 1800, null, 8, null, 2],
  ['С0713', 1600, null, 1, null, 55],
] as Array<[string, number, number | null, number, string | null, number]>).map(([code, len, w, qty, note, days], i) => ({
  id: uid('offcut', i), m: mat(code), lengthMm: len, widthMm: w, qty, note,
  createdAt: atHours(-days * 24 - 3.4), updatedAt: atHours(-Math.min(days, 2) * 24 - 1.2),
}));

function offcutJson(o: Offcut) {
  return {
    id: o.id,
    materialId: o.m.id,
    lengthMm: dec(o.lengthMm, 1),
    widthMm: o.widthMm == null ? null : dec(o.widthMm, 1),
    qty: dec(o.qty),
    note: o.note,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    material: { id: o.m.id, materialCode: o.m.code, name: o.m.name, unit: o.m.unit, category: o.m.cat },
  };
}
const sortOffcuts = (list: Offcut[]) => [...list].sort((a, b) => ruCompare(a.m.name, b.m.name) || b.lengthMm - a.lengthMm);

// ---------------------------------------------------------------------------
// Резервы партий: перехваты (решение директора) и истекающие резервы
// ---------------------------------------------------------------------------

interface Override {
  id: string; status: 'PENDING' | 'APPROVED' | 'REJECTED'; m: Mat; qty: number; reason: string;
  createdHoursAgo: number; requester: Ord; holder: Ord; unitPrice: number; reservedQty: number;
  reservationId: string; batchId: string; batchDaysAgo: number; supplier: string | null; batchRemaining: number;
}
const OVERRIDES: Override[] = ([
  ['PENDING', 'С0604', 120, 'Казахтелеком просит отгрузить раньше — площадка KZ-ALM_Dudar простаивает без мачты', 5, 'Т7АА-002541', 'Т7АА-002518', 4322.5, 180, 31, 'Avrora Global trade, ТОО', 260],
  ['PENDING', 'С0509', 260, 'Партия дешевле на 18 %, у держателя отгрузка через три недели', 19, 'Т7АА-002537', 'Т7АА-002553', 1220.51, 400, 26, 'Модуль сталь, ТОО', 640],
  ['PENDING', 'С0406', 60, 'Секции 2м под мачту М25м — закуп по новой цене выйдет дороже на 380 тыс. ₸', 41, 'Т7АА-002538', 'Т7АА-002558', 5058.75, 96, 48, 'Торговый дом "Алаш", ТОО', 110],
  ['PENDING', 'С0202', 12, 'Пластины под фланцы: лист 10 мм на складе один, держатель ещё не в производстве', 66, 'Т7АА-002529', 'Т7АА-002550', 22029.39, 24, 60, 'Фирма "А -Профиль" ТОО', 36],
  ['PENDING', 'С0104', 340, 'Ограждение под квадропод: круг ф12 нужен на этой неделе, резерв держателя истекает', 98, 'Т7АА-002542', 'Т7АА-002519', 307.3, 500, 12, 'Avrora Global trade, ТОО', 900],
  ['PENDING', 'Л0006', 46, 'Anticor RAL 5005 остался в одной партии; держатель красит в 9005', 130, 'Т7АА-002549', 'Т7АА-002540', 3017, 60, 20, 'МАЙ ТОО', 75],
  ['APPROVED', 'С0605', 80, 'Срочная отгрузка Аврора 75 — держатель согласен', 190, 'Т7АА-002551', 'Т7АА-002527', 4710.11, 120, 33, 'Модуль сталь, ТОО', 300],
  ['APPROVED', 'М0119', 55, 'Болты М20х80 под фланцы мачты', 240, 'Т7АА-002530', 'Т7АА-002523', 680, 90, 41, 'Bugel Алматы, ТОО', 140],
  ['REJECTED', 'С0318', 140, 'Держатель уже в производстве, труба раскроена', 300, 'Т7АА-002525', 'Т7АА-002536', 2548, 200, 55, 'Avrora Global trade, ТОО', 160],
] as Array<[Override['status'], string, number, string, number, string, string, number, number, number, string | null, number]>)
  .map(([status, code, qty, reason, hours, req, hold, unitPrice, reservedQty, batchDaysAgo, supplier, batchRemaining], i) => ({
    id: uid('override', i), status, m: mat(code), qty, reason, createdHoursAgo: hours,
    requester: ord(req), holder: ord(hold), unitPrice, reservedQty,
    reservationId: uid('reservation', i), batchId: uid('res-batch', i), batchDaysAgo, supplier, batchRemaining,
  }));
/** Решения, принятые в этой сессии дизайна (id → статус) */
const decided = new Map<string, 'APPROVED' | 'REJECTED'>();

function overrideJson(o: Override) {
  return {
    id: o.id,
    status: decided.get(o.id) ?? o.status,
    qtyRequested: o.qty,
    reason: o.reason,
    createdAt: atHours(-o.createdHoursAgo),
    requestedByOrderId: o.requester.id,
    requestedByOrder: orderRef(o.requester),
    holderOrderId: o.holder.id,
    holderOrder: orderRef(o.holder),
    material: { materialCode: o.m.code, name: o.m.name, unit: o.m.unit },
    unitPrice: o.unitPrice,
    reservedQty: o.reservedQty,
    ageHours: Math.floor(o.createdHoursAgo),
  };
}

interface Expiring { id: string; order: Ord; m: Mat; qty: number; unitPrice: number; expiresHours: number }
const EXPIRING: Expiring[] = ([
  ['Т7АА-002530', 'С0508', 180, 947.92, 9], ['Т7АА-002525', 'С0421', 420, 1610, 22], ['Т7АА-002523', 'М0104', 40, 660, 31],
  ['Т7АА-002519', 'С0104', 500, 307.3, 47], ['Т7АА-002536', 'С0605', 96, 4710.11, 58], ['Т7АА-002527', 'Л0003', 300, 690, 69],
  ['Т7АА-002540', 'С0210', 18, 12911.56, 90], ['Т7АА-002517', 'С0513', 210, 2532.82, 118], ['Т7АА-002558', 'К1203', 48, 3319.7, 150],
  ['Т7АА-002553', 'С0406', 140, 5058.75, 190], ['Т7АА-002550', 'С0318', 260, 2548, 228],
] as Array<[string, string, number, number, number]>).map(([o, code, qty, unitPrice, hours], i) => ({
  id: uid('expiring', i), order: ord(o), m: mat(code), qty, unitPrice, expiresHours: hours,
}));

// ---------------------------------------------------------------------------
// Минимальные остатки ГП
// ---------------------------------------------------------------------------

interface MinStock { id: string; art: Art; period: number; target: number; actual: number }
const MIN_STOCK: MinStock[] = ([
  ['m-035', 12, 10], ['b-016', 20, 14], ['b-015', 10, 9], ['b-017', 6, 6], ['a-005', 10, 16], ['n-039', 300, 220],
  ['b-012', 500, 448], ['b-007', 20, 19], ['n-019', 20, 13], ['k-030', 40, 8], ['k-013', 100, 36], ['a-011', 60, 12],
  ['k-028', 60, 43], ['k-001', 300, 175], ['n-628', 12, 15], ['a-001', 24, 18],
] as Array<[string, number, number]>).map(([code, target, actual], i) => ({ id: uid('min-stock', i), art: art(code), period: 3, target, actual }));
/** Правки нормативов в этой сессии */
const minStockEdits = new Map<string, { target: number; period: number }>();

function minStockJson(l: MinStock) {
  const edit = minStockEdits.get(l.art.id);
  const target = edit ? edit.target : l.target;
  const period = edit ? edit.period : l.period;
  const actual = round3(l.actual);
  const deficit = Math.max(0, round3(target - actual));
  const readiness = target > 0 ? Math.min(100, Math.floor(actual / target * 1000 + 0.5) / 10) : 100;
  const value = round2(deficit * l.art.price);
  return {
    id: l.id,
    articleId: l.art.id,
    article: { id: l.art.id, articleCode: l.art.code, name: l.art.name, approvedPrice: dec(l.art.price, 2) },
    periodMonths: period,
    targetQty: target,
    actualQty: actual,
    deficitQty: deficit,
    readinessPct: readiness,
    deficitValue: value,
  };
}

// ---------------------------------------------------------------------------
// Маршруты
// ---------------------------------------------------------------------------

function filterMaterials(params: URLSearchParams): Mat[] {
  let list = MATERIALS;
  const category = params.get('category');
  const categories = params.get('categories');
  if (category) list = list.filter((m) => m.cat === category);
  else if (categories) {
    const set = new Set(categories.split(',').map((s) => s.trim()).filter(Boolean));
    if (set.size) list = list.filter((m) => set.has(m.cat));
  }
  const search = (params.get('search') ?? '').trim().toLowerCase();
  if (search) list = list.filter((m) => lc(m.code).includes(search) || lc(m.name).includes(search));
  return [...list].sort((a, b) => ruCompare(a.name, b.name));
}

export const routes: FixtureRoute[] = [
  // ---------- /materials (catalog/materials.go) ----------
  {
    method: 'GET', match: /^\/materials$/,
    handler: ({ params }) => {
      const list = filterMaterials(params);
      const { data, page, pageSize } = pageOf(list, params, 50);
      return { data: data.map(materialJson), meta: { page, pageSize, total: list.length } };
    },
  },
  {
    method: 'GET', match: /^\/materials\/([^/]+)$/,
    handler: ({ path }) => {
      const id = path.split('/')[2];
      const m = BY_ID.get(id) ?? MATERIALS[0];
      const rnd = mulberry32(id.length * 7919);
      const bomItems = ARTICLES.filter(() => rnd() < 0.08).slice(0, 4).map((a, i) => ({
        id: uid('bom', `${m.code}-${i}`),
        articleId: a.id,
        materialId: m.id,
        qtyPerUnit: dec(1 + rnd() * 60, 2),
        operationType: ['CUTTING', 'WELDING_ASSEMBLY', 'CLADDING', 'PAINTING'][Math.floor(rnd() * 4)],
        laborHours: dec(rnd() * 3, 2),
        lineCost: dec(m.price * (1 + rnd() * 60), 2),
      }));
      return { ...materialJson(m), bomItems };
    },
  },
  {
    method: 'POST', match: /^\/materials$/,
    handler: (ctx) => {
      const b = body(ctx);
      const m: Mat = {
        id: uid('material-new', String(b.materialCode ?? 'new')), code: String(b.materialCode ?? 'НОВ-0001'), cat: (b.category as Cat) ?? 'METAL',
        name: String(b.name ?? 'Новый материал'), unit: String(b.unit ?? 'шт'), price: Number(b.purchasePrice ?? 0), list: 0, stock: 0,
        last: 0, lastDate: null, updatedAt: null, weight: Number(b.unitWeightKg ?? 0),
      };
      return materialJson(m);
    },
  },
  {
    method: 'PATCH', match: /^\/materials\/([^/]+)$/,
    handler: (ctx) => {
      const id = ctx.path.split('/')[2];
      const m = BY_ID.get(id) ?? MATERIALS[0];
      const b = body(ctx);
      if (typeof b.name === 'string') m.name = b.name;
      if (typeof b.unit === 'string') m.unit = b.unit;
      if (typeof b.category === 'string') m.cat = b.category as Cat;
      if (typeof b.purchasePrice === 'number') { m.price = b.purchasePrice; m.updatedAt = NOW.toISOString(); }
      if (typeof b.unitWeightKg === 'number') m.weight = b.unitWeightKg;
      return materialJson(m);
    },
  },

  // ---------- Склады ----------
  {
    method: 'GET', match: /^\/warehouse\/warehouses$/,
    handler: ({ params }) => {
      const search = (params.get('search') ?? '').trim().toLowerCase();
      const isCmk = (n: string) => n.includes('74п') || n.includes('ЦМК');
      return WAREHOUSES
        .filter((w) => !search || lc(w.name).includes(search))
        .sort((a, b) => Number(isCmk(b.name)) - Number(isCmk(a.name)) || ruCompare(a.name, b.name));
    },
  },

  // ---------- Остатки и движения материалов ----------
  {
    method: 'GET', match: /^\/warehouse\/materials\/balance$/,
    handler: ({ params }) => {
      const list = filterMaterials(params);
      const { data } = pageOf(list, params, 100);
      return data.map((m) => ({
        materialId: m.id, materialCode: m.code, name: m.name, category: m.cat, unit: m.unit,
        stockQty: m.stock, purchasePrice: m.price, totalValue: m.stock * m.price,
      }));
    },
  },
  {
    method: 'GET', match: /^\/warehouse\/materials\/([^/]+)\/movements$/,
    handler: ({ path, params }) => {
      const id = path.split('/')[3];
      const m = BY_ID.get(id);
      if (!m) return [];
      let take = Number(params.get('limit'));
      if (!(take >= 1)) take = 50;
      return movementsOf(m, take);
    },
  },
  {
    method: 'POST', match: /^\/warehouse\/materials\/receipt$/,
    handler: (ctx) => {
      const b = body(ctx);
      const m = BY_ID.get(String(b.materialId)) ?? mat('С0604');
      const qty = Math.abs(Number(b.qty ?? 0));
      const unitPrice = Number(b.unitPrice ?? m.price);
      const before = m.price;
      const after = m.stock + qty > 0 ? round2((m.stock * m.price + qty * unitPrice) / (m.stock + qty)) : unitPrice;
      const factor = before > 0 ? Math.max(unitPrice / before, before / unitPrice) : 1;
      const anomaly = factor >= 5;
      m.stock = round3(m.stock + qty);
      if (!anomaly) { m.price = after; m.last = unitPrice; m.lastDate = NOW.toISOString(); m.updatedAt = NOW.toISOString(); }
      const movementDate = typeof b.movementDate === 'string' && b.movementDate ? new Date(b.movementDate).toISOString() : NOW.toISOString();
      const movementId = uid('receipt-new', `${m.code}-${m.stock}`);
      const batchId = uid('batch-new', movementId);
      RECEIPTS.unshift({
        id: movementId, materialId: m.id, date: movementDate, qty, unitPrice,
        documentNumber: (b.documentNumber as string | undefined)?.trim() || null,
        supplierName: (b.supplierName as string | undefined)?.trim() || null,
        origin: 'MOVEMENT', paymentDocumentId: null,
      });
      const affected = 2 + (m.code.charCodeAt(1) % 7);
      return {
        movement: {
          id: movementId, itemId: m.id, warehouseId: null, movementType: 'RECEIPT',
          qty: dec(qty), unitPrice: dec(unitPrice, 2), movementDate, project: null, sourceDocumentId: null,
          supplierName: (b.supplierName as string | undefined)?.trim() || null,
          documentNumber: (b.documentNumber as string | undefined)?.trim() || null,
          comment: (b.comment as string | undefined)?.trim() || null,
          createdAt: NOW.toISOString(),
        },
        material: { id: m.id, materialCode: m.code, name: m.name, unit: m.unit, stockQty: m.stock },
        price: { before, after: anomaly ? before : after, receipt: unitPrice, changed: !anomaly && after !== before },
        batch: { id: batchId, unitPrice, qtyRemaining: qty, priceAnomaly: anomaly, anomalyFactor: anomaly ? round2(factor) : null },
        affectedArticles: affected,
        recalculation: affected > 0 ? { jobId: uid('recalc', movementId), status: 'QUEUED' } : null,
      };
    },
  },
  {
    method: 'POST', match: /^\/warehouse\/materials\/tolling-receipt$/,
    handler: (ctx) => {
      const b = body(ctx);
      const m = BY_ID.get(String(b.materialId)) ?? mat('С0604');
      const qty = Math.abs(Number(b.qty ?? 0));
      const date = typeof b.receiptDate === 'string' && b.receiptDate ? new Date(b.receiptDate).toISOString() : NOW.toISOString();
      m.stock = round3(m.stock + qty);
      return {
        id: uid('tolling', `${m.code}-${m.stock}`), materialId: m.id, warehouseId: null, receiptDate: date,
        unitPrice: '0', qtyReceived: dec(qty), qtyRemaining: dec(qty),
        supplierName: (b.supplierName as string | undefined) ?? null, documentNumber: (b.documentNumber as string | undefined) ?? null,
        sourceMovementId: null, paymentDocumentId: null, origin: 'LOCAL', externalId: null, batchType: 'TOLLING',
        ownerOrderId: String(b.orderId ?? ORDERS[0].id), priceAnomaly: false, anomalyFactor: null,
        anomalyClearedAt: null, anomalyClearedById: null, createdAt: NOW.toISOString(),
      };
    },
  },
  {
    method: 'POST', match: /^\/warehouse\/materials\/movements$/,
    handler: (ctx) => {
      const b = body(ctx);
      const m = BY_ID.get(String(b.materialId)) ?? mat('С0604');
      const qty = Math.abs(Number(b.qty ?? 0));
      const type = String(b.movementType ?? 'TO_PRODUCTION');
      const wh = WAREHOUSES.find((w) => w.id === b.warehouseId) ?? null;
      const unitPrice = typeof b.unitPrice === 'number' && b.unitPrice !== 0 ? b.unitPrice : m.price;
      const movementDate = typeof b.movementDate === 'string' && b.movementDate ? new Date(b.movementDate).toISOString() : NOW.toISOString();
      m.stock = round3(m.stock - qty);
      const invBatch = uid('inv-batch', m.code);
      const covered = Math.min(qty, Math.max(0, m.stock + qty));
      return {
        id: uid('issue', `${m.code}-${m.stock}`), itemId: m.id, warehouseId: wh ? wh.id : null, movementType: type,
        qty: dec(qty), unitPrice: dec(unitPrice, 2), movementDate, project: (b.project as string | undefined) || null,
        sourceDocumentId: null, supplierName: null, documentNumber: null, comment: null, createdAt: NOW.toISOString(),
        warehouse: wh ? { name: wh.name } : null,
        material: { materialCode: m.code, name: m.name },
        batchConsumption: { consumed: covered > 0 ? [{ batchId: invBatch, qty: round3(covered) }] : [], uncoveredQty: round3(qty - covered) },
      };
    },
  },

  // ---------- Склад ГП ----------
  {
    method: 'GET', match: /^\/warehouse\/finished-goods$/,
    handler: ({ params }) => {
      const { data, page, pageSize } = pageOf(FG_MOVES, params, 100);
      return { data: data.map(fgMoveJson), meta: { page, pageSize, total: FG_MOVES.length } };
    },
  },
  {
    method: 'GET', match: /^\/warehouse\/finished-goods\/balance$/,
    handler: ({ params }) => {
      const search = (params.get('search') ?? '').trim().toLowerCase();
      const list = fgBalanceRows().filter((r) => !search || lc(r.articleCode).includes(search) || lc(r.name).includes(search));
      const totalValue = round2(list.reduce((s, r) => s + r.valueEstimate, 0));
      const { data, page, pageSize } = pageOf(list, params, 100);
      return { data, totalValue, meta: { page, pageSize, total: list.length } };
    },
  },
  {
    method: 'POST', match: /^\/warehouse\/finished-goods\/movements$/,
    handler: (ctx) => {
      const b = body(ctx);
      const a = ARTICLES.find((x) => x.id === b.articleId) ?? ARTICLES[0];
      const raw = String(b.movementType ?? 'RECEIPT');
      const map: Record<string, string> = { 'приход': 'RECEIPT', 'расход': 'EXPENSE', 'в_производство': 'TO_PRODUCTION', 'с_производства': 'FROM_PRODUCTION', 'возврат': 'RETURN', 'коррекция': 'CORRECTION', 'отгрузка': 'SHIPMENT' };
      const type = map[raw] ?? raw;
      const order = ORDERS.find((o) => o.id === b.orderId) ?? null;
      const qty = Number(b.qty ?? 1);
      const unitPrice = typeof b.unitPrice === 'number' && b.unitPrice !== 0 ? b.unitPrice : a.price;
      const movementDate = typeof b.movementDate === 'string' && b.movementDate ? new Date(b.movementDate).toISOString() : NOW.toISOString();
      const mv: FgMove = { id: uid('fg-new', `${a.code}-${FG_MOVES.length}`), art: a, order, type, qty, unitPrice, date: movementDate, project: null };
      FG_MOVES.unshift(mv);
      const bal = FG_BALANCE.find((x) => x.code === a.code);
      const sign = type === 'RECEIPT' || type === 'FROM_PRODUCTION' || type === 'RETURN' ? 1 : type === 'CORRECTION' ? 1 : -1;
      if (bal) { bal.stock = round3(bal.stock + sign * qty); bal.lastDays = 0; }
      else FG_BALANCE.push({ code: a.code, stock: sign * qty, lastDays: 0 });
      return fgMoveJson(mv);
    },
  },

  // ---------- Журнал приходов ----------
  {
    method: 'GET', match: /^\/warehouse\/receipts$/,
    handler: ({ params }) => {
      const search = (params.get('search') ?? '').trim().toLowerCase();
      const list = search
        ? RECEIPTS.filter((r) => {
          const m = BY_ID.get(r.materialId) as Mat;
          return lc(m.name).includes(search) || lc(m.code).includes(search)
            || (r.supplierName != null && lc(r.supplierName).includes(search))
            || (r.documentNumber != null && lc(r.documentNumber).includes(search));
        })
        : RECEIPTS;
      const { data, page, pageSize } = pageOf(list, params, 50);
      return { data: data.map(receiptJson), meta: { page, pageSize, total: list.length } };
    },
  },

  // ---------- Обрезки ----------
  {
    method: 'GET', match: /^\/warehouse\/offcuts$/,
    handler: ({ params }) => {
      const search = (params.get('search') ?? '').trim().toLowerCase();
      const list = sortOffcuts(OFFCUTS.filter((o) => !search || lc(o.m.name).includes(search) || lc(o.m.code).includes(search)));
      return { data: list.map(offcutJson), total: list.length };
    },
  },
  {
    method: 'GET', match: /^\/warehouse\/offcuts\/for-order\/([^/]+)$/,
    handler: ({ path }) => {
      const orderId = path.split('/')[4];
      const order = ORDERS.find((o) => o.id === orderId);
      // Спецификация мачты М25м: уголок 50х50х5, круг ф12, труба 120х120х4 — по BOM m-015
      const need: Array<[string, number]> = [['С0509', 22.7 * 2], ['С0104', 20.52 * 2], ['С0406', 19.97 * 2], ['С0605', 59.26 * 2]];
      const materials = need.map(([code, needQty]) => {
        const m = mat(code);
        const offcuts = sortOffcuts(OFFCUTS.filter((o) => o.m.code === code));
        return { m, needQty, offcuts };
      }).filter((x) => x.offcuts.length > 0).map(({ m, needQty, offcuts }) => ({
        materialId: m.id, materialCode: m.code, name: m.name, needQty: round3(needQty), unit: m.unit,
        offcuts: offcuts.map((o) => ({ id: o.id, lengthMm: o.lengthMm, widthMm: o.widthMm, qty: o.qty, note: o.note })),
      }));
      const usedBefore = order && order.status !== 'CONFIRMED'
        ? [
          { materialCode: 'С0104', materialName: 'Круг ф 12 мм', lengthMm: 1200, qty: 4, usedAt: atHours(-52) },
          { materialCode: 'С0509', materialName: 'Уголок 50х50х5 мм', lengthMm: 1800, qty: 2, usedAt: atHours(-52) },
        ]
        : [];
      return { materials, usedBefore };
    },
  },
  {
    method: 'POST', match: /^\/warehouse\/offcuts\/for-order\/([^/]+)$/,
    handler: (ctx) => {
      const usages: Array<{ offcutId: string; qty: number }> = Array.isArray(body(ctx).usages) ? body(ctx).usages : [];
      let recorded = 0;
      for (const u of usages) {
        if (!(u.qty > 0)) continue;
        const idx = OFFCUTS.findIndex((o) => o.id === u.offcutId);
        if (idx < 0) continue;
        const take = Math.round(u.qty);
        OFFCUTS[idx].qty -= take;
        OFFCUTS[idx].updatedAt = NOW.toISOString();
        if (OFFCUTS[idx].qty <= 0) OFFCUTS.splice(idx, 1);
        recorded++;
      }
      return { recorded };
    },
  },
  {
    method: 'POST', match: /^\/warehouse\/offcuts$/,
    handler: (ctx) => {
      const b = body(ctx);
      const m = BY_ID.get(String(b.materialId)) ?? mat('С0104');
      const o: Offcut = {
        id: uid('offcut-new', `${m.code}-${b.lengthMm}-${OFFCUTS.length}`), m,
        lengthMm: Number(b.lengthMm ?? 0), widthMm: b.widthMm != null && Number(b.widthMm) > 0 ? Number(b.widthMm) : null,
        qty: Math.round(Number(b.qty ?? 1)), note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null,
        createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      };
      OFFCUTS.push(o);
      return offcutJson(o);
    },
  },
  {
    method: 'PATCH', match: /^\/warehouse\/offcuts\/([^/]+)$/,
    handler: (ctx) => {
      const id = ctx.path.split('/')[3];
      const b = body(ctx);
      const idx = OFFCUTS.findIndex((o) => o.id === id);
      if (idx < 0) return { deleted: true };
      const o = OFFCUTS[idx];
      if (typeof b.qty === 'number') {
        const q = Math.round(b.qty);
        if (q <= 0) { OFFCUTS.splice(idx, 1); return { deleted: true }; }
        o.qty = q;
      }
      if (typeof b.note === 'string') o.note = b.note.trim() || null;
      o.updatedAt = NOW.toISOString();
      return offcutJson(o);
    },
  },
  {
    method: 'DELETE', match: /^\/warehouse\/offcuts\/([^/]+)$/,
    handler: ({ path }) => {
      const id = path.split('/')[3];
      const idx = OFFCUTS.findIndex((o) => o.id === id);
      if (idx >= 0) OFFCUTS.splice(idx, 1);
      return { deleted: true };
    },
  },

  // ---------- Партии: карантин цен ----------
  {
    method: 'GET', match: /^\/material-batches\/anomalies$/,
    handler: () => {
      const data = ANOMALIES.filter((a) => !clearedAnomalies.has(a.batchId)).map(anomalyJson);
      return { data, total: data.length };
    },
  },
  {
    method: 'POST', match: /^\/material-batches\/anomalies\/([^/]+)\/clear$/,
    handler: ({ path }) => {
      const batchId = path.split('/')[3];
      const a = ANOMALY_BY_BATCH.get(batchId) ?? ANOMALIES[0];
      clearedAnomalies.add(a.batchId);
      return batchModelJson(a, true);
    },
  },
  {
    method: 'GET', match: /^\/material-batches\/(?!anomalies$)([^/]+)$/,
    handler: ({ path, params }) => {
      const id = path.split('/')[2];
      const m = BY_ID.get(id);
      if (!m) return { data: [], totalRemaining: 0 };
      const includeEmpty = params.get('includeEmpty') === 'true';
      const an = ANOMALY_BY_CODE.get(m.code);
      const onec = RECEIPTS.filter((r) => r.materialId === m.id && r.origin === 'ONEC');
      const data: Array<Record<string, unknown>> = [];
      if (m.stock > 0) {
        data.push({
          id: uid('inv-batch', m.code), receiptDate: INVENTORY_DATE, unitPrice: an ? an.unitPrice : m.price,
          qtyReceived: m.stock, qtyRemaining: m.stock, supplierName: null, documentNumber: null, origin: 'INVENTORY',
          priceAnomaly: !!an && !clearedAnomalies.has(an.batchId), anomalyFactor: an ? an.factor : null,
        });
      }
      onec.forEach((r, i) => {
        const remaining = i === 0 ? round3(r.qty * 0.35) : 0;
        if (remaining === 0 && !includeEmpty) return;
        data.push({
          id: r.id, receiptDate: r.date, unitPrice: r.unitPrice, qtyReceived: r.qty, qtyRemaining: remaining,
          supplierName: r.supplierName, documentNumber: r.documentNumber, origin: 'ONEC', priceAnomaly: false, anomalyFactor: null,
        });
      });
      const totalRemaining = data.reduce((s, b) => s + Number(b.qtyRemaining), 0);
      return { data, totalRemaining: round3(totalRemaining) };
    },
  },
  {
    method: 'POST', match: /^\/material-batches\/([^/]+)\/price$/,
    handler: (ctx) => {
      const id = ctx.path.split('/')[2];
      const m = BY_ID.get(id) ?? mat('С0604');
      const b = body(ctx);
      const qty = Number(b.qty ?? 1);
      const source = String(b.source ?? 'FIFO_STOCK');
      const covered = Math.min(qty, m.stock);
      const shortage = round3(qty - covered);
      const unitPrice = typeof b.explicitPrice === 'number' ? b.explicitPrice : m.price;
      return {
        source,
        unitPrice,
        totalCost: round2(qty * unitPrice),
        allocations: covered > 0 ? [{ batchId: uid('inv-batch', m.code), qty: round3(covered), unitPrice, lineCost: round2(covered * unitPrice) }] : [],
        coveredQty: round3(covered),
        shortageQty: shortage,
        shortageUnitPrice: shortage > 0 ? unitPrice : 0,
        shortageCost: round2(shortage * unitPrice),
        isShortage: shortage > 0,
        excludedAnomalyBatchIds: ANOMALY_BY_CODE.has(m.code) ? [uid('inv-batch', m.code)] : [],
        basis: covered > 0 ? 'batches' : 'last_purchase',
      };
    },
  },

  // ---------- Резервы: перехваты и истекающие ----------
  {
    method: 'GET', match: /^\/batch-reservations\/overrides$/,
    handler: ({ params }) => {
      const status = params.get('status') || 'PENDING';
      const data = OVERRIDES
        .filter((o) => (decided.get(o.id) ?? o.status) === status)
        .sort((a, b) => b.createdHoursAgo - a.createdHoursAgo)
        .map(overrideJson);
      return { data, total: data.length };
    },
  },
  {
    method: 'POST', match: /^\/batch-reservations\/overrides$/,
    handler: (ctx) => {
      const b = body(ctx);
      const requester = ORDERS.find((o) => o.id === b.requestedByOrderId) ?? ORDERS[5];
      const base = OVERRIDES.find((o) => o.reservationId === b.reservationId) ?? OVERRIDES[0];
      const o: Override = {
        ...base, id: uid('override-new', `${OVERRIDES.length}`), status: 'PENDING', qty: Number(b.qtyRequested ?? base.qty),
        reason: String(b.reason ?? ''), createdHoursAgo: 0, requester,
      };
      OVERRIDES.push(o);
      return {
        id: o.id, reservationId: o.reservationId, requestedByOrderId: requester.id, qtyRequested: dec(o.qty),
        reason: o.reason, status: 'PENDING', requestedById: DESIGN_USER_ID, createdAt: NOW.toISOString(),
      };
    },
  },
  {
    method: 'GET', match: /^\/batch-reservations\/expiring$/,
    handler: ({ params }) => {
      let horizon = 3;
      const v = Number(params.get('days'));
      if (Number.isInteger(v) && v !== 0) horizon = Math.max(1, v);
      const data = EXPIRING
        .filter((e) => e.expiresHours < horizon * 24)
        .sort((a, b) => a.expiresHours - b.expiresHours)
        .map((e) => ({
          id: e.id,
          order: { id: e.order.id, orderNumber: e.order.number, status: e.order.status },
          material: { materialCode: e.m.code, name: e.m.name, unit: e.m.unit },
          qty: e.qty, unitPrice: e.unitPrice, expiresAt: atHours(e.expiresHours),
          daysLeft: Math.max(0, Math.ceil(e.expiresHours / 24)),
        }));
      return { data, total: data.length };
    },
  },
  {
    method: 'GET', match: /^\/batch-reservations\/overrides\/([^/]+)$/,
    handler: ({ path }) => {
      const id = path.split('/')[3];
      const o = OVERRIDES.find((x) => x.id === id) ?? OVERRIDES[0];
      const alternatives = RECEIPTS
        .filter((r) => r.materialId === o.m.id && r.origin === 'ONEC' && r.id !== o.batchId)
        .slice(0, 3)
        .map((r, i) => ({ id: r.id, receiptDate: r.date, unitPrice: r.unitPrice, qtyRemaining: round3(r.qty * (0.2 + i * 0.15)) }))
        .sort((a, b) => a.unitPrice - b.unitPrice);
      const impact = alternatives.length > 0
        ? {
          alternativeUnitPrice: alternatives[0].unitPrice,
          deltaPerUnit: round2(alternatives[0].unitPrice - o.unitPrice),
          totalDelta: round2((alternatives[0].unitPrice - o.unitPrice) * o.qty),
        }
        : { alternativeUnitPrice: null, deltaPerUnit: null, totalDelta: null, note: 'Других партий нет — придётся закупать' };
      return {
        request: { id: o.id, qtyRequested: o.qty, reason: o.reason, status: decided.get(o.id) ?? o.status, createdAt: atHours(-o.createdHoursAgo) },
        material: { materialCode: o.m.code, name: o.m.name, unit: o.m.unit },
        batch: { id: o.batchId, receiptDate: dayIso(o.batchDaysAgo), unitPrice: o.unitPrice, qtyRemaining: o.batchRemaining, supplierName: o.supplier },
        holder: { id: o.holder.id, orderNumber: o.holder.number, status: o.holder.status, plannedShipmentDate: o.holder.planned },
        requester: { id: o.requester.id, orderNumber: o.requester.number, status: o.requester.status, plannedShipmentDate: o.requester.planned },
        impact,
        alternatives,
      };
    },
  },
  {
    method: 'POST', match: /^\/batch-reservations\/overrides\/([^/]+)\/decide$/,
    handler: (ctx) => {
      const id = ctx.path.split('/')[3];
      const o = OVERRIDES.find((x) => x.id === id) ?? OVERRIDES[0];
      const b = body(ctx);
      const status: 'APPROVED' | 'REJECTED' = b.approve ? 'APPROVED' : 'REJECTED';
      decided.set(o.id, status);
      const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim() : null;
      return {
        request: {
          id: o.id, reservationId: o.reservationId, requestedByOrderId: o.requester.id, qtyRequested: dec(o.qty),
          reason: o.reason, status, requestedById: null, createdAt: atHours(-o.createdHoursAgo),
          decidedById: DESIGN_USER_ID, decidedAt: NOW.toISOString(), decisionComment: comment,
        },
        affectedCostingId: b.approve ? uid('costing', o.requester.id) : null,
      };
    },
  },
  {
    method: 'POST', match: /^\/batch-reservations\/expire-stale$/,
    handler: () => ({ expired: 2, warned: EXPIRING.filter((e) => e.expiresHours < 72).length }),
  },

  // ---------- Минимальные остатки ГП ----------
  {
    method: 'GET', match: /^\/min-stock-levels$/,
    handler: ({ params }) => {
      const articleId = params.get('articleId');
      const deficitOnly = params.get('deficitOnly') === 'true';
      return MIN_STOCK
        .filter((l) => !articleId || l.art.id === articleId)
        .map(minStockJson)
        .filter((r) => !deficitOnly || r.deficitQty > 0)
        .sort((a, b) => b.deficitValue - a.deficitValue);
    },
  },
  {
    method: 'PATCH', match: /^\/min-stock-levels\/([^/]+)$/,
    handler: (ctx) => {
      const articleId = ctx.path.split('/')[2];
      const b = body(ctx);
      let l = MIN_STOCK.find((x) => x.art.id === articleId);
      if (!l) {
        const a = ARTICLES.find((x) => x.id === articleId) ?? { id: articleId, code: 'n-0000', name: 'Изделие', price: 0 };
        const bal = FG_BALANCE.find((x) => x.code === a.code);
        l = { id: uid('min-stock-new', articleId), art: a, period: 3, target: 0, actual: bal ? bal.stock : 0 };
        MIN_STOCK.push(l);
      }
      const prev = minStockEdits.get(articleId) ?? { target: l.target, period: l.period };
      const target = typeof b.targetQty === 'number' && b.targetQty >= 0 ? b.targetQty : prev.target;
      const period = typeof b.periodMonths === 'number' && b.periodMonths > 0 ? b.periodMonths : prev.period;
      minStockEdits.set(articleId, { target, period });
      const r = minStockJson(l);
      return {
        id: r.id, articleId: r.articleId, periodMonths: dec(period), targetQty: dec(target),
        actualQty: dec(r.actualQty), deficitQty: dec(r.deficitQty), readinessPct: dec(r.readinessPct, 1),
      };
    },
  },
  {
    method: 'DELETE', match: /^\/min-stock-levels\/([^/]+)$/,
    handler: ({ path }) => {
      const articleId = path.split('/')[2];
      const idx = MIN_STOCK.findIndex((x) => x.art.id === articleId);
      if (idx >= 0) MIN_STOCK.splice(idx, 1);
      minStockEdits.delete(articleId);
      return { deleted: true };
    },
  },
];
