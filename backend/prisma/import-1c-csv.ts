/**
 * Заливка выгрузки 1С (24.08.2026, второй заход): заказы, номенклатура —
 * и теперь контрагенты, оплаты, остатки склада, журнал производства.
 * В отличие от go-live.ts (живой HTTP 1С, недоступен с этой машины), этот
 * путь работает офлайн — оператор выгружает отчёты из 1С сам.
 *
 * Ключевая находка при разборе: «Номер» документа в выгрузке — это номер
 * внутри 1С-серии, которая сбрасывается по годам, а год в колонке не виден.
 * Коллизии серии разрешаются добавлением года только к столкнувшимся
 * номерам (buildUniqueKeys) — для заказов клиента/поставщику через строки,
 * для оплат и производства — через ближайшую дату (resolveOrderId).
 *
 * Материалы, как и в живой синхронизации, автоматически НЕ создаются —
 * непознанные уходят в отчёт. Артикулы клиентских позиций создаются, как
 * в живой синхронизации.
 *
 * Контрагенты.csv решает проблему «1С сама называет контрагента по-разному»
 * не отчётом, а по-настоящему: сопоставление по нормализованному имени
 * (без учёта порядка слов) сначала ищет уже созданного контрагента под
 * ДРУГИМ написанием, и только потом — эталонную запись со своим БИН.
 *
 * Производство (ПроизводствоШапки/Строки.csv) — только ОТЧЁТ, в базу не
 * пишется: связь со стадией/трудочасами по этим данным не восстановить,
 * писать в ProductionStage значило бы придумывать то, чего нет в выгрузке.
 *
 * Запуск:
 *   npm run import:1c-csv -- --headers <файл> --lines <файл> --nomenclature <файл>
 *     [--contractors <файл>] [--payments <файл>] [--stock <файл>]
 *     [--production-headers <файл>] [--production-lines <файл>]
 *     [--wipe --yes] [--dry-run]
 */
import * as fs from 'fs';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { normalizeName } from '../src/common/nomenclature';
import { isPriceAnomaly, anomalyFactor } from '../src/common/material-batches';
import { wipeOperationalData } from './go-live';

const ANOMALY_THRESHOLD = 5;

const argv = process.argv.slice(2);
function arg(flag: string, def: string | null = null): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const has = (f: string) => argv.includes(f);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const clean = text.replace(/^﻿/, '');
  while (i < clean.length) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ';') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

function readRows(path: string): Record<string, string>[] {
  const raw = parseCsv(fs.readFileSync(path, 'utf8'));
  const header = raw[0];
  return raw.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

function num(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseRuDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, d, mo, y, h = '0', mi = '0', s = '0'] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

// Хэш на ТОЧНОЙ строке, не на normalizeName: та схлопывает разные названия
// («Аврора 77, ТОО» / «Аврора 75, ТОО» после огрубления могут совпасть) —
// разным контрагентам и позициям нужны разные фиктивные коды.
function slug(exact: string): string {
  return 'C-' + crypto.createHash('sha1').update(exact.trim()).digest('hex').slice(0, 10).toUpperCase();
}

/**
 * Года в «Номере» нет, серия у 1С по годам сбрасывается — совпадение
 * встречается у РАЗНЫХ документов. Трогаем только те номера, что реально
 * столкнулись; остальные остаются как есть, чтобы номер узнавался с ходу.
 */
function buildUniqueKeys<T>(items: T[], numberOf: (t: T) => string, dateOf: (t: T) => Date | null) {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const n = numberOf(it);
    (groups.get(n) ?? groups.set(n, []).get(n)!).push(it);
  }
  const keyOf = new Map<T, string>();
  const disambiguated: Array<{ number: string; key: string; date: string }> = [];
  for (const [n, group] of groups) {
    if (group.length === 1) { keyOf.set(group[0], n); continue; }
    const sorted = [...group].sort((a, b) => (dateOf(a)?.getTime() ?? 0) - (dateOf(b)?.getTime() ?? 0));
    const seenKeys = new Set<string>();
    for (const it of sorted) {
      const year = dateOf(it)?.getFullYear() ?? 0;
      let key = `${n}-${year}`;
      let suffix = 2;
      while (seenKeys.has(key)) { key = `${n}-${year}-${suffix}`; suffix += 1; }
      seenKeys.add(key);
      keyOf.set(it, key);
      disambiguated.push({ number: n, key, date: dateOf(it)?.toISOString().slice(0, 10) ?? '' });
    }
  }
  return { keyOf, disambiguated };
}

/**
 * Строки не несут дату — привязать их к одному из столкнувшихся по номеру
 * документов напрямую нельзя. Но «НомерСтроки» в отчёте сбрасывается на 1
 * в начале каждого документа: это и есть граница между ними. Сегментируем
 * по сбросу, затем каждый блок отдаём документу с ближайшей суммой —
 * проверено на всех 306 столкновениях выгрузки: блоков всегда ровно
 * столько же, сколько документов, и суммы блоков бьются с точностью до тенге.
 */
function assignLinesToHeaders<H>(
  headerGroup: H[],
  lineGroup: Array<Record<string, string>>,
  amountOf: (h: H) => number,
): Map<Record<string, string>, H> {
  const result = new Map<Record<string, string>, H>();
  if (headerGroup.length === 1) {
    for (const l of lineGroup) result.set(l, headerGroup[0]);
    return result;
  }
  const blocks: Array<Array<Record<string, string>>> = [];
  let cur: Array<Record<string, string>> = [];
  for (const l of lineGroup) {
    if (l['НомерСтроки'] === '1' && cur.length) { blocks.push(cur); cur = []; }
    cur.push(l);
  }
  if (cur.length) blocks.push(cur);
  if (blocks.length !== headerGroup.length) return result; // не сошлось — оставляем неразнесённым, не гадаем

  const remaining = [...headerGroup];
  for (const block of blocks) {
    const target = block.reduce((s, l) => s + num(l['Сумма']), 0);
    let bestIdx = 0, bestDiff = Infinity;
    remaining.forEach((h, idx) => {
      const diff = Math.abs(amountOf(h) - target);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = idx; }
    });
    const chosen = remaining.splice(bestIdx, 1)[0];
    for (const l of block) result.set(l, chosen);
  }
  return result;
}

// Точные соответствия — уже проверенный STATUS_MAP из живой синхронизации
// (onec-sync.service.ts). «Подтвержден» и «Согласован» там не встречались
// вовсе — это домысел, вынесенный отдельно и явно подсвечен в отчёте.
const STATUS_MAP: Array<[RegExp, string, boolean]> = [
  [/закрыт/, 'CLOSED', false],
  [/котгрузке/, 'READY_TO_SHIP', false],
  [/аннулир|отмен/, 'CANCELLED', false],
  [/насогласовании/, 'DRAFT', false],
  [/квыполнению/, 'CONFIRMED', false],
  [/подтвержден|согласован/, 'CONFIRMED', true],
];
function mapStatus(raw: string): { status: string; guessed: boolean } {
  const norm = raw.toLowerCase().replace(/\s+/g, '').replace(/\//g, '');
  for (const [re, status, guessed] of STATUS_MAP) {
    if (re.test(norm)) return { status, guessed };
  }
  return { status: 'DRAFT', guessed: true };
}

async function matchMaterial(prisma: PrismaClient, name: string, code: string): Promise<string | null> {
  if (code) {
    const byCode = await prisma.material.findFirst({ where: { materialCode: code }, select: { id: true } });
    if (byCode) return byCode.id;
  }
  if (!name) return null;
  const byName = await prisma.material.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
  if (byName) return byName.id;
  const byAlias = await prisma.materialAlias.findFirst({ where: { normalized: normalizeName(name) }, select: { materialId: true } });
  return byAlias?.materialId ?? null;
}

interface NomEntry { code: string; articleCode: string | null; type: string; unit: string }

// Ключ дедупликации контрагентов: слова без учёта порядка и регистра —
// «ТОО» то до имени, то после, а точное сравнение это не ловит
function contractorKey(name: string): string {
  return normalizeName(name).split(' ').filter(Boolean).sort().join(' ');
}

// «Назначение» в производстве пишет номер БЕЗ ведущих нулей («Т7АА-415»),
// а «Номер» в заказах — с ними до 6 цифр («Т7АА-000415»). Без выравнивания
// resolveOrderId никогда не находит совпадение, хотя заказ реально есть.
function padOrderNumber(raw: string): string {
  const m = /^(Т7АА-)(\d+)$/.exec(raw);
  if (!m) return raw;
  return m[1] + m[2].padStart(6, '0');
}

interface StockRow { name: string; qty: number; unit: string; price: number; date: Date | null }
interface PaymentRow { docNumber: string; kind: 'Клиенту' | 'Поставщику'; date: Date | null; amount: number }

async function main() {
  const headersPath = arg('--headers');
  const linesPath = arg('--lines');
  const nomPath = arg('--nomenclature');
  const contractorsPath = arg('--contractors');
  const paymentsPath = arg('--payments');
  const stockPath = arg('--stock');
  const prodHeadersPath = arg('--production-headers');
  const prodLinesPath = arg('--production-lines');
  if (!headersPath || !linesPath || !nomPath) {
    console.log('Использование: npm run import:1c-csv -- --headers <файл> --lines <файл> --nomenclature <файл> [--contractors <файл>] [--payments <файл>] [--stock <файл>] [--production-headers <файл>] [--production-lines <файл>] [--wipe --yes] [--dry-run]');
    process.exit(1);
  }
  const dryRun = has('--dry-run');

  const headers = readRows(headersPath);
  const lines = readRows(linesPath);
  const nomRows = readRows(nomPath);
  const contractorRows = contractorsPath ? readRows(contractorsPath) : [];
  const paymentRowsRaw = paymentsPath ? readRows(paymentsPath) : [];
  const stockRowsRaw = stockPath ? readRows(stockPath) : [];
  const prodHeaderRows = prodHeadersPath ? readRows(prodHeadersPath) : [];
  const prodLineRows = prodLinesPath ? readRows(prodLinesPath) : [];
  console.log(`Прочитано: шапки ${headers.length}, строки ${lines.length}, номенклатура ${nomRows.length}` +
    (contractorRows.length ? `, контрагенты ${contractorRows.length}` : '') +
    (paymentRowsRaw.length ? `, оплаты ${paymentRowsRaw.length}` : '') +
    (stockRowsRaw.length ? `, остатки ${stockRowsRaw.length}` : '') +
    (prodHeaderRows.length ? `, производство ${prodHeaderRows.length}/${prodLineRows.length}` : ''));

  // Эталонный справочник контрагентов: ключ — тот же, что и у отчёта
  // о вероятных дублях, чтобы сразу МЕНЯТЬ поведение, а не только показывать
  const canonicalContractors = new Map<string, { name: string; binIin: string; type: string }>();
  for (const c of contractorRows) {
    const name = c['Наименование']?.trim();
    const binIin = c['БИН']?.trim();
    if (!name || !binIin) continue;
    canonicalContractors.set(contractorKey(name), { name, binIin, type: c['Тип']?.trim() ?? '' });
  }

  const paymentRows: PaymentRow[] = paymentRowsRaw
    .map((p) => ({
      docNumber: p['НомерДокументаОснования']?.trim() ?? '',
      kind: p['Тип']?.trim() as 'Клиенту' | 'Поставщику',
      date: parseRuDate(p['Дата']),
      amount: num(p['Сумма']),
    }))
    .filter((p) => p.docNumber && p.amount > 0 && (p.kind === 'Клиенту' || p.kind === 'Поставщику'));

  const stockRows: StockRow[] = stockRowsRaw
    .map((s) => ({
      name: s['Материал']?.trim() ?? '',
      qty: num(s['Количество']),
      unit: (s['ЕдиницаИзмерения']?.trim() || 'шт').slice(0, 10),
      price: num(s['УчётнаяЦена']),
      date: parseRuDate(s['ДатаОстатка']),
    }))
    .filter((s) => s.name && s.qty > 0);

  const nomDict = new Map<string, NomEntry>();
  let nomCollisions = 0;
  for (const n of nomRows) {
    const key = normalizeName(n['Наименование']);
    if (!key) continue;
    if (nomDict.has(key)) { nomCollisions += 1; continue; }
    nomDict.set(key, {
      code: n['Код']?.trim() ?? '',
      articleCode: n['Артикул']?.trim() || null,
      type: n['ТипНоменклатуры']?.trim() ?? '',
      unit: (n['ЕдиницаИзмерения']?.trim() || 'шт').slice(0, 10),
    });
  }

  const clientHeaders = headers.filter((h) => h['Тип'] === 'Клиенту');
  const supplierHeaders = headers.filter((h) => h['Тип'] === 'Поставщику');
  const dateOfHeader = (h: Record<string, string>) => parseRuDate(h['Дата']);
  const { keyOf: orderKeyOf, disambiguated: orderDisambig } =
    buildUniqueKeys(clientHeaders, (h) => h['Номер'], dateOfHeader);
  const { keyOf: docKeyOf, disambiguated: docDisambig } =
    buildUniqueKeys(supplierHeaders, (h) => h['Номер'], dateOfHeader);

  const clientHeadersByNumber = new Map<string, Record<string, string>[]>();
  for (const h of clientHeaders) {
    const n = h['Номер'];
    (clientHeadersByNumber.get(n) ?? clientHeadersByNumber.set(n, []).get(n)!).push(h);
  }
  const supplierHeadersByNumber = new Map<string, Record<string, string>[]>();
  for (const h of supplierHeaders) {
    const n = h['Номер'];
    (supplierHeadersByNumber.get(n) ?? supplierHeadersByNumber.set(n, []).get(n)!).push(h);
  }

  const clientLines = lines.filter((l) => l['Тип'] === 'Клиенту');
  const clientLinesByNumber = new Map<string, Record<string, string>[]>();
  for (const l of clientLines) {
    const n = l['НомерЗаказа'];
    (clientLinesByNumber.get(n) ?? clientLinesByNumber.set(n, []).get(n)!).push(l);
  }
  const supplierLines = lines.filter((l) => l['Тип'] === 'Поставщику');
  const supplierLinesByNumber = new Map<string, Record<string, string>[]>();
  for (const l of supplierLines) {
    const n = l['НомерЗаказа'];
    (supplierLinesByNumber.get(n) ?? supplierLinesByNumber.set(n, []).get(n)!).push(l);
  }

  const amountOfHeader = (h: Record<string, string>) => num(h['СуммаДокумента']);
  const clientLineToHeader = new Map<Record<string, string>, Record<string, string>>();
  for (const [n, group] of clientHeadersByNumber) {
    const assigned = assignLinesToHeaders(group, clientLinesByNumber.get(n) ?? [], amountOfHeader);
    for (const [l, h] of assigned) clientLineToHeader.set(l, h);
  }
  const supplierLineToHeader = new Map<Record<string, string>, Record<string, string>>();
  for (const [n, group] of supplierHeadersByNumber) {
    const assigned = assignLinesToHeaders(group, supplierLinesByNumber.get(n) ?? [], amountOfHeader);
    for (const [l, h] of assigned) supplierLineToHeader.set(l, h);
  }

  const customerNames = new Set<string>();
  for (const h of headers) if (h['Контрагент']?.trim()) customerNames.add(h['Контрагент'].trim());

  console.log(`\nЗаказы клиента: ${clientHeaders.length} (уник. номеров с коллизией года: ${orderDisambig.length})`);
  console.log(`Заказы поставщику: ${supplierHeaders.length} (уник. номеров с коллизией года: ${docDisambig.length})`);
  console.log(`Уникальных контрагентов: ${customerNames.size}`);
  console.log(`Словарь номенклатуры: ${nomDict.size} записей (коллизий имени: ${nomCollisions})`);

  if (dryRun) {
    console.log('\n--dry-run: запись в базу пропущена.');
    return;
  }

  const prisma = new PrismaClient();
  const report = {
    customersCreated: 0, customersMatched: 0,
    ordersCreated: 0, ordersUpdated: 0,
    linesCreated: 0, linesSkippedZeroQty: 0, linesUnresolvedCollision: 0,
    articlesCreated: [] as string[],
    materialResaleCreated: 0,
    docsCreated: 0, docsUpdated: 0,
    batchesCreated: 0, batchAnomalies: 0,
    docLinesCreated: 0, docLinesMismatch: 0,
    unmatchedMaterials: new Map<string, { qty: number; amount: number }>(),
    statusGuessed: new Map<string, number>(),
  };

  try {
    if (has('--wipe')) {
      if (!has('--yes')) { console.error('Снос данных необратим: добавьте --yes.'); process.exit(2); }
      console.log('\n===== СНОС ОПЕРАЦИОННЫХ ДАННЫХ =====');
      await wipeOperationalData(prisma);
    }

    console.log('\n===== КОНТРАГЕНТЫ =====');
    // Сама 1С называет одного контрагента по-разному в заказах клиента и
    // поставщику («LVE Group, ТОО» / «ТОО "LVE Group"») — точное сравнение
    // это не ловит. Теперь ловим по-настоящему: если под другим написанием
    // с тем же нормализованным ключом контрагент уже создан в ЭТОМ прогоне —
    // переиспользуем его id, а не заводим второго. Если есть эталон
    // (Контрагенты.csv) — берём оттуда настоящий БИН вместо синтетического.
    const customerIdByName = new Map<string, string>();
    const customerIdByKey = new Map<string, string>();
    const mergedDuplicates: string[][] = [];
    const dedupGroups = new Map<string, string[]>();
    for (const name of customerNames) {
      const key = contractorKey(name);
      if (!key) continue;
      (dedupGroups.get(key) ?? dedupGroups.set(key, []).get(key)!).push(name);
    }

    for (const name of customerNames) {
      const key = contractorKey(name);
      const byKey = key ? customerIdByKey.get(key) : undefined;
      if (byKey) { customerIdByName.set(name, byKey); continue; } // уже создан под другим написанием в этом прогоне

      const existing = await prisma.customer.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
      if (existing) {
        customerIdByName.set(name, existing.id);
        if (key) customerIdByKey.set(key, existing.id);
        report.customersMatched += 1;
        continue;
      }
      const canonical = key ? canonicalContractors.get(key) : undefined;
      const created = await prisma.customer.create({
        data: {
          name: canonical?.name ?? name,
          binIin: canonical?.binIin ?? slug(name),
          customerType: 'OUTSIDE',
        },
      });
      customerIdByName.set(name, created.id);
      if (key) customerIdByKey.set(key, created.id);
      report.customersCreated += 1;
    }
    for (const [key, names] of dedupGroups) {
      if (names.length > 1) mergedDuplicates.push(names);
    }
    console.log(`Сопоставлено: ${report.customersMatched}, создано новых: ${report.customersCreated}, слито написаний-дублей: ${mergedDuplicates.length}`);

    console.log('\n===== ЗАКАЗЫ КЛИЕНТА =====');
    const orderIdByHeader = new Map<Record<string, string>, string>();
    // Сырой номер → все заказы под этим номером (обычно один; при коллизии
    // серии — несколько, тогда оплату/производство относим к ближайшему
    // по дате). Тем же способом решалась коллизия строк заказа выше.
    const orderCandidatesByRawNumber = new Map<string, Array<{ id: string; date: Date | null }>>();
    for (const h of clientHeaders) {
      const orderNumber = orderKeyOf.get(h)!;
      const { status, guessed } = mapStatus(h['Статус']);
      if (guessed) report.statusGuessed.set(h['Статус'], (report.statusGuessed.get(h['Статус']) ?? 0) + 1);
      const customerId = customerIdByName.get(h['Контрагент'].trim());
      const requestDate = dateOfHeader(h);
      // 10 колонок, для которых уже есть готовое поле в Order — раньше их
      // знала только живая HTTP-синхронизация с 1С (недоступна с этой
      // машины), офлайн-CSV-импорт никогда их не читал. «ТипЗаказа» в
      // этот orderType (ФЗ/ВЗ) НЕ мапим — проверено на реальных данных,
      // значения ('', 'ЦМК') не похожи на ФЗ/ВЗ; сырое значение всё равно
      // попадёт в rawColumns.
      const plannedShipmentDate = parseRuDate(h['ПланВывоза']);
      const existedBefore = await prisma.order.findUnique({ where: { orderNumber }, select: { id: true } });
      const order = await prisma.order.upsert({
        where: { orderNumber },
        create: {
          orderNumber,
          customerId: customerId!,
          orderType: 'FZ',
          status: status as any,
          onecNum: h['Номер'],
          onecStatus: h['Статус'],
          onecTotalAmount: num(h['СуммаДокумента']),
          requestDate: requestDate ?? undefined,
          divisionCode: h['Подразделение']?.trim() || undefined,
          projectGroup: h['ГруппаПроектов']?.trim() || undefined,
          projectSite: h['Проект']?.trim() || undefined,
          region: h['Регион']?.trim() || undefined,
          bitrixDealId: h['НомерЗаказаБитрикс']?.trim() || undefined,
          plannedShipmentDate: plannedShipmentDate ?? undefined,
          clientAgreement: h['Соглашение']?.trim() || undefined,
          finalCustomer: h['КонечныйЗаказчик']?.trim() || undefined,
          customerOrderNum: h['НомерЗаказаКлиента']?.trim() || undefined,
          rawColumns: h as any,
        },
        update: {
          onecStatus: h['Статус'],
          onecTotalAmount: num(h['СуммаДокумента']),
          divisionCode: h['Подразделение']?.trim() || undefined,
          projectGroup: h['ГруппаПроектов']?.trim() || undefined,
          projectSite: h['Проект']?.trim() || undefined,
          region: h['Регион']?.trim() || undefined,
          bitrixDealId: h['НомерЗаказаБитрикс']?.trim() || undefined,
          plannedShipmentDate: plannedShipmentDate ?? undefined,
          clientAgreement: h['Соглашение']?.trim() || undefined,
          finalCustomer: h['КонечныйЗаказчик']?.trim() || undefined,
          customerOrderNum: h['НомерЗаказаКлиента']?.trim() || undefined,
          rawColumns: h as any,
        },
      });
      if (existedBefore) report.ordersUpdated += 1; else report.ordersCreated += 1;
      orderIdByHeader.set(h, order.id);
      const raw = h['Номер'];
      (orderCandidatesByRawNumber.get(raw) ?? orderCandidatesByRawNumber.set(raw, []).get(raw)!)
        .push({ id: order.id, date: requestDate });
    }
    console.log(`Создано: ${report.ordersCreated}, обновлено: ${report.ordersUpdated}`);

    // Ближайший по дате кандидат — тот же приём, что и для строк заказа
    // поставщику при коллизии серии, только на уровне целого документа
    function resolveOrderId(rawNumber: string, when: Date | null): string | null {
      const candidates = orderCandidatesByRawNumber.get(rawNumber);
      if (!candidates || candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0].id;
      if (!when) return candidates[0].id;
      return candidates.reduce((best, c) => {
        const bd = Math.abs((best.date?.getTime() ?? 0) - when.getTime());
        const cd = Math.abs((c.date?.getTime() ?? 0) - when.getTime());
        return cd < bd ? c : best;
      }).id;
    }

    console.log('\n===== ПОЗИЦИИ ЗАКАЗОВ КЛИЕНТА =====');
    for (const l of clientLines) {
      const header = clientLineToHeader.get(l);
      if (!header) { report.linesUnresolvedCollision += 1; continue; }
      const orderId = orderIdByHeader.get(header);
      if (!orderId) continue;
      const qty = num(l['Количество']);
      if (qty <= 0) { report.linesSkippedZeroQty += 1; continue; }
      const itemName = l['Номенклатура']?.trim() ?? '';
      const nomEntry = nomDict.get(normalizeName(itemName));
      const articleCode = (nomEntry?.articleCode || nomEntry?.code || slug(itemName)).slice(0, 20);
      let article = await prisma.article.findUnique({ where: { articleCode } });
      if (!article) {
        article = await prisma.article.findFirst({ where: { name: { equals: itemName, mode: 'insensitive' } } });
      }
      if (!article) {
        // Тот же код уже занят материалом — не изделие, а прямая продажа
        // сырья без изготовления (решение 25.08.2026, аудит нашёл 1002
        // таких карточек); иначе следующая синхронизация повторила бы то же
        const sameCodeMaterial = await prisma.material.findFirst({ where: { materialCode: articleCode } });
        article = await prisma.article.create({
          data: { articleCode, name: itemName || articleCode, isMaterialResale: Boolean(sameCodeMaterial) },
        });
        report.articlesCreated.push(articleCode);
        if (sameCodeMaterial) report.materialResaleCreated += 1;
      }
      await prisma.orderLine.create({
        data: {
          orderId,
          articleId: article.id,
          qty,
          unit: nomEntry?.unit ?? 'шт',
          unitPrice: num(l['Цена']),
          lineTotalVat: num(l['Сумма']),
          productNameRaw: itemName,
        },
      });
      report.linesCreated += 1;
    }
    console.log(`Создано позиций: ${report.linesCreated}, пропущено (нулевое кол-во): ${report.linesSkippedZeroQty}, не разнесено из-за коллизии номера: ${report.linesUnresolvedCollision}`);

    console.log('\n===== ЗАКАЗЫ ПОСТАВЩИКУ (платёжные документы) =====');
    const docByHeader = new Map<Record<string, string>, { id: string; date: Date | null; customerName: string; doNumber: string }>();
    const docCandidatesByRawNumber = new Map<string, Array<{ doNumber: string; date: Date | null }>>();
    for (const h of supplierHeaders) {
      const doNumber = docKeyOf.get(h)!;
      const contractorId = customerIdByName.get(h['Контрагент'].trim());
      const existedBefore = await prisma.paymentDocument.findUnique({ where: { doNumber }, select: { id: true } });
      // Все данные заказа поставщику, а не 6 колонок из 33: раньше
      // подразделение, направление, проект, автор, утвердитель и документы
      // поставщика просто терялись (26.08.2026). Один и тот же набор в
      // create и update — иначе у уже существующих 306 документов поля
      // навсегда остались бы пустыми.
      const doFields = {
        doDate: dateOfHeader(h) ?? undefined,
        contractorId: contractorId!,
        currency: h['Валюта']?.trim() || 'KZT',
        totalAmount: num(h['СуммаДокумента']),
        rawColumns: h as any,
        businessDirection: h['НаправлениеДеятельности']?.trim() || null,
        projectName: h['Проект']?.trim() || null,
        division: h['Подразделение']?.trim() || null,
        warehouseName: h['Склад']?.trim() || null,
        costCategory: h['КатегорияЗатрат']?.trim() || null,
        author: h['Автор']?.trim() || null,
        managerName: h['Менеджер']?.trim() || null,
        approvedAt: parseRuDate(h['ДатаСогласования']) ?? undefined,
        approver: h['Утвердитель']?.trim() || null,
        supplierDocNumber: h['НомерПоДаннымПоставщика']?.trim() || null,
        supplierDocDate: parseRuDate(h['ДатаПоДаннымПоставщика']) ?? undefined,
        salesOrderNumber: h['НомерЗаказаНаПродажу']?.trim() || null,
      };
      const doc = await prisma.paymentDocument.upsert({
        where: { doNumber },
        create: {
          doNumber,
          ...doFields,
          // unpaidAmount только при создании: дальше его пересчитывает блок оплат
          unpaidAmount: num(h['СуммаДокумента']),
        },
        update: doFields,
      });
      if (existedBefore) report.docsUpdated += 1; else report.docsCreated += 1;
      docByHeader.set(h, { id: doc.id, date: dateOfHeader(h), customerName: h['Контрагент'], doNumber });
      const raw = h['Номер'];
      (docCandidatesByRawNumber.get(raw) ?? docCandidatesByRawNumber.set(raw, []).get(raw)!)
        .push({ doNumber, date: dateOfHeader(h) });
    }
    console.log(`Создано: ${report.docsCreated}, обновлено: ${report.docsUpdated}`);

    function resolveDoNumber(rawNumber: string, when: Date | null): string | null {
      const candidates = docCandidatesByRawNumber.get(rawNumber);
      if (!candidates || candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0].doNumber;
      if (!when) return candidates[0].doNumber;
      return candidates.reduce((best, c) => {
        const bd = Math.abs((best.date?.getTime() ?? 0) - when.getTime());
        const cd = Math.abs((c.date?.getTime() ?? 0) - when.getTime());
        return cd < bd ? c : best;
      }).doNumber;
    }

    console.log('\n===== СТРОКИ И ПРИХОДЫ ПО ЗАКУПУ =====');
    // Строки заказа поставщику сохраняются ВСЕГДА, даже когда материал не
    // опознан или цена нулевая: иначе «что заказано» видно лишь у той трети
    // документов, где импорт смог завести партию (26.08.2026).
    await prisma.paymentDocumentLine.deleteMany({
      where: { paymentDocumentId: { in: [...docByHeader.values()].map((d) => d.id) } },
    });
    const healthyByMaterial = new Map<string, number[]>();
    for (const l of supplierLines) {
      const header = supplierLineToHeader.get(l);
      if (!header) { report.linesUnresolvedCollision += 1; continue; }
      const doc = docByHeader.get(header);
      if (!doc) continue;
      const qty = num(l['Количество']);
      const price = num(l['Цена']);
      const amount = num(l['Сумма']);
      const itemName = l['Номенклатура']?.trim() ?? '';
      const nomEntry = nomDict.get(normalizeName(itemName));
      const materialId = await matchMaterial(prisma, itemName, nomEntry?.code ?? '');

      // «Количество × Цена ≠ Сумма» в четверти строк — цена за тонну при
      // количестве в штуках. Помечаем один раз здесь, чтобы все расчёты
      // ниже могли опираться только на «Сумму», а карточка — предупредить.
      const expected = qty * price;
      const mismatch = amount > 0 && expected > 0
        && Math.abs(expected - amount) > Math.max(1, amount * 0.01);
      await prisma.paymentDocumentLine.create({
        data: {
          paymentDocumentId: doc.id,
          lineNo: Number(l['НомерСтроки']) || 0,
          itemName: itemName || '(без названия)',
          qty: qty || null,
          unitPrice: price || null,
          amount: amount || null,
          vatRate: l['СтавкаНДС']?.trim() || null,
          packaging: l['Упаковка']?.trim() || null,
          expenseItem: l['СтатьяРасходов']?.trim() || null,
          purpose: l['Назначение']?.trim() || null,
          customerOrderNum: l['НомерЗаказаКлиента']?.trim() || null,
          materialId,
          amountMismatch: mismatch,
          rawColumns: l as any,
        },
      });
      report.docLinesCreated += 1;
      if (mismatch) report.docLinesMismatch += 1;

      if (qty <= 0 || price <= 0) continue;
      if (!materialId) {
        const key = itemName || '(без названия)';
        const acc = report.unmatchedMaterials.get(key) ?? { qty: 0, amount: 0 };
        acc.qty += qty; acc.amount += amount;
        report.unmatchedMaterials.set(key, acc);
        continue;
      }
      const others = healthyByMaterial.get(materialId) ?? [];
      const anomaly = isPriceAnomaly(price, others, ANOMALY_THRESHOLD);
      await prisma.materialBatch.create({
        data: {
          materialId,
          receiptDate: doc.date ?? new Date(2026, 0, 1),
          unitPrice: price,
          qtyReceived: qty,
          qtyRemaining: 0,
          supplierName: doc.customerName,
          documentNumber: doc.doNumber,
          paymentDocumentId: doc.id,
          origin: 'ONEC',
          priceAnomaly: anomaly,
          anomalyFactor: anomaly ? anomalyFactor(price, others) : null,
        },
      });
      report.batchesCreated += 1;
      if (anomaly) report.batchAnomalies += 1; else healthyByMaterial.set(materialId, [...others, price]);
    }
    console.log(`Строк заказов поставщику: ${report.docLinesCreated} (кол-во × цена ≠ сумма: ${report.docLinesMismatch})`);
    console.log(`Создано исторических партий: ${report.batchesCreated} (в карантине по цене: ${report.batchAnomalies})`);
    console.log(`Неопознанных материалов (уникальных названий): ${report.unmatchedMaterials.size}`);

    // ===== ОПЛАТЫ: дебиторка заказчиков + оплаченность закупа =====
    let paymentsToOrders = 0, paymentsToOrdersUnmatched = 0;
    let paymentsToDocs = 0, paymentsToDocsUnmatched = 0;
    if (paymentRows.length) {
      console.log('\n===== ОПЛАТЫ =====');
      const paidByOrder = new Map<string, number>();
      const paidByDoNumber = new Map<string, number>();
      for (const p of paymentRows) {
        if (p.kind === 'Клиенту') {
          const orderId = resolveOrderId(p.docNumber, p.date);
          if (!orderId) { paymentsToOrdersUnmatched += 1; continue; }
          paidByOrder.set(orderId, (paidByOrder.get(orderId) ?? 0) + p.amount);
          paymentsToOrders += 1;
        } else {
          const doNumber = resolveDoNumber(p.docNumber, p.date);
          if (!doNumber) { paymentsToDocsUnmatched += 1; continue; }
          paidByDoNumber.set(doNumber, (paidByDoNumber.get(doNumber) ?? 0) + p.amount);
          paymentsToDocs += 1;
        }
      }
      for (const [orderId, paid] of paidByOrder) {
        await prisma.order.update({ where: { id: orderId }, data: { onecPaidAmount: paid } });
      }
      for (const [doNumber, paid] of paidByDoNumber) {
        const doc = await prisma.paymentDocument.findUnique({ where: { doNumber }, select: { totalAmount: true } });
        if (!doc) continue;
        const total = Number(doc.totalAmount);
        const unpaid = Math.max(0, total - paid);
        await prisma.paymentDocument.update({
          where: { doNumber },
          data: {
            paidAmount: paid,
            unpaidAmount: unpaid,
            status: (unpaid <= 0 && total > 0 ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID') as any,
          },
        });
      }
      console.log(`Заказы клиента: разнесено платежей на ${paidByOrder.size} заказов (${paymentsToOrders} строк, не сопоставлено — ${paymentsToOrdersUnmatched})`);
      console.log(`Заказы поставщику: разнесено платежей на ${paidByDoNumber.size} документов (${paymentsToDocs} строк, не сопоставлено — ${paymentsToDocsUnmatched})`);
    }

    // ===== ОСТАТКИ СКЛАДА: стартовые партии с реальным qtyRemaining =====
    let stockBatchesCreated = 0;
    const unmatchedStock = new Map<string, { qty: number; value: number }>();
    if (stockRows.length) {
      console.log('\n===== ОСТАТКИ СКЛАДА =====');
      for (const s of stockRows) {
        // Остатки.csv дописывает длину в скобках («…40×3 мм (6 м)»), которой
        // нет в самом названии материала («…40×3 мм») — 446 из 3021 строк.
        // Фоллбэк только здесь, не в общей normalizeName: в других местах
        // скобки бывают значащими (код поставщика и т.п.), рисковать нельзя.
        let materialId = await matchMaterial(prisma, s.name, '');
        if (!materialId) {
          const withoutLength = s.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
          if (withoutLength !== s.name) materialId = await matchMaterial(prisma, withoutLength, '');
        }
        if (!materialId) {
          const acc = unmatchedStock.get(s.name) ?? { qty: 0, value: 0 };
          acc.qty += s.qty; acc.value += s.qty * s.price;
          unmatchedStock.set(s.name, acc);
          continue;
        }
        await prisma.materialBatch.create({
          data: {
            materialId,
            receiptDate: s.date ?? new Date(),
            unitPrice: s.price,
            qtyReceived: s.qty,
            qtyRemaining: s.qty, // не 0, как у исторических приходов — это то, что физически лежит сейчас
            origin: 'INVENTORY',
          },
        });
        // Material.stockQty — отдельный счётчик (не сумма по партиям!),
        // его двигает только material-receipt.service.ts. Партия создана
        // в обход сервиса (это не покупка, а снимок остатка) — счётчик
        // пришлось бы иначе оставить на 0, и склад показывал бы «пусто»
        // при реально существующей партии. Курс закупки не трогаем —
        // это не покупка, пересчитывать среднюю цену не нужно.
        await prisma.material.update({
          where: { id: materialId },
          data: { stockQty: { increment: s.qty } },
        });
        stockBatchesCreated += 1;
      }
      console.log(`Создано партий стартового остатка: ${stockBatchesCreated}`);
      console.log(`Неопознанных материалов в остатках: ${unmatchedStock.size}`);
    }

    // ===== ПРОИЗВОДСТВО: только отчёт, в базу не пишем =====
    // «Назначение» строки несёт номер заказа клиента текстом — надёжно
    // там, где вообще заполнено (проверено на выгрузке: где есть текст,
    // там всегда есть и номер, 0 исключений). Но восстановить из этого
    // передел/трудочасы нельзя — писать в ProductionStage значило бы
    // придумывать данные, которых в выгрузке нет.
    let productionOrdersConfirmed = 0;
    let productionDocsWithOrder = 0;
    if (prodHeaderRows.length && prodLineRows.length) {
      console.log('\n===== ПРОИЗВОДСТВО (отчёт, в базу не пишется) =====');
      const orderNumRe = /Т7АА-\d+/;
      const prodDateByNum = new Map<string, Date | null>();
      for (const h of prodHeaderRows) prodDateByNum.set(h['Номер'], parseRuDate(h['Дата']));

      const rawOrderByProdDoc = new Map<string, string>();
      for (const l of prodLineRows) {
        const m = orderNumRe.exec(l['Назначение'] ?? '');
        if (m && !rawOrderByProdDoc.has(l['НомерПроизводства'])) {
          rawOrderByProdDoc.set(l['НомерПроизводства'], padOrderNumber(m[0]));
        }
      }
      const confirmedOrderIds = new Set<string>();
      for (const [prodDoc, rawOrderNum] of rawOrderByProdDoc) {
        const when = prodDateByNum.get(prodDoc) ?? null;
        const orderId = resolveOrderId(rawOrderNum, when);
        if (orderId) { confirmedOrderIds.add(orderId); productionDocsWithOrder += 1; }
      }
      productionOrdersConfirmed = confirmedOrderIds.size;
      console.log(`Документов производства: ${prodHeaderRows.length}, строк: ${prodLineRows.length}`);
      console.log(`Документов со ссылкой на заказ клиента в «Назначении»: ${rawOrderByProdDoc.size}`);
      console.log(`Из них сопоставлено с реальным заказом в базе: ${productionDocsWithOrder}`);
      console.log(`Уникальных заказов с подтверждённой историей производства: ${productionOrdersConfirmed}`);
      console.log('Решение о том, писать ли это в ProductionStage/этапы и как — за вами: данных о переделе и часах в выгрузке нет.');
    }

    console.log('\n===== ИТОГ =====');
    console.log(`Контрагенты: сопоставлено ${report.customersMatched}, создано ${report.customersCreated}`);
    if (mergedDuplicates.length) {
      console.log(`Слитые написания-дубли (сама 1С называет по-разному, теперь один контрагент) — ${mergedDuplicates.length} групп:`);
      for (const names of mergedDuplicates) console.log(`  · ${names.join('  ==  ')}`);
    }
    console.log(`Заказы клиента: создано ${report.ordersCreated}, обновлено ${report.ordersUpdated}`);
    console.log(`Позиции: ${report.linesCreated} (не разнесено из-за коллизии номера года: ${report.linesUnresolvedCollision})`);
    console.log(`Заказы поставщику (ДО): создано ${report.docsCreated}, обновлено ${report.docsUpdated}`);
    console.log(`Исторические партии закупа: ${report.batchesCreated}, в карантине: ${report.batchAnomalies}`);
    if (report.articlesCreated.length) {
      const realNew = report.articlesCreated.length - report.materialResaleCreated;
      console.log(`\nАвтоматически заведённые артикулы: ${report.articlesCreated.length} (из них прямая продажа сырья, помечено само: ${report.materialResaleCreated}; настоящих новых изделий без состава: ${realNew}):`);
      for (const a of report.articlesCreated.slice(0, 30)) console.log(`  · ${a}`);
      if (report.articlesCreated.length > 30) console.log(`  … и ещё ${report.articlesCreated.length - 30}`);
    }
    if (report.unmatchedMaterials.size) {
      const sorted = [...report.unmatchedMaterials.entries()].sort((a, b) => b[1].amount - a[1].amount);
      console.log(`\nНеопознанные материалы закупа (топ-30 по сумме) — завести алиас:`);
      for (const [name, v] of sorted.slice(0, 30)) console.log(`  · ${name} — ${v.qty} шт/ед, на ${Math.round(v.amount).toLocaleString('ru-RU')} ₸`);
    }
    if (report.statusGuessed.size) {
      console.log(`\nСтатусы, домапленные по смыслу (подтвердить у оператора 1С):`);
      for (const [raw, count] of report.statusGuessed) console.log(`  · «${raw}» → CONFIRMED (${count} заказов)`);
    }
    if (orderDisambig.length) {
      console.log(`\nНомера заказов клиента, столкнувшиеся в серии (разведены годом): ${orderDisambig.length}`);
      for (const d of orderDisambig.slice(0, 10)) console.log(`  · ${d.number} → ${d.key} (${d.date})`);
    }
    if (docDisambig.length) {
      console.log(`Номера заказов поставщику, столкнувшиеся в серии: ${docDisambig.length} (первые 10 из отчёта опущены для краткости)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
