import type { FixtureRoute, FixtureContext } from './types';

/**
 * Фикстуры каталога изделий для режима дизайна (03.09.2026).
 *
 * Закрывает раздел «Изделия» (/specs) и «Прайс» (/prices): справочник
 * изделий, состав (BOM), нормы труда по трём переделам, себестоимость с
 * разбором формулы, участки, коэффициенты калькуляции, пересмотр цен и
 * заявки на номенклатуру.
 *
 * Почему появился: /specs падал с «items.slice is not a function» —
 * фикстур каталога не было, и GET /articles/:id/bom получал заглушку
 * {data: [], meta}, тогда как Go отдаёт ГОЛЫЙ массив.
 *
 * Форма ответов повторяет Go-обработчики:
 *   backend-go/internal/modules/catalog/articles.go      — список, карточка, BOM
 *   backend-go/internal/modules/catalog/price_digest.go  — сводка прайса
 *   backend-go/internal/modules/catalog/routing.go       — нормы, факт, участки, коэффициенты
 *   backend-go/internal/costing/pure.go                  — арифметика калькуляции
 *   backend-go/internal/modules/misc/catalog_misc.go     — пересмотр цен
 *   backend-go/internal/modules/misc/nomenclature*.go    — заявки на номенклатуру
 *
 * Правила сериализации Go, воспроизведённые здесь:
 *   • decimal.Decimal → строка без хвостовых нулей: "4710.11", "1779.4", "0";
 *   • common.PDate / time.Format → "2026-08-25T00:00:00.000Z" либо null;
 *   • float64 → число (весь блок routing/costing считается во float64);
 *   • GET /articles/:id/bom и GET /work-centers → голый массив, без {data};
 *   • work-centers.hourlyRate — Decimal, то есть СТРОКА «1268.92», хотя
 *     WorkCenter в src/api/routing.ts объявлен как number. Так отвечает
 *     настоящий бэкенд, поэтому так же отвечаем и мы (экран не ломается:
 *     строка попадает в умножение, а не в сложение).
 *
 * Данные — выборка из реальной базы ЦМК Аврора (артикулы m-035 «Мачта
 * М25м…», z-050 «Казарма модульного типа…», n-455 «Комплект для
 * контейнера…», материалы С0605 «Швеллер 14П», К1004 «Сэндвич-панель
 * 80х1200», участки CUT-1/ASM-1/ASM-2/PNT-1 со ставкой 1268.92 ₸/час,
 * коэффициенты 2040 ₸/час, логистика 3 %, ЖКХ 1 %, маржа 35 % от цены).
 * Размножено детерминированным генератором: без Math.random и Date.now —
 * одна и та же картинка при каждом открытии.
 *
 * Масштаб настоящей базы: 2 152 изделия (без перепродажи сырья), у 176
 * есть утверждённая цена. Здесь показываем 60 реальных карточек, а
 * meta.total берём настоящий — так пагинация выглядит как в бою.
 */

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

/** «Сегодня» режима дизайна */
const NOW = new Date('2026-09-03T09:00:00.000Z');
const DAY = 86_400_000;

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Детерминированный псевдо-UUID. Алгоритм тот же, что в production.ts, —
 * иначе id участка из GET /work-centers не совпал бы с id внутри
 * routing.stages[].workCenter, и выпадающий список «Участок» на экране
 * норм всегда показывал бы «Общая ставка».
 */
function uuid(...parts: Array<string | number>): string {
  const key = parts.join(':');
  const hex = [0, 1, 2, 3].map((k) => fnv(`${key}#${k}`).toString(16).padStart(8, '0')).join('');
  const variant = (8 + (parseInt(hex[16], 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

/** decimal.Decimal в JSON — строка без хвостовых нулей: "4710.11", "1779.4", "0" */
const dec = (n: number, places = 4): string => String(Number(n.toFixed(places)));
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Полночь UTC n дней назад — как date-колонки из 1С */
function dayIso(daysAgo: number): string {
  const d = new Date(NOW);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}
/** Момент со смещением в часах от «сейчас» */
const atHours = (hoursFromNow: number): string => new Date(NOW.getTime() + hoursFromNow * 3_600_000).toISOString();

function pageOf<T>(list: T[], params: URLSearchParams, defaultSize: number): { data: T[]; page: number; pageSize: number } {
  let page = Number(params.get('page'));
  if (!(page >= 1)) page = 1;
  let pageSize = Number(params.get('pageSize'));
  if (!(pageSize >= 1)) pageSize = defaultSize;
  const start = Math.min((page - 1) * pageSize, list.length);
  return { data: list.slice(start, start + pageSize), page, pageSize };
}

const lc = (s: string) => s.toLowerCase();
const body = (ctx: FixtureContext): Record<string, any> => (ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, any>) : {});
/** id из пути: /articles/<id>/routing/CUTTING → сегменты без пустых */
const seg = (path: string): string[] => path.split('/').filter(Boolean);

/** Пользователь режима дизайна (см. designMode.ts) */
const DESIGN_USER_ID = '00000000-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// Справочник материалов (реальные строки таблицы materials)
// ---------------------------------------------------------------------------

type CatRu = 'Металл' | 'Комплектующие' | 'Метизы' | 'Расходники' | 'Инструменты';

/** models.CategoryDBToAPI: в базе русская метка, наружу — код enum */
const CATEGORY_API: Record<CatRu, string> = {
  'Металл': 'METAL',
  'Комплектующие': 'COMPONENTS',
  'Метизы': 'HARDWARE',
  'Расходники': 'CONSUMABLES',
  'Инструменты': 'INSTRUMENTS',
};

interface MatSeed {
  code: string;
  cat: CatRu;
  name: string;
  unit: string;
  /** purchase_price — по ней считается материальная часть себестоимости */
  price: number;
  /** price_list_price */
  list?: number;
  /** last_purchase_price + сколько дней назад был закуп */
  last?: number;
  lastDays?: number;
  stock: number;
}

/**
 * 79 позиций из настоящего справочника: коды, названия, единицы и цены
 * взяты из базы как есть — в том числе длинные названия комплектующих,
 * на которых и проверяют читаемость состава.
 */
const MATERIALS: readonly MatSeed[] = [
  // --- Металл ---
  { code: 'С0605', cat: 'Металл', name: 'Швеллер 14П', unit: 'м', price: 4710.11, list: 15673, stock: 406714.5 },
  { code: 'С0207', cat: 'Металл', name: 'Лист горячекатанный 1500х6000х3', unit: 'м2', price: 7099.96, stock: 0 },
  { code: 'С0208', cat: 'Металл', name: 'Лист горячекатанный 1500х6000х4 мм', unit: 'м2', price: 9004.11, list: 9004.11, stock: 582.624 },
  { code: 'С0210', cat: 'Металл', name: 'Лист горячекатанный 1500х6000х6', unit: 'м2', price: 12911.56, stock: 0 },
  { code: 'С0211', cat: 'Металл', name: 'Лист горячекатанный 1500х6000х8', unit: 'м2', price: 18521.74, list: 18521.74, stock: 0 },
  { code: 'С0204', cat: 'Металл', name: 'Лист горячекатанный 1500х6000х12', unit: 'м2', price: 26740.95, stock: 0 },
  { code: 'С0201', cat: 'Металл', name: 'Лист горячекатанный 1250х2500х1,8', unit: 'м2', price: 4367.37, stock: 0 },
  { code: 'С0217', cat: 'Металл', name: 'Лист холоднокатанный 1250х2500х2,0', unit: 'м2', price: 6285.6, list: 240, stock: 0 },
  { code: 'С0212', cat: 'Металл', name: 'Лист оцинкованный 1250х2500х0.5', unit: 'м2', price: 2000, list: 2000, stock: 0 },
  { code: 'С0213', cat: 'Металл', name: 'Лист ПВЛ 1000х2500х4', unit: 'м2', price: 8580, list: 8580, stock: 0 },
  { code: 'С0214', cat: 'Металл', name: 'Лист риф. 1500х6000х4', unit: 'м2', price: 9554.83, stock: 0 },
  { code: 'С0406', cat: 'Металл', name: 'Труба профильная 120х120х4 мм', unit: 'м', price: 5058.75, stock: 2663.937 },
  { code: 'С0409', cat: 'Металл', name: 'Труба профильная 140х140х4 мм', unit: 'м', price: 5862.5, stock: 2340 },
  { code: 'С0411', cat: 'Металл', name: 'Труба профильная 20х20х1,4 мм', unit: 'м', price: 3901.23, stock: 0 },
  { code: 'С0418', cat: 'Металл', name: 'Труба профильная 40х20х1,5 мм', unit: 'м', price: 568.74, list: 568.74, stock: 596.132 },
  { code: 'С0431', cat: 'Металл', name: 'Труба профильная 80х80х3 мм', unit: 'м', price: 2769.95, stock: 1311 },
  { code: 'С0436', cat: 'Металл', name: 'Труба профильная 100х100х3 мм', unit: 'м', price: 3212.65, stock: 612 },
  { code: 'С0449', cat: 'Металл', name: 'Труба профильная 40х20х2,0 мм', unit: 'м', price: 678.33, stock: 986.531 },
  { code: 'С0318', cat: 'Металл', name: 'Труба э/с ф76х3,5 мм', unit: 'м', price: 2548, list: 430, last: 2548, lastDays: 168, stock: 0 },
  { code: 'С0320', cat: 'Металл', name: 'Труба э/с ф102х3,5 мм', unit: 'м', price: 3027.5, stock: 0 },
  { code: 'С0507', cat: 'Металл', name: 'Уголок 40х40х4 мм', unit: 'м', price: 817.5, list: 86, stock: 6743.276 },
  { code: 'С0510', cat: 'Металл', name: 'Уголок 63х63х5 мм', unit: 'м', price: 1556.86, list: 106.67, stock: 6955.151 },
  { code: 'С0511', cat: 'Металл', name: 'Уголок 70х70х5 мм', unit: 'м', price: 1793.84, list: 5909.94, stock: 1418.21 },
  { code: 'С0513', cat: 'Металл', name: 'Уголок 80х80х6 мм', unit: 'м', price: 2532.82, stock: 6740.98 },
  { code: 'С0103', cat: 'Металл', name: 'Круг ф 10 мм', unit: 'м', price: 194.02, stock: 8828.126 },
  { code: 'С0104', cat: 'Металл', name: 'Круг ф 12 мм', unit: 'м', price: 307.3, list: 307.3, stock: 5729.585 },
  { code: 'С0107', cat: 'Металл', name: 'Круг ф 18 мм', unit: 'м', price: 888.89, list: 888.89, stock: 1992 },
  { code: 'С0108', cat: 'Металл', name: 'Круг ф 20 мм', unit: 'м', price: 753.72, stock: 7214.2 },

  // --- Комплектующие ---
  { code: 'К1004', cat: 'Комплектующие', name: 'Сэндвич-панель 80х1200 мм мин.плита', unit: 'м2', price: 12350, list: 1130, stock: 908.808 },
  { code: 'К1011', cat: 'Комплектующие', name: 'Сэндвич-панель 150х1200 мм мин.плита', unit: 'м2', price: 20000, stock: 0 },
  { code: 'К0339', cat: 'Комплектующие', name: 'Профнастил ЛКП HС44 0,7х1000 мм (6,38м)', unit: 'м', price: 4250, list: 4250, stock: 0 },
  { code: 'К0342', cat: 'Комплектующие', name: 'Профнастил оц. С4 0,45х1180 мм (6,0м)', unit: 'м', price: 3830, stock: 0 },
  { code: 'К0073', cat: 'Комплектующие', name: 'Плита теплоизоляционная П-35 (1000*500*50)', unit: 'м3', price: 21000, list: 2726, stock: 0 },
  { code: 'К1120', cat: 'Комплектующие', name: 'ЦСП 3200х1250х20', unit: 'шт', price: 16000, stock: 21 },
  { code: 'К1121', cat: 'Комплектующие', name: 'ЦСП 3200х1250х10', unit: 'шт', price: 8600, stock: 0 },
  { code: 'К1126', cat: 'Комплектующие', name: 'Фанера ФСФ-10 (2440х1220)', unit: 'м2', price: 2519.48, stock: 0 },
  { code: 'К1102', cat: 'Комплектующие', name: 'Фанера ФСФ-21 (2440х1220)', unit: 'м2', price: 5206.93, list: 3950, stock: 110 },
  { code: 'К0180', cat: 'Комплектующие', name: 'Линолеум коммерческий', unit: 'м2', price: 5980, stock: 442.5 },
  { code: 'К0049', cat: 'Комплектующие', name: 'линолеум', unit: 'м2', price: 2295, list: 367.92, stock: 0 },
  { code: 'К0198', cat: 'Комплектующие', name: 'САЙДИНГ "Эльбрус" (АМТ) (БЕЛЫЙ RAL 9003)', unit: 'м', price: 752.4, stock: 0 },
  { code: 'К0457', cat: 'Комплектующие', name: 'ФП Начальная рейка L=3000мм Ral 9003', unit: 'м', price: 319.9, stock: 0 },
  { code: 'К0216', cat: 'Комплектующие', name: 'Дверь двухстворчатый металлический утепленный', unit: 'шт', price: 149500, stock: 2 },
  { code: 'К0215', cat: 'Комплектующие', name: 'Дверь одностворчатый металлический глухой', unit: 'шт', price: 99000, stock: 0 },
  { code: 'К0192', cat: 'Комплектующие', name: 'ДПГ Гладкое 2000х800', unit: 'шт', price: 35670, stock: 0 },
  { code: 'К0186', cat: 'Комплектующие', name: 'Ф3 ручка 101', unit: 'шт', price: 7050, stock: 0 },
  { code: 'К0187', cat: 'Комплектующие', name: 'К-Т кор ЛАМ 26х70', unit: 'шт', price: 10680, stock: 0 },
  { code: 'К0193', cat: 'Комплектующие', name: 'К-Т нал 70х20', unit: 'шт', price: 9310, stock: 0 },
  { code: 'К0217', cat: 'Комплектующие', name: 'Желоб водосточный D125х3000 GS lite (ПЭД-01-9003\\9003 Белый двухсторонний-0.5)', unit: 'шт', price: 4695, list: 4695, stock: 0 },
  { code: 'К0218', cat: 'Комплектующие', name: 'Держатель желоба карнизный D125х132 GS lite (ПО-01-9003 Белый-3)', unit: 'шт', price: 775, list: 775, stock: 0 },
  { code: 'К0220', cat: 'Комплектующие', name: 'Воронка выпускная D125/90 GS lite (ПЭД-01-9003\\9003 Белый двухсторонний-0.6)', unit: 'шт', price: 1410, list: 1410, stock: 0 },
  { code: 'К0221', cat: 'Комплектующие', name: 'Колено сливное D90х60 градусов GS lite (ПЭД-01-9003\\9003 Белый двухсторонний-0.6)', unit: 'шт', price: 1660, list: 1660, stock: 0 },
  { code: 'К0009', cat: 'Комплектующие', name: 'Брезент арт.11293 СКПВ (пл 480+32 гр.м.кв., водоупорная пропитка, шир. 90 см., ГОСТ 15530-93)', unit: 'м', price: 5321, list: 5321, stock: 0 },
  { code: 'К0441', cat: 'Комплектующие', name: 'Hikvision DS-PDP18-EG2+DS-PDB-IN+RMLD874_E Пассивный инфракрасный извещатель+настенный кронштейн', unit: 'шт', price: 3199, list: 10012.5, stock: 0 },
  { code: 'К0442', cat: 'Комплектующие', name: 'Модуль газового пожаротушения FeniX МГП FX 25-20, V=20л.,подвесной', unit: 'шт', price: 238046, list: 6900.18, stock: 0 },
  { code: 'К0436', cat: 'Комплектующие', name: 'КРИСТАЛЛ-24"Автоматика отключена"Оповещатель световой,24В, табло плоское', unit: 'шт', price: 1175, list: 10625, stock: 0 },
  { code: 'К0159', cat: 'Комплектующие', name: 'Прожектор Gauss LED Elementary 200W 16800lm IP65 6500K черный 691511200', unit: 'шт', price: 9047, list: 30, stock: 0 },
  { code: 'К0075', cat: 'Комплектующие', name: 'Прожектор Gauss LED Elementary 100W 9500lm IP65 6500K черный 613100100', unit: 'шт', price: 7660, list: 6887.8, stock: 0 },
  { code: 'К0502', cat: 'Комплектующие', name: 'Трос 14 мм', unit: 'м', price: 630, list: 17857.14, stock: 5352.5 },
  { code: 'К0804', cat: 'Комплектующие', name: 'Замок гаражный накладной ЗГЦ-02', unit: 'шт', price: 4655, list: 1336, stock: 0 },
  { code: 'К0906', cat: 'Комплектующие', name: 'Кабель ВВГнг-LS 3х2,5', unit: 'м', price: 476, list: 55357.14, stock: 2914 },
  { code: 'К0902', cat: 'Комплектующие', name: 'Кабель ВВГ нг LS 3 х 1,5', unit: 'м', price: 301, list: 446.43, stock: 0 },
  { code: 'К0204', cat: 'Комплектующие', name: 'Наконечник медный Т  6-6-4 ЗЭТА', unit: 'шт', price: 5220, list: 5220, stock: 0 },
  { code: 'K0407', cat: 'Комплектующие', name: 'Светильник внутренний круглый без решетки', unit: 'шт', price: 2149, list: 2149, stock: 521 },
  { code: 'К0008', cat: 'Комплектующие', name: 'Бикрост ХПП', unit: 'м2', price: 410, list: 4115, stock: 0 },

  // --- Метизы ---
  { code: 'М0201', cat: 'Метизы', name: 'Гайка M10 оц.', unit: 'кг', price: 920, list: 306.25, stock: 0 },
  { code: 'М0202', cat: 'Метизы', name: 'Гайка M12 оц.', unit: 'кг', price: 920, list: 1720, stock: 0 },
  { code: 'М0136', cat: 'Метизы', name: 'Болт мебельный М8х100', unit: 'кг', price: 870, list: 1470, stock: 123.7 },
  { code: 'М0005', cat: 'Метизы', name: 'Анкерный болт М10х12х150', unit: 'шт', price: 182, list: 2295, stock: 580 },
  { code: 'М0511', cat: 'Метизы', name: 'Саморез кровельный 5.5х32', unit: 'кг', price: 1280, list: 380, stock: 0 },
  { code: 'М1102', cat: 'Метизы', name: 'Заклепка алюминиевая 4х16', unit: 'шт', price: 4.35, list: 111, stock: 0 },

  // --- Расходники ---
  { code: 'Л0038', cat: 'Расходники', name: 'Грунт-эмаль Эмапрайм SP 7040', unit: 'кг', price: 5530, stock: 0 },
  { code: 'Л0008', cat: 'Расходники', name: 'Грунт-эмаль Anticor 101 RAL 9005', unit: 'кг', price: 2973, list: 696.43, stock: 0 },
  { code: 'Л0077', cat: 'Расходники', name: 'Эмаль ПФ-115 синяя', unit: 'кг', price: 950, list: 950, stock: 4815.272 },
  { code: 'Л0020', cat: 'Расходники', name: 'Растворитель 646', unit: 'л', price: 950, stock: 15068.773 },
  { code: 'Р0060', cat: 'Расходники', name: 'Проволока для кэмпинга 1,2 мм', unit: 'кг', price: 857, list: 49062.5, stock: 13613.01 },
  { code: 'Р0406', cat: 'Расходники', name: 'Диск отрезной 400', unit: 'шт', price: 4950, list: 8035.71, stock: 10.1 },
  { code: 'Р0012', cat: 'Расходники', name: 'Герметик силиконовый', unit: 'шт', price: 1650.24, list: 7808, stock: 136 },
  { code: 'Р0024', cat: 'Расходники', name: 'Клей для линолеума', unit: 'кг', price: 418.29, stock: 335 },
  { code: 'Р0199', cat: 'Расходники', name: 'Пленка теплоизоляционная 200Мкр', unit: 'кг', price: 900, stock: 0 },
  { code: 'Р0002', cat: 'Расходники', name: 'Пена "Титан"', unit: 'шт', price: 1200, list: 1200, stock: 0 },
  { code: 'Р4015', cat: 'Расходники', name: 'Автоматический выключатель SE EZ9F34110 EASY 9 1П 10А С 4.5кА 230В', unit: 'шт', price: 338, list: 338, stock: 0 },
  { code: 'Р4010', cat: 'Расходники', name: 'Шина РЕ "земля" ШНИ-8х12-8-КС-Ж в комб DIN-изол "Стойка" UNIT (10) NEW', unit: 'шт', price: 620, list: 620, stock: 0 },
];

const MAT_BY_CODE = new Map<string, MatSeed>(MATERIALS.map((m) => [m.code, m]));

/** models.OperationTypeDBToAPI: резка→CUTTING, сборка/сварка→WELDING_ASSEMBLY, покраска→PAINTING */
function opTypeOf(m: MatSeed): string {
  if (m.cat === 'Металл') return 'CUTTING';
  if (m.code === 'Р0406') return 'CUTTING'; // отрезной диск списывают на резке
  if (/Грунт-эмаль|Эмаль|Растворитель/.test(m.name)) return 'PAINTING';
  return 'WELDING_ASSEMBLY';
}

function materialJson(m: MatSeed): Record<string, unknown> {
  return {
    id: uuid('material', m.code),
    materialCode: m.code,
    category: CATEGORY_API[m.cat],
    name: m.name,
    unit: m.unit,
    unitWeightKg: '0',
    purchasePrice: dec(m.price, 2),
    purchasePriceUpdatedAt: m.lastDays != null ? dayIso(m.lastDays) : null,
    lastPurchasePrice: dec(m.last ?? 0, 2),
    lastPurchaseDate: m.lastDays != null ? dayIso(m.lastDays) : null,
    priceListPrice: dec(m.list ?? 0, 2),
    stockQty: dec(m.stock, 3),
  };
}

// ---------------------------------------------------------------------------
// Участки и коэффициенты калькуляции
// ---------------------------------------------------------------------------

interface WcSeed { code: string; name: string; stage: 'CUTTING' | 'ASSEMBLY' | 'PAINTING'; rate: number; capacity: number }

/** work_centers как есть: все четыре участка со ставкой 1268.92 ₸/час */
const WC_SEEDS: readonly WcSeed[] = [
  { code: 'ASM-1', name: 'Сварка-1', stage: 'ASSEMBLY', rate: 1268.92, capacity: 24 },
  { code: 'ASM-2', name: 'Сварка-2', stage: 'ASSEMBLY', rate: 1268.92, capacity: 24 },
  { code: 'CUT-1', name: 'Резка-1', stage: 'CUTTING', rate: 1268.92, capacity: 16 },
  { code: 'PNT-1', name: 'Покраска-1', stage: 'PAINTING', rate: 1268.92, capacity: 16 },
];

const WC_BY_CODE = new Map<string, WcSeed>(WC_SEEDS.map((w) => [w.code, w]));

/** GET /work-centers — Decimal-поля строками, порядок по коду */
const WORK_CENTERS = WC_SEEDS.map((w) => ({
  id: uuid('wc', w.code),
  code: w.code,
  name: w.name,
  stage: w.stage,
  hourlyRate: dec(w.rate, 2),
  capacityPerDay: dec(w.capacity, 2),
  isActive: true,
}));

type Stage = 'CUTTING' | 'ASSEMBLY' | 'PAINTING';

const STAGES: readonly Stage[] = ['CUTTING', 'ASSEMBLY', 'PAINTING'];

/** costing.stageLabels — три передела «Спецификации 2022» */
const STAGE_LABEL: Record<Stage, string> = {
  CUTTING: 'Резка',
  ASSEMBLY: 'Сборка / сварка / обшивка',
  PAINTING: 'Зачистка / покраска',
};

/** Действующая строка costing_configs (valid_to IS NULL) */
const CONFIG = {
  id: uuid('costing-config', '2026-08-27'),
  validFrom: '2026-08-27T00:00:00.000Z',
  hourlyRate: 2040,
  rateCutting: 2040,
  rateAssembly: 2040,
  ratePainting: 2040,
  logisticsPct: 0.03,
  utilitiesPct: 0.01,
  vatPct: 0.16,
  marginPct: 0.35,
  paymentTermDays: 30,
  weldingFactor: 0.02,
  marginMode: 'MARGIN',
  logisticsMode: 'PERCENT_OF_MATERIAL',
  logisticsFixed: 0,
  logisticsPerKg: 0,
  stageTrackingThreshold: 5,
};

/** costing.ActiveRates */
const RATES = {
  hourlyRate: CONFIG.hourlyRate,
  stageRates: { CUTTING: CONFIG.rateCutting, ASSEMBLY: CONFIG.rateAssembly, PAINTING: CONFIG.ratePainting } as Record<Stage, number>,
  logisticsPct: CONFIG.logisticsPct,
  utilitiesPct: CONFIG.utilitiesPct,
  marginPct: CONFIG.marginPct,
  marginMode: CONFIG.marginMode,
  logisticsMode: CONFIG.logisticsMode,
  logisticsFixed: CONFIG.logisticsFixed,
  logisticsPerKg: CONFIG.logisticsPerKg,
};

/** ratesOut() из routing.go */
const ratesJson = () => ({
  hourlyRate: RATES.hourlyRate,
  stageRates: { CUTTING: RATES.stageRates.CUTTING, ASSEMBLY: RATES.stageRates.ASSEMBLY, PAINTING: RATES.stageRates.PAINTING },
  logisticsPct: RATES.logisticsPct,
  utilitiesPct: RATES.utilitiesPct,
  marginPct: RATES.marginPct,
  marginMode: RATES.marginMode,
  logisticsMode: RATES.logisticsMode,
  logisticsFixed: RATES.logisticsFixed,
  logisticsPerKg: RATES.logisticsPerKg,
});

/** costing-config в форме costingConfigOut: Decimal-поля строками */
const configJson = (over: Partial<typeof CONFIG> = {}) => {
  const c = { ...CONFIG, ...over };
  return {
    id: c.id,
    validFrom: c.validFrom,
    validTo: null,
    hourlyRate: dec(c.hourlyRate, 2),
    rateCutting: dec(c.rateCutting, 2),
    rateAssembly: dec(c.rateAssembly, 2),
    ratePainting: dec(c.ratePainting, 2),
    logisticsPct: dec(c.logisticsPct, 4),
    utilitiesPct: dec(c.utilitiesPct, 4),
    vatPct: dec(c.vatPct, 4),
    marginPct: dec(c.marginPct, 4),
    paymentTermDays: c.paymentTermDays,
    weldingFactor: dec(c.weldingFactor, 4),
    createdById: DESIGN_USER_ID,
    marginMode: c.marginMode,
    logisticsMode: c.logisticsMode,
    logisticsFixed: dec(c.logisticsFixed, 2),
    logisticsPerKg: dec(c.logisticsPerKg, 2),
    stageTrackingThreshold: c.stageTrackingThreshold,
  };
};

// ---------------------------------------------------------------------------
// Арифметика калькуляции — перенос internal/costing/pure.go
// ---------------------------------------------------------------------------

interface Norm { stage: Stage; workers: number; hoursPerUnit: number; wcCode: string | null }

interface StageCostLine {
  stage: Stage; workers: number; hoursPerUnit: number; hourlyRate: number; manHours: number; stageCost: number;
}

interface CostingResult {
  materialCost: number; stages: StageCostLine[]; totalManHours: number; laborCost: number;
  logisticsCost: number; utilitiesCost: number; totalCost: number; margin: number; price: number;
  marginMode: string; marginPct: number; marginOfPricePct: number; markupPct: number;
}

/** RateForStage — каскад ставок: участок → передел → общая */
function rateForStage(stage: Stage, wcCode: string | null): number {
  if (wcCode) {
    const wc = WC_BY_CODE.get(wcCode);
    if (wc) return wc.rate;
  }
  return RATES.stageRates[stage] ?? RATES.hourlyRate;
}

/** CalculateArticleCosting: маржа 35 % ОТ ЦЕНЫ — price = cost / (1 - pct) */
function calcCosting(materialCost: number, norms: Norm[]): CostingResult {
  const stages: StageCostLine[] = norms.map((n) => {
    const hourlyRate = rateForStage(n.stage, n.wcCode);
    const manHours = round3(n.workers * n.hoursPerUnit);
    return { stage: n.stage, workers: n.workers, hoursPerUnit: n.hoursPerUnit, hourlyRate, manHours, stageCost: round2(manHours * hourlyRate) };
  });

  let totalManHours = 0;
  let laborCost = 0;
  for (const s of stages) {
    totalManHours += s.manHours;
    laborCost += s.stageCost;
  }
  totalManHours = round3(totalManHours);
  laborCost = round2(laborCost);

  const logisticsCost = round2(materialCost * RATES.logisticsPct);
  const utilitiesCost = round2(materialCost * RATES.utilitiesPct);
  const totalCost = round2(materialCost + laborCost + logisticsCost + utilitiesCost);
  const price = round2(totalCost / (1 - RATES.marginPct));
  const margin = round2(price - totalCost);

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
    marginMode: RATES.marginMode,
    marginPct: RATES.marginPct,
    marginOfPricePct: price > 0 ? round2((margin / price) * 100) : 0,
    markupPct: totalCost > 0 ? round2((margin / totalCost) * 100) : 0,
  };
}

/** trimFloat — как String(number) в JS: «35», не «35.00» */
const trimFloat = (n: number): string => String(n);

/** pctFormula: ставки в Costing не передаются (rates=nil), процент выводится из факта */
function pctFormula(value: number, base: number): string {
  const shown = base > 0 ? (value / base) * 100 : 0;
  return `материалы × ${trimFloat(round2(shown))} %`;
}

interface ExplainLine { label: string; value: number; unit: string; source?: string; formula?: string }

/** ExplainCosting — «разбор формулы» вместо =IF(IFERROR(VLOOKUP(...))) */
function explainCosting(result: CostingResult, approvedPrice: number) {
  const lines: ExplainLine[] = [{ label: 'Материалы', value: result.materialCost, unit: '₸', source: 'bom' }];
  for (const s of result.stages) {
    lines.push({
      label: STAGE_LABEL[s.stage],
      value: s.stageCost,
      unit: '₸',
      source: 'routing',
      formula: `${trimFloat(s.workers)} чел × ${trimFloat(s.hoursPerUnit)} ч × ${trimFloat(s.hourlyRate)} ₸/час`,
    });
  }
  lines.push(
    { label: 'Логистика', value: result.logisticsCost, unit: '₸', source: 'costingConfig', formula: pctFormula(result.logisticsCost, result.materialCost) },
    { label: 'Вода / газ / электричество', value: result.utilitiesCost, unit: '₸', source: 'costingConfig', formula: pctFormula(result.utilitiesCost, result.materialCost) },
    { label: 'Себестоимость', value: result.totalCost, unit: '₸' },
    { label: 'Маржа', value: result.margin, unit: '₸', formula: `${trimFloat(round2(result.marginPct * 100))} % от цены` },
    { label: 'Расчётная цена', value: result.price, unit: '₸' },
  );

  const priceCheck = approvedPrice > 0 && result.price > 0
    ? {
      approvedPrice,
      deviationPct: round2(((approvedPrice - result.price) / result.price) * 100),
      belowCost: approvedPrice < result.totalCost,
    }
    : null;

  return {
    lines,
    totalManHours: result.totalManHours,
    priceCheck,
    // Обе трактовки процента рядом — иначе «35 %» читается как угодно (09 §3.2)
    marginSummary: {
      mode: result.marginMode,
      pct: round2(result.marginPct * 100),
      marginOfPricePct: result.marginOfPricePct,
      markupPct: result.markupPct,
      label: `маржа ${trimFloat(result.marginOfPricePct)} % от цены = наценка ${trimFloat(result.markupPct)} %`,
    },
  };
}

/** ActualDeviationPct — отклонение факта от нормы; null — факта нет */
function actualDeviationPct(normManHours: number, aw: number | null, ah: number | null): number | null {
  if (aw == null || ah == null || normManHours <= 0) return null;
  return round2(((aw * ah - normManHours) / normManHours) * 100);
}

// ---------------------------------------------------------------------------
// Справочник изделий — 60 реальных карточек, порядок как в Postgres (ORDER BY name)
// ---------------------------------------------------------------------------

interface ArtSeed {
  code: string;
  name: string;
  /** approved_price: 0 — цена не утверждена (в базе таких 92 %) */
  price: number;
  weight?: number;
  legacy?: string;
  /** сколько позиций в составе */
  bom: number;
  /** масштаб расхода; без него берётся bomScale(bom) */
  scale?: number;
}

/**
 * Артикулы, названия, веса и утверждённые цены — из таблицы articles как
 * есть. Первые три по алфавиту (подстанция и два модульных здания) держат
 * БОЛЬШОЙ состав: именно на них смотрят, влезает ли длинное название
 * материала в строку состава.
 *
 * Два отступления от базы, оба намеренные:
 *   • z-227 и z-027 получили утверждённую цену (в базе она 0, как у 92 %
 *     каталога) — иначе на первом же открытом экране блок «утверждённая
 *     цена против расчёта» приходит пустым и рисовать его не по чему;
 *   • scale подобран так, чтобы расчётная цена сошлась с утверждённой в
 *     пределах ±5 % там, где цена известна. Исключения оставлены нарочно:
 *     n-1247 и k-028 уходят ниже себестоимости — это и есть та самая
 *     «где завод теряет деньги» строка сводки прайса.
 */
const ARTICLE_SEEDS: readonly ArtSeed[] = [
  { code: 'z-227', name: '2КТПБ-2000/10-0,4кВ', price: 31500000, bom: 34, scale: 46 },
  { code: 'z-027', name: 'БМЗ 9,0х2,8х2,6м', price: 21800000, bom: 29, scale: 47 },
  { code: 'z-447', name: 'БМК 6.0х2.4х2.7м', price: 0, bom: 24, scale: 35 },
  { code: 'z-185', name: 'БМК – 3,2 ГЖ-ТМ 10,0х7,2х2,8м', price: 0, bom: 18, scale: 33 },
  { code: 'z-258', name: 'Выносная площадка', price: 0, bom: 6 },
  { code: 'n-344', name: 'Горизонтальный кабель-рост с защитой, L=1600мм', price: 0, bom: 5 },
  { code: 'z-389', name: 'Доп работы САЦ', price: 0, bom: 3 },
  { code: 'n-574', name: 'Защита от подения на квадропод 10м, L=990мм', price: 0, bom: 4 },
  { code: 'z-244', name: 'Изготовление и монтаж Противопожарной насосной станции ТОО ПепсиКо', price: 0, bom: 14 },
  { code: 'z-119', name: 'Изготовление опорной конструкции по чертежам заказчика', price: 0, bom: 9 },
  { code: 'n-317', name: 'Кабельный мост 1,5м (без трубостойки)', price: 0, bom: 5 },
  { code: 'z-050', name: 'Казарма модульного типа для пограничного отделения «Кастек»', price: 0, bom: 22, scale: 70 },
  { code: 'n-179', name: 'Квадропод 10м', price: 1581977, bom: 12, scale: 6.5 },
  { code: 'm-007', name: 'Квадропод 11,6м', price: 2400000, weight: 2814.8, bom: 13, scale: 12.3 },
  { code: 'm-008', name: 'Квадропод 15м', price: 2525000, weight: 3112.53, legacy: 'w-011', bom: 14, scale: 10 },
  { code: 'm-009', name: 'Квадропод 18м на крыше', price: 2970000, weight: 3.74, bom: 15, scale: 10.1 },
  { code: 'n-455', name: 'Комплект для контейнера из сэндвич панелей 4,5х2,4х2,86', price: 0, bom: 20, scale: 5 },
  { code: 'n-595', name: 'Комплект лестницы с защитой от падения на Мачту 24м', price: 0, bom: 7 },
  { code: 'n-1142', name: 'Конструкция-2 (КН-2)', price: 0, bom: 4 },
  { code: 'n-1230', name: 'Контейнер  5х2м', price: 2296000, bom: 17, scale: 1 },
  { code: 'b-001', name: 'Контейнер технологический - ШЕЛТОР 0321 (3х2)', price: 1620000, weight: 1.54, legacy: 'w-056', bom: 16, scale: 1.1 },
  { code: 'b-003', name: 'Контейнер технологический - ШЕЛТОР 0415 (3,4х2,4)', price: 1772815, weight: 1.63, legacy: 'w-012', bom: 18, scale: 1.6 },
  { code: 'b-015', name: 'Контейнер технологический - Шелтор 0123 (3х2)', price: 1453500, weight: 1.57, bom: 15, scale: 4.5 },
  { code: 'n-027', name: 'Крепление двухфланцевой коробки к трубе из уголка 75х5 L=190мм', price: 0, bom: 3 },
  { code: 'n-749', name: 'Крепление трубостойки к мачте, L=400мм/327мм', price: 0, bom: 3 },
  { code: 'z-175', name: 'Кронштейн 1,5х0,3м', price: 0, bom: 4 },
  { code: 'n-1262', name: 'Лестница L-2', price: 64200, bom: 5, scale: 0.55 },
  { code: 'z-057', name: 'Лестница и ограждение', price: 0, bom: 6 },
  { code: 'm-001', name: 'МК 18,5м', price: 2100000, weight: 1833.18, legacy: 'w-001', bom: 13, scale: 13.1 },
  { code: 'm-002', name: 'МК 22м', price: 2423935, weight: 2538.18, legacy: 'w-002', bom: 14, scale: 6.8 },
  { code: 'm-003', name: 'МК 24,5м', price: 2700000, weight: 3073.45, legacy: 'w-003', bom: 15, scale: 8.2 },
  { code: 'm-004', name: 'МК 25м', price: 3000000, weight: 3110.69, legacy: 'w-004', bom: 16, scale: 6.9 },
  { code: 'n-201', name: 'Мачта М18м на пространственной раме', price: 2916500, bom: 12, scale: 11 },
  { code: 'm-016', name: 'Мачта М22м на пространственной раме (секция 6м)', price: 3400000, bom: 13, scale: 10.1 },
  { code: 'm-034', name: 'Мачта М24м на пространственной раме (секция 2м) в сборе', price: 3372500, bom: 14, scale: 11.6 },
  { code: 'm-035', name: 'Мачта М25м на пространственной раме (секция 2м) в сборе', price: 3439000, bom: 16, scale: 14.9 },
  { code: 'z-381', name: 'Метизы для ферм школы на 1200 учащихся (пятно 84, Блок 4)', price: 0, bom: 5 },
  { code: 'm-005', name: 'Монополь 15м', price: 1355160, weight: 1673.91, legacy: 'w-006', bom: 11, scale: 6.5 },
  { code: 'm-006', name: 'Монополь 17,4м ф133', price: 1537850, weight: 2037.86, legacy: 'w-007', bom: 12, scale: 5.9 },
  { code: 'z-333', name: 'Монтажный элемент. Адм.здание (пятно 4)', price: 0, bom: 4 },
  { code: 'n-1191', name: 'Ограждение 16000х16000х2500 (круг ф14)', price: 0, bom: 6 },
  { code: 'n-1312', name: 'Ограждение 6000х4400мм П-образная (Сетка рабица )', price: 0, bom: 5 },
  { code: 'm-031', name: 'Основание М18,5', price: 0, bom: 8 },
  { code: 'z-040', name: 'ПВЛ 1033х908мм (H1-2)', price: 0, bom: 2 },
  { code: 'd-028', name: 'Пластина (Фасонка) 80х6 L=300мм', price: 0, bom: 2 },
  { code: 'n-710', name: 'Пластина 150х150х8мм', price: 0, bom: 2 },
  { code: 'z-055', name: 'Пластина 200х200х8мм (под анкер М12)', price: 0, bom: 3 },
  { code: 'n-983', name: 'Пластина 300х120х1,8мм', price: 0, bom: 2 },
  { code: 'n-1349', name: 'Пластина 400х400х20мм', price: 0, bom: 2 },
  { code: 'n-926', name: 'Пластина регулировочная 200х200х4мм', price: 0, bom: 2 },
  { code: 'n-357', name: 'Полоса 50х4х2200 мм', price: 0, bom: 2 },
  { code: 'm-010', name: 'Пригр. Опора МК 30м без корзины', price: 5600000, weight: 6.59, legacy: 'w-008', bom: 17, scale: 17.9 },
  { code: 'm-011', name: 'Пригр. Опора МК 35м с корзиной', price: 6400000, weight: 7.8, legacy: 'w-009', bom: 19, scale: 29.5 },
  { code: 'm-012', name: 'Пригруженная Монополь 18,2м (секция 2м)', price: 3370000, legacy: 'w-054', bom: 13, scale: 16 },
  { code: 'm-023', name: 'Разгрузочная рама под монополь на морской контейнер', price: 312250, legacy: 'w-062', bom: 7, scale: 9.6 },
  { code: 'n-1247', name: 'Стяжной хомут ФБС блока (пз. B4) Б-30 Р-50.50', price: 4813, bom: 4, scale: 0.1 },
  { code: 't-007', name: 'Трубостойка Ø89х3,5мм L3000mm', price: 0, bom: 3 },
  { code: 'n-875', name: 'Уголок 63х63х5мм, L=1800мм', price: 0, bom: 2 },
  { code: 'k-028', name: 'Швеллерная балка L500 mm под трубу Ф76-76', price: 5705, weight: 0.006, legacy: 'w-038', bom: 3, scale: 0.15 },
  { code: 'd-019', name: 'Электрод заземления ф18 оц L=2000мм', price: 0, bom: 3 },
];

/**
 * У кого посчитана себестоимость (spec_price > 0). В настоящей базе это
 * всего 2 карточки из 2 152 — здесь их 12, иначе экран «Прайс» и блок
 * «где тонко» нечем показать: сравнивать было бы не с чем.
 */
const HAS_SPEC = new Set(['z-227', 'z-027', 'z-447', 'n-179', 'm-007', 'm-035', 'n-1247', 'k-028', 'n-1262', 'b-003', 'm-023', 'm-012']);

/** Настоящий масштаб каталога — из базы: 2 152 изделия, 176 с ценой */
const REAL_TOTAL = 2152;
const REAL_PRICED = 176;

// ---------------------------------------------------------------------------
// Сборка: состав, нормы, калькуляция
// ---------------------------------------------------------------------------

interface BomLine { id: string; mat: MatSeed; qty: number; op: string }

interface Article {
  seed: ArtSeed;
  id: string;
  bom: BomLine[];
  norms: Norm[];
  /** факт из цеха по переделам (может отсутствовать) */
  actuals: Partial<Record<Stage, { workers: number; hours: number }>>;
  notes: Partial<Record<Stage, string>>;
  createdAt: string;
  updatedAt: string;
  materialCost: number;
  costing: CostingResult;
  specPrice: number;
  priceDeviationPct: number;
}

/**
 * Масштаб расхода по размеру изделия. Пластина 400х400 и казарма берут
 * материал в разных порядках величины: у первой это 0,2 м2 листа, у второй
 * — 822 м2 сэндвич-панели (обе цифры из настоящих спецификаций). Там, где
 * настоящая себестоимость известна, масштаб задан в самом seed (поле scale),
 * чтобы расчёт не расходился с утверждённой ценой на порядок.
 */
function bomScale(size: number): number {
  if (size >= 20) return 20;
  if (size >= 16) return 4;
  if (size >= 12) return 3;
  if (size >= 8) return 1.6;
  if (size >= 5) return 0.9;
  return 0.3;
}

/** Расход на единицу — правдоподобный для единицы измерения и размера изделия */
function qtyFor(m: MatSeed, factor: number, rnd: () => number): number {
  const r = rnd();
  switch (m.unit) {
    case 'м':
      return round3((0.4 + r * 7) * factor);
    case 'м2':
      return round3((0.2 + r * 4) * factor);
    case 'м3':
      return round3((0.05 + r * 0.9) * factor);
    case 'кг':
      return round3((0.2 + r * 9) * factor);
    case 'л':
      return round3((0.15 + r * 3) * factor);
    default:
      // Штучные (двери, светильники, модули) растут медленнее — по корню
      return Math.max(1, Math.round((0.5 + r * 4) * Math.sqrt(factor)));
  }
}

/**
 * Состав изделия. Первые три карточки набирают позиции из «строительной»
 * части справочника (панели, профнастил, ЦСП, двери, водосток) — как в
 * настоящих спецификациях модульных зданий; остальные берут метал и
 * метизы.
 */
function buildBom(seed: ArtSeed, index: number): BomLine[] {
  const rnd = mulberry32(fnv(`bom:${seed.code}`));
  const buildingLike = index < 4 || seed.code === 'z-050' || seed.code === 'n-455' || seed.code.startsWith('b-') || seed.name.startsWith('Контейнер');
  const pool = MATERIALS.filter((m) => (buildingLike ? true : m.cat === 'Металл' || m.cat === 'Метизы' || m.cat === 'Расходники'));

  // Детерминированная перестановка пула — состав стабилен между перезагрузками
  const order = pool.map((m, i) => ({ m, k: rnd() + (buildingLike && m.cat === 'Комплектующие' ? -0.35 : 0) + i * 1e-6 }));
  order.sort((a, b) => a.k - b.k);

  const factor = seed.scale ?? bomScale(seed.bom);
  const lines: BomLine[] = [];
  for (const { m } of order.slice(0, seed.bom)) {
    const op = opTypeOf(m);
    lines.push({ id: uuid('bom', seed.code, m.code, op), mat: m, qty: qtyFor(m, factor, rnd), op });
  }
  // Крупные позиции сверху — GetBom сортирует ORDER BY line_cost DESC
  return lines;
}

/**
 * Нормы труда. Заполнены не у всех: экран обязан честно показывать
 * «Норма не задана» — иначе не видно, что себестоимость труда встанет в ноль.
 */
function buildNorms(seed: ArtSeed, index: number): { norms: Norm[]; actuals: Article['actuals']; notes: Article['notes'] } {
  const rnd = mulberry32(fnv(`norm:${seed.code}`));
  const norms: Norm[] = [];
  const actuals: Article['actuals'] = {};
  const notes: Article['notes'] = {};

  // Первая карточка — норма из базы для n-182: 3 чел × 23 ч на участке Резка-1
  if (index === 0) {
    norms.push({ stage: 'CUTTING', workers: 3, hoursPerUnit: 23, wcCode: 'CUT-1' });
    norms.push({ stage: 'ASSEMBLY', workers: 4, hoursPerUnit: 36, wcCode: 'ASM-1' });
    norms.push({ stage: 'PAINTING', workers: 2, hoursPerUnit: 11.5, wcCode: 'PNT-1' });
    actuals.CUTTING = { workers: 3, hours: 25.5 };
    actuals.ASSEMBLY = { workers: 4, hours: 33 };
    notes.ASSEMBLY = 'Обшивка идёт вместе со сваркой каркаса — считаем одним переделом';
    return { norms, actuals, notes };
  }

  const size = seed.bom;
  const filled = size >= 8 ? 3 : size >= 4 ? 2 : rnd() < 0.5 ? 1 : 0;
  const base = size >= 16 ? 12 : size >= 8 ? 3 : size >= 4 ? 0.6 : 0.08;

  for (let i = 0; i < filled; i++) {
    const stage = STAGES[i];
    const workers = stage === 'ASSEMBLY' ? 1 + Math.floor(rnd() * 4) : 1 + Math.floor(rnd() * 2);
    const factor = stage === 'CUTTING' ? 0.6 : stage === 'ASSEMBLY' ? 1 : 0.3;
    const hours = round3(base * factor * (0.7 + rnd() * 0.8));
    const wcCode = rnd() < 0.72 ? (stage === 'CUTTING' ? 'CUT-1' : stage === 'PAINTING' ? 'PNT-1' : rnd() < 0.5 ? 'ASM-1' : 'ASM-2') : null;
    norms.push({ stage, workers, hoursPerUnit: hours, wcCode });

    if (rnd() < 0.4) {
      actuals[stage] = { workers, hours: round3(hours * (0.82 + rnd() * 0.5)) };
    }
  }
  if (rnd() < 0.18 && norms.length > 0) {
    notes[norms[0].stage] = 'Норма снята с партии 12 шт — на единичном заказе уходит дольше';
  }
  return { norms, actuals, notes };
}

/** Порядок как в Postgres: ORDER BY name ASC, коллация C (байтовая) */
const SORTED_SEEDS = [...ARTICLE_SEEDS].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const ARTICLES: Article[] = SORTED_SEEDS.map((seed, index) => {
  const bom = buildBom(seed, index);
  const { norms, actuals, notes } = buildNorms(seed, index);
  const materialCost = bom.reduce((s, l) => s + l.qty * l.mat.price, 0);
  const costing = calcCosting(materialCost, norms);
  const specPrice = HAS_SPEC.has(seed.code) ? costing.price : 0;
  const priceDeviationPct = specPrice > 0 && seed.price > 0 ? round2(((seed.price - specPrice) / specPrice) * 100) : 0;
  return {
    seed,
    id: uuid('article', seed.code),
    bom,
    norms,
    actuals,
    notes,
    createdAt: dayIso(13 + (index % 5)),
    updatedAt: atHours(-(6 + index * 3)),
    materialCost,
    costing,
    specPrice,
    priceDeviationPct,
  };
});

const BY_ID = new Map<string, Article>(ARTICLES.map((a) => [a.id, a]));
const BY_CODE = new Map<string, Article>(ARTICLES.map((a) => [a.seed.code, a]));

/** Правки состава из BomPanel живут до перезагрузки страницы */
const bomEdits = new Map<string, number>();
const bomRemoved = new Set<string>();

function linesOf(a: Article): BomLine[] {
  return a.bom.filter((l) => !bomRemoved.has(l.id)).map((l) => ({ ...l, qty: bomEdits.get(l.id) ?? l.qty }));
}

function materialCostOf(a: Article): number {
  return linesOf(a).reduce((s, l) => s + l.qty * l.mat.price, 0);
}

function costingOf(a: Article): CostingResult {
  return calcCosting(materialCostOf(a), a.norms);
}

// ---------------------------------------------------------------------------
// Формы ответов
// ---------------------------------------------------------------------------

/** bomItemOut: материал вложен целиком, Decimal-поля строками */
function bomItemJson(a: Article, l: BomLine): Record<string, unknown> {
  return {
    id: l.id,
    articleId: a.id,
    materialId: uuid('material', l.mat.code),
    qtyPerUnit: dec(l.qty, 4),
    operationType: l.op,
    laborHours: '0',
    lineCost: dec(round2(l.qty * l.mat.price), 2),
    material: materialJson(l.mat),
  };
}

/** models.Article */
function articleJson(a: Article): Record<string, unknown> {
  return {
    id: a.id,
    articleCode: a.seed.code,
    legacyCode: a.seed.legacy ?? null,
    name: a.seed.name,
    weightKg: dec(a.seed.weight ?? 0, 3),
    series: null,
    description: null,
    approvedPrice: dec(a.seed.price, 2),
    isMaterialResale: false,
    specPrice: dec(a.specPrice, 2),
    priceDeviationPct: dec(a.priceDeviationPct, 2),
    leadTimeDays: '0',
    palletCapacity: '0',
    isActive: true,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** articleOut = models.Article + bomItems (список отдаёт состав вместе с карточкой) */
function articleOut(a: Article): Record<string, unknown> {
  return { ...articleJson(a), bomItems: linesOf(a).map((l) => bomItemJson(a, l)) };
}

/** history цен: у большинства карточек пусто — цену меняли только через пересмотр */
function priceHistoryOf(a: Article): Array<Record<string, unknown>> {
  if (!(a.seed.price > 0)) return [];
  const rnd = mulberry32(fnv(`ph:${a.seed.code}`));
  const count = 1 + Math.floor(rnd() * 2);
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: uuid('price-history', a.seed.code, i),
      articleId: a.id,
      price: dec(round2(a.seed.price * (1 - 0.06 * (count - i))), 2),
      validFrom: dayIso(60 + i * 120),
      changedBy: i === 0 ? 'Директор' : 'Прайс 2025',
    });
  }
  return out;
}

/** stageOut из GetRouting: все три передела всегда в ответе */
function routingStages(a: Article) {
  return STAGES.map((stage) => {
    const norm = a.norms.find((n) => n.stage === stage);
    const exists = !!norm;
    const workers = norm?.workers ?? 0;
    const hours = norm?.hoursPerUnit ?? 0;
    const wc = norm?.wcCode ? WC_BY_CODE.get(norm.wcCode) : undefined;
    const rate = rateForStage(stage, norm?.wcCode ?? null);
    const manHours = workers * hours;
    const act = a.actuals[stage];
    return {
      stage,
      label: STAGE_LABEL[stage],
      exists,
      workers,
      hoursPerUnit: hours,
      workCenter: wc ? { id: uuid('wc', wc.code), code: wc.code, name: wc.name, hourlyRate: rate } : null,
      hourlyRate: rate,
      manHours: round3(manHours),
      stageCost: round2(manHours * rate),
      actualWorkers: act ? act.workers : null,
      actualHours: act ? act.hours : null,
      actualDeviationPct: actualDeviationPct(round3(manHours), act ? act.workers : null, act ? act.hours : null),
      notes: a.notes[stage] ?? null,
      updatedAt: exists ? a.updatedAt : null,
    };
  });
}

/** routingOperationOut: Decimal-поля строками, стадия в API-коде */
function operationJson(a: Article, stage: Stage): Record<string, unknown> {
  const norm = a.norms.find((n) => n.stage === stage);
  const act = a.actuals[stage];
  return {
    id: uuid('routing-op', a.seed.code, stage),
    articleId: a.id,
    stage,
    sortOrder: STAGES.indexOf(stage),
    workers: dec(norm?.workers ?? 0, 2),
    hoursPerUnit: dec(norm?.hoursPerUnit ?? 0, 3),
    actualWorkers: act ? dec(act.workers, 2) : null,
    actualHours: act ? dec(act.hours, 3) : null,
    workCenterId: norm?.wcCode ? uuid('wc', norm.wcCode) : null,
    notes: a.notes[stage] ?? null,
    updatedAt: NOW.toISOString(),
    updatedById: DESIGN_USER_ID,
  };
}

// ---------------------------------------------------------------------------
// «Где применяется» — активные заказы с этим артикулом
// ---------------------------------------------------------------------------

const USAGE_CUSTOMERS = [
  'Аврора Сервис, ТОО',
  'Аврора 75, ТОО',
  'Казахтелеком, АО',
  'Kazakhstan Tower Company (Казахстан Тауэр Компани), ТОО',
  'LVE Group, ТОО',
  'IDA INTERTASCO JV, ТОО',
  'Greystone Construction, ТОО',
  'КаР-Тел, ТОО',
];
const USAGE_STATUSES = ['DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP'];

function usageOf(a: Article) {
  const rnd = mulberry32(fnv(`usage:${a.seed.code}`));
  const count = a.seed.price > 0 ? 1 + Math.floor(rnd() * 5) : Math.floor(rnd() * 4);
  const orders = [];
  for (let i = 0; i < count; i++) {
    const hasDate = rnd() < 0.8;
    orders.push({
      orderId: uuid('order', a.seed.code, i),
      orderNumber: `Т7АА-${String(140 + Math.floor(rnd() * 9800)).padStart(6, '0')}`,
      customer: USAGE_CUSTOMERS[Math.floor(rnd() * USAGE_CUSTOMERS.length)],
      status: USAGE_STATUSES[Math.floor(rnd() * USAGE_STATUSES.length)],
      qty: Math.max(1, Math.round(rnd() * (a.seed.bom > 14 ? 4 : 40))),
      plannedShipmentDate: hasDate ? dayIso(-(2 + Math.floor(rnd() * 48))) : null,
    });
  }
  // Без даты отгрузки — в конец, остальные по возрастанию даты
  orders.sort((x, y) => {
    if (x.plannedShipmentDate == null) return y.plannedShipmentDate == null ? 0 : 1;
    if (y.plannedShipmentDate == null) return -1;
    return x.plannedShipmentDate < y.plannedShipmentDate ? -1 : 1;
  });
  const totalQty = orders.reduce((s, o) => s + o.qty, 0);
  const nearest = orders.find((o) => o.plannedShipmentDate != null);
  return {
    articleId: a.id,
    ordersCount: orders.length,
    linesCount: orders.length + Math.floor(orders.length / 2),
    totalQty,
    nearestShipment: nearest ? { orderNumber: nearest.orderNumber, date: nearest.plannedShipmentDate } : null,
    orders: orders.slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// Истории: нормы и снимки калькуляции
// ---------------------------------------------------------------------------

const NORM_REASONS: Array<string | null> = [
  'Факт из цеха принят как норму',
  'Пересмотр после перевода на участок Сварка-2',
  'Уточнили по хронометражу партии',
  null,
];

function normHistoryOf(a: Article) {
  const rnd = mulberry32(fnv(`nhist:${a.seed.code}`));
  const out: Array<Record<string, unknown>> = [];
  a.norms.forEach((n, i) => {
    const count = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < count; k++) {
      out.push({
        id: uuid('norm-history', a.seed.code, n.stage, k),
        operationId: uuid('routing-op', a.seed.code, n.stage),
        workers: dec(k === 0 ? n.workers : Math.max(1, n.workers - (k % 2)), 2),
        hoursPerUnit: dec(k === 0 ? n.hoursPerUnit : round3(n.hoursPerUnit * (1 + 0.12 * k)), 3),
        changedAt: atHours(-(9 + i * 26 + k * 71)),
        changedById: k % 2 === 0 ? DESIGN_USER_ID : null,
        reason: NORM_REASONS[Math.floor(rnd() * NORM_REASONS.length)],
        operation: { stage: n.stage },
      });
    }
  });
  out.sort((x, y) => (String(x.changedAt) < String(y.changedAt) ? 1 : -1));
  return out.slice(0, 100);
}

const TRIGGERS = ['bom_change', 'routing_change', 'manual', 'material_price'];

function costingHistoryOf(a: Article) {
  const rnd = mulberry32(fnv(`chist:${a.seed.code}`));
  const now = costingOf(a);
  const count = a.norms.length === 0 ? 1 : 2 + Math.floor(rnd() * 4);
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const drift = i === 0 ? 1 : 1 - (0.03 + rnd() * 0.09) * i;
    out.push({
      id: uuid('costing', a.seed.code, i),
      articleId: a.id,
      calculatedAt: atHours(-(5 + i * 47 + Math.floor(rnd() * 12))),
      materialCost: dec(round2(now.materialCost * drift), 2),
      laborCost: dec(round2(now.laborCost * drift), 2),
      totalManHours: dec(round3(now.totalManHours * (i === 0 ? 1 : 0.94 + rnd() * 0.12)), 3),
      logisticsCost: dec(round2(now.logisticsCost * drift), 2),
      utilitiesCost: dec(round2(now.utilitiesCost * drift), 2),
      totalCost: dec(round2(now.totalCost * drift), 2),
      margin: dec(round2(now.margin * drift), 2),
      price: dec(round2(now.price * drift), 2),
      marginMode: 'MARGIN',
      marginPct: '0.35',
      logisticsPct: '0.03',
      trigger: i === 0 ? 'bom_change' : TRIGGERS[Math.floor(rnd() * TRIGGERS.length)],
      triggeredById: DESIGN_USER_ID,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Пересмотр цен (§3.4) и заявки на номенклатуру
// ---------------------------------------------------------------------------

interface Review {
  id: string;
  code: string;
  reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdHoursAgo: number;
  decidedHoursAgo?: number;
  newPrice?: number;
  comment?: string;
}

const REVIEWS: Review[] = [
  { id: uuid('review', 1), code: 'n-1247', reason: 'Цена 2024 года, металл с тех пор подорожал на треть', status: 'PENDING', createdHoursAgo: 26 },
  { id: uuid('review', 2), code: 'k-028', reason: 'Расчёт по спецификации выше утверждённой цены — работаем в минус', status: 'PENDING', createdHoursAgo: 51 },
  { id: uuid('review', 3), code: 'n-1262', reason: null, status: 'PENDING', createdHoursAgo: 8 },
  { id: uuid('review', 4), code: 'm-023', reason: 'Заказчик просит зафиксировать цену на год', status: 'APPROVED', createdHoursAgo: 196, decidedHoursAgo: 170, newPrice: 348000, comment: 'Согласовано с учётом объёма 24 шт' },
  { id: uuid('review', 5), code: 'm-012', reason: 'Пересчёт после смены поставщика трубы', status: 'REJECTED', createdHoursAgo: 340, decidedHoursAgo: 300, comment: 'Ждём подтверждения цены трубы от снабжения' },
];

function reviewJson(r: Review, withPrices: boolean): Record<string, unknown> {
  const a = BY_CODE.get(r.code);
  const approved = a ? a.seed.price : 0;
  const calculated = a ? (a.specPrice > 0 ? a.specPrice : costingOf(a).price) : 0;
  const deviation = calculated > 0 ? round2(((approved - calculated) / calculated) * 100) : 0;
  return {
    id: r.id,
    articleId: a ? a.id : uuid('article', r.code),
    calculatedPrice: dec(calculated, 2),
    approvedPrice: dec(approved, 2),
    deviationPct: dec(deviation, 2),
    reason: r.reason,
    status: r.status,
    requestedById: DESIGN_USER_ID,
    createdAt: atHours(-r.createdHoursAgo),
    decidedById: r.decidedHoursAgo != null ? DESIGN_USER_ID : null,
    decidedAt: r.decidedHoursAgo != null ? atHours(-r.decidedHoursAgo) : null,
    newPrice: r.newPrice != null ? dec(r.newPrice, 2) : null,
    decisionComment: r.comment ?? null,
    article: withPrices
      ? { articleCode: r.code, name: a ? a.seed.name : r.code, specPrice: dec(a ? a.specPrice : 0, 2), approvedPrice: dec(approved, 2) }
      : { articleCode: r.code, name: a ? a.seed.name : r.code },
  };
}

interface NomReq {
  id: string;
  proposedName: string;
  series: string | null;
  description: string | null;
  reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WAITING_1C';
  requestedBy: string;
  createdHoursAgo: number;
  decidedHoursAgo?: number;
  comment?: string;
  articleCode?: string;
  onecCode?: string;
}

const NOM_REQUESTS: NomReq[] = [
  {
    id: uuid('nreq', 1), proposedName: 'Кронштейн крепления антенны к монополю ф133, L=850мм', series: 'n',
    description: 'Уголок 63х5, две пластины 120х120х8, оцинковка', reason: 'В заказе Т7АА-004182 позиции нет в справочнике',
    status: 'PENDING', requestedBy: 'Инженер ПТО', createdHoursAgo: 5,
  },
  {
    id: uuid('nreq', 2), proposedName: 'Площадка обслуживания 1200х900 с ограждением на мачту М24', series: 'n',
    description: null, reason: 'Продажник обещал заказчику, артикул нужен сегодня', status: 'PENDING',
    requestedBy: 'Менеджер по продажам', createdHoursAgo: 31,
  },
  {
    id: uuid('nreq', 3), proposedName: 'Ограждение антивандальное 6000х4400 (сетка рабица, калитка)', series: 'z',
    description: 'Аналог z-034, но с калиткой', reason: null, status: 'WAITING_1C', requestedBy: 'Инженер ПТО',
    createdHoursAgo: 76, onecCode: 'z-0512',
  },
  {
    id: uuid('nreq', 4), proposedName: 'Стяжной хомут ФБС блока Б-30 Р-50.50 (усиленный)', series: 'n',
    description: null, reason: 'Заказчик просит усиленное исполнение', status: 'APPROVED', requestedBy: 'Планировщик',
    createdHoursAgo: 190, decidedHoursAgo: 160, comment: 'Присвоен n-1361', articleCode: 'n-1361',
  },
  {
    id: uuid('nreq', 5), proposedName: 'Труба профильная 40х20 (нарезка)', series: null, description: null,
    reason: 'Нужно продать остатки', status: 'REJECTED', requestedBy: 'Менеджер по продажам', createdHoursAgo: 260,
    decidedHoursAgo: 240, comment: 'Это материал, а не изделие — продаём через перепродажу сырья',
  },
];

function nomReqJson(r: NomReq): Record<string, unknown> {
  return {
    id: r.id,
    proposedName: r.proposedName,
    series: r.series,
    description: r.description,
    reason: r.reason,
    status: r.status,
    requestedBy: r.requestedBy,
    createdAt: atHours(-r.createdHoursAgo),
    decidedBy: r.decidedHoursAgo != null ? 'Инженер ПТО' : null,
    decidedAt: r.decidedHoursAgo != null ? atHours(-r.decidedHoursAgo) : null,
    decisionComment: r.comment ?? null,
    articleId: r.articleCode ? uuid('article', r.articleCode) : null,
    onecCode: r.onecCode ?? null,
    onecName: r.onecCode ? r.proposedName : null,
    onecGuid: r.onecCode ? uuid('1c-guid', r.id) : null,
    onecUnit: r.onecCode ? 'шт' : null,
    linkedMaterialId: null,
    syncedAt: r.onecCode ? atHours(-(r.createdHoursAgo - 12)) : null,
    slaDueAt: atHours(-r.createdHoursAgo + 48),
    bitrixTaskId: r.status === 'PENDING' ? String(41200 + Number(r.createdHoursAgo)) : null,
    bitrixTaskCreatedAt: r.status === 'PENDING' ? atHours(-r.createdHoursAgo + 0.2) : null,
    article: r.articleCode ? { articleCode: r.articleCode, name: r.proposedName } : null,
  };
}

// ---------------------------------------------------------------------------
// Сводка прайса
// ---------------------------------------------------------------------------

/**
 * PriceDigest. total и priced — настоящие цифры базы (2 152 и 176);
 * withSpec/comparable/belowCost и «где тонко» считаются по 60 показанным
 * карточкам — в базе расчёт есть у двух изделий, и блок был бы пустым.
 */
function priceDigest() {
  const withSpecList = ARTICLES.filter((a) => a.specPrice > 0);
  const comparable = withSpecList.filter((a) => a.seed.price > 0);
  const belowCost = comparable.filter((a) => a.seed.price < a.specPrice);
  const thinnest = [...comparable]
    .sort((x, y) => (x.seed.price - x.specPrice) / x.specPrice - (y.seed.price - y.specPrice) / y.specPrice)
    .slice(0, 6)
    .map((a) => ({
      id: a.id,
      articleCode: a.seed.code,
      name: a.seed.name,
      approvedPrice: dec(a.seed.price, 2),
      specPrice: dec(a.specPrice, 2),
      deviationPct: dec(a.priceDeviationPct, 2),
    }));
  return {
    total: REAL_TOTAL,
    priced: REAL_PRICED,
    withSpec: withSpecList.length,
    comparable: comparable.length,
    belowCost: belowCost.length,
    thinnest,
  };
}

// ---------------------------------------------------------------------------
// Разбор пути и поиск изделия
// ---------------------------------------------------------------------------

/** /articles/<id>/... — изделие по id; неизвестный id отдаёт первое, чтобы экран не пустовал */
function articleFromPath(path: string): Article {
  const id = seg(path)[1] ?? '';
  return BY_ID.get(id) ?? BY_CODE.get(id) ?? ARTICLES[0];
}

function stageFromPath(path: string, at: number): Stage {
  const s = seg(path)[at];
  return (STAGES as readonly string[]).includes(s) ? (s as Stage) : 'CUTTING';
}

// ---------------------------------------------------------------------------
// Маршруты. Порядок важен: специфичные — выше общих
// ---------------------------------------------------------------------------

export const routes: FixtureRoute[] = [
  // ---------- Очереди работы инженера (строго до /articles/:id) ----------
  {
    method: 'GET',
    match: /^\/articles\/gaps$/,
    handler: () => {
      // Считаем по тем же данным, что отдаёт список: иначе пилюля обещала
      // бы одно число, а список показывал другое — и разошлись бы уже
      // внутри режима дизайна (04.09.2026)
      const noBom = (a: typeof ARTICLES[number]) => a.bom.length === 0;
      const noNorms = (a: typeof ARTICLES[number]) => a.norms.length === 0;
      return {
        total: ARTICLES.length,
        nobom: ARTICLES.filter(noBom).length,
        nonorms: ARTICLES.filter(noNorms).length,
        noprice: ARTICLES.filter((a) => !(a.seed.price > 0)).length,
        empty: ARTICLES.filter((a) => noBom(a) && noNorms(a)).length,
      };
    },
  },

  // ---------- Сводка прайса (строго до /articles/:id) ----------
  {
    method: 'GET',
    match: /^\/articles\/price-digest$/,
    handler: () => priceDigest(),
  },

  // ---------- Список изделий ----------
  {
    method: 'GET',
    match: /^\/articles$/,
    handler: ({ params }) => {
      const search = (params.get('search') ?? '').trim();
      const onlyPriced = params.get('onlyPriced') === 'true';

      let list = ARTICLES;
      if (onlyPriced) list = list.filter((a) => a.seed.price > 0);
      // Очередь работы инженера: те же условия, что в Go (gapWhere).
      // Без этого пилюли «Без состава» / «Без норм» в режиме дизайна
      // ничего не меняли, и проверить экран было нельзя (04.09.2026).
      const gap = params.get('gap');
      if (gap) {
        const noBom = (a: typeof ARTICLES[number]) => a.bom.length === 0;
        const noNorms = (a: typeof ARTICLES[number]) => a.norms.length === 0;
        if (gap === 'nobom') list = list.filter(noBom);
        else if (gap === 'nonorms') list = list.filter(noNorms);
        else if (gap === 'noprice') list = list.filter((a) => !(a.seed.price > 0));
        else if (gap === 'empty') list = list.filter((a) => noBom(a) && noNorms(a));
      }
      if (search) {
        const q = lc(search);
        list = list.filter((a) => lc(a.seed.code).includes(q) || lc(a.seed.name).includes(q) || lc(a.seed.legacy ?? '').includes(q));
      }

      const { data, page, pageSize } = pageOf(list, params, 50);
      // Настоящий масштаб каталога виден в пагинации: 2 152 изделия, 176 с
      // ценой. Но при поиске и в очереди работы total обязан считаться по
      // отфильтрованному: иначе пилюля обещает «Без состава 13», а
      // пагинация под списком пишет «из 2 152» (04.09.2026).
      const filtered = search || gap;
      const total = filtered ? list.length : onlyPriced ? REAL_PRICED : REAL_TOTAL;
      return { data: data.map(articleOut), meta: { page, pageSize, total } };
    },
  },

  // ---------- Состав: ГОЛЫЙ массив (из-за него и падал экран) ----------
  {
    method: 'GET',
    match: /^\/articles\/[^/]+\/bom$/,
    handler: ({ path }) => {
      const a = articleFromPath(path);
      return linesOf(a)
        .map((l) => ({ l, cost: l.qty * l.mat.price }))
        .sort((x, y) => y.cost - x.cost)
        .map(({ l }) => bomItemJson(a, l));
    },
  },
  {
    method: 'POST',
    match: /^\/articles\/[^/]+\/bom$/,
    handler: (ctx) => {
      const a = articleFromPath(ctx.path);
      const b = body(ctx);
      const matId = String(b.materialId ?? '');
      const mat = MATERIALS.find((m) => uuid('material', m.code) === matId) ?? MATERIALS[0];
      const op = typeof b.operationType === 'string' && b.operationType ? b.operationType : 'WELDING_ASSEMBLY';
      const qty = Number(b.qtyPerUnit) > 0 ? Number(b.qtyPerUnit) : 1;
      const id = uuid('bom', a.seed.code, mat.code, op);
      const existing = a.bom.find((l) => l.id === id);
      if (existing) {
        bomRemoved.delete(id);
        bomEdits.set(id, qty);
      } else {
        a.bom.push({ id, mat, qty, op });
      }
      return { item: bomItemJson(a, { id, mat, qty, op }), costing: costingOf(a) };
    },
  },
  {
    method: 'PUT',
    match: /^\/articles\/[^/]+\/bom$/,
    handler: (ctx) => {
      const a = articleFromPath(ctx.path);
      const b = body(ctx);
      const items = Array.isArray(b.items) ? (b.items as Array<Record<string, unknown>>) : [];
      const next: BomLine[] = [];
      for (const it of items) {
        const mat = MATERIALS.find((m) => uuid('material', m.code) === String(it.materialId)) ?? null;
        const qty = Number(it.qtyPerUnit);
        if (!mat || !(qty > 0)) continue;
        const op = typeof it.operationType === 'string' && it.operationType ? it.operationType : 'WELDING_ASSEMBLY';
        next.push({ id: uuid('bom', a.seed.code, mat.code, op), mat, qty, op });
      }
      a.bom = next;
      for (const l of next) {
        bomRemoved.delete(l.id);
        bomEdits.delete(l.id);
      }
      return { items: linesOf(a).map((l) => bomItemJson(a, l)), costing: costingOf(a) };
    },
  },

  // ---------- Нормы, факт, себестоимость ----------
  {
    method: 'GET',
    match: /^\/articles\/[^/]+\/routing$/,
    handler: ({ path }) => {
      const a = articleFromPath(path);
      return { articleId: a.id, rates: ratesJson(), stages: routingStages(a) };
    },
  },
  {
    method: 'GET',
    match: /^\/articles\/[^/]+\/routing\/history$/,
    handler: ({ path }) => normHistoryOf(articleFromPath(path)),
  },
  {
    method: 'GET',
    match: /^\/articles\/[^/]+\/routing\/usage$/,
    handler: ({ path }) => usageOf(articleFromPath(path)),
  },
  {
    method: 'GET',
    match: /^\/articles\/[^/]+\/routing\/costing\/history$/,
    handler: ({ path }) => costingHistoryOf(articleFromPath(path)),
  },
  {
    method: 'GET',
    match: /^\/articles\/[^/]+\/routing\/costing$/,
    handler: ({ path }) => {
      const a = articleFromPath(path);
      const result = costingOf(a);
      return { articleId: a.id, result, explain: explainCosting(result, a.seed.price) };
    },
  },
  {
    // Предпросмотр влияния правки нормы — ДО сохранения (§2.3 ④)
    method: 'POST',
    match: /^\/articles\/[^/]+\/routing\/costing\/preview$/,
    handler: (ctx) => {
      const a = articleFromPath(ctx.path);
      const b = body(ctx);
      const stage: Stage = (STAGES as readonly string[]).includes(String(b.stage)) ? (String(b.stage) as Stage) : 'CUTTING';
      const wc = WC_SEEDS.find((w) => uuid('wc', w.code) === String(b.workCenterId ?? ''));
      const proposedNorm: Norm = {
        stage,
        workers: Number(b.workers) || 0,
        hoursPerUnit: Number(b.hoursPerUnit) || 0,
        wcCode: wc ? wc.code : null,
      };
      const materialCost = materialCostOf(a);
      const current = calcCosting(materialCost, a.norms);
      const proposed = calcCosting(materialCost, [...a.norms.filter((n) => n.stage !== stage), proposedNorm]);

      const impactLine = (label: string, before: number, after: number, unit: string) => ({
        label,
        before,
        after,
        delta: round2(after - before),
        deltaPct: before !== 0 ? round2(((after - before) / before) * 100) : null,
        unit,
      });
      const impact = [
        impactLine('Трудоёмкость', current.totalManHours, proposed.totalManHours, 'чел/час'),
        impactLine('Себестоимость труда', current.laborCost, proposed.laborCost, '₸'),
        impactLine('Себестоимость', current.totalCost, proposed.totalCost, '₸'),
        impactLine('Расчётная цена', current.price, proposed.price, '₸'),
      ];

      const usage = usageOf(a);
      const rnd = mulberry32(fnv(`neg:${a.seed.code}`));
      const negative = usage.orders
        .map((o) => ({ orderNumber: o.orderNumber, customer: o.customer, unitPrice: round2((a.seed.price > 0 ? a.seed.price : proposed.price) * (0.72 + rnd() * 0.5)) }))
        .filter((o) => o.unitPrice > 0 && o.unitPrice < proposed.totalCost)
        .slice(0, 10)
        .map((o) => ({ ...o, newCost: proposed.totalCost }));

      return {
        articleId: a.id,
        current,
        proposed,
        impact,
        affected: {
          ordersCount: usage.ordersCount,
          linesCount: usage.linesCount,
          totalQty: usage.totalQty,
          negativeMarginCount: negative.length,
          negativeMarginOrders: negative,
        },
        // Утверждённая цена прайса не меняется — только через согласование директора (§3.4)
        approvedPrice: a.seed.price > 0 ? a.seed.price : null,
        approvedPriceUnchanged: true,
      };
    },
  },
  {
    method: 'POST',
    match: /^\/articles\/[^/]+\/routing\/recalculate$/,
    handler: ({ path }) => costingOf(articleFromPath(path)),
  },
  {
    method: 'POST',
    match: /^\/articles\/[^/]+\/routing\/[^/]+\/actual$/,
    handler: (ctx) => {
      const a = articleFromPath(ctx.path);
      const stage = stageFromPath(ctx.path, 3);
      const b = body(ctx);
      const workers = Number(b.actualWorkers) || 0;
      const hours = Number(b.actualHours) || 0;
      if (workers > 0 && hours > 0) a.actuals[stage] = { workers, hours };
      return operationJson(a, stage);
    },
  },
  {
    method: 'POST',
    match: /^\/articles\/[^/]+\/routing\/[^/]+\/promote$/,
    handler: (ctx) => {
      const a = articleFromPath(ctx.path);
      const stage = stageFromPath(ctx.path, 3);
      const act = a.actuals[stage];
      if (act) {
        const norm = a.norms.find((n) => n.stage === stage);
        if (norm) {
          norm.workers = act.workers;
          norm.hoursPerUnit = act.hours;
        } else {
          a.norms.push({ stage, workers: act.workers, hoursPerUnit: act.hours, wcCode: null });
        }
      }
      return { operation: operationJson(a, stage), costing: costingOf(a) };
    },
  },
  {
    method: 'PUT',
    match: /^\/articles\/[^/]+\/routing\/[^/]+$/,
    handler: (ctx) => {
      const a = articleFromPath(ctx.path);
      const stage = stageFromPath(ctx.path, 3);
      const b = body(ctx);
      const workers = Number(b.workers) || 0;
      const hours = Number(b.hoursPerUnit) || 0;
      const wc = WC_SEEDS.find((w) => uuid('wc', w.code) === String(b.workCenterId ?? ''));
      const norm = a.norms.find((n) => n.stage === stage);
      if (norm) {
        norm.workers = workers;
        norm.hoursPerUnit = hours;
        norm.wcCode = wc ? wc.code : null;
      } else {
        a.norms.push({ stage, workers, hoursPerUnit: hours, wcCode: wc ? wc.code : null });
        a.norms.sort((x, y) => STAGES.indexOf(x.stage) - STAGES.indexOf(y.stage));
      }
      if (typeof b.notes === 'string') a.notes[stage] = b.notes;
      return { operation: operationJson(a, stage), costing: costingOf(a) };
    },
  },

  // ---------- Заявка на пересмотр цены изделия ----------
  {
    method: 'POST',
    match: /^\/articles\/[^/]+\/price-review$/,
    handler: (ctx) => {
      const a = articleFromPath(ctx.path);
      const b = body(ctx);
      const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim() : null;
      const existing = REVIEWS.find((r) => r.code === a.seed.code && r.status === 'PENDING');
      if (existing) return reviewJson(existing, false);
      const r: Review = { id: uuid('review', `new:${a.seed.code}`), code: a.seed.code, reason, status: 'PENDING', createdHoursAgo: 0 };
      REVIEWS.unshift(r);
      return reviewJson(r, false);
    },
  },

  // ---------- Карточка изделия (после всех /articles/:id/*) ----------
  {
    method: 'GET',
    match: /^\/articles\/[^/]+$/,
    handler: ({ path }) => {
      const a = articleFromPath(path);
      return { ...articleJson(a), bomItems: linesOf(a).map((l) => bomItemJson(a, l)), priceHistory: priceHistoryOf(a) };
    },
  },
  {
    method: 'POST',
    match: /^\/articles$/,
    handler: (ctx) => {
      const b = body(ctx);
      const code = String(b.articleCode ?? 'n-0000');
      return {
        id: uuid('article', code),
        articleCode: code,
        legacyCode: b.legacyCode ?? null,
        name: String(b.name ?? 'Новое изделие'),
        weightKg: dec(Number(b.weightKg) || 0, 3),
        series: b.series ?? null,
        description: b.description ?? null,
        approvedPrice: '0',
        isMaterialResale: false,
        specPrice: '0',
        priceDeviationPct: '0',
        leadTimeDays: '0',
        palletCapacity: '0',
        isActive: true,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
    },
  },
  {
    method: 'PATCH',
    match: /^\/articles\/[^/]+$/,
    handler: (ctx) => {
      const a = articleFromPath(ctx.path);
      const b = body(ctx);
      if (typeof b.name === 'string' && b.name.trim()) a.seed = { ...a.seed, name: b.name.trim() };
      if (Number(b.approvedPrice) >= 0 && b.approvedPrice != null) a.seed = { ...a.seed, price: Number(b.approvedPrice) };
      a.updatedAt = NOW.toISOString();
      return articleJson(a);
    },
  },

  // ---------- Позиции состава ----------
  {
    method: 'PATCH',
    match: /^\/bom-items\/[^/]+$/,
    handler: (ctx) => {
      const id = seg(ctx.path)[1] ?? '';
      const b = body(ctx);
      const qty = Number(b.qtyPerUnit);
      const owner = ARTICLES.find((a) => a.bom.some((l) => l.id === id));
      const line = owner?.bom.find((l) => l.id === id);
      if (!owner || !line) return { id, qtyPerUnit: dec(qty > 0 ? qty : 1, 4) };
      if (qty > 0) bomEdits.set(id, qty);
      return bomItemJson(owner, { ...line, qty: bomEdits.get(id) ?? line.qty });
    },
  },
  {
    method: 'DELETE',
    match: /^\/bom-items\/[^/]+$/,
    handler: ({ path }) => {
      const id = seg(path)[1] ?? '';
      bomRemoved.add(id);
      return { deleted: true };
    },
  },

  // ---------- Участки и коэффициенты ----------
  {
    method: 'GET',
    match: /^\/work-centers$/,
    handler: () => WORK_CENTERS,
  },
  {
    method: 'GET',
    match: /^\/costing-config$/,
    handler: () => configJson(),
  },
  {
    method: 'PUT',
    match: /^\/costing-config$/,
    handler: (ctx) => {
      const b = body(ctx);
      const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
      return configJson({
        validFrom: NOW.toISOString(),
        hourlyRate: num(b.hourlyRate, CONFIG.hourlyRate),
        logisticsPct: num(b.logisticsPct, CONFIG.logisticsPct),
        utilitiesPct: num(b.utilitiesPct, CONFIG.utilitiesPct),
        vatPct: num(b.vatPct, CONFIG.vatPct),
        marginPct: num(b.marginPct, CONFIG.marginPct),
        paymentTermDays: num(b.paymentTermDays, CONFIG.paymentTermDays),
        rateCutting: num(b.rateCutting, CONFIG.rateCutting),
        rateAssembly: num(b.rateAssembly, CONFIG.rateAssembly),
        ratePainting: num(b.ratePainting, CONFIG.ratePainting),
      });
    },
  },

  // ---------- Пересмотр цен: очередь директора ----------
  {
    method: 'GET',
    match: /^\/price-reviews$/,
    handler: ({ params }) => {
      const status = params.get('status');
      const list = REVIEWS.filter((r) => !status || r.status === status);
      const { data, page, pageSize } = pageOf(list, params, 25);
      return { data: data.map((r) => reviewJson(r, true)), meta: { page, pageSize, total: list.length } };
    },
  },
  {
    method: 'POST',
    match: /^\/price-reviews\/[^/]+\/approve$/,
    handler: (ctx) => {
      const id = seg(ctx.path)[1] ?? '';
      const b = body(ctx);
      const r = REVIEWS.find((x) => x.id === id) ?? REVIEWS[0];
      r.status = 'APPROVED';
      r.decidedHoursAgo = 0;
      if (Number(b.newPrice) > 0) {
        r.newPrice = Number(b.newPrice);
        const a = BY_CODE.get(r.code);
        if (a) a.seed = { ...a.seed, price: Number(b.newPrice) };
      }
      if (typeof b.comment === 'string' && b.comment.trim()) r.comment = b.comment.trim();
      return reviewJson(r, false);
    },
  },
  {
    method: 'POST',
    match: /^\/price-reviews\/[^/]+\/reject$/,
    handler: (ctx) => {
      const id = seg(ctx.path)[1] ?? '';
      const b = body(ctx);
      const r = REVIEWS.find((x) => x.id === id) ?? REVIEWS[0];
      r.status = 'REJECTED';
      r.decidedHoursAgo = 0;
      if (typeof b.comment === 'string' && b.comment.trim()) r.comment = b.comment.trim();
      return reviewJson(r, false);
    },
  },

  // ---------- Заявки на номенклатуру («как в 1С») ----------
  {
    method: 'GET',
    match: /^\/nomenclature-requests$/,
    handler: ({ params }) => {
      const status = params.get('status');
      return NOM_REQUESTS.filter((r) => !status || r.status === status).map(nomReqJson);
    },
  },
  {
    method: 'POST',
    match: /^\/nomenclature-requests$/,
    handler: (ctx) => {
      const b = body(ctx);
      const r: NomReq = {
        id: uuid('nreq', `new:${String(b.proposedName ?? '')}`),
        proposedName: String(b.proposedName ?? 'Новая позиция'),
        series: typeof b.series === 'string' && b.series ? b.series : null,
        description: typeof b.description === 'string' && b.description ? b.description : null,
        reason: typeof b.reason === 'string' && b.reason ? b.reason : null,
        status: 'PENDING',
        requestedBy: 'Режим дизайна',
        createdHoursAgo: 0,
      };
      NOM_REQUESTS.unshift(r);
      return nomReqJson(r);
    },
  },
  {
    method: 'POST',
    match: /^\/nomenclature-requests\/[^/]+\/approve$/,
    handler: (ctx) => {
      const id = seg(ctx.path)[1] ?? '';
      const b = body(ctx);
      const r = NOM_REQUESTS.find((x) => x.id === id) ?? NOM_REQUESTS[0];
      r.status = 'APPROVED';
      r.decidedHoursAgo = 0;
      r.articleCode = typeof b.articleCode === 'string' && b.articleCode ? b.articleCode : `${r.series ?? 'n'}-1362`;
      if (typeof b.comment === 'string' && b.comment.trim()) r.comment = b.comment.trim();
      return { request: nomReqJson(r), article: { id: uuid('article', r.articleCode), articleCode: r.articleCode } };
    },
  },
  {
    method: 'POST',
    match: /^\/nomenclature-requests\/[^/]+\/reject$/,
    handler: (ctx) => {
      const id = seg(ctx.path)[1] ?? '';
      const b = body(ctx);
      const r = NOM_REQUESTS.find((x) => x.id === id) ?? NOM_REQUESTS[0];
      r.status = 'REJECTED';
      r.decidedHoursAgo = 0;
      if (typeof b.comment === 'string' && b.comment.trim()) r.comment = b.comment.trim();
      return nomReqJson(r);
    },
  },

  // ---------- Номенклатура: поиск, дубли, зависшие заявки ----------
  {
    method: 'GET',
    match: /^\/nomenclature\/search$/,
    handler: ({ params }) => {
      const q = (params.get('q') ?? '').trim();
      const suggestions = q
        ? MATERIALS.filter((m) => lc(m.name).includes(lc(q)) || lc(m.code).includes(lc(q)))
          .slice(0, 10)
          .map((m, i) => ({ id: uuid('material', m.code), name: m.name, materialCode: m.code, unit: m.unit, score: round2(0.97 - i * 0.04) }))
        : [];
      return { query: q, suggestions, total: suggestions.length };
    },
  },
  {
    method: 'GET',
    match: /^\/nomenclature\/suggest$/,
    handler: ({ params }) => {
      const q = (params.get('q') ?? '').trim();
      let limit = Number(params.get('limit'));
      if (!(limit > 0)) limit = 5;
      const data = q
        ? MATERIALS.filter((m) => lc(m.name).includes(lc(q)))
          .slice(0, limit)
          .map((m, i) => ({ id: uuid('material', m.code), name: m.name, materialCode: m.code, unit: m.unit, score: round2(0.96 - i * 0.05) }))
        : [];
      return { data, total: data.length };
    },
  },
  {
    method: 'GET',
    match: /^\/nomenclature\/duplicates$/,
    handler: () => {
      // Настоящая беда справочника: «линолеум» и «Линолеум коммерческий»,
      // две «Грунт-эмали», два «Прожектора Gauss» — одно и то же разными строками
      const groups = [
        { key: 'линолеум', codes: ['К0049', 'К0180'] },
        { key: 'грунт эмаль', codes: ['Л0008', 'Л0038'] },
        { key: 'прожектор gauss led elementary', codes: ['К0075', 'К0159'] },
        { key: 'сэндвич панель мин плита', codes: ['К1004', 'К1011'] },
        { key: 'фанера фсф', codes: ['К1102', 'К1126'] },
      ]
        .map((g) => ({
          key: g.key,
          items: g.codes
            .map((c) => MAT_BY_CODE.get(c))
            .filter((m): m is MatSeed => !!m)
            .map((m) => ({ id: uuid('material', m.code), name: m.name, materialCode: m.code, unit: m.unit, stockQty: m.stock })),
        }))
        .filter((g) => g.items.length > 1);
      return { groups, groupCount: groups.length, itemCount: groups.reduce((s, g) => s + g.items.length, 0) };
    },
  },
  {
    method: 'GET',
    match: /^\/nomenclature\/stalled-requests$/,
    handler: () =>
      NOM_REQUESTS.filter((r) => r.status === 'APPROVED' || r.status === 'WAITING_1C').map((r) => ({
        id: r.id,
        proposedName: r.proposedName,
        requestedBy: r.requestedBy,
        createdAt: atHours(-r.createdHoursAgo),
        slaDueAt: atHours(-r.createdHoursAgo + 48),
        overdueHours: Math.max(0, Math.round(r.createdHoursAgo - 48)),
      })),
  },
  {
    method: 'GET',
    match: /^\/nomenclature\/materials\/[^/]+\/names$/,
    handler: ({ path }) => {
      const id = seg(path)[2] ?? '';
      const m = MATERIALS.find((x) => uuid('material', x.code) === id) ?? MATERIALS[0];
      return {
        materialId: uuid('material', m.code),
        canonical: m.name,
        aliases: [
          { id: uuid('alias', m.code, 0), alias: m.name.toLowerCase(), source: '1C', createdAt: dayIso(40) },
          { id: uuid('alias', m.code, 1), alias: `${m.code} ${m.name}`, source: 'import', createdAt: dayIso(12) },
        ],
      };
    },
  },
  {
    method: 'POST',
    match: /^\/nomenclature\/materials\/[^/]+\/aliases$/,
    handler: (ctx) => {
      const id = seg(ctx.path)[2] ?? '';
      const b = body(ctx);
      return {
        id: uuid('alias-new', id, String(b.alias ?? '')),
        materialId: id,
        alias: String(b.alias ?? ''),
        source: typeof b.source === 'string' ? b.source : 'manual',
        createdAt: NOW.toISOString(),
        created: true,
      };
    },
  },
];
