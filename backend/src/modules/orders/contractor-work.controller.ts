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

  /**
   * Завести подрядчика (26.08.2026). Раньше справочник был только на
   * чтение: подрядчика подобрали в Б24 — записать его было некуда,
   * и весь поток заявок упирался в это.
   */
  @Post('contractors')
  @Roles('procurement', 'planner', 'sales_manager', 'admin')
  @ApiOperation({ summary: 'Завести подрядчика' })
  async createContractor(@Body() body: {
    name: string; binIin?: string;
    defaultRateType?: string; defaultRate?: number;
    defaultWorkLocation?: 'OUR_SHOP' | 'CONTRACTOR_SITE'; notes?: string;
  }) {
    const name = body.name?.trim();
    if (!name) {
      throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'Укажите название подрядчика' });
    }
    const rateType = body.defaultRateType ?? 'PER_UNIT';
    if (!RATE_TYPES.has(rateType)) {
      throw new BadRequestException({ code: 'INVALID_RATE_TYPE', message: `Неизвестный тип ставки: ${rateType}` });
    }
    const binIin = body.binIin?.trim() || null;
    if (binIin) {
      // БИН — единственная связь с актами 1С: дубль сломал бы сверку
      const dup = await this.prisma.contractor.findUnique({ where: { binIin } });
      if (dup) {
        throw new BadRequestException({
          code: 'BIN_TAKEN',
          message: `БИН ${binIin} уже у подрядчика «${dup.name}»`,
        });
      }
    }
    return this.prisma.contractor.create({
      data: {
        name,
        binIin,
        defaultRateType: rateType as any,
        defaultRate: Number(body.defaultRate) > 0 ? body.defaultRate : 0,
        defaultWorkLocation: (body.defaultWorkLocation ?? 'CONTRACTOR_SITE') as any,
        notes: body.notes?.trim() || null,
      },
    });
  }

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
        request: { select: { id: true, number: true } },
      },
      orderBy: [{ acceptedAt: { sort: 'asc', nulls: 'first' } }, { decidedAt: 'desc' }],
      take: 300,
    });

    const rows = works.map((w) => {
      // FIXED — сумма за объём, а не цена единицы: умножение на actualQty
      // раздувало долг подрядчику ровно во столько раз, сколько единиц
      // разнесено (та же ветка, что в accept ниже)
      const amount = w.actualAmount != null
        ? Number(w.actualAmount)
        : w.rateType === 'FIXED'
          ? Number(w.rate)
          : w.actualQty != null
            ? Number(w.actualQty) * Number(w.rate)
            : null;
      return {
        id: w.id,
        order: w.order,
        contractor: w.contractor,
        // Разовый подряд или строка из заявки — видно, откуда взялась
        request: w.request,
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
      // FIXED — сумма за объём целиком, объёмом её умножать нельзя
      if (w.rateType === 'FIXED') return Number(w.rate);
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

    /**
     * Что подряд сделал с трудозатратами (26.08.2026, вопрос пользователя:
     * «было базовая трудозатрата 2 часа, от неё сминусуется то, что сделал
     * подряд, и выйдет правильная сумма»).
     *
     * Это уже работало внутри калькуляции, но нигде не показывалось: доля
     * подряда вырезает свой кусок нормы, а штату достаётся остаток. Здесь
     * та же арифметика, но названная вслух — чтобы человек видел, откуда
     * взялось «осталось 0,8 ч» вместо прежних 2.
     */
    const lines = await this.prisma.orderLine.findMany({
      where: { orderId, articleId: { not: null } },
      select: { qty: true, articleId: true, article: { select: { isMaterialResale: true } } },
    });
    const articleIds = [...new Set(
      lines.filter((l) => !l.article?.isMaterialResale).map((l) => l.articleId),
    )] as string[];
    const ops = articleIds.length
      ? await this.prisma.routingOperation.findMany({
          where: { articleId: { in: articleIds } },
          select: { articleId: true, stage: true, workers: true, hoursPerUnit: true },
        })
      : [];
    const normPerUnit = new Map<string, number>();
    for (const o of ops) {
      normPerUnit.set(
        `${o.articleId}:${o.stage}`,
        (normPerUnit.get(`${o.articleId}:${o.stage}`) ?? 0) + Number(o.workers) * Number(o.hoursPerUnit),
      );
    }

    const STAGE_RU: Record<string, string> = {
      CUTTING: 'Резка', ASSEMBLY: 'Сборка / сварка / обшивка', PAINTING: 'Зачистка / покраска',
    };
    const laborImpact = (['CUTTING', 'ASSEMBLY', 'PAINTING'] as const).map((stage) => {
      const normHours = lines
        .filter((l) => !l.article?.isMaterialResale)
        .reduce((s, l) => s + (normPerUnit.get(`${l.articleId}:${stage}`) ?? 0) * Number(l.qty), 0);
      const stageWorks = works.filter((w) => w.routingStage === stage);
      const share = Math.min(1, stageWorks.reduce((s, w) => s + Number(w.share), 0));
      const contractorAmount = stageWorks.reduce((s, w) => s + amountOf(w), 0);
      return {
        stage,
        stageLabel: STAGE_RU[stage] ?? stage,
        normHours: Math.round(normHours * 100) / 100,
        contractorSharePct: Math.round(share * 100),
        // Штату остаётся то, что подряд не забрал: 2 ч при доле 60 % → 0,8 ч
        staffHours: Math.round(normHours * (1 - share) * 100) / 100,
        contractorHours: Math.round(normHours * share * 100) / 100,
        contractorAmount: Math.round(contractorAmount * 100) / 100,
        contractors: stageWorks.map((w) => ({
          name: w.contractor.name,
          sharePct: Math.round(Number(w.share) * 100),
        })),
      };
    }).filter((r) => r.normHours > 0 || r.contractorSharePct > 0);

    return {
      laborImpact,
      laborTotals: {
        normHours: Math.round(laborImpact.reduce((s, r) => s + r.normHours, 0) * 100) / 100,
        staffHours: Math.round(laborImpact.reduce((s, r) => s + r.staffHours, 0) * 100) / 100,
        contractorHours: Math.round(laborImpact.reduce((s, r) => s + r.contractorHours, 0) * 100) / 100,
        contractorAmount: Math.round(laborImpact.reduce((s, r) => s + r.contractorAmount, 0) * 100) / 100,
      },
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
    // Заменяемую строку ищем ДО проверки долей: из знаменателя должна
    // выпадать ровно она. Исключение «все строки этого подрядчика»
    // пропускало пару «на заказ 100 % + на позицию 100 %» одного и того же
    // подрядчика — ту самую, от которой защищает комментарий выше
    const existing = await this.prisma.contractorWork.findFirst({
      where: {
        orderId,
        orderLineId: body.orderLineId ?? null,
        routingStage: stage as any,
        contractorId: body.contractorId,
      },
    });

    const allSiblings = await this.prisma.contractorWork.findMany({
      where: { orderId, routingStage: stage as any },
      select: { id: true, share: true, orderLineId: true },
    });
    const siblings = allSiblings.filter((w) => w.id !== existing?.id);
    const orderLevel = siblings.filter((w) => w.orderLineId === null)
      .reduce((sum, w) => sum + Number(w.share), 0);
    const byLine = new Map<string, number>();
    for (const w of siblings) {
      if (w.orderLineId === null) continue;
      byLine.set(w.orderLineId, (byLine.get(w.orderLineId) ?? 0) + Number(w.share));
    }
    // Доли складываются внутри позиции: три позиции по 50 % — это законные
    // 50 % на каждой, а не «уже отдано 150 %»
    const taken = body.orderLineId
      ? orderLevel + (byLine.get(body.orderLineId) ?? 0)
      : orderLevel + Math.max(0, ...[...byLine.values()], 0);
    if (taken + share > 1.0001) {
      const scope = body.orderLineId ? 'на этих работах по позиции' : 'на этих работах по заказу';
      throw new BadRequestException({
        code: 'SHARE_OVERFLOW',
        message: `Уже отдано ${Math.round(taken * 100)} % ${scope}`
          + `, свободно ${Math.round(Math.max(0, 1 - taken) * 100)} %`,
      });
    }

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
    const work = await this.prisma.contractorWork.findUnique({
      where: { id }, include: { request: { select: { number: true } } },
    });
    if (!work) throw new NotFoundException({ code: 'NOT_FOUND', message: `Работа ${id} не найдена` });
    // Строка заявки — часть партии: её сумма выводится из акта заявки
    // раскладкой по объёму. Принять её отдельно значило бы порвать
    // инвариант «сумма строк = сумма акта» без единого сигнала наружу
    if (work.requestId) {
      throw new BadRequestException({
        code: 'BELONGS_TO_REQUEST',
        message: `Строка разнесена из заявки ${work.request?.number ?? ''} — акт принимают на самой заявке`,
      });
    }
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
    const work = await this.prisma.contractorWork.findUnique({
      where: { id }, include: { request: { select: { number: true } } },
    });
    if (!work) throw new NotFoundException({ code: 'NOT_FOUND', message: `Работа ${id} не найдена` });
    // Удаление в обход заявки оставило бы её суммы неперераспределёнными
    if (work.requestId) {
      throw new BadRequestException({
        code: 'BELONGS_TO_REQUEST',
        message: `Строка разнесена из заявки ${work.request?.number ?? ''} — снимайте разнесение там,`
          + ' иначе суммы по остальным заказам не пересчитаются',
      });
    }
    await this.prisma.contractorWork.delete({ where: { id } });
    return { deleted: true };
  }
}
