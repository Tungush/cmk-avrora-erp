import { Controller, Get, Post, Patch, Param, Query, Body, NotFoundException, ConflictException, ForbiddenException, BadRequestException, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Resource } from '../../common/decorators/resource.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { assertFieldWriteAllowed, permissionsForRoles, rowScopeForRoles } from '../../common/field-access';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockOrders } from '../../common/mock-data';
import { OrderStateMachine, OrderStateContext } from '../../services/order-state-machine.service';
import { IntegrationService } from '../../services/integration.service';

/** Кто может перевести заказ В этот статус (серверная копия матрицы из 04_ROLES_PERMISSIONS.md) */
const STATUS_TRANSITION_ROLES: Record<string, string[]> = {
  CONFIRMED: ['sales_manager', 'admin'],
  IN_PRODUCTION: ['planner', 'admin'],
  READY_TO_SHIP: ['warehouse_fg', 'admin'],
  SHIPPED: ['warehouse_fg', 'admin'],
  CLOSED: ['accountant', 'admin'],
  CANCELLED: ['sales_manager', 'director', 'admin'],
};

const STAGE_CODES = [
  'OS_WITH_CUSTOMER', 'GENERAL_VIEW', 'DRAWINGS', 'PROCUREMENT',
  'CUTTING', 'WELDING_ASSEMBLY', 'PAINTING', 'CLADDING',
] as const;

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

        return { data, meta: { page, pageSize, total } };
      },
      () => getMockOrders(page, pageSize),
    );
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
    return order;
  }

  @Post()
  @Roles('sales_manager', 'admin')
  @ApiOperation({ summary: 'Create order' })
  async create(@Body() body: any) {
    const { lines, ...orderData } = body;
    // API принимает человекочитаемые «ФЗ»/«ВЗ» (как в исходной таблице); Prisma ждёт имена enum
    if (orderData.orderType === 'ФЗ') orderData.orderType = 'FZ';
    if (orderData.orderType === 'ВЗ') orderData.orderType = 'VZ';
    if (orderData.orderNumber) {
      const existing = await this.prisma.order.findUnique({ where: { orderNumber: orderData.orderNumber } });
      if (existing) throw new ConflictException({ code: 'DUPLICATE_ENTITY', message: `Order number ${orderData.orderNumber} already exists` });
    } else {
      // Номер в формате исходной таблицы: П-NNNNN-YY (П-88192-21)
      const yy = String(new Date().getFullYear()).slice(-2);
      do {
        orderData.orderNumber = `П-${String(Math.floor(10000 + Math.random() * 90000))}-${yy}`;
      } while (await this.prisma.order.findUnique({ where: { orderNumber: orderData.orderNumber } }));
    }

    // Заказ создаётся у нас, 1С оформляет документ (§4.2) — событие в той же транзакции
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          ...orderData,
          orderLines: lines
            ? { create: lines.map((l: any) => ({ unit: 'шт', ...l })) }
            : undefined,
        },
        include: { customer: true, orderLines: { include: { article: true } } },
      });
      await this.integration.enqueue(tx, {
        type: 'order.created',
        entityType: 'Order',
        entityId: order.id,
        payload: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          customer: { name: order.customer?.name, binIin: order.customer?.binIin },
          orderType: order.orderType,
          plannedShipmentDate: order.plannedShipmentDate,
          lines: order.orderLines.map((l) => ({
            articleCode: l.article?.articleCode,
            name: l.article?.name,
            qty: Number(l.qty),
            unit: l.unit,
            unitPrice: Number(l.unitPrice),
          })),
        },
      });
      return order;
    });
  }

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
      })),
      customerBinIin: order.customer?.binIin,
      productionStages: order.productionStages.map((s) => ({
        stageCode: s.stageCode,
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

    const [updated] = await this.prisma.$transaction([
      this.prisma.order.update({ where: { id }, data: { status: toStatus as any } }),
      this.prisma.auditLogEntry.create({
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
      }),
    ]);

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

  @Patch(':id/production-stages/:code')
  @Roles('shop_foreman', 'planner', 'admin')
  @ApiOperation({ summary: 'Update production stage status (Канбан цеха)' })
  async updateProductionStage(
    @Param('id') id: string,
    @Param('code') code: string,
    @Body() body: { status: string; defectPhotoUrl?: string },
    @CurrentUser() user: UserPayload,
  ) {
    if (!STAGE_CODES.includes(code as any)) {
      throw new BadRequestException({
        code: 'INVALID_STAGE_CODE',
        message: `Неизвестный этап: ${code}. Допустимо: ${STAGE_CODES.join(', ')}`,
      });
    }
    const status = STAGE_STATUS_MAP[body.status];
    if (!status) {
      throw new BadRequestException({
        code: 'INVALID_STAGE_STATUS',
        message: `Недопустимый статус этапа: ${body.status}`,
      });
    }
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: `Order ${id} not found` });

    return this.prisma.productionStage.upsert({
      where: { orderId_stageCode: { orderId: id, stageCode: code as any } },
      update: {
        status: status as any,
        completedAt: status === 'DONE' ? new Date() : null,
        defectPhotoUrl: body.defectPhotoUrl,
      },
      create: {
        orderId: id,
        stageCode: code as any,
        status: status as any,
        completedAt: status === 'DONE' ? new Date() : null,
        defectPhotoUrl: body.defectPhotoUrl,
      },
    });
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
