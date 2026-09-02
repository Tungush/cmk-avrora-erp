/**
 * Кредитные линии ДАМУ (31.08.2026) — не 1С, а Excel, который вручную
 * выгружают из личного кабинета банка/фонда. Формат одинаковый в обоих
 * присланных файлах: лист «график ...» несёт лимит/использовано/доступно
 * и блоки траншей (номер, сумма, даты, план ОД/% по датам вперёд);
 * лист «Лист1» — факт погашений.
 *
 * Один файл может содержать несколько «график ...» листов — это разные
 * транши общего лимита за разное время (например, старая и новая
 * выборка). Каждый лист заводит/обновляет свою CreditLine по
 * contractNumber (номер общего договора в строке 4).
 *
 * Импорт идемпотентен: контракт находится по номеру, лимит/остаток
 * перезаписываются как снимок на дату файла, транши и график — upsert
 * по номеру транша/дате, факт платежей — upsert по (линия, дата, сумма).
 *
 * Запуск: npm run import:damu -- --file "…Кредит ....xlsx" --name "ДАМУ 6% А77 — 100 млн"
 */
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';

const argv = process.argv.slice(2);
function arg(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function excelDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'number') {
    // Excel serial date, 1900 system
    return new Date(Math.round((v - 25569) * 86400 * 1000));
  }
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

interface ParsedTranche {
  contractNumber: string;
  amount: number;
  startDate: Date;
  endDate: Date;
  schedule: Array<{ dueDate: Date; totalAmount: number; principalAmount: number; interestAmount: number }>;
}
interface ParsedLine {
  contractNumber: string;
  limitAmount: number;
  usedAmount: number;
  availableAmount: number;
  tranches: ParsedTranche[];
}

/** Разбирает один лист «график ...»: шапка лимитов + блоки траншей по 4 строки. */
function parseScheduleSheet(rows: unknown[][]): ParsedLine | null {
  const limitAmount = num(rows[0]?.[1]);
  const usedAmount = num(rows[1]?.[1]);
  const availableAmount = num(rows[2]?.[1]);
  const contractNumber = String(rows[3]?.[0] ?? '').trim();
  if (!contractNumber || !(limitAmount > 0)) return null;

  // Строка 6 (индекс) — даты платежей начиная с колонки F (индекс 5)
  const headerRow = rows[6] ?? [];
  const dateCols: Array<{ col: number; date: Date }> = [];
  for (let c = 5; c < headerRow.length; c += 1) {
    const d = excelDate(headerRow[c]);
    if (d) dateCols.push({ col: c, date: d });
  }

  const tranches: ParsedTranche[] = [];
  for (let r = 7; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) continue;
    const trancheContract = String(row[0] ?? '').trim();
    if (!trancheContract) continue;
    const amount = num(row[1]);
    const startDate = excelDate(row[2]);
    const endDate = excelDate(row[3]);
    if (!(amount > 0) || !startDate || !endDate) continue;

    // Следующие три строки — итого / ОД / % по тем же колонкам дат
    const totalRow = row;
    const odRow = rows[r + 1] ?? [];
    const pctRow = rows[r + 2] ?? [];
    const schedule: ParsedTranche['schedule'] = [];
    for (const { col, date } of dateCols) {
      const total = num(totalRow[col]);
      if (!(total > 0)) continue;
      schedule.push({
        dueDate: date,
        totalAmount: total,
        principalAmount: num(odRow[col]),
        interestAmount: num(pctRow[col]),
      });
    }
    tranches.push({ contractNumber: trancheContract, amount, startDate, endDate, schedule });
    r += 3; // ДП-строка и пустая строка-разделитель — пропускаем целиком блок
  }

  return { contractNumber, limitAmount, usedAmount, availableAmount, tranches };
}

/** Разбирает лист «Лист1»: фактические погашения (Дата / Общая сумма / % / ОД / Статус). */
function parsePaymentLog(rows: unknown[][]): Array<{
  paymentDate: Date; totalAmount: number; interestAmount: number; principalAmount: number; status: string;
}> {
  // Шапка «(Дата) | Общая сумма | % | ОД | Статус» — ищем по колонке B,
  // колонка A плавает («Дата» в одном файле, пусто в другом)
  let headerRow = -1;
  for (let r = 0; r < Math.min(rows.length, 10); r += 1) {
    const second = String(rows[r]?.[1] ?? '').trim().toLowerCase();
    if (second === 'общая сумма') { headerRow = r; break; }
  }
  if (headerRow < 0) return [];

  const out: Array<{ paymentDate: Date; totalAmount: number; interestAmount: number; principalAmount: number; status: string }> = [];
  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) continue;
    const paymentDate = excelDate(row[0]);
    const totalAmount = num(row[1]);
    const status = String(row[4] ?? '').trim();
    // Строки-разделители месяцев несут только текст в колонке даты — без суммы.
    // Пустой статус — это будущая строка графика, продублированная в этом же
    // листе, а не факт: банк подписывает статус только у прошедших платежей
    if (!paymentDate || !(totalAmount > 0) || !status) continue;
    out.push({ paymentDate, totalAmount, interestAmount: num(row[2]), principalAmount: num(row[3]), status });
  }
  return out;
}

async function main() {
  const filePath = arg('--file');
  const displayName = arg('--name');
  if (!filePath || !displayName) {
    console.log('Использование: npm run import:damu -- --file <файл> --name "ДАМУ 6% А77 — 100 млн"');
    process.exit(1);
  }

  const wb = XLSX.readFile(filePath, { cellDates: true });
  const scheduleSheets = wb.SheetNames.filter((n) => n.trim().toLowerCase().startsWith('график'));
  if (scheduleSheets.length === 0) {
    console.log('В файле нет листа «график ...» — нечего разбирать');
    process.exit(1);
  }
  const logSheetName = wb.SheetNames.find((n) => n.trim() === 'Лист1');

  const prisma = new PrismaClient();
  try {
    // Лист1 (факт погашений) один на весь файл, а «график ...» листов
    // может быть несколько (старая и новая выборка) — факт крепим только
    // к последнему, самому свежему листу, иначе платежи задвоятся
    const lastScheduleSheet = scheduleSheets[scheduleSheets.length - 1];
    for (const sheetName of scheduleSheets) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, raw: true });
      const parsed = parseScheduleSheet(rows);
      if (!parsed) {
        console.log(`Лист «${sheetName}»: не распознан (нет лимита или номера договора) — пропущен`);
        continue;
      }

      const line = await prisma.creditLine.upsert({
        where: { contractNumber: parsed.contractNumber },
        create: {
          name: `${displayName} · ${sheetName}`,
          contractNumber: parsed.contractNumber,
          limitAmount: parsed.limitAmount,
          usedAmount: parsed.usedAmount,
          availableAmount: parsed.availableAmount,
          asOfDate: new Date(),
          sourceFile: filePath.split('/').pop() ?? filePath,
        },
        update: {
          limitAmount: parsed.limitAmount,
          usedAmount: parsed.usedAmount,
          availableAmount: parsed.availableAmount,
          asOfDate: new Date(),
          sourceFile: filePath.split('/').pop() ?? filePath,
        },
      });

      let scheduleRows = 0;
      for (const t of parsed.tranches) {
        const tranche = await prisma.creditTranche.upsert({
          where: { creditLineId_contractNumber: { creditLineId: line.id, contractNumber: t.contractNumber } },
          create: {
            creditLineId: line.id, contractNumber: t.contractNumber,
            amount: t.amount, startDate: t.startDate, endDate: t.endDate,
          },
          update: { amount: t.amount, startDate: t.startDate, endDate: t.endDate },
        });
        for (const s of t.schedule) {
          await prisma.creditScheduleEntry.upsert({
            where: { trancheId_dueDate: { trancheId: tranche.id, dueDate: s.dueDate } },
            create: { trancheId: tranche.id, ...s },
            update: { totalAmount: s.totalAmount, principalAmount: s.principalAmount, interestAmount: s.interestAmount },
          });
          scheduleRows += 1;
        }
      }

      console.log(`Лист «${sheetName}» → линия ${parsed.contractNumber}: лимит ${parsed.limitAmount.toLocaleString('ru-RU')}, `
        + `траншей ${parsed.tranches.length}, плановых платежей ${scheduleRows}`);

      if (logSheetName && sheetName === lastScheduleSheet) {
        const logRows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[logSheetName], { header: 1, raw: true });
        const payments = parsePaymentLog(logRows);
        let created = 0;
        for (const p of payments) {
          await prisma.creditPayment.upsert({
            where: { creditLineId_paymentDate: { creditLineId: line.id, paymentDate: p.paymentDate } },
            create: { creditLineId: line.id, ...p },
            update: { status: p.status, interestAmount: p.interestAmount, principalAmount: p.principalAmount, totalAmount: p.totalAmount },
          });
          created += 1;
        }
        console.log(`  факт погашений из «${logSheetName}»: ${created}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
