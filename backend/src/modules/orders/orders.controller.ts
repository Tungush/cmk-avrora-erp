import { Controller, Get, Post, Patch, Param, Query, Body, NotFoundException, ConflictException, ForbiddenException, BadRequestException, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Resource } from '../../common/decorators/resource.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { assertFieldWriteAllowed, permissionsForRoles, rowScopeForRoles } from '../../common/field-access';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockOrders } from '../../common/mock-data';
import {
  OrderStateMachine, OrderStateContext, deriveStatusFromStages,
} from '../../services/order-state-machine.service';
import { IntegrationService } from '../../services/integration.service';
import { MaterialBatchService } from '../../services/material-batch.service';
import {
  stageShapeError, allocateActualHours, resolveTrackingMode, DEFAULT_STAGE_TRACKING_THRESHOLD,
} from '../../common/production-stages';

/** Кто может перевести заказ В этот статус (серверная копия матрицы из 04_ROLES_PERMISSIONS.md) */
const STATUS_TRANSITION_ROLES: Record<string, string[]> = {
  // Приём из инбокса (NEW → CONFIRMED) — руками производства/планирования;
  // директор может всё, что может согласовать
  CONFIRMED: ['sales_manager', 'planner', 'director', 'admin'],
  DRAFT: ['sales_manager', 'planner', 'director', 'admin'],
  IN_PRODUCTION: ['planner', 'admin'],
  READY_TO_SHIP: ['warehouse_fg', 'admin'],
  SHIPPED: ['warehouse_fg', 'admin'],
  CLOSED: ['accountant', 'admin'],
  CANCELLED: ['sales_manager', 'director', 'admin'],
};


const STAGE_STATUS_MAP: Record<string, 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE'> = {
  not_started: 'NOT_STARTED',
  in_progress: 'IN_PROGRESS',
  done: 'DONE',
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  DONE: 'DONE',
};

@ApiTags('Orders')
@ApiBearerAuth()
@Resource('order')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integration: IntegrationService,
    private readonly batches: MaterialBatchService,
  ) {}

  /**
   * Ограничение видимости строк (§1.8): подмешивается в Prisma-where, а не фильтруется после выборки.
   * Без привязки (viewer без linkedCustomerId) — безопасный дефолт «не видит ничего».
   */
  private async rowScopeWhere(user: UserPayload): Promise<Record<string, string> | null> {
    const scope = rowScopeForRoles(user.roles, 'order');
    if (!scope) return null;
    const NONE = '00000000-0000-0000-0000-000000000000';
    // демо-пользователи (usr-*) не существуют в БД — привязки нет
    const dbUser = user.userId.startsWith('usr-')
      ? null
      : await runWithFallback(
          this.prisma,
          () => this.prisma.user.findUnique({
            where: { id: user.userId },
            select: { employeeId: true, linkedCustomerId: true },
          }),
          () => null,
        );
    if (scope === 'customer') return { customerId: dbUser?.linkedCustomerId ?? NONE };
    return { managerId: dbUser?.employeeId ?? NONE };
  }

  @Get()
  @ApiOperation({ summary: 'List orders' })
  async findAll(
    @Query() query: { status?: string; customerId?: string; overdueOnly?: string; page?: string; pageSize?: string; search?: string },
    @CurrentUser() user: UserPayload,
  ) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 50;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.customerId) where.customerId = query.customerId;
    if (query.overdueOnly === 'true') where.overdueDays = { gt: 0 };
    // Сырые заказы Excel-миграции скрыты по умолчанию — не удалены
    if ((query as any).archived !== 'true') where.isArchived = false;
    if (query.search) {
      where.OR = [
        { orderNumber: { contains: query.search, mode: 'insensitive' } },
        { customer: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const scopeWhere = await this.rowScopeWhere(user);
    if (scopeWhere) Object.assign(where, scopeWhere);

    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.order.findMany({
            where, skip, take: pageSize,
            orderBy: { createdAt: 'desc' },
            include: {
              customer: true,
              orderLines: { include: { article: true } },
            },
          }),
          this.prisma.order.count({ where }),
        ]);

        // rawColumns — сырые ячейки Excel с ценами; фронт их не читает,
        // а роли без прав на финансы читать их и не должны
        const clean = data.map(({ rawColumns, ...o }: any) => ({
          ...o,
          orderLines: o.orderLines?.map(({ rawColumns: _r, ...l }: any) => l),
        }));
        return { data: clean, meta: { page, pageSize, total } };
      },
      () => getMockOrders(page, pageSize),
    );
  }

  /**
   * Инбокс «Новые заказы»: пришли из 1С (рождены сделкой Б24), производством
   * не приняты. У каждого — список блокеров: пока они есть, кнопка «Принять»
   * недоступна, и заказ не попадает в планирование.
   */
  @Get('inbox')
  @Roles('planner', 'sales_manager', 'director', 'admin')
  @ApiOperation({ summary: 'Инбокс новых заказов из 1С, ждущих приёма в производство' })
  async inbox() {
    const orders = await this.prisma.order.findMany({
      where: { status: 'NEW' as any, isArchived: false },
      orderBy: { createdAt: 'asc' },
      include: {
        customer: true,
        orderLines: { include: { article: { select: { id: true, articleCode: true, name: true } } } },
      },
    });

    const withBlockers = await Promise.all(orders.map(async (o) => {
      const blockers: Array<{ code: string; message: string }> = [];
      if (o.orderLines.length === 0) {
        blockers.push({ code: 'EMPTY_ORDER_LINES', message: 'Нет позиций — дождитесь синхронизации строк из 1С' });
      }
      const unresolved = o.orderLines.filter((l) => !l.articleId);
      if (unresolved.length > 0) {
        blockers.push({
          code: 'UNRESOLVED_ORDER_LINES',
          message: `${unresolved.length} позиций без сопоставленного артикула: ${unresolved.map((l) => l.productNameRaw || l.articleCodeRaw || '—').slice(0, 3).join(', ')}${unresolved.length > 3 ? '…' : ''}`,
        });
      }
      if (!o.customer?.binIin?.trim()) {
        blockers.push({ code: 'MISSING_CUSTOMER_BIN', message: 'У заказчика нет БИН/ИИН' });
      }
      const withArticle = o.orderLines.filter((l) => l.articleId);
      if (withArticle.length > 0) {
        const bomCounts = await this.prisma.bomItem.groupBy({
          by: ['articleId'],
          where: { articleId: { in: withArticle.map((l) => l.articleId as string) } },
          _count: true,
        });
        const withBom = new Set(bomCounts.map((b) => b.articleId));
        const noBom = withArticle.filter((l) => !withBom.has(l.articleId as string));
        if (noBom.length > 0) {
          blockers.push({
            code: 'NO_BOM',
            message: `${noBom.length} позиций без состава изделия — калькуляция будет пустой`,
          });
        }
      }
      return { ...o, blockers, canAccept: blockers.filter((b) => b.code !== 'NO_BOM').length === 0 };
    }));

    return { data: withBlockers, meta: { total: withBlockers.length } };
  }

  /**
   * Явный приём в производство: NEW → CONFIRMED с записью, кто и когда принял.
   * Блокеры проверяет state machine — здесь только след приёма.
   */
  @Post(':id/accept')
  @Roles('planner', 'sales_manager', 'director', 'admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Принять заказ из инбокса в производство' })
  async acceptOrder(
    @Param('id') id: string,
    @Body() body: { comment?: string },
    @CurrentUser() user: UserPayload,
  ) {
    const result = await this.transitionOrder(id, 'CONFIRMED', body?.comment ?? 'Принят в производство из инбокса', user);
    const dbUser = user.userId.startsWith('usr-') ? null : user.userId;
    let employeeId: string | null = null;
    if (dbUser) {
      const u = await this.prisma.user.findUnique({ where: { id: dbUser }, select: { employeeId: true } });
      employeeId = u?.employeeId ?? null;
    }
    const order = await this.prisma.order.update({
      where: { id },
      data: { acceptedAt: new Date(), acceptedById: employeeId },
    });
    return { ...result, order };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get order by ID' })
  async findOne(@Param('id') id: string, @CurrentUser() user: UserPayload) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        orderLines: { include: { article: true } },
        paymentDocuments: true,
        productionStages: true,
      },
    });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${id} not found` });

    // Row scope действует и на доступ по прямому ID; чужой заказ = 404, не 403 —
    // не раскрываем сам факт существования (§1.8)
    const scopeWhere = await this.rowScopeWhere(user);
    if (scopeWhere) {
      for (const [field, value] of Object.entries(scopeWhere)) {
        if ((order as any)[field] !== value) {
          throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${id} not found` });
        }
      }
    }

    // rawColumns — полный сырой ряд 1С (суммы, договор, дата согласования);
    // тот же список читает order.commercial, что и цены строк. Список
    // (findAll выше) это уже вырезал, здесь была дыра — роль без прав на
    // финансы получала все деньги заказа через один и тот же ответ.
    if (!permissionsForRoles(user.roles).includes('order.commercial:read')) {
      const { rawColumns, ...rest } = order as any;
      return rest;
    }
    return order;
  }

  // Создания заказа руками здесь нет намеренно (решение 23.08.2026).
  // Заказ рождается сделкой в воронке Б24, оттуда документом «Заказ клиента»
  // в 1С, и приходит к нам синхронизацией в инбокс (GET /orders/inbox).
  // Второй способ завести тот же заказ мимо 1С — это гарантированные
  // расхождения, которые потом никто не может объяснить.

  /**
   * Переход статуса через state machine (02_BUSINESS_LOGIC.md §3):
   * проверка роли на конкретный переход, бизнес-условия, запись в аудит.
   */
  private async transitionOrder(
    id: string,
    toStatus: string,
    comment: string | undefined,
    user: UserPayload,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        orderLines: true,
        productionStages: true,
        paymentDocuments: true,
        acceptanceActs: true,
        finishedGoodsMovements: true,
      },
    });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${id} not found` });

    const allowedRoles = STATUS_TRANSITION_ROLES[toStatus];
    if (!allowedRoles) {
      throw new BadRequestException({ code: 'INVALID_STATUS', message: `Unknown target status: ${toStatus}` });
    }
    if (!user.roles.some((r) => allowedRoles.includes(r))) {
      throw new ForbiddenException({
        code: 'TRANSITION_FORBIDDEN',
        message: `Роли [${user.roles.join(', ')}] не могут перевести заказ в ${toStatus}`,
      });
    }

    // Отгружено по этому заказу — сумма движений «отгрузка» против суммы позиций
    const orderedQty = order.orderLines.reduce((s, l) => s + Number(l.qty), 0);
    const shippedQty = order.finishedGoodsMovements
      .filter((m) => m.movementType === 'SHIPMENT')
      .reduce((s, m) => s + Number(m.qty), 0);

    // Долг: по ДО, если они есть; иначе по строкам заказа
    const balanceDue = order.paymentDocuments.length > 0
      ? order.paymentDocuments.reduce((s, d) => s + Number(d.unpaidAmount), 0)
      : order.orderLines.reduce((s, l) => s + Number(l.balanceDue), 0);

    const context: OrderStateContext = {
      orderId: order.id,
      currentStatus: order.status,
      lines: order.orderLines.map((l) => ({
        qty: Number(l.qty),
        reservedQty: Number(l.reservedQty),
        articleCode: l.articleId ?? undefined,
      })),
      customerBinIin: order.customer?.binIin,
      productionStages: order.productionStages.map((s) => ({
        stageCode: s.stageCode,
        // Без передела три шага производства сливаются в один, и проверка
        // «все этапы готовы» считается по неполному списку
        routingStage: s.routingStage,
        status: s.status.toLowerCase(),
      })),
      finishedGoodsShipped: orderedQty > 0 && shippedQty >= orderedQty,
      balanceDue,
      hasAcceptanceAct: order.acceptanceActs.length > 0,
    };

    // BusinessGuardError → 409 через HttpExceptionFilter
    const audit = OrderStateMachine.transition(context, {
      targetStatus: toStatus as any,
      userId: user.userId,
      userRole: user.roles[0],
      comment,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      const upd = await tx.order.update({ where: { id }, data: { status: toStatus as any } });
      // Статус производства уходит в 1С: там по нему оформляют отгрузку
      // и документы — пользователь в саму 1С не заходит
      await this.integration.enqueue(tx, {
        type: 'production-status',
        entityType: 'Order',
        entityId: order.id,
        payload: {
          orderNumber: order.orderNumber,
          onecNum: order.onecNum,
          status: toStatus,
          changedAt: new Date().toISOString(),
          comment: comment ?? null,
        },
      });
      await tx.auditLogEntry.create({
        data: {
          entityType: audit.entityType,
          entityId: audit.entityId,
          action: audit.action,
          before: audit.before as any,
          after: audit.after as any,
          userId: user.userId.startsWith('usr-') ? null : user.userId,
          userRole: audit.userRole,
          comment: audit.comment,
        },
      });
      return upd;
    });

    return { order: updated, audit };
  }

  @Post(':id/status')
  @Roles('sales_manager', 'planner', 'warehouse_fg', 'accountant', 'director', 'admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transition order status (state machine + RBAC + audit)' })
  async transitionStatus(
    @Param('id') id: string,
    @Body() body: { toStatus?: string; status?: string; comment?: string },
    @CurrentUser() user: UserPayload,
  ) {
    const toStatus = body.toStatus ?? body.status;
    if (!toStatus) throw new BadRequestException({ code: 'MISSING_STATUS', message: 'toStatus is required' });
    return this.transitionOrder(id, toStatus, body.comment, user);
  }

  @Patch(':id/status')
  @Roles('sales_manager', 'planner', 'warehouse_fg', 'accountant', 'director', 'admin')
  @ApiOperation({ summary: 'Transition order status (alias for POST :id/status)' })
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { toStatus?: string; status?: string; comment?: string },
    @CurrentUser() user: UserPayload,
  ) {
    const toStatus = body.toStatus ?? body.status;
    if (!toStatus) throw new BadRequestException({ code: 'MISSING_STATUS', message: 'status is required' });
    return this.transitionOrder(id, toStatus, body.comment, user);
  }

  /** Порог из действующего CostingConfig; без БД — значение по умолчанию 5 */
  private async stageTrackingThreshold(): Promise<number> {
    return runWithFallback(
      this.prisma,
      async () => {
        const cfg = await this.prisma.costingConfig.findFirst({
          where: { validTo: null },
          orderBy: { validFrom: 'desc' },
        });
        return cfg?.stageTrackingThreshold ?? DEFAULT_STAGE_TRACKING_THRESHOLD;
      },
      () => DEFAULT_STAGE_TRACKING_THRESHOLD,
    );
  }

  /**
   * Ручное переключение режима отметки (09 §2.2). Переключение вниз, на
   * отметку заказа целиком, запрещено при уже проставленных позициях: иначе
   * построчный факт осиротеет и прогресс посчитается по пустому месту.
   */
  @Patch(':id/stage-tracking-mode')
  @Roles('planner', 'shop_foreman', 'admin')
  @ApiOperation({ summary: 'Переключить отметку этапов: заказ целиком или по позициям' })
  async setStageTrackingMode(
    @Param('id') id: string,
    @Body() body: { mode: 'ORDER' | 'LINE' },
  ) {
    if (body.mode !== 'ORDER' && body.mode !== 'LINE') {
      throw new BadRequestException({
        code: 'INVALID_TRACKING_MODE',
        message: `Режим отметки: ORDER или LINE, получено ${body.mode}`,
      });
    }
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${id} not found` });

    if (body.mode === 'ORDER') {
      const lineStages = await this.prisma.productionStage.count({
        where: { orderId: id, orderLineId: { not: null } },
      });
      if (lineStages > 0) {
        throw new ConflictException({
          code: 'LINE_STAGES_EXIST',
          message: `Нельзя вернуть отметку на заказ целиком: по позициям уже отмечено ${lineStages} этапов`,
        });
      }
    }
    return this.prisma.order.update({ where: { id }, data: { stageTrackingMode: body.mode } });
  }

  /**
   * Отметка этапа цехом (09 §2.1—2.3). Код — веха заказа (DESIGN | SUPPLY |
   * PRODUCTION), для производства дополнительно передел в body.routingStage.
   *
   * Позиция (orderLineId) обязательна ровно в режиме LINE и запрещена в режиме
   * ORDER: смешивать нельзя, иначе прогресс заказа считается по двум разным
   * основаниям и расходится сам с собой.
   */
  /**
   * Обеспеченность заказа сырьём — read-only, до начала работ (26.08.2026).
   * Цех видит «хватает / не хватает N позиций» на карточке заказа в очереди.
   */
  @Get(':id/material-availability')
  @ApiOperation({ summary: 'Хватает ли сырья на заказ (по партиям, с учётом чужих резервов)' })
  async materialAvailability(@Param('id') id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, select: { id: true } });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${id} not found` });
    return this.batches.orderMaterialAvailability(id);
  }

  @Patch(':id/production-stages/:code')
  @Roles('shop_foreman', 'planner', 'admin')
  @ApiOperation({ summary: 'Отметить вид работ по заказу (резка / сборка / покраска)' })
  async updateProductionStage(
    @Param('id') id: string,
    @Param('code') code: string,
    @Body() body: {
      status: string;
      routingStage?: string | null;
      orderLineId?: string | null;
      actualWorkers?: number | null;
      actualHours?: number | null;
      defectPhotoUrl?: string;
    },
    @CurrentUser() user: UserPayload,
  ) {
    const shapeError = stageShapeError(code, body.routingStage);
    if (shapeError) {
      throw new BadRequestException({ code: 'INVALID_STAGE_CODE', message: shapeError });
    }
    const status = STAGE_STATUS_MAP[body.status];
    if (!status) {
      throw new BadRequestException({
        code: 'INVALID_STAGE_STATUS',
        message: `Недопустимый статус этапа: ${body.status}`,
      });
    }
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        orderLines: {
          select: {
            id: true, qty: true, unit: true, articleId: true,
            article: { select: { articleCode: true, name: true } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${id} not found` });

    const orderLineId = body.orderLineId ?? null;
    if (order.stageTrackingMode === 'LINE' && !orderLineId) {
      throw new BadRequestException({
        code: 'ORDER_LINE_REQUIRED',
        message: `Заказ отмечается построчно (${order.orderLines.length} позиций) — укажите orderLineId`,
      });
    }
    if (order.stageTrackingMode === 'ORDER' && orderLineId) {
      throw new BadRequestException({
        code: 'ORDER_LINE_NOT_ALLOWED',
        message: 'Заказ отмечается целиком — orderLineId указывать нельзя',
      });
    }
    if (orderLineId && !order.orderLines.some((l) => l.id === orderLineId)) {
      throw new BadRequestException({
        code: 'ORDER_LINE_NOT_IN_ORDER',
        message: `Позиция ${orderLineId} не принадлежит заказу ${order.orderNumber}`,
      });
    }

    const routingStage = (body.routingStage ?? null) as any;
    // «Кто отметил» — поле было в схеме с самого начала, но не заполнялось.
    // Ссылается на Employee, не на User: у общего цехового входа сотрудник
    // не привязан — тогда остаётся null (след в audit log всё равно есть)
    let completedById: string | null = null;
    if (status === 'DONE' && !user.userId.startsWith('usr-')) {
      const u = await this.prisma.user.findUnique({
        where: { id: user.userId }, select: { employeeId: true },
      });
      completedById = u?.employeeId ?? null;
    }
    const data = {
      status: status as any,
      completedAt: status === 'DONE' ? new Date() : null,
      completedById,
      actualWorkers: body.actualWorkers ?? undefined,
      actualHours: body.actualHours ?? undefined,
      defectPhotoUrl: body.defectPhotoUrl,
    };

    // Составного уникального ключа нет намеренно: NULL-ы в orderLineId и
    // routingStage обычный UNIQUE считает различными. Уникальность держат
    // частичные индексы в БД, поиск здесь — по тем же полям.
    const existing = await this.prisma.productionStage.findFirst({
      where: { orderId: id, orderLineId, stageCode: code as any, routingStage },
    });

    return this.prisma.$transaction(async (tx) => {
      const stage = existing
        ? await tx.productionStage.update({ where: { id: existing.id }, data })
        : await tx.productionStage.create({
            data: { orderId: id, orderLineId, stageCode: code as any, routingStage, ...data },
          });
      // Ход производства виден 1С: по «производство завершено» там начинают
      // готовить отгрузку, не заглядывая к нам
      await this.integration.enqueue(tx, {
        type: 'production-stage',
        entityType: 'Order',
        entityId: id,
        payload: {
          orderNumber: order.orderNumber,
          onecNum: order.onecNum,
          stageCode: code,
          routingStage,
          status,
          changedAt: new Date().toISOString(),
        },
      });

      // Статус заказа выводится из этапов, а не двигается отдельно
      // (решение 23.08.2026). Мастер отметил — заказ сам встал куда надо,
      // и никто больше не делает ту же работу второй раз вручную.
      const allStages = await tx.productionStage.findMany({
        where: { orderId: id },
        select: { stageCode: true, routingStage: true, orderLineId: true, status: true },
      });
      // В режиме LINE шаг закрыт, только когда отмечены все позиции
      const expectedLines = order.stageTrackingMode === 'LINE'
        ? Math.max(1, order.orderLines.length)
        : 1;
      const derived = deriveStatusFromStages(order.status, allStages as any, expectedLines);
      if (derived) {
        // Условие в WHERE: если статус успели сдвинуть между чтением заказа
        // и этой записью (параллельная отметка, ручной переход), обновление
        // не применится и чужое решение не будет затёрто
        const applied = await tx.order.updateMany({
          where: { id, status: order.status },
          data: { status: derived },
        });
        if (applied.count === 0) {
          return { ...stage, orderStatus: order.status, orderStatusChanged: false };
        }
        await tx.auditLogEntry.create({
          data: {
            entityType: 'Order',
            entityId: id,
            action: 'status_change',
            before: { status: order.status } as any,
            after: { status: derived } as any,
            userId: user.userId.startsWith('usr-') ? null : user.userId,
            userRole: user.roles[0],
            comment: `Автоматически по этапам: ${stage.stageCode}${routingStage ? ` / ${routingStage}` : ''} → ${status}`,
          },
        });
        await this.integration.enqueue(tx, {
          type: 'production-status',
          entityType: 'Order',
          entityId: id,
          payload: {
            orderNumber: order.orderNumber,
            onecNum: order.onecNum,
            status: derived,
            changedAt: new Date().toISOString(),
            comment: 'автоматически по отметкам этапов',
          },
        });

        // Все виды работ закрыты — заказ изготовлен. Один сигнал в 1С со
        // всеми позициями: там по нему оформляют «Производство без заказа»
        // (запрос пользователя 26.08.2026, спроектировано в 08_INTEGRATION_1C
        // §4.5). Однократность гарантирует optimistic guard выше: повторного
        // перехода в READY_TO_SHIP из этого кода не бывает.
        if (derived === 'READY_TO_SHIP') {
          const releaseDate = new Date();
          await this.integration.enqueue(tx, {
            type: 'production.completed',
            entityType: 'Order',
            entityId: id,
            payload: {
              orderId: id,
              orderNumber: order.orderNumber,
              onecNum: order.onecNum,
              releaseDate: releaseDate.toISOString(),
              reportedBy: user.email ?? user.roles[0],
              documentHint: 'Производство без заказа',
              lines: order.orderLines
                .filter((l) => l.articleId)
                .map((l) => ({
                  orderLineId: l.id,
                  articleCode: l.article?.articleCode ?? null,
                  articleName: l.article?.name ?? null,
                  qty: Number(l.qty),
                  unit: l.unit,
                })),
            },
          });
          // Той же транзакцией — приход готовой продукции: склад ГП начинает
          // жить от работы цеха, а не ждать отдельной выгрузки
          for (const l of order.orderLines) {
            if (!l.articleId) continue;
            await tx.finishedGoodsMovement.create({
              data: {
                itemId: l.articleId,
                orderId: id,
                movementType: 'FROM_PRODUCTION',
                qty: l.qty,
                movementDate: releaseDate,
              },
            });
          }
        }
      }

      return { ...stage, orderStatus: derived ?? order.status, orderStatusChanged: Boolean(derived) };
    });
  }

  /**
   * Раскладка фактических часов по позициям (09 §2.3): мастер вводит один факт
   * на заказ, разбивка по изделиям считается из нормативной трудоёмкости.
   */
  @Get(':id/production-stages/:code/hours-allocation')
  @ApiOperation({ summary: 'Как фактические часы этапа лягут на позиции заказа' })
  async stageHoursAllocation(
    @Param('id') id: string,
    @Param('code') code: string,
    @Query('routingStage') routingStageQuery?: string,
  ) {
    const routingStage = routingStageQuery ?? null;
    const shapeError = stageShapeError(code, routingStage);
    if (shapeError) {
      throw new BadRequestException({ code: 'INVALID_STAGE_CODE', message: shapeError });
    }

    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        orderLines: { include: { article: { select: { id: true, articleCode: true, name: true } } } },
        productionStages: true,
      },
    });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${id} not found` });

    const stage = order.productionStages.find(
      (s) => s.stageCode === (code as any) && s.routingStage === (routingStage as any) && !s.orderLineId,
    );
    const actualHours = stage?.actualHours ? Number(stage.actualHours) : 0;

    const articleIds = order.orderLines.map((l) => l.article?.id).filter(Boolean) as string[];
    const ops = routingStage
      ? await this.prisma.routingOperation.findMany({
          where: { articleId: { in: articleIds }, stage: routingStage as any },
        })
      : [];
    const normByArticle = new Map(
      ops.map((o) => [o.articleId, Number(o.workers) * Number(o.hoursPerUnit)]),
    );

    const lines = order.orderLines.map((l) => ({
      orderLineId: l.id,
      normManHours: (normByArticle.get(l.article?.id ?? '') ?? 0) * Number(l.qty),
    }));
    const allocation = allocateActualHours(actualHours, lines);

    return {
      stage: { code, routingStage, actualHours },
      basis: normByArticle.size > 0 ? 'norms' : 'equal_split',
      lines: allocation.map((a) => {
        const line = order.orderLines.find((l) => l.id === a.orderLineId);
        return {
          ...a,
          articleCode: line?.article?.articleCode ?? line?.articleCodeRaw ?? null,
          articleName: line?.article?.name ?? line?.productNameRaw ?? null,
          qty: line ? Number(line.qty) : 0,
        };
      }),
    };
  }

  @Patch(':id')
  @Roles('sales_manager', 'accountant', 'planner', 'warehouse_fg', 'admin')
  @ApiOperation({ summary: 'Update order (field-level RBAC)' })
  async update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: UserPayload) {
    // Каждое поле тела проверяется на право <group>:write — §1.5 07_ARCHITECTURE_AND_UX.md
    assertFieldWriteAllowed(body, 'order', permissionsForRoles(user.roles));
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${id} not found` });
    return this.prisma.order.update({ where: { id }, data: body });
  }
}
