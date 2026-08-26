import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';

const n = (v: unknown) => Number(v ?? 0);
const DAY = 24 * 60 * 60 * 1000;

/**
 * Раздел «Закупки» — заказы поставщику (ДО) из 1С (26.08.2026).
 *
 * До этого закуп был виден только косвенно: 85 документов из 306 всплывали
 * в журнале приходов, остальные 221 недостижимы из интерфейса вообще.
 *
 * Все цифры считаются по колонкам, реально заполненным в выгрузке. Там, где
 * данных нет, ответ несёт явный счётчик «не размечено», а не тихий ноль:
 * категория затрат есть у 94 ДО из 306, утвердитель — у 94, склад — у 281.
 */
@ApiTags('Purchases')
@ApiBearerAuth()
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('dashboard')
  @Roles('procurement', 'accountant', 'director', 'admin')
  @ApiOperation({ summary: 'Дашборд закупок: сколько должны, куда ушло, где обошли процедуру' })
  async dashboard() {
    return runWithFallback(
      this.prisma,
      async () => {
        const docs = await this.prisma.paymentDocument.findMany({
          include: {
            contractor: { select: { id: true, name: true } },
            _count: { select: { batches: true, lines: true } },
          },
        });
        const now = Date.now();
        const kzt = docs.filter((d) => (d.currency ?? 'KZT') === 'KZT');
        const other = docs.filter((d) => (d.currency ?? 'KZT') !== 'KZT');

        const unpaid = kzt.filter((d) => n(d.unpaidAmount) > 0);
        const ageOf = (d: (typeof docs)[number]) =>
          d.doDate ? Math.floor((now - new Date(d.doDate).getTime()) / DAY) : 0;

        // Срок оплаты 1С не отдаёт — считаем возраст от даты документа
        // и говорим об этом прямо в подписи на экране
        const overdue30 = unpaid.filter((d) => ageOf(d) > 30);
        const bucket = (from: number, to: number) =>
          unpaid.filter((d) => ageOf(d) > from && ageOf(d) <= to);

        const monthAgo = now - 30 * DAY;
        const prevMonth = now - 60 * DAY;
        const inRange = (d: (typeof docs)[number], from: number, to: number) =>
          d.doDate && new Date(d.doDate).getTime() > from && new Date(d.doDate).getTime() <= to;
        const spendMonth = kzt.filter((d) => inRange(d, monthAgo, now));
        const spendPrev = kzt.filter((d) => inRange(d, prevMonth, monthAgo));

        const noReceipt = docs.filter((d) => d._count.batches === 0);

        const sum = (list: typeof docs, f: (d: (typeof docs)[number]) => number) =>
          list.reduce((s, d) => s + f(d), 0);

        // Разрезы: считаем сразу все, переключение на фронте без похода на сервер
        const cut = (key: (d: (typeof docs)[number]) => string | null) => {
          const map = new Map<string, { docs: number; total: number; telecom: number; other: number }>();
          for (const d of kzt) {
            const k = key(d) ?? '__none__';
            const acc = map.get(k) ?? { docs: 0, total: 0, telecom: 0, other: 0 };
            acc.docs += 1;
            acc.total += n(d.totalAmount);
            if (d.businessDirection === 'ЦМК Телекоммуникации') acc.telecom += n(d.totalAmount);
            else acc.other += n(d.totalAmount);
            map.set(k, acc);
          }
          return [...map.entries()]
            .map(([k, v]) => ({ key: k === '__none__' ? null : k, ...v }))
            .sort((a, b) => b.total - a.total);
        };

        const bySupplier = new Map<string, { id: string; name: string; docs: number; total: number; paid: number; unpaid: number; noReceipt: number; lastDate: Date | null }>();
        for (const d of docs) {
          const key = d.contractorId;
          const acc = bySupplier.get(key) ?? {
            id: d.contractorId, name: d.contractor?.name ?? '—',
            docs: 0, total: 0, paid: 0, unpaid: 0, noReceipt: 0, lastDate: null,
          };
          acc.docs += 1;
          if ((d.currency ?? 'KZT') === 'KZT') {
            acc.total += n(d.totalAmount);
            acc.paid += n(d.paidAmount);
            acc.unpaid += n(d.unpaidAmount);
          }
          if (d._count.batches === 0) acc.noReceipt += 1;
          if (d.doDate && (!acc.lastDate || d.doDate > acc.lastDate)) acc.lastDate = d.doDate;
          bySupplier.set(key, acc);
        }
        const suppliers = [...bySupplier.values()].sort((a, b) => b.total - a.total);
        const totalKzt = sum(kzt, (d) => n(d.totalAmount));

        // Контроль: то, что считается по колонкам, заполненным на 306/306
        const noApprover = docs.filter((d) => !d.approver);
        const slowApproval = docs.filter((d) =>
          d.approvedAt && d.doDate
          && (new Date(d.approvedAt).getTime() - new Date(d.doDate).getTime()) / DAY > 30);
        // Сравниваем ТОЛЬКО календарные дни: doDate несёт время из 1С
        // («27.08.2025 21:57:34»), а supplierDocDate — полночь, и наивное
        // сравнение объявляло бы «задним числом» каждый документ,
        // оформленный в тот же день (284 вместо 85).
        const dayOf = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
        const backdated = docs.filter((d) =>
          d.supplierDocDate && d.doDate
          && dayOf(new Date(d.supplierDocDate)) < dayOf(new Date(d.doDate)));
        const noWarehouse = docs.filter((d) => !d.warehouseName);
        const overpaid = docs.filter((d) => n(d.paidAmount) > n(d.totalAmount));

        return {
          kpi: {
            owed: {
              amount: sum(unpaid, (d) => n(d.unpaidAmount)),
              docs: unpaid.length,
              totalDocs: docs.length,
              otherCurrencies: [...other.reduce((m, d) => {
                const c = d.currency ?? '—';
                m.set(c, (m.get(c) ?? 0) + n(d.unpaidAmount));
                return m;
              }, new Map<string, number>())].map(([currency, amount]) => ({ currency, amount }))
                .filter((x) => x.amount > 0),
            },
            overdue30: {
              amount: sum(overdue30, (d) => n(d.unpaidAmount)),
              docs: overdue30.length,
              over90: bucket(90, 1e9).length,
              over90Amount: sum(bucket(90, 1e9), (d) => n(d.unpaidAmount)),
            },
            spendMonth: {
              amount: sum(spendMonth, (d) => n(d.totalAmount)),
              docs: spendMonth.length,
              prevAmount: sum(spendPrev, (d) => n(d.totalAmount)),
            },
            noReceipt: {
              docs: noReceipt.length,
              totalDocs: docs.length,
              paidDocs: noReceipt.filter((d) => n(d.paidAmount) > 0).length,
              paidAmount: sum(noReceipt.filter((d) => n(d.paidAmount) > 0), (d) => n(d.paidAmount)),
            },
          },
          totalKzt,
          dimensions: {
            project: cut((d) => d.projectName),
            costCategory: cut((d) => d.costCategory),
            author: cut((d) => d.author),
            manager: cut((d) => d.managerName),
            warehouse: cut((d) => d.warehouseName),
            division: cut((d) => d.division),
          },
          // Возраст неоплаченного: единственная честная замена сроку оплаты
          buckets: [
            { label: '90+ дней', ...agg(bucket(90, 1e9)) },
            { label: '61–90 дней', ...agg(bucket(60, 90)) },
            { label: '31–60 дней', ...agg(bucket(30, 60)) },
            { label: 'до 30 дней', ...agg(bucket(-1, 30)) },
          ],
          unpaidDocs: unpaid
            .sort((a, b) => ageOf(b) - ageOf(a))
            .map((d) => ({
              id: d.id, doNumber: d.doNumber, doDate: d.doDate,
              ageDays: ageOf(d), supplier: d.contractor?.name ?? '—',
              supplierId: d.contractorId, currency: d.currency,
              totalAmount: n(d.totalAmount), paidAmount: n(d.paidAmount),
              unpaidAmount: n(d.unpaidAmount),
            })),
          suppliers: suppliers.slice(0, 10),
          supplierStats: {
            total: suppliers.length,
            top5Share: totalKzt ? suppliers.slice(0, 5).reduce((s, x) => s + x.total, 0) / totalKzt : 0,
            top10Share: totalKzt ? suppliers.slice(0, 10).reduce((s, x) => s + x.total, 0) / totalKzt : 0,
            oneOff: suppliers.filter((s) => s.docs === 1).length,
          },
          control: [
            { code: 'noApprover', label: 'без утвердителя', docs: noApprover.length, amount: sum(noApprover, (d) => n(d.totalAmount)) },
            { code: 'slowApproval', label: 'согласование дольше 30 дней', docs: slowApproval.length, amount: sum(slowApproval, (d) => n(d.totalAmount)) },
            { code: 'backdated', label: 'документ поставщика раньше нашего заказа', docs: backdated.length, amount: sum(backdated, (d) => n(d.totalAmount)) },
            { code: 'noWarehouse', label: 'без склада', docs: noWarehouse.length, amount: sum(noWarehouse, (d) => n(d.totalAmount)) },
            { code: 'overpaid', label: 'оплачено больше суммы документа', docs: overpaid.length, amount: sum(overpaid, (d) => n(d.paidAmount) - n(d.totalAmount)) },
          ],
        };

        function agg(list: typeof docs) {
          return { docs: list.length, amount: list.reduce((s, d) => s + n(d.unpaidAmount), 0) };
        }
      },
      () => null,
    );
  }

  @Get('documents')
  @Roles('procurement', 'accountant', 'director', 'admin')
  @ApiOperation({ summary: 'Реестр заказов поставщику: все 306, а не только те, где опознан материал' })
  async documents(@Query() q: {
    search?: string; page?: string; pageSize?: string;
    direction?: string; project?: string; costCategory?: string; warehouse?: string;
    supplierId?: string; unpaidOnly?: string; hasBatches?: string; overdueDays?: string; control?: string;
  }) {
    const page = Number(q.page) || 1;
    const pageSize = Math.min(200, Number(q.pageSize) || 50);
    const where: any = {};
    if (q.search) {
      where.OR = [
        { doNumber: { contains: q.search, mode: 'insensitive' } },
        { supplierDocNumber: { contains: q.search, mode: 'insensitive' } },
        { contractor: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }
    if (q.direction) where.businessDirection = q.direction;
    if (q.project) where.projectName = q.project === '__none__' ? null : q.project;
    if (q.costCategory) where.costCategory = q.costCategory === '__none__' ? null : q.costCategory;
    if (q.warehouse) where.warehouseName = q.warehouse === '__none__' ? null : q.warehouse;
    if (q.supplierId) where.contractorId = q.supplierId;
    if (q.unpaidOnly === '1') where.unpaidAmount = { gt: 0 };
    if (q.hasBatches === '0') where.batches = { none: {} };
    if (q.hasBatches === '1') where.batches = { some: {} };
    if (q.control === 'noApprover') where.approver = null;
    if (q.control === 'noWarehouse') where.warehouseName = null;
    if (q.overdueDays) {
      const cutoff = new Date(Date.now() - Number(q.overdueDays) * DAY);
      where.doDate = { lt: cutoff };
      where.unpaidAmount = { gt: 0 };
    }

    return runWithFallback(
      this.prisma,
      async () => {
        const [rows, total] = await Promise.all([
          this.prisma.paymentDocument.findMany({
            where, skip: (page - 1) * pageSize, take: pageSize,
            orderBy: { doDate: 'desc' },
            include: {
              contractor: { select: { id: true, name: true } },
              _count: { select: { batches: true, lines: true } },
            },
          }),
          this.prisma.paymentDocument.count({ where }),
        ]);
        return {
          data: rows.map((d) => ({
            id: d.id, doNumber: d.doNumber, doDate: d.doDate, status: d.status,
            supplier: d.contractor?.name ?? '—', supplierId: d.contractorId,
            currency: d.currency,
            totalAmount: n(d.totalAmount), paidAmount: n(d.paidAmount), unpaidAmount: n(d.unpaidAmount),
            businessDirection: d.businessDirection, projectName: d.projectName,
            costCategory: d.costCategory, warehouseName: d.warehouseName,
            linesCount: d._count.lines, batchesCount: d._count.batches,
          })),
          meta: { page, pageSize, total },
        };
      },
      () => ({ data: [], meta: { page, pageSize, total: 0 } }),
    );
  }
}
