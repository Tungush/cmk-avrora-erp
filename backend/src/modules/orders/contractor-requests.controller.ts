import {
  Controller, Get, Post, Patch, Delete, Param, Query, Body,
  NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { BitrixClientService } from '../../services/bitrix-client.service';
import { runWithFallback } from '../../common/fallback';
import {
  RATE_UNITS, STAGE_LABELS, splitAmount, splitProportional, allocationSummary,
} from '../../common/contractor-requests';

const RATE_TYPES = new Set(['PER_HOUR', 'PER_UNIT', 'PER_KG', 'PER_TON', 'FIXED']);
const STAGES = new Set(['CUTTING', 'ASSEMBLY', 'PAINTING']);
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Пользователь БД или демо-пользователь (usr-*), которого в базе нет */
const dbUserId = (u?: UserPayload) => (u && !u.userId.startsWith('usr-') ? u.userId : null);

/**
 * Заявки на подряд (26.08.2026, запрос пользователя: «чтобы через подряд
 * могли ребята создавать заявки в б24 а потом уже в цеху отмечать что
 * конкретно из сделанного заказа подряда ушло по каким заказам»).
 *
 * Поток: заявка заводится ПАРТИЕЙ, до того как известно, по каким заказам
 * работа разойдётся («увезли красить балки») → пачкой уходит одной сделкой
 * в воронку Б24 «Заказ на Работы», там подберут подрядчика и назовут ставку
 * → цех разносит: «на этот заказ ушло 3,2 т» → приходит акт, сумма
 * замораживается и делится между заказами пропорционально объёму.
 *
 * Деньги входят в себестоимость СУЩЕСТВУЮЩИМ путём: разнесение создаёт
 * обычную строку ContractorWork, и ни labor.ts, ни order-costing.service.ts
 * не меняются ни на строку. Это самое дорогое место для ошибки в проекте.
 */
@ApiTags('Contractor Requests')
@ApiBearerAuth()
@Controller('contractor-requests')
export class ContractorRequestsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bitrix: BitrixClientService,
  ) {}

  /** Следующий свободный номер: ПОДР-001 → ПОДР-002 … */
  private async nextNumber(): Promise<string> {
    const rows = await this.prisma.contractorRequest.findMany({
      where: { number: { startsWith: 'ПОДР-' } },
      select: { number: true },
      orderBy: { number: 'desc' },
      take: 200,
    });
    let max = 0;
    for (const r of rows) {
      const n = Number(r.number.slice('ПОДР-'.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `ПОДР-${String(max + 1).padStart(3, '0')}`;
  }

  /**
   * Создание с ретраем на занятый номер. Двое заводят заявку одновременно —
   * оба читают тот же максимум, и второй получал 409 про unique-констрейнт:
   * человек видел отказ там, где ничего не дублировал, а в пачке для Б24
   * тихо не хватало позиции.
   */
  private async createWithNumber(data: Record<string, unknown>, include: any) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.prisma.contractorRequest.create({
          data: { ...data, number: await this.nextNumber() } as any,
          include,
        });
      } catch (e: any) {
        if (e?.code !== 'P2002' || attempt === 4) throw e;
      }
    }
    throw new ConflictException({
      code: 'NUMBER_RACE',
      message: 'Не удалось занять номер заявки — попробуйте ещё раз',
    });
  }

  /**
   * Пересчёт пропорций по ВСЕМ строкам заявки. Зовётся после любого
   * изменения состава: объём одной строки меняет доли всех остальных.
   *
   * Три величины делятся по объёму (`actualQty` строки):
   * - `actualAmount` — сумма акта, после приёмки. Последней строке остаток,
   *   чтобы Σ строк сошлась с суммой акта в копейку.
   * - `rate` для FIXED — ловушка: labor.ts:155 считает `rate × alloc`, где
   *   alloc — доля ПОЗИЦИИ внутри заказа. Положи туда полную сумму партии,
   *   и каждый заказ получит её целиком. Поэтому в строку пишется уже
   *   поделённая ставка.
   * - `plannedHours` — оценка часов, если работали в нашем цеху: без неё
   *   labor.ts:168 роняет расчёт SHOP_HOURS_ESTIMATE_REQUIRED.
   */
  private async redistribute(requestId: string): Promise<number> {
    const req = await this.prisma.contractorRequest.findUnique({
      where: { id: requestId },
      include: { works: { orderBy: { decidedAt: 'asc' } } },
    });
    if (!req || req.works.length === 0) return 0;

    const qtys = req.works.map((w) => Number(w.actualQty ?? 0));
    const total = qtys.reduce((s, q) => s + q, 0);
    if (!(total > 0)) return 0;

    // Знаменатель — ПРИНЯТЫЙ объём, а не разнесённый. Иначе неразнесённая
    // часть партии молча оплачивается теми заказами, куда разнесли: приняли
    // 12 т на 1 200 000 ₸, разнесли 5 — и один заказ получал всю сумму
    // вместо 500 000 ₸. Хвост остаётся деньгами вне заказов, и «висит X ₸»
    // на экране становится правдой, а не нулём.
    const denomQty = Math.max(total, Number(req.actualQty ?? 0));
    const tail = round3(Math.max(0, denomQty - total));
    // Виртуальная доля «не разнесено» участвует в делении и выбрасывается
    const withTail = tail > 1e-9 ? [...qtys, tail] : qtys;
    const take = (arr: number[] | null) => (arr ? arr.slice(0, qtys.length) : null);

    const amounts = take(req.actualAmount != null
      ? splitAmount(Number(req.actualAmount), withTail)
      : null);
    const hours = take(req.plannedHours != null
      ? splitProportional(Number(req.plannedHours), withTail)
      : null);
    const fixedRates = take(req.rateType === 'FIXED' && req.estimatedAmount != null
      ? splitAmount(Number(req.estimatedAmount), withTail)
      : null);

    for (let i = 0; i < req.works.length; i += 1) {
      const w = req.works[i];
      const data: Record<string, unknown> = {};
      if (amounts) data.actualAmount = amounts[i];
      if (hours) data.plannedHours = round3(hours[i]);
      // Принятая сумма важнее оценки: если акт есть, ставка FIXED уже
      // не участвует в расчёте (labor.ts:162), но пусть не врёт в карточке
      if (fixedRates) data.rate = amounts ? amounts[i] : fixedRates[i];
      if (Object.keys(data).length > 0) {
        await this.prisma.contractorWork.update({ where: { id: w.id }, data });
      }
    }
    return req.works.length;
  }

  @Get()
  @Roles('planner', 'sales_manager', 'director', 'accountant', 'shop_foreman', 'procurement', 'admin')
  @ApiOperation({ summary: 'Заявки на подряд: что отдано, что разнесено, что висит' })
  async findAll(@Query() query: { status?: string; stage?: string; contractorId?: string }) {
    return runWithFallback(
      this.prisma,
      async () => {
        const where: any = {};
        if (query.status) where.status = query.status;
        if (query.stage && STAGES.has(query.stage)) where.routingStage = query.stage;
        if (query.contractorId) where.contractorId = query.contractorId;

        const rows = await this.prisma.contractorRequest.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          take: 300,
          include: {
            contractor: { select: { id: true, name: true, binIin: true } },
            paymentDocument: { select: { doNumber: true, totalAmount: true } },
            works: {
              select: {
                id: true, orderId: true, actualQty: true, actualAmount: true, share: true,
                order: { select: { id: true, orderNumber: true } },
              },
            },
          },
        });

        // «Ждём ответа от 1С» должно заканчиваться сигналом, а не тишиной:
        // по отправленным заявкам ищем свежие непривязанные ДО их подрядчиков
        const waiting = rows.filter((r) => r.bitrixSentAt && !r.paymentDocumentId && r.contractor?.binIin);
        const bins = [...new Set(waiting.map((r) => r.contractor!.binIin as string))];
        const freshDocs = bins.length
          ? await this.prisma.paymentDocument.findMany({
              where: { contractorRequest: null, contractor: { binIin: { in: bins } } },
              select: {
                doNumber: true, doDate: true, totalAmount: true,
                contractor: { select: { binIin: true } },
              },
              orderBy: { doDate: 'desc' },
            })
          : [];

        const data = rows.map((r) => {
          // ДО свежее отправки в Б24 — похоже, это ответ 1С на эту заявку
          const candidate = r.bitrixSentAt && !r.paymentDocumentId && r.contractor?.binIin
            ? freshDocs.find((d) => d.contractor.binIin === r.contractor!.binIin
                && (!d.doDate || d.doDate.getTime() >= r.bitrixSentAt!.getTime() - 86_400_000))
            : null;
          return {
            ...allocationSummary(r),
            supplierDoc: r.paymentDocument
              ? { doNumber: r.paymentDocument.doNumber, totalAmount: Number(r.paymentDocument.totalAmount) }
              : null,
            candidateDoc: candidate
              ? { doNumber: candidate.doNumber, totalAmount: Number(candidate.totalAmount) }
              : null,
          };
        });
        return {
          data,
          // Самая опасная точка: деньги приняты, но не сидят ни в одном
          // заказе — подряд занижен, а штат на этих переделах считается
          // по норме на 100 %. Это обязано быть цифрой, а не тишиной
          unallocated: {
            requests: data.filter((r) => r.needsAllocation).length,
            amount: round2(data
              .filter((r) => r.needsAllocation)
              .reduce((s, r) => s + r.unallocatedAmount, 0)),
          },
          total: data.length,
        };
      },
      () => ({ data: [], unallocated: { requests: 0, amount: 0 }, total: 0 }),
    );
  }

  @Get(':id')
  @Roles('planner', 'sales_manager', 'director', 'accountant', 'shop_foreman', 'procurement', 'admin')
  @ApiOperation({ summary: 'Заявка на подряд со строками разнесения и сверкой с актами 1С' })
  async findOne(@Param('id') id: string) {
    const req = await this.prisma.contractorRequest.findUnique({
      where: { id },
      include: {
        contractor: { select: { id: true, name: true, binIin: true } },
        paymentDocument: { select: { id: true, doNumber: true, doDate: true, totalAmount: true } },
        works: {
          orderBy: { decidedAt: 'asc' },
          include: {
            order: { select: { id: true, orderNumber: true, status: true, plannedShipmentDate: true } },
          },
        },
      },
    });
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: `Заявка ${id} не найдена` });

    // Сверка идёт на уровне ПОДРЯДЧИКА, а не заказа: акт существует именно
    // там, а партия из трёх заказов дала бы вечный MISMATCH по каждому.
    // Из этих же ДО выбирают основание приёмки: пришёл «Заказ поставщику»
    // из 1С — его сумма и раскидывается по заказам, а не сумма со слов
    const acts = req.contractor?.binIin
      ? await this.prisma.paymentDocument.findMany({
          where: { contractor: { binIin: req.contractor.binIin } },
          select: {
            id: true, doNumber: true, doDate: true, totalAmount: true, orderId: true,
            contractorRequest: { select: { id: true, number: true } },
          },
          orderBy: { doDate: 'desc' },
          take: 20,
        })
      : [];

    return {
      ...allocationSummary(req),
      supplierDoc: req.paymentDocument
        ? {
            id: req.paymentDocument.id,
            doNumber: req.paymentDocument.doNumber,
            doDate: req.paymentDocument.doDate,
            totalAmount: Number(req.paymentDocument.totalAmount),
          }
        : null,
      description: req.description,
      note: req.note,
      works: req.works.map((w) => ({
        id: w.id,
        order: w.order,
        share: Number(w.share),
        qty: w.actualQty != null ? Number(w.actualQty) : null,
        amount: w.actualAmount != null ? Number(w.actualAmount) : null,
        plannedHours: w.plannedHours != null ? Number(w.plannedHours) : null,
        decidedAt: w.decidedAt,
        acceptedAt: w.acceptedAt,
      })),
      supplierActs: acts.map((a) => ({
        id: a.id,
        doNumber: a.doNumber,
        doDate: a.doDate,
        totalAmount: Number(a.totalAmount),
        orderId: a.orderId,
        // Занят другой заявкой — в кандидаты приёмки не годится
        linkedRequestNumber: a.contractorRequest && a.contractorRequest.id !== req.id
          ? a.contractorRequest.number
          : null,
      })),
    };
  }

  @Post()
  @Roles('shop_foreman', 'planner', 'sales_manager', 'procurement', 'admin')
  @ApiOperation({ summary: 'Завести заявку на подряд (заказ и подрядчик ещё не известны)' })
  async create(
    @Body() body: {
      routingStage: string; description: string;
      rateType?: string; plannedQty?: number; rate?: number; estimatedAmount?: number;
      contractorId?: string | null; workLocation?: 'OUR_SHOP' | 'CONTRACTOR_SITE';
      plannedHours?: number; note?: string;
    },
    @CurrentUser() user: UserPayload,
  ) {
    if (!STAGES.has(body.routingStage)) {
      throw new BadRequestException({
        code: 'INVALID_STAGE',
        message: `Вид работ: CUTTING, ASSEMBLY или PAINTING; получено ${body.routingStage}`,
      });
    }
    const description = body.description?.trim();
    if (!description) {
      throw new BadRequestException({
        code: 'DESCRIPTION_REQUIRED',
        message: 'Опишите работу словами — по этому тексту её будут искать в Б24',
      });
    }
    const rateType = body.rateType ?? 'PER_UNIT';
    if (!RATE_TYPES.has(rateType)) {
      throw new BadRequestException({ code: 'INVALID_RATE_TYPE', message: `Неизвестный тип ставки: ${rateType}` });
    }
    const workLocation = body.workLocation ?? 'CONTRACTOR_SITE';

    // Сдельная ставка не содержит часов. Спросить оценку надо здесь, пока
    // человек держит заявку в голове: на разнесении она станет блокером
    // (labor.ts:168 иначе роняет расчёт всего заказа)
    if (workLocation === 'OUR_SHOP' && rateType !== 'PER_HOUR' && !(Number(body.plannedHours) > 0)) {
      throw new BadRequestException({
        code: 'SHOP_HOURS_ESTIMATE_REQUIRED',
        message: 'Работы идут в нашем цеху по сдельной ставке — нужна оценка часов на всю партию',
      });
    }
    if (body.contractorId) {
      const c = await this.prisma.contractor.findUnique({ where: { id: body.contractorId } });
      if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Подрядчик не найден' });
    }

    return this.createWithNumber(
      {
        routingStage: body.routingStage as any,
        description,
        rateType: rateType as any,
        plannedQty: Number(body.plannedQty) > 0 ? body.plannedQty : null,
        rate: Number(body.rate) > 0 ? body.rate : null,
        estimatedAmount: Number(body.estimatedAmount) > 0 ? body.estimatedAmount : null,
        contractorId: body.contractorId || null,
        workLocation: workLocation as any,
        plannedHours: Number(body.plannedHours) > 0 ? body.plannedHours : null,
        note: body.note?.trim() || null,
        createdById: dbUserId(user),
      },
      { contractor: { select: { id: true, name: true } } },
    );
  }

  @Patch(':id')
  @Roles('shop_foreman', 'planner', 'sales_manager', 'procurement', 'admin')
  @ApiOperation({ summary: 'Проставить подрядчика и ставку — их назвали в Б24' })
  async update(
    @Param('id') id: string,
    @Body() body: {
      contractorId?: string | null; rate?: number; rateType?: string;
      plannedQty?: number; estimatedAmount?: number; plannedHours?: number;
      description?: string; note?: string;
      workLocation?: 'OUR_SHOP' | 'CONTRACTOR_SITE';
    },
  ) {
    const req = await this.prisma.contractorRequest.findUnique({
      where: { id }, include: { works: true },
    });
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: `Заявка ${id} не найдена` });
    if (req.status === 'CANCELLED') {
      throw new ConflictException({ code: 'REQUEST_CANCELLED', message: 'Заявка отменена' });
    }
    if (body.rateType && !RATE_TYPES.has(body.rateType)) {
      throw new BadRequestException({ code: 'INVALID_RATE_TYPE', message: `Неизвестный тип ставки: ${body.rateType}` });
    }
    // Тип ставки после разнесения менять нельзя: единицы объёма уже
    // записаны в строки, и «3,2» превратилось бы из тонн в штуки молча
    if (body.rateType && body.rateType !== req.rateType && req.works.length > 0) {
      throw new ConflictException({
        code: 'RATE_TYPE_LOCKED',
        message: `Заявка уже разнесена на ${req.works.length} заказов — тип ставки не изменить, снимите разнесение`,
      });
    }
    if (body.contractorId) {
      const c = await this.prisma.contractor.findUnique({ where: { id: body.contractorId } });
      if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Подрядчик не найден' });
    }

    const workLocation = body.workLocation ?? req.workLocation;
    const rateType = (body.rateType ?? req.rateType) as string;
    const plannedHours = body.plannedHours !== undefined
      ? (Number(body.plannedHours) > 0 ? Number(body.plannedHours) : null)
      : (req.plannedHours != null ? Number(req.plannedHours) : null);
    if (workLocation === 'OUR_SHOP' && rateType !== 'PER_HOUR' && !(Number(plannedHours) > 0)) {
      throw new BadRequestException({
        code: 'SHOP_HOURS_ESTIMATE_REQUIRED',
        message: 'Работы в нашем цеху по сдельной ставке — нужна оценка часов на всю партию',
      });
    }

    const updated = await this.prisma.contractorRequest.update({
      where: { id },
      data: {
        ...(body.contractorId !== undefined ? { contractorId: body.contractorId || null } : {}),
        ...(body.rate !== undefined ? { rate: Number(body.rate) > 0 ? body.rate : null } : {}),
        ...(body.rateType ? { rateType: body.rateType as any } : {}),
        ...(body.plannedQty !== undefined
          ? { plannedQty: Number(body.plannedQty) > 0 ? body.plannedQty : null } : {}),
        ...(body.estimatedAmount !== undefined
          ? { estimatedAmount: Number(body.estimatedAmount) > 0 ? body.estimatedAmount : null } : {}),
        ...(body.plannedHours !== undefined ? { plannedHours } : {}),
        ...(body.description?.trim() ? { description: body.description.trim() } : {}),
        ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
        ...(body.workLocation ? { workLocation: body.workLocation as any } : {}),
      },
      include: { contractor: { select: { id: true, name: true } } },
    });

    // Ставка и подрядчик проставлены задним числом — уже разнесённые строки
    // должны узнать об этом, иначе подряд останется в расчёте по старой цене
    if (req.works.length > 0) {
      const patch: Record<string, unknown> = {};
      if (body.contractorId) patch.contractorId = body.contractorId;
      if (body.rate !== undefined && Number(body.rate) > 0 && updated.rateType !== 'FIXED') {
        patch.rate = body.rate;
      }
      if (body.workLocation) patch.workLocation = body.workLocation;
      if (Object.keys(patch).length > 0) {
        await this.prisma.contractorWork.updateMany({ where: { requestId: id }, data: patch as any });
      }
      await this.redistribute(id);
    }
    return updated;
  }

  /**
   * Пачка заявок → ОДНА сделка в воронке Б24 «Заказ на Работы».
   * Отсутствие вебхука — честная ошибка, не тихий no-op: человек нажал
   * кнопку и должен знать, ушла заявка или нет.
   */
  @Post('send-to-bitrix')
  @Roles('shop_foreman', 'planner', 'sales_manager', 'procurement', 'admin')
  @ApiOperation({ summary: 'Отправить выбранные заявки одной сделкой в Б24 (воронка «Заказ на Работы»)' })
  async sendToBitrix(@Body() body: { ids: string[] }, @CurrentUser() user: UserPayload) {
    if (!body.ids?.length) {
      throw new BadRequestException({ code: 'EMPTY_SELECTION', message: 'Не выбрано ни одной заявки' });
    }
    const requests = await this.prisma.contractorRequest.findMany({
      where: { id: { in: body.ids }, status: 'DRAFT' },
      include: { contractor: { select: { name: true } } },
    });
    if (requests.length === 0) {
      throw new BadRequestException({
        code: 'NOTHING_TO_SEND',
        message: 'Среди выбранных нет заявок в статусе «черновик»',
      });
    }

    const lines = requests.map((r) => ({
      number: r.number,
      stageLabel: STAGE_LABELS[r.routingStage] ?? r.routingStage,
      description: r.description,
      qty: r.plannedQty != null ? Number(r.plannedQty) : null,
      unit: RATE_UNITS[r.rateType] ?? '',
      rate: r.rate != null ? Number(r.rate) : null,
      estimate: r.estimatedAmount != null
        ? Number(r.estimatedAmount)
        : (r.plannedQty != null && r.rate != null ? Number(r.plannedQty) * Number(r.rate) : null),
      atOurShop: r.workLocation === 'OUR_SHOP',
      contractorName: r.contractor?.name ?? null,
    }));
    const totalEstimate = lines.reduce((s, l) => s + (l.estimate ?? 0), 0);

    let dealId: string;
    try {
      dealId = await this.bitrix.createWorksRequestDeal({
        title: `Заказ на работы: ${lines.length} заявок`
          + (totalEstimate > 0 ? ` на ${Math.round(totalEstimate).toLocaleString('ru-RU')} ₸` : ''),
        lines,
        totalEstimate,
        requestedBy: user.email ?? user.roles[0],
      });
    } catch (e) {
      throw new BadRequestException({
        code: 'BITRIX_SEND_FAILED',
        message: e instanceof Error ? e.message : 'Не удалось отправить в Б24',
      });
    }

    await this.prisma.contractorRequest.updateMany({
      where: { id: { in: requests.map((r) => r.id) } },
      data: { status: 'SENT', bitrixDealId: dealId, bitrixSentAt: new Date() },
    });
    return { sent: requests.length, dealId, totalEstimate: Math.round(totalEstimate) };
  }

  /**
   * Разнести часть заявки на заказ: «из ПОДР-007 на этот заказ ушло 3,2 т».
   *
   * Создаёт обычную строку ContractorWork — деньги дальше считает та же
   * арифметика, что и у разового подряда. Повтор по паре «заявка + заказ»
   * ОБНОВЛЯЕТ строку: мастер исправляет, и последнее слово мастера — правда;
   * суммирование было бы двойным счётом.
   */
  @Post(':id/allocate')
  @Roles('shop_foreman', 'planner', 'admin')
  @ApiOperation({ summary: 'Разнести часть заявки на заказ' })
  async allocate(
    @Param('id') id: string,
    @Body() body: { orderId: string; orderLineId?: string | null; qty: number; share?: number; note?: string },
    @CurrentUser() user: UserPayload,
  ) {
    const req = await this.prisma.contractorRequest.findUnique({
      where: { id }, include: { works: true },
    });
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: `Заявка ${id} не найдена` });
    if (req.status === 'CANCELLED') {
      throw new ConflictException({ code: 'REQUEST_CANCELLED', message: 'Заявка отменена — разносить нечего' });
    }
    // Без подрядчика и ставки строка встала бы в расчёт нулём, и заказ
    // выглядел бы дешевле, чем он есть
    if (!req.contractorId) {
      throw new BadRequestException({
        code: 'CONTRACTOR_REQUIRED',
        message: 'Укажите в заявке, кто выполнил работу — иначе она встанет в 0 ₸',
      });
    }
    const hasPrice = req.rateType === 'FIXED'
      ? Number(req.estimatedAmount) > 0 || Number(req.actualAmount) > 0
      : Number(req.rate) > 0;
    if (!hasPrice) {
      throw new BadRequestException({
        code: 'RATE_REQUIRED',
        message: req.rateType === 'FIXED'
          ? 'Укажите в заявке сумму — иначе работа встанет в 0 ₸'
          : 'Укажите в заявке ставку — иначе работа встанет в 0 ₸',
      });
    }

    const qty = Number(body.qty);
    // Фоллбэков «поделим по нормам» нет намеренно: цех и так называет объём,
    // а тихая цифра, за которую никто не отвечает, хуже красной строки
    if (!(qty > 0)) {
      throw new BadRequestException({
        code: 'QTY_REQUIRED',
        message: `Сколько ушло на этот заказ? Объём в ${RATE_UNITS[req.rateType] ?? 'единицах ставки'}`,
      });
    }
    const share = body.share ?? 1;
    if (!(share > 0) || share > 1) {
      throw new BadRequestException({
        code: 'INVALID_SHARE',
        message: 'Доля вида работ — больше нуля и не больше единицы',
      });
    }

    const order = await this.prisma.order.findUnique({
      where: { id: body.orderId }, select: { id: true, orderNumber: true },
    });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Заказ ${body.orderId} не найден` });
    if (body.orderLineId) {
      const line = await this.prisma.orderLine.findUnique({ where: { id: body.orderLineId } });
      if (!line || line.orderId !== body.orderId) {
        throw new BadRequestException({ code: 'LINE_MISMATCH', message: 'Позиция не из этого заказа' });
      }
    }

    // Принято 12 т — разнести 15 нельзя: два заказа поделили бы больше,
    // чем подрядчик сдал, и подряд посчитался бы дважды
    if (req.actualQty != null) {
      const others = req.works
        // Заменяется ровно одна строка — пара «заказ + позиция», остальные
        // строки того же заказа по другим позициям остаются в знаменателе
        .filter((w) => !(w.orderId === body.orderId && (w.orderLineId ?? null) === (body.orderLineId ?? null)))
        .reduce((s, w) => s + Number(w.actualQty ?? 0), 0);
      if (others + qty > Number(req.actualQty) + 1e-6) {
        throw new BadRequestException({
          code: 'QTY_OVERFLOW',
          message: `По заявке принято ${Number(req.actualQty)} ${RATE_UNITS[req.rateType] ?? ''}`
            + `, уже разнесено ${round3(others)} — свободно ${round3(Number(req.actualQty) - others)}`,
        });
      }
    }

    // Строка адресуется парой «заказ + позиция»: две позиции одного заказа —
    // это две разные строки. Поиск по одному orderId молча перетирал первую,
    // и объём с неё исчезал без единой ошибки
    const lineKey = body.orderLineId ?? null;
    const existing = req.works.find(
      (w) => w.orderId === body.orderId && (w.orderLineId ?? null) === lineKey,
    );

    // Больше целого вида работ отдать нельзя. Считаем ДО записи и на обоих
    // уровнях: калькуляция позиции складывает и её собственные строки, и
    // заказ-уровневые, поэтому проверка внутри своего уровня пропускала
    // пару «на заказ 100 % + на позицию 100 %» → INVALID_SHARES → 500.
    // Берём ВСЕ строки заказа по этому виду работ и отсеиваем в JS: условие
    // `NOT: { requestId: id }` в Prisma выбрасывало заодно и строки разового
    // подряда (request_id IS NULL), из-за чего 100 % + 100 % проходило.
    const allSiblings = await this.prisma.contractorWork.findMany({
      where: { orderId: body.orderId, routingStage: req.routingStage },
      select: { id: true, share: true, orderLineId: true },
    });
    const siblings = allSiblings.filter((w) => w.id !== existing?.id);

    // Доли суммируются ВНУТРИ позиции, а не по всему заказу: три позиции
    // по 50 % — это законные 50 % на каждой, а не «уже отдано 150 %»
    const orderLevel = siblings.filter((w) => w.orderLineId === null)
      .reduce((sum, w) => sum + Number(w.share), 0);
    const byLine = new Map<string, number>();
    for (const w of siblings) {
      if (w.orderLineId === null) continue;
      byLine.set(w.orderLineId, (byLine.get(w.orderLineId) ?? 0) + Number(w.share));
    }
    const taken = lineKey
      ? orderLevel + (byLine.get(lineKey) ?? 0)
      // Разносим на заказ целиком — мешает самая занятая позиция
      : orderLevel + Math.max(0, ...[...byLine.values()], 0);
    if (taken + share > 1.0001) {
      throw new BadRequestException({
        code: 'SHARE_OVERFLOW',
        message: `Уже отдано ${Math.round(taken * 100)} % работ этого вида по заказу ${order.orderNumber}`
          + `, свободно ${Math.round(Math.max(0, 1 - taken) * 100)} %`,
      });
    }
    const base = {
      share,
      rateType: req.rateType,
      // FIXED получит поделённую сумму в redistribute; остальным ставка
      // заявки годится как есть — объём делит деньги сам
      rate: req.rateType === 'FIXED' ? 0 : Number(req.rate),
      workLocation: req.workLocation,
      contractorId: req.contractorId,
      // Объём в единицах ставки: labor.ts возьмёт его как measured и
      // посчитает деньги правильно ещё до акта
      actualQty: qty,
      note: body.note?.trim() || null,
      decidedById: dbUserId(user),
      decidedAt: new Date(),
    };

    const work = existing
      ? await this.prisma.contractorWork.update({
          where: { id: existing.id },
          data: { ...base, orderLineId: lineKey } as any,
        })
      : await this.prisma.contractorWork.create({
          data: {
            ...base,
            requestId: id,
            orderId: body.orderId,
            orderLineId: lineKey,
            routingStage: req.routingStage,
            reason: `Заявка на подряд ${req.number}`,
          } as any,
        });

    const rows = await this.redistribute(id);
    if (req.status === 'DRAFT' || req.status === 'SENT' || req.status === 'ACCEPTED') {
      await this.prisma.contractorRequest.update({
        where: { id },
        data: { status: req.acceptedAt != null ? 'ALLOCATED' : req.status },
      });
    }

    const after = await this.prisma.contractorRequest.findUnique({
      where: { id },
      include: { works: { select: { actualQty: true, actualAmount: true, orderId: true } } },
    });
    return {
      workId: work.id,
      orderNumber: order.orderNumber,
      qty,
      unit: RATE_UNITS[req.rateType] ?? '',
      stageLabel: STAGE_LABELS[req.routingStage] ?? req.routingStage,
      // Пересчёт затронул чужие заказы — это надо сказать вслух
      recalculatedRows: rows > 1 ? rows : 0,
      remainingQty: after?.actualQty != null
        ? round3(Number(after.actualQty) - after.works.reduce((s, w) => s + Number(w.actualQty ?? 0), 0))
        : (after?.plannedQty != null
          ? round3(Number(after.plannedQty) - after.works.reduce((s, w) => s + Number(w.actualQty ?? 0), 0))
          : null),
    };
  }

  @Delete(':id/allocations/:workId')
  @Roles('shop_foreman', 'planner', 'admin')
  @ApiOperation({ summary: 'Снять ошибочное разнесение (пропорции пересчитаются)' })
  async removeAllocation(@Param('id') id: string, @Param('workId') workId: string) {
    const work = await this.prisma.contractorWork.findUnique({ where: { id: workId } });
    if (!work || work.requestId !== id) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Разнесение не найдено в этой заявке' });
    }
    await this.prisma.contractorWork.delete({ where: { id: workId } });
    const rows = await this.redistribute(id);
    return { deleted: true, recalculatedRows: rows };
  }

  /**
   * Приёмка партии целиком: объём и сумма акта. Сумма замораживается и
   * делится между заказами пропорционально разнесённому объёму — с этого
   * момента пересчёт калькуляции цену подряда уже не двигает.
   */
  @Post(':id/accept')
  @Roles('procurement', 'accountant', 'planner', 'admin')
  @ApiOperation({ summary: 'Принять работу по заявке (замораживает сумму акта)' })
  async accept(
    @Param('id') id: string,
    @Body() body: {
      actualQty: number; actualAmount?: number;
      /** «Заказ поставщику» из 1С — основание приёмки: сумма берётся из него */
      paymentDocumentId?: string | null;
      note?: string;
    },
    @CurrentUser() user: UserPayload,
  ) {
    const req = await this.prisma.contractorRequest.findUnique({
      where: { id }, include: { works: true, contractor: { select: { binIin: true, name: true } } },
    });
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: `Заявка ${id} не найдена` });
    if (req.status === 'CANCELLED') {
      throw new ConflictException({ code: 'REQUEST_CANCELLED', message: 'Заявка отменена' });
    }
    const qty = Number(body.actualQty);
    if (!(qty > 0)) {
      throw new BadRequestException({ code: 'INVALID_QTY', message: 'Укажите принятый объём' });
    }

    // Приёмка по ДО из 1С: Б24 оформил заказ поставщику, 1С назвала сумму —
    // она и раскидывается по заказам. Ручной ввод остаётся на случай, когда
    // ДО ещё не пришёл, но платить уже надо
    let doc: { id: string; doNumber: string; totalAmount: unknown } | null = null;
    if (body.paymentDocumentId) {
      const found = await this.prisma.paymentDocument.findUnique({
        where: { id: body.paymentDocumentId },
        include: {
          contractor: { select: { binIin: true, name: true } },
          contractorRequest: { select: { id: true, number: true } },
        },
      });
      if (!found) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ поставщику не найден' });
      }
      // Один ДО — одна заявка: иначе одна сумма 1С разнеслась бы дважды
      if (found.contractorRequest && found.contractorRequest.id !== id) {
        throw new ConflictException({
          code: 'DOC_TAKEN',
          message: `ДО ${found.doNumber} уже привязан к заявке ${found.contractorRequest.number}`,
        });
      }
      // ДО чужого контрагента — почти наверняка ошибка выбора из списка
      if (req.contractor?.binIin && found.contractor.binIin
        && req.contractor.binIin !== found.contractor.binIin) {
        throw new BadRequestException({
          code: 'DOC_CONTRACTOR_MISMATCH',
          message: `ДО ${found.doNumber} — контрагент «${found.contractor.name}»,`
            + ` а в заявке подрядчик «${req.contractor?.name ?? '—'}»`,
        });
      }
      doc = found;
    }

    const amount = body.actualAmount != null ? Number(body.actualAmount)
      : doc != null ? Number(doc.totalAmount) : NaN;
    if (!(amount >= 0)) {
      throw new BadRequestException({
        code: 'INVALID_AMOUNT',
        message: doc == null && body.actualAmount == null
          ? 'Укажите сумму или выберите заказ поставщику из 1С'
          : 'Сумма акта не может быть отрицательной',
      });
    }
    // Разнесли 15 т, принимаем 12 — цифры разошлись, и молча подрезать
    // чужие заказы нельзя: пусть человек сначала поправит разнесение
    const allocated = req.works.reduce((s, w) => s + Number(w.actualQty ?? 0), 0);
    if (allocated > qty + 1e-6) {
      throw new ConflictException({
        code: 'ALLOCATED_EXCEEDS_ACT',
        message: `По заказам разнесено ${round3(allocated)} ${RATE_UNITS[req.rateType] ?? ''}`
          + `, а принимается ${qty} — поправьте разнесение`,
      });
    }

    await this.prisma.contractorRequest.update({
      where: { id },
      data: {
        actualQty: qty,
        actualAmount: amount,
        acceptedAt: new Date(),
        acceptedById: dbUserId(user),
        status: req.works.length > 0 && allocated >= qty - 1e-6 ? 'ALLOCATED' : 'ACCEPTED',
        // Смена основания: новый ДО заменяет старый, отвязка — только с ДО
        ...(body.paymentDocumentId !== undefined
          ? { paymentDocumentId: doc?.id ?? null }
          : {}),
        note: body.note?.trim() || req.note,
      },
    });
    // Строки узнают о приёмке: acceptedAt на них — это «деньги заморожены»
    if (req.works.length > 0) {
      await this.prisma.contractorWork.updateMany({
        where: { requestId: id },
        data: { acceptedAt: new Date(), acceptedById: dbUserId(user) },
      });
    }
    const rows = await this.redistribute(id);

    const after = await this.prisma.contractorRequest.findUnique({
      where: { id },
      include: { works: { include: { order: { select: { orderNumber: true } } } } },
    });
    return {
      accepted: true,
      actualQty: qty,
      actualAmount: amount,
      supplierDocNumber: doc?.doNumber ?? null,
      allocatedRows: rows,
      // Директор должен видеть арифметику, а не «сумма разошлась по заказам»
      split: (after?.works ?? []).map((w) => ({
        orderNumber: w.order.orderNumber,
        qty: Number(w.actualQty ?? 0),
        amount: w.actualAmount != null ? Number(w.actualAmount) : 0,
      })),
      unallocatedQty: round3(qty - allocated),
    };
  }

  @Post(':id/cancel')
  @Roles('planner', 'procurement', 'admin')
  @ApiOperation({ summary: 'Отменить заявку (нельзя, если уже разнесена)' })
  async cancel(@Param('id') id: string) {
    const req = await this.prisma.contractorRequest.findUnique({
      where: { id }, include: { works: true },
    });
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: `Заявка ${id} не найдена` });
    if (req.works.length > 0) {
      throw new ConflictException({
        code: 'HAS_ALLOCATIONS',
        message: `Заявка разнесена на ${req.works.length} заказов — сначала снимите разнесение`,
      });
    }
    return this.prisma.contractorRequest.update({ where: { id }, data: { status: 'CANCELLED' } });
  }
}
