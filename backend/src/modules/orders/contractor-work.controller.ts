import {
  Controller, Get, Post, Patch, Delete, Param, Query, Body,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';

const RATE_TYPES = new Set(['PER_HOUR', 'PER_UNIT', 'PER_KG', 'PER_TON', 'FIXED']);
const STAGES = new Set(['CUTTING', 'ASSEMBLY', 'PAINTING']);

/** Пользователь БД или демо-пользователь (usr-*), которого в базе нет */
const dbUserId = (u?: UserPayload) =>
  u && !u.userId.startsWith('usr-') ? u.userId : null;

/**
 * Подряд на переделе (решение 23.08.2026: «норматив молчит, подряд говорит»).
 *
 * Штат здесь не заводится никогда: норма изделия — это и есть план штата,
 * и остаток объёма (1 − Σ доля подряда) достаётся ему автоматически.
 * Руками заводится ровно одно — исключение: «этот передел забрал подрядчик X».
 *
 * Приёмка работы (actualQty + actualAmount) замораживает сумму: платим то,
 * что приняли, даже если ставка в справочнике потом изменится.
 *
 * Финансовая сверка — против ДО (PaymentDocument) из «Заказа поставщику» 1С:
 * для 1С подрядчик такой же поставщик, просто продаёт работы. Связь
 * Contractor ↔ Customer только по БИН.
 */
@ApiTags('Contractor Work')
@ApiBearerAuth()
@Controller()
export class ContractorWorkController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('contractors')
  @ApiOperation({ summary: 'Справочник подрядчиков' })
  async contractors(@Query() query: { activeOnly?: string }) {
    return runWithFallback(
      this.prisma,
      () => this.prisma.contractor.findMany({
        where: query.activeOnly === 'false' ? {} : { isActive: true },
        orderBy: { name: 'asc' },
      }),
      () => [],
    );
  }

  /**
   * Все работы подряда одним списком — экран «Подряд». Без него подряд
   * виден только внутри отметки этапа и карточки заказа, то есть увидеть
   * «кто у нас сейчас что делает и сколько мы должны» негде.
   */
  @Get('contractor-work')
  @Roles('planner', 'sales_manager', 'director', 'accountant', 'admin')
  @ApiOperation({ summary: 'Все работы подрядчиков: что делают, сколько должны, что принято' })
  async allWork(@Query() query: { contractorId?: string; onlyOpen?: string }) {
    const works = await this.prisma.contractorWork.findMany({
      where: {
        ...(query.contractorId ? { contractorId: query.contractorId } : {}),
        ...(query.onlyOpen === 'true' ? { acceptedAt: null } : {}),
        order: { isArchived: false },
      },
      include: {
        contractor: { select: { id: true, name: true, binIin: true } },
        order: { select: { id: true, orderNumber: true, status: true, plannedShipmentDate: true } },
      },
      orderBy: [{ acceptedAt: { sort: 'asc', nulls: 'first' } }, { decidedAt: 'desc' }],
      take: 300,
    });

    const rows = works.map((w) => {
      const amount = w.actualAmount != null
        ? Number(w.actualAmount)
        : w.actualQty != null
          ? Number(w.actualQty) * Number(w.rate)
          : null;
      return {
        id: w.id,
        order: w.order,
        contractor: w.contractor,
        routingStage: w.routingStage,
        share: Number(w.share),
        rateType: w.rateType,
        rate: Number(w.rate),
        actualQty: w.actualQty != null ? Number(w.actualQty) : null,
        amount,
        workLocation: w.workLocation,
        isAccepted: w.acceptedAt != null,
        acceptedAt: w.acceptedAt,
        decidedAt: w.decidedAt,
        reason: w.reason,
      };
    });

    // Итог по подрядчикам: сколько работ в работе и сколько денег принято
    const byContractor = new Map<string, { id: string; name: string; open: number; accepted: number; amount: number }>();
    for (const r of rows) {
      const acc = byContractor.get(r.contractor.id) ?? {
        id: r.contractor.id, name: r.contractor.name, open: 0, accepted: 0, amount: 0,
      };
      if (r.isAccepted) { acc.accepted++; acc.amount += r.amount ?? 0; } else acc.open++;
      byContractor.set(r.contractor.id, acc);
    }

    return { data: rows, byContractor: [...byContractor.values()], total: rows.length };
  }

  @Get('orders/:orderId/contractor-work')
  @ApiOperation({ summary: 'Подряд по заказу со сверкой против актов 1С' })
  async orderWork(@Param('orderId') orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${orderId} not found` });

    const works = await this.prisma.contractorWork.findMany({
      where: { orderId },
      include: { contractor: { select: { id: true, name: true, binIin: true } } },
      orderBy: [{ routingStage: 'asc' }, { decidedAt: 'desc' }],
    });

    /** Сколько мы должны подрядчику: принятая сумма, иначе расчёт по объёму */
    const amountOf = (w: (typeof works)[number]) => {
      if (w.actualAmount != null) return Number(w.actualAmount);
      if (w.actualQty != null) return Number(w.actualQty) * Number(w.rate);
      return 0;
    };

    const contractorBins = [...new Set(works.map((w) => w.contractor.binIin).filter(Boolean))] as string[];
    const acts = contractorBins.length
      ? await this.prisma.paymentDocument.findMany({
          where: { orderId, contractor: { binIin: { in: contractorBins } } },
          include: { contractor: { select: { binIin: true } } },
        })
      : [];

    const byContractor = new Map<string, { contractorId: string; name: string; logged: number; acted: number }>();
    for (const w of works) {
      const row = byContractor.get(w.contractorId) ?? {
        contractorId: w.contractorId, name: w.contractor.name, logged: 0, acted: 0,
      };
      row.logged += amountOf(w);
      byContractor.set(w.contractorId, row);
    }
    for (const a of acts) {
      const w = works.find((x) => x.contractor.binIin === a.contractor.binIin);
      if (!w) continue;
      const row = byContractor.get(w.contractorId);
      if (row) row.acted += Number(a.totalAmount);
    }

    const reconciliation = [...byContractor.values()].map((r) => ({
      ...r,
      logged: Math.round(r.logged * 100) / 100,
      delta: Math.round((r.logged - r.acted) * 100) / 100,
      // Расхождение имеет смысл, только когда акт уже пришёл
      status: r.acted === 0 ? 'WAITING_ACT' : Math.abs(r.logged - r.acted) < 0.01 ? 'MATCHED' : 'MISMATCH',
    }));

    return {
      data: works.map((w) => ({
        ...w,
        share: Number(w.share),
        rate: Number(w.rate),
        actualQty: w.actualQty != null ? Number(w.actualQty) : null,
        actualAmount: w.actualAmount != null ? Number(w.actualAmount) : null,
        amount: amountOf(w),
        isAccepted: w.acceptedAt != null,
      })),
      reconciliation,
    };
  }

  /**
   * Отдать передел подрядчику. Вызывается из отметки этапа в цеху
   * («делал не наш цех») и из карточки заказа. Повторный вызов для той же
   * пары «передел + подрядчик» обновляет строку, а не плодит дубли.
   */
  @Post('orders/:orderId/stages/:stage/contractor')
  @Roles('shop_foreman', 'planner', 'sales_manager', 'admin')
  @ApiOperation({ summary: 'Отдать передел подрядчику (целиком или частью)' })
  async assign(
    @Param('orderId') orderId: string,
    @Param('stage') stage: string,
    @Body() body: {
      contractorId: string; orderLineId?: string | null;
      share?: number; rateType?: string; rate?: number;
      workLocation?: 'OUR_SHOP' | 'CONTRACTOR_SITE';
      plannedHours?: number; reason?: string; note?: string;
    },
    @CurrentUser() user: UserPayload,
  ) {
    if (!STAGES.has(stage)) {
      throw new BadRequestException({
        code: 'INVALID_STAGE',
        message: `Передел: CUTTING, ASSEMBLY или PAINTING; получено ${stage}`,
      });
    }
    const [order, contractor] = await Promise.all([
      this.prisma.order.findUnique({ where: { id: orderId } }),
      this.prisma.contractor.findUnique({ where: { id: body.contractorId } }),
    ]);
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${orderId} not found` });
    if (!contractor) throw new NotFoundException({ code: 'NOT_FOUND', message: `Подрядчик не найден` });

    const share = body.share ?? 1;
    if (!(share > 0) || share > 1) {
      throw new BadRequestException({
        code: 'INVALID_SHARE',
        message: 'Доля передела — больше нуля и не больше единицы',
      });
    }
    const rateType = body.rateType ?? contractor.defaultRateType;
    if (!RATE_TYPES.has(rateType)) {
      throw new BadRequestException({ code: 'INVALID_RATE_TYPE', message: `Неизвестный тип ставки: ${rateType}` });
    }
    const workLocation = body.workLocation ?? contractor.defaultWorkLocation;

    // Сдельная ставка не содержит часов: без оценки планирование мощности
    // покажет свободный участок, которого нет (та же защита, что в labor.ts)
    if (workLocation === 'OUR_SHOP' && rateType !== 'PER_HOUR' && !(body.plannedHours > 0)) {
      throw new BadRequestException({
        code: 'SHOP_HOURS_ESTIMATE_REQUIRED',
        message: 'Работы в нашем цеху по сдельной ставке — нужна оценка часов',
      });
    }

    // Больше целого передела отдать нельзя — иначе объём оплачен дважды.
    // Считаем ОБА уровня: калькуляция позиции складывает и её собственные
    // строки, и заказ-уровневые, поэтому проверка только внутри своего
    // уровня пропускала пару «на заказ 100 % + на позицию 100 %», после
    // которой позиция вообще переставала считаться (INVALID_SHARES → 500).
    const siblings = await this.prisma.contractorWork.findMany({
      where: {
        orderId,
        routingStage: stage as any,
        ...(body.orderLineId
          ? { OR: [{ orderLineId: body.orderLineId }, { orderLineId: null }] }
          : {}),
        NOT: { contractorId: body.contractorId },
      },
    });
    const taken = siblings.reduce((s, w) => s + Number(w.share), 0);
    if (taken + share > 1.0001) {
      const scope = body.orderLineId ? 'на переделе этой позиции' : 'на переделе';
      throw new BadRequestException({
        code: 'SHARE_OVERFLOW',
        message: `Уже отдано ${Math.round(taken * 100)} % ${scope}, свободно ${Math.round((1 - taken) * 100)} %`,
      });
    }

    const existing = await this.prisma.contractorWork.findFirst({
      where: {
        orderId,
        orderLineId: body.orderLineId ?? null,
        routingStage: stage as any,
        contractorId: body.contractorId,
      },
    });

    const data = {
      share,
      rateType: rateType as any,
      rate: body.rate ?? Number(contractor.defaultRate),
      workLocation: workLocation as any,
      plannedHours: body.plannedHours ?? null,
      reason: body.reason?.trim() || null,
      note: body.note?.trim() || null,
      decidedById: dbUserId(user),
    };

    return existing
      ? this.prisma.contractorWork.update({ where: { id: existing.id }, data })
      : this.prisma.contractorWork.create({
          data: {
            orderId,
            orderLineId: body.orderLineId ?? null,
            routingStage: stage as any,
            contractorId: body.contractorId,
            ...data,
          },
        });
  }

  /**
   * Принять работу: объём в единицах ставки замораживает сумму. После этого
   * пересчёт калькуляции цену подряда уже не двигает — платим принятое.
   */
  @Patch('contractor-work/:id/accept')
  @Roles('shop_foreman', 'planner', 'admin')
  @ApiOperation({ summary: 'Принять работу подрядчика (замораживает сумму)' })
  async accept(
    @Param('id') id: string,
    @Body() body: { actualQty: number; actualWorkers?: number; actualAmount?: number; note?: string },
    @CurrentUser() user: UserPayload,
  ) {
    const work = await this.prisma.contractorWork.findUnique({ where: { id } });
    if (!work) throw new NotFoundException({ code: 'NOT_FOUND', message: `Работа ${id} не найдена` });
    if (!(Number(body.actualQty) >= 0)) {
      throw new BadRequestException({ code: 'INVALID_QTY', message: 'Объём не может быть отрицательным' });
    }

    const qty = Number(body.actualQty);
    const amount = body.actualAmount ?? (
      work.rateType === 'FIXED' ? Number(work.rate) : Math.round(qty * Number(work.rate) * 100) / 100
    );

    return this.prisma.contractorWork.update({
      where: { id },
      data: {
        actualQty: qty,
        actualWorkers: body.actualWorkers ?? null,
        actualAmount: amount,
        acceptedAt: new Date(),
        acceptedById: dbUserId(user),
        note: body.note?.trim() || work.note,
      },
    });
  }

  @Delete('contractor-work/:id')
  @Roles('shop_foreman', 'planner', 'admin')
  @ApiOperation({ summary: 'Убрать подряд — объём возвращается штату по норме' })
  async remove(@Param('id') id: string) {
    const work = await this.prisma.contractorWork.findUnique({ where: { id } });
    if (!work) throw new NotFoundException({ code: 'NOT_FOUND', message: `Работа ${id} не найдена` });
    await this.prisma.contractorWork.delete({ where: { id } });
    return { deleted: true };
  }
}
