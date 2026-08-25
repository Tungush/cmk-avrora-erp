/**
 * День Х: переход на живые данные из 1С (решение 24.08.2026).
 *
 * Порядок один и тот же на репетиции с моком и в бою:
 *   1) ping 1С через наш API — без связи ничего не сносим;
 *   2) --wipe: снос ОПЕРАЦИОННЫХ данных (заказы, деньги, склад, партии,
 *      резервы, подряд, контрагенты). Каталог остаётся:
 *      артикулы, BOM, нормы, участки, конфиг, алиасы, пользователи —
 *      1С этого не отдаёт, без них калькуляция мертва;
 *   3) --orders <файл>: заливка по списку номеров (1С не отдаёт список
 *      «что появилось» — номера даёт бизнес, вопрос №91 опросника),
 *      по каждому: заказ + закуп, в конце сводка блокеров и неопознанного.
 *
 * Запуск (бэкенд должен работать):
 *   npm run go-live -- --wipe --yes
 *   npm run go-live -- --orders numbers.txt
 *   GO_LIVE_API=http://host:3000/api/v1 GO_LIVE_EMAIL=… npm run go-live -- …
 */
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

const API = process.env.GO_LIVE_API || 'http://localhost:3000/api/v1';
const EMAIL = process.env.GO_LIVE_EMAIL || 'admin@avh.kz';
const PASSWORD = process.env.GO_LIVE_PASSWORD || '';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

async function api(path: string, method: 'GET' | 'POST', token?: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не-JSON оставляем текстом */ }
  return { status: res.status, json, text };
}

async function login(): Promise<string> {
  const r = await api('/auth/login', 'POST', undefined, {
    email: EMAIL, password: PASSWORD || undefined, roles: ['admin'],
  });
  if ((r.status !== 200 && r.status !== 201) || !r.json?.accessToken) {
    throw new Error(`Не удалось войти (${r.status}): ${r.text.slice(0, 200)}`);
  }
  return r.json.accessToken;
}

async function ping(token: string) {
  const r = await api('/integrations/1c/ping', 'GET', token);
  if (r.status !== 200) throw new Error(`ping 1С не прошёл (${r.status}): ${r.text.slice(0, 200)}`);
  console.log(`1С отвечает: ${JSON.stringify(r.json).slice(0, 160)}`);
}

/**
 * Снос операционных данных. Дети раньше родителей — порядок важен,
 * он повторяет внешние ключи схемы.
 */
export async function wipeOperationalData(prisma: PrismaClient) {
  const steps: Array<[string, () => Promise<{ count: number }>]> = [
    ['оплаты', () => prisma.payment.deleteMany()],
    ['акты приёмки', () => prisma.acceptanceAct.deleteMany()],
    ['запросы перехвата', () => prisma.batchOverrideRequest.deleteMany()],
    ['резервы партий', () => prisma.batchReservation.deleteMany()],
    ['подрядные работы', () => prisma.contractorWork.deleteMany()],
    ['труд калькуляций', () => prisma.orderCostingLabor.deleteMany()],
    ['материалы калькуляций', () => prisma.orderCostingMaterial.deleteMany()],
    ['калькуляции заказов', () => prisma.orderCosting.deleteMany()],
    ['отметки этапов', () => prisma.productionStage.deleteMany()],
    ['план производства', () => prisma.productionPlanItem.deleteMany()],
    ['движения сырья', () => prisma.materialStockMovement.deleteMany()],
    ['движения готовой продукции', () => prisma.finishedGoodsMovement.deleteMany()],
    ['платёжные документы', () => prisma.paymentDocument.deleteMany()],
    ['документы поставщиков (истор.)', () => prisma.supplierDocument.deleteMany()],
    ['заявки на закуп', () => prisma.purchaseRequest.deleteMany()],
    ['заявки на пересмотр цены', () => prisma.priceReviewRequest.deleteMany()],
    ['заявки на номенклатуру', () => prisma.nomenclatureRequest.deleteMany()],
    ['промахи поиска', () => prisma.searchMiss.deleteMany()],
    ['позиции заказов', () => prisma.orderLine.deleteMany()],
    ['партии материалов', () => prisma.materialBatch.deleteMany()],
    ['заказы', () => prisma.order.deleteMany()],
    ['сделки', () => prisma.deal.deleteMany()],
    ['сотрудники (придут из 1С)', () => prisma.employee.deleteMany()],
    ['заказчики (придут из 1С)', () => prisma.customer.deleteMany()],
    ['внешние ссылки', () => prisma.externalRef.deleteMany()],
    ['исходящие сообщения', () => prisma.outboxMessage.deleteMany()],
    ['входящие сообщения', () => prisma.inboxMessage.deleteMany()],
    ['журнал аудита', () => prisma.auditLogEntry.deleteMany()],
  ];

  // Учётки переживают снос, но их привязки указывают на удаляемые записи
  await prisma.user.updateMany({ data: { employeeId: null, linkedCustomerId: null } });

  let total = 0;
  for (const [name, run] of steps) {
    const { count } = await run();
    total += count;
    if (count > 0) console.log(`  − ${name}: ${count}`);
  }
  // Остатки Excel обнуляются: живые появятся из приходов 1С и инвентаризации
  const stock = await prisma.material.updateMany({
    where: { stockQty: { not: 0 } },
    data: { stockQty: 0 },
  });
  console.log(`  − остатки обнулены у ${stock.count} материалов`);
  console.log(`Снесено записей: ${total}`);

  const kept = {
    'артикулы': await prisma.article.count(),
    'материалы': await prisma.material.count(),
    'строки BOM': await prisma.bomItem.count(),
    'нормы труда': await prisma.routingOperation.count(),
    'алиасы': await prisma.materialAlias.count(),
    'пользователи': await prisma.user.count(),
  };
  console.log('Каталог не тронут: ' + Object.entries(kept).map(([k, v]) => `${k} ${v}`).join(', '));
}

async function syncOrders(token: string, numbers: string[]) {
  const report = {
    ok: [] as string[],
    failed: [] as Array<{ num: string; error: string }>,
    blockers: [] as Array<{ num: string; blockers: string }>,
    unmatched: new Set<string>(),
  };
  for (const num of numbers) {
    process.stdout.write(`→ ${num} … `);
    const order = await api(`/integrations/1c/sync/order/${encodeURIComponent(num)}`, 'POST', token);
    if (order.status !== 200 && order.status !== 201) {
      report.failed.push({ num, error: `заказ: ${order.status} ${order.text.slice(0, 120)}` });
      console.log('ошибка заказа');
      continue;
    }
    const blockers = order.json?.blockers ?? order.json?.data?.blockers;
    if (Array.isArray(blockers) && blockers.length) {
      report.blockers.push({ num, blockers: blockers.map((b: any) => b.code ?? b).join(', ') });
    }
    const proc = await api(`/integrations/1c/sync/procurement/${encodeURIComponent(num)}`, 'POST', token);
    if (proc.status !== 200 && proc.status !== 201) {
      report.failed.push({ num, error: `закуп: ${proc.status} ${proc.text.slice(0, 120)}` });
      console.log('заказ есть, закуп упал');
      continue;
    }
    const unmatched = proc.json?.procurement?.unmatched ?? proc.json?.unmatched ?? [];
    for (const u of unmatched) report.unmatched.add(typeof u === 'string' ? u : u?.name ?? JSON.stringify(u));
    report.ok.push(num);
    console.log(`ок${unmatched.length ? `, неопознанных позиций: ${unmatched.length}` : ''}`);
  }

  console.log('\n===== СВОДКА ЗАЛИВКИ =====');
  console.log(`Успешно: ${report.ok.length} из ${numbers.length}`);
  if (report.blockers.length) {
    console.log(`Заказы с блокерами приёма (${report.blockers.length}):`);
    for (const b of report.blockers) console.log(`  ${b.num}: ${b.blockers}`);
  }
  if (report.unmatched.size) {
    console.log(`Неопознанные материалы (${report.unmatched.size}) — завести алиас или карточку:`);
    for (const u of Array.from(report.unmatched).slice(0, 50)) console.log(`  · ${u}`);
  }
  if (report.failed.length) {
    console.log(`Ошибки (${report.failed.length}):`);
    for (const f of report.failed) console.log(`  ${f.num}: ${f.error}`);
    process.exitCode = 1;
  }
}

async function main() {
  const doWipe = has('--wipe');
  const ordersFile = val('--orders');
  if (!doWipe && !ordersFile) {
    console.log('Использование: npm run go-live -- [--wipe --yes] [--orders numbers.txt]');
    return;
  }

  const token = await login();
  await ping(token); // связи с 1С нет — дальше не идём, особенно к сносу

  if (doWipe) {
    if (!has('--yes')) {
      console.error('Снос данных необратим: добавьте --yes, чтобы подтвердить.');
      process.exit(2);
    }
    const prisma = new PrismaClient();
    try {
      console.log('\n===== СНОС ОПЕРАЦИОННЫХ ДАННЫХ =====');
      await wipeOperationalData(prisma);
    } finally {
      await prisma.$disconnect();
    }
  }

  if (ordersFile) {
    const numbers = fs.readFileSync(ordersFile, 'utf8')
      .split('\n').map((s) => s.trim()).filter(Boolean);
    console.log(`\n===== ЗАЛИВКА ${numbers.length} ЗАКАЗОВ ИЗ 1С =====`);
    await syncOrders(token, numbers);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
