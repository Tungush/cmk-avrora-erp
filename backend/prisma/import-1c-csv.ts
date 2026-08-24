/**
 * Заливка выгрузки 1С из трёх CSV-отчётов (24.08.2026): заказы (шапки+строки)
 * и номенклатура. В отличие от go-live.ts (живой HTTP 1С, недоступен с этой
 * машины), этот путь работает офлайн — оператор выгружает отчёты из 1С сам.
 *
 * Ключевая находка при разборе: «Номер» документа в выгрузке — это номер
 * внутри 1С-серии, которая сбрасывается по годам, а год в колонке не виден.
 * Пять номеров заказов клиента и 301 номер заказов поставщику в этой
 * выгрузке повторяются у РАЗНЫХ документов (разные контрагенты, суммы,
 * даты) — это коллизия серии, не дубль. Разрешается добавлением года
 * только к столкнувшимся номерам (buildUniqueKeys).
 *
 * Материалы, как и в живой синхронизации, автоматически НЕ создаются —
 * непознанные уходят в отчёт (procurement.unmatched — тот же принцип).
 * Артикулы клиентских позиций создаются, как в живой синхронизации.
 *
 * Запуск:
 *   npm run import:1c-csv -- --headers "…ЗаказыШапки.csv" --lines "…ЗаказыСтроки.csv" --nomenclature "…Номенклатура.csv" [--wipe --yes] [--dry-run]
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

async function main() {
  const headersPath = arg('--headers');
  const linesPath = arg('--lines');
  const nomPath = arg('--nomenclature');
  if (!headersPath || !linesPath || !nomPath) {
    console.log('Использование: npm run import:1c-csv -- --headers <файл> --lines <файл> --nomenclature <файл> [--wipe --yes] [--dry-run]');
    process.exit(1);
  }
  const dryRun = has('--dry-run');

  const headers = readRows(headersPath);
  const lines = readRows(linesPath);
  const nomRows = readRows(nomPath);
  console.log(`Прочитано: шапки ${headers.length}, строки ${lines.length}, номенклатура ${nomRows.length}`);

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
    docsCreated: 0, docsUpdated: 0,
    batchesCreated: 0, batchAnomalies: 0,
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
    const customerIdByName = new Map<string, string>();
    for (const name of customerNames) {
      const existing = await prisma.customer.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
      if (existing) { customerIdByName.set(name, existing.id); report.customersMatched += 1; continue; }
      const created = await prisma.customer.create({
        data: { name, binIin: slug(name), customerType: 'OUTSIDE' },
      });
      customerIdByName.set(name, created.id);
      report.customersCreated += 1;
    }
    console.log(`Сопоставлено: ${report.customersMatched}, создано новых: ${report.customersCreated}`);

    // Сама 1С называет одного контрагента по-разному в заказах клиента и
    // поставщику («LVE Group, ТОО» / «ТОО "LVE Group"») — точное сравнение
    // это не поймает и заведёт двух разных заказчиков. Не сливаем молча
    // (риск ошибочно объединить разных), только показываем — тот же принцип,
    // что и для дублей материалов (duplicateReport в nomenclature.service.ts).
    // «ТОО» встречается то до имени, то после — сортировка слов ловит и это
    const probableDuplicateCustomers = new Map<string, string[]>();
    for (const name of customerNames) {
      const key = normalizeName(name).split(' ').filter(Boolean).sort().join(' ');
      if (!key) continue;
      (probableDuplicateCustomers.get(key) ?? probableDuplicateCustomers.set(key, []).get(key)!).push(name);
    }
    for (const [key, names] of probableDuplicateCustomers) {
      if (names.length < 2) probableDuplicateCustomers.delete(key);
    }

    console.log('\n===== ЗАКАЗЫ КЛИЕНТА =====');
    const orderIdByHeader = new Map<Record<string, string>, string>();
    for (const h of clientHeaders) {
      const orderNumber = orderKeyOf.get(h)!;
      const { status, guessed } = mapStatus(h['Статус']);
      if (guessed) report.statusGuessed.set(h['Статус'], (report.statusGuessed.get(h['Статус']) ?? 0) + 1);
      const customerId = customerIdByName.get(h['Контрагент'].trim());
      const requestDate = dateOfHeader(h);
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
        },
        update: {
          onecStatus: h['Статус'],
          onecTotalAmount: num(h['СуммаДокумента']),
        },
      });
      if (existedBefore) report.ordersUpdated += 1; else report.ordersCreated += 1;
      orderIdByHeader.set(h, order.id);
    }
    console.log(`Создано: ${report.ordersCreated}, обновлено: ${report.ordersUpdated}`);

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
        article = await prisma.article.create({ data: { articleCode, name: itemName || articleCode } });
        report.articlesCreated.push(articleCode);
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
    for (const h of supplierHeaders) {
      const doNumber = docKeyOf.get(h)!;
      const contractorId = customerIdByName.get(h['Контрагент'].trim());
      const existedBefore = await prisma.paymentDocument.findUnique({ where: { doNumber }, select: { id: true } });
      const doc = await prisma.paymentDocument.upsert({
        where: { doNumber },
        create: {
          doNumber,
          doDate: dateOfHeader(h) ?? undefined,
          contractorId: contractorId!,
          currency: h['Валюта']?.trim() || 'KZT',
          totalAmount: num(h['СуммаДокумента']),
          unpaidAmount: num(h['СуммаДокумента']),
        },
        update: { totalAmount: num(h['СуммаДокумента']) },
      });
      if (existedBefore) report.docsUpdated += 1; else report.docsCreated += 1;
      docByHeader.set(h, { id: doc.id, date: dateOfHeader(h), customerName: h['Контрагент'], doNumber });
    }
    console.log(`Создано: ${report.docsCreated}, обновлено: ${report.docsUpdated}`);

    console.log('\n===== ПРИХОДЫ ПО СТРОКАМ ЗАКУПА (исторические партии) =====');
    const healthyByMaterial = new Map<string, number[]>();
    for (const l of supplierLines) {
      const header = supplierLineToHeader.get(l);
      if (!header) { report.linesUnresolvedCollision += 1; continue; }
      const doc = docByHeader.get(header);
      if (!doc) continue;
      const qty = num(l['Количество']);
      const price = num(l['Цена']);
      if (qty <= 0 || price <= 0) continue;
      const itemName = l['Номенклатура']?.trim() ?? '';
      const nomEntry = nomDict.get(normalizeName(itemName));
      const materialId = await matchMaterial(prisma, itemName, nomEntry?.code ?? '');
      if (!materialId) {
        const key = itemName || '(без названия)';
        const acc = report.unmatchedMaterials.get(key) ?? { qty: 0, amount: 0 };
        acc.qty += qty; acc.amount += num(l['Сумма']);
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
          origin: 'ONEC',
          priceAnomaly: anomaly,
          anomalyFactor: anomaly ? anomalyFactor(price, others) : null,
        },
      });
      report.batchesCreated += 1;
      if (anomaly) report.batchAnomalies += 1; else healthyByMaterial.set(materialId, [...others, price]);
    }
    console.log(`Создано исторических партий: ${report.batchesCreated} (в карантине по цене: ${report.batchAnomalies})`);
    console.log(`Неопознанных материалов (уникальных названий): ${report.unmatchedMaterials.size}`);

    console.log('\n===== ИТОГ =====');
    console.log(`Контрагенты: сопоставлено ${report.customersMatched}, создано ${report.customersCreated}`);
    if (probableDuplicateCustomers.size) {
      console.log(`Вероятные дубли контрагентов (сама 1С называет по-разному) — ${probableDuplicateCustomers.size} групп:`);
      for (const [, names] of probableDuplicateCustomers) console.log(`  · ${names.join('  ==  ')}`);
    }
    console.log(`Заказы клиента: создано ${report.ordersCreated}, обновлено ${report.ordersUpdated}`);
    console.log(`Позиции: ${report.linesCreated} (не разнесено из-за коллизии номера года: ${report.linesUnresolvedCollision})`);
    console.log(`Заказы поставщику (ДО): создано ${report.docsCreated}, обновлено ${report.docsUpdated}`);
    console.log(`Исторические партии закупа: ${report.batchesCreated}, в карантине: ${report.batchAnomalies}`);
    if (report.articlesCreated.length) {
      console.log(`\nАвтоматически заведённые артикулы (${report.articlesCreated.length}) — без состава и норм, калькуляция даст 0:`);
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
