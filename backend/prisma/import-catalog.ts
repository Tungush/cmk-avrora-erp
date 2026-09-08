/**
 * Загрузка НАШИХ данных по изделиям: состав (BOM) и нормы труда.
 * Источник — таблица инженера (Google Таблицы → «Файл → Скачать → CSV»).
 *
 * Почему отдельно от 1С: состав изделия и нормы труда 1С не отдаёт и не
 * знает — это область конструктора. Всё, что приходит из 1С (заказы,
 * контрагенты, оплаты, приходы, остатки), грузится import-1c-csv.ts и
 * руками не правится.
 *
 * Правила, на которых стоит импорт:
 *   1. Ничего не создаёт в справочниках. Неизвестный артикул или материал —
 *      в отчёт, строка пропускается. Иначе в каталоге заводятся призраки.
 *   2. По умолчанию НИЧЕГО не пишет: печатает план и проблемы. Запись —
 *      только с флагом --apply.
 *   3. Идемпотентен: повторный прогон того же файла не создаёт дублей.
 *   4. Считает line_cost по текущей цене закупа материала. Себестоимость
 *      изделия пересчитывается отдельно: npm run recalc:costing.
 *
 * Формат файлов (первая строка — заголовки, порядок колонок любой,
 * разделитель ; или , определяется сам, лишние колонки игнорируются):
 *
 *   Состав (--bom):
 *     Артикул | Материал | Количество | Операция
 *     n-059   | С0104    | 0,44       | резка
 *   «Материал» — код из справочника или точное наименование.
 *   «Операция» необязательна, по умолчанию «сборка/сварка».
 *
 *   Нормы (--norms):
 *     Артикул | Передел | Человек | Часов
 *     n-059   | резка   | 2       | 0,25
 *   «Передел»: резка | сборка | покраска (принимаются полные названия).
 *
 * Запуск:
 *   npm run import:catalog -- --bom состав.csv --norms нормы.csv
 *   npm run import:catalog -- --bom состав.csv --apply
 *   npm run import:catalog -- --bom состав.csv --apply --replace
 *     --replace: состав изделия заменяется целиком (строки, которых нет в
 *     файле, удаляются). Без него строки добавляются и обновляются.
 */
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { normalizeName } from './lib/nomenclature';

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const arg = (f: string): string | null => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const has = (f: string) => argv.includes(f);

const APPLY = has('--apply');
const REPLACE = has('--replace');
/** Заводить изделия прайса, которых нет в справочнике (только для --prices) */
const CREATE_MISSING = has('--create-missing');

/** CSV с автоопределением разделителя; кавычки по RFC, BOM снимается */
function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const head = clean.slice(0, clean.indexOf('\n') >= 0 ? clean.indexOf('\n') : clean.length);
  const delim = [';', '\t', ',']
    .map((d) => ({ d, n: head.split(d).length }))
    .sort((a, b) => b.n - a.n)[0].d;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; continue; }
        inQuotes = false; continue;
      }
      field += c; continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Заголовок → ключ: регистр, пробелы и знаки не важны */
const key = (s: string) => s.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');

function readTable(file: string, synonyms: Record<string, string[]>): Array<Record<string, string>> {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (rows.length < 2) throw new Error(`${file}: нет строк данных`);
  const header = rows[0].map(key);
  const index: Record<string, number> = {};
  for (const [field, names] of Object.entries(synonyms)) {
    const want = names.map(key);
    const at = header.findIndex((h) => want.includes(h));
    if (at >= 0) index[field] = at;
  }
  const missing = Object.keys(synonyms).filter((f) => index[f] === undefined && !f.endsWith('?'));
  if (missing.length) {
    throw new Error(
      `${file}: не найдены колонки ${missing.join(', ')}. ` +
      `В файле есть: ${rows[0].map((h) => h.trim()).filter(Boolean).join(' | ')}`,
    );
  }
  return rows.slice(1).map((r) => {
    const out: Record<string, string> = {};
    for (const [field, at] of Object.entries(index)) out[field] = (r[at] ?? '').trim();
    return out;
  });
}

/** «0,44», «1 200,5», «1 200.5» → число; пусто и мусор → null */
function num(raw: string): number | null {
  if (!raw) return null;
  const s = raw.replace(/ |\s/g, '').replace(',', '.');
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

const OPERATIONS: Record<string, string> = {
  резка: 'CUTTING',
  раскрой: 'CUTTING',
  сборкасварка: 'WELDING_ASSEMBLY',
  сборка: 'WELDING_ASSEMBLY',
  сварка: 'WELDING_ASSEMBLY',
  обшивка: 'CLADDING',
  покраска: 'PAINTING',
  зачисткапокраска: 'PAINTING',
};
const STAGES: Record<string, string> = {
  резка: 'CUTTING',
  раскрой: 'CUTTING',
  сборка: 'ASSEMBLY',
  сборкасваркаобшивка: 'ASSEMBLY',
  сборкасварка: 'ASSEMBLY',
  сварка: 'ASSEMBLY',
  обшивка: 'ASSEMBLY',
  покраска: 'PAINTING',
  зачисткапокраска: 'PAINTING',
};
const STAGE_ORDER: Record<string, number> = { CUTTING: 0, ASSEMBLY: 1, PAINTING: 2 };

interface Report {
  rows: number;
  ok: number;
  unknownArticles: Map<string, number>;
  unknownMaterials: Map<string, number>;
  badNumbers: string[];
  badStages: Map<string, number>;
  defaulted: number;
}
const emptyReport = (): Report => ({
  rows: 0, ok: 0, unknownArticles: new Map(), unknownMaterials: new Map(),
  badNumbers: [], badStages: new Map(), defaulted: 0,
});
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

async function loadArticles() {
  const rows = await prisma.article.findMany({ select: { id: true, articleCode: true } });
  const byCode = new Map<string, string>();
  for (const a of rows) byCode.set(a.articleCode.trim().toLowerCase(), a.id);
  return byCode;
}

async function loadMaterials() {
  const rows = await prisma.material.findMany({
    select: { id: true, materialCode: true, name: true, purchasePrice: true },
  });
  const byCode = new Map<string, { id: string; price: number }>();
  const byName = new Map<string, { id: string; price: number }>();
  for (const m of rows) {
    const v = { id: m.id, price: Number(m.purchasePrice) };
    byCode.set(m.materialCode.trim().toLowerCase(), v);
    const n = normalizeName(m.name);
    if (n && !byName.has(n)) byName.set(n, v);
  }
  return { byCode, byName };
}

async function importBom(file: string) {
  const table = readTable(file, {
    article: ['Артикул', 'Артикул изделия', 'Код изделия', 'Изделие'],
    material: ['Материал', 'Код материала', 'Артикул материала', 'Номенклатура'],
    qty: ['Количество', 'Кол-во', 'Норма', 'Количество на единицу', 'Расход'],
    'operation?': ['Операция', 'Передел', 'Вид работ'],
  });
  const articles = await loadArticles();
  const materials = await loadMaterials();
  const rep = emptyReport();

  // Строки, сгруппированные по изделию: так работает и --replace, и проверка дублей
  const byArticle = new Map<string, Array<{ materialId: string; qty: number; operation: string; price: number }>>();
  const seen = new Set<string>();

  for (const r of table) {
    rep.rows += 1;
    const articleId = articles.get(r.article.toLowerCase());
    if (!articleId) { bump(rep.unknownArticles, r.article || '(пусто)'); continue; }
    const mat = materials.byCode.get(r.material.toLowerCase()) ?? materials.byName.get(normalizeName(r.material));
    if (!mat) { bump(rep.unknownMaterials, r.material || '(пусто)'); continue; }
    const qty = num(r.qty);
    if (qty === null || qty <= 0) {
      rep.badNumbers.push(`${r.article} · ${r.material}: количество «${r.qty}»`);
      continue;
    }
    let operation = 'WELDING_ASSEMBLY';
    if (r['operation?']) {
      const found = OPERATIONS[key(r['operation?'])];
      if (!found) { bump(rep.badStages, r['operation?']); continue; }
      operation = found;
    } else {
      rep.defaulted += 1;
    }
    const dup = `${articleId}|${mat.id}|${operation}`;
    if (seen.has(dup)) {
      rep.badNumbers.push(`${r.article} · ${r.material} · ${operation}: строка повторяется в файле`);
      continue;
    }
    seen.add(dup);
    const list = byArticle.get(articleId) ?? [];
    list.push({ materialId: mat.id, qty, operation, price: mat.price });
    byArticle.set(articleId, list);
    rep.ok += 1;
  }

  console.log(`\n=== СОСТАВ ИЗДЕЛИЙ (${file}) ===`);
  printReport(rep, byArticle.size);

  if (!APPLY) return;
  let written = 0;
  let removed = 0;
  for (const [articleId, items] of byArticle) {
    if (REPLACE) {
      const keep = items.map((i) => `${i.materialId}|${i.operation}`);
      const existing = await prisma.bomItem.findMany({ where: { articleId }, select: { id: true, materialId: true, operationType: true } });
      const extra = existing.filter((e) => !keep.includes(`${e.materialId}|${e.operationType}`));
      if (extra.length) {
        await prisma.bomItem.deleteMany({ where: { id: { in: extra.map((e) => e.id) } } });
        removed += extra.length;
      }
    }
    for (const i of items) {
      await prisma.bomItem.upsert({
        where: { articleId_materialId_operationType: { articleId, materialId: i.materialId, operationType: i.operation as never } },
        create: {
          articleId, materialId: i.materialId, operationType: i.operation as never,
          qtyPerUnit: i.qty, lineCost: round2(i.qty * i.price),
        },
        update: { qtyPerUnit: i.qty, lineCost: round2(i.qty * i.price) },
      });
      written += 1;
    }
  }
  console.log(`Записано строк состава: ${written}${removed ? `, удалено лишних: ${removed}` : ''}`);
}

async function importNorms(file: string) {
  const table = readTable(file, {
    article: ['Артикул', 'Артикул изделия', 'Код изделия', 'Изделие'],
    stage: ['Передел', 'Этап', 'Операция', 'Вид работ'],
    workers: ['Человек', 'Рабочих', 'Кол-во человек', 'Люди'],
    hours: ['Часов', 'Часы', 'Часов на единицу', 'Норма часов', 'Нормочасы'],
  });
  const articles = await loadArticles();
  const rep = emptyReport();
  const plan = new Map<string, { articleId: string; stage: string; workers: number; hours: number }>();

  for (const r of table) {
    rep.rows += 1;
    const articleId = articles.get(r.article.toLowerCase());
    if (!articleId) { bump(rep.unknownArticles, r.article || '(пусто)'); continue; }
    const stage = STAGES[key(r.stage)];
    if (!stage) { bump(rep.badStages, r.stage || '(пусто)'); continue; }
    const workers = num(r.workers);
    const hours = num(r.hours);
    if (workers === null || workers <= 0 || hours === null || hours < 0) {
      rep.badNumbers.push(`${r.article} · ${r.stage}: человек «${r.workers}», часов «${r.hours}»`);
      continue;
    }
    plan.set(`${articleId}|${stage}`, { articleId, stage, workers, hours });
    rep.ok += 1;
  }

  console.log(`\n=== НОРМЫ ТРУДА (${file}) ===`);
  printReport(rep, new Set([...plan.values()].map((p) => p.articleId)).size);

  if (!APPLY) return;
  let written = 0;
  for (const p of plan.values()) {
    await prisma.routingOperation.upsert({
      where: { articleId_stage: { articleId: p.articleId, stage: p.stage as never } },
      create: {
        articleId: p.articleId, stage: p.stage as never, workers: p.workers,
        hoursPerUnit: p.hours, sortOrder: STAGE_ORDER[p.stage] ?? 0,
      },
      update: { workers: p.workers, hoursPerUnit: p.hours },
    });
    written += 1;
  }
  console.log(`Записано норм: ${written}`);
}

async function importPrices(file: string) {
  const table = readTable(file, {
    article: ['Артикул', 'Арт.', 'Арт', 'Код изделия', 'Изделие'],
    price: ['Цена', 'УТВ цена', 'Утверждённая цена', 'Утвержденная цена', 'Прайс'],
    'name?': ['Наименование', 'Название', 'Изделие'],
  });
  const articles = await prisma.article.findMany({ select: { id: true, articleCode: true, approvedPrice: true } });
  const byCode = new Map(articles.map((a) => [a.articleCode.trim().toLowerCase(), a]));
  const rep = emptyReport();
  const plan: Array<{ id: string; price: number }> = [];
  /** Изделия, встреченные в файле: они и составляют прайс-лист */
  const inList: string[] = [];
  let same = 0;

  // Прайс — это список того, что завод продаёт: изделие из прайса обязано
  // быть в справочнике. По умолчанию импорт справочник не пополняет (общее
  // правило), но с --create-missing заводит недостающие позиции прайса по
  // коду и наименованию — состав, нормы и вес к ним придут своим импортом.
  const created: string[] = [];
  if (CREATE_MISSING && APPLY) {
    for (const r of table) {
      if (byCode.has(r.article.toLowerCase()) || !r.article.trim()) continue;
      const name = (r['name?'] ?? '').trim() || r.article;
      const made = await prisma.article.create({
        data: { articleCode: r.article.trim(), name, isActive: true },
        select: { id: true, articleCode: true, approvedPrice: true },
      });
      byCode.set(made.articleCode.trim().toLowerCase(), made);
      created.push(`${made.articleCode} · ${name}`);
    }
  }

  for (const r of table) {
    rep.rows += 1;
    const a = byCode.get(r.article.toLowerCase());
    if (!a) { bump(rep.unknownArticles, r.article || '(пусто)'); continue; }
    const price = num(r.price);
    if (price === null || price <= 0) {
      rep.badNumbers.push(`${r.article}: цена «${r.price}»`);
      continue;
    }
    rep.ok += 1;
    inList.push(a.id);
    // Цена не изменилась — это не «изменение», в историю писать нечего
    if (Math.abs(Number(a.approvedPrice) - price) < 1) { same += 1; continue; }
    plan.push({ id: a.id, price });
  }

  console.log(`\n=== УТВЕРЖДЁННЫЕ ЦЕНЫ (${file}) ===`);
  printReport(rep, plan.length + same);
  console.log(`  Цена совпала с уже утверждённой: ${same}, к изменению: ${plan.length}`);
  if (created.length) {
    console.log(`  Заведено изделий по прайсу: ${created.length}`);
    for (const c of created) console.log(`    ${c}`);
  } else if (rep.unknownArticles.size && !CREATE_MISSING) {
    console.log('  Чтобы завести недостающие изделия прайса, добавьте --create-missing');
  }

  if (!APPLY) return;
  // Автор изменения — директор: утверждённая цена в файле уже его решение
  const director = await prisma.user.findFirst({ where: { email: 'director@avh.kz' }, select: { id: true } });
  if (!director) throw new Error('Учётка director@avh.kz не найдена — некому приписать историю цены');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const p of plan) {
    await prisma.$transaction([
      prisma.article.update({ where: { id: p.id }, data: { approvedPrice: p.price } }),
      prisma.priceHistory.create({ data: { articleId: p.id, price: p.price, validFrom: today, changedBy: director.id } }),
    ]);
  }
  console.log(`Обновлено цен (с записью в историю): ${plan.length}`);

  // Прайс-лист — это ровно то, что в файле. Отмечаем встреченные и, при
  // --replace, снимаем отметку с тех, кого в файле нет: экран «Прайс-лист»
  // обязан показывать таблицу завода, а не всё, чему когда-то ставили цену
  await prisma.article.updateMany({ where: { id: { in: inList } }, data: { priceListAt: today } });
  if (REPLACE) {
    const dropped = await prisma.article.updateMany({
      where: { id: { notIn: inList }, priceListAt: { not: null } },
      data: { priceListAt: null },
    });
    if (dropped.count) console.log(`Убрано из прайс-листа (в файле их нет): ${dropped.count}`);
  }
  console.log(`В прайс-листе теперь: ${inList.length} изделий`);
}

function printReport(rep: Report, articles: number) {
  console.log(`Строк в файле: ${rep.rows}, принято: ${rep.ok}, изделий затронуто: ${articles}`);
  if (rep.defaulted) console.log(`  Операция не указана у ${rep.defaulted} строк — принято «сборка/сварка»`);
  const list = (title: string, m: Map<string, number>) => {
    if (!m.size) return;
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log(`  ${title}: ${m.size}`);
    for (const [k, n] of top) console.log(`    ${k} (строк: ${n})`);
    if (m.size > top.length) console.log(`    … и ещё ${m.size - top.length}`);
  };
  list('НЕТ В СПРАВОЧНИКЕ ИЗДЕЛИЙ', rep.unknownArticles);
  list('НЕТ В СПРАВОЧНИКЕ МАТЕРИАЛОВ', rep.unknownMaterials);
  list('НЕПОНЯТНЫЙ ПЕРЕДЕЛ/ОПЕРАЦИЯ', rep.badStages);
  if (rep.badNumbers.length) {
    console.log(`  ПЛОХИЕ ЧИСЛА И ПОВТОРЫ: ${rep.badNumbers.length}`);
    for (const b of rep.badNumbers.slice(0, 15)) console.log(`    ${b}`);
    if (rep.badNumbers.length > 15) console.log(`    … и ещё ${rep.badNumbers.length - 15}`);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const bom = arg('--bom');
  const norms = arg('--norms');
  const prices = arg('--prices');
  if (!bom && !norms && !prices) {
    console.log('Укажите файлы: --bom состав.csv, --norms нормы.csv, --prices прайс.csv (описание — в docs/ЗАПОЛНЕНИЕ.md)');
    process.exit(2);
  }
  if (!APPLY) console.log('РЕЖИМ ПРОВЕРКИ: в базу ничего не пишется. Добавьте --apply, когда отчёт устроит.');
  if (REPLACE && APPLY) console.log('РЕЖИМ ЗАМЕНЫ: состав перечисленных изделий будет заменён целиком.');

  if (bom) await importBom(bom);
  if (norms) await importNorms(norms);
  if (prices) await importPrices(prices);

  if (APPLY) {
    console.log('\nГотово. Дальше: npm run recalc:costing — пересчитать себестоимость затронутых изделий.');
  }
}

main()
  .catch((e) => { console.error(e.message ?? e); process.exit(1); })
  .finally(() => prisma.$disconnect());
