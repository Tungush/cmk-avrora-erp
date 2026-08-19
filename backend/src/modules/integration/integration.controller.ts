import {
  Controller, Get, Post, Param, Query, Body, Req,
  UnauthorizedException, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { IntegrationService, INTEGRATION_1C_URL } from '../../services/integration.service';
import { InboxHandlersService } from './inbox-handlers.service';
import { OneCSyncService } from './onec-sync.service';
import { OneCClientService, ONEC_BASE_URL } from '../../services/onec-client.service';
import { runWithFallback } from '../../common/fallback';

/** Типы, которые принимаем от 1С (08_INTEGRATION_1C.md §4) */
const KNOWN_INBOX_TYPES = [
  'nomenclature.created',
  'receipt.posted',
  'stock.snapshot',
  'payment.posted',
  'order.status_changed',
  'purchase_order.posted',
];

@ApiTags('Integration - 1C')
@Controller('integrations')
export class IntegrationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integration: IntegrationService,
    private readonly handlers: InboxHandlersService,
    private readonly sync: OneCSyncService,
    private readonly onec: OneCClientService,
  ) {}

  /**
   * Приём сообщений от 1С. Подпись HMAC, а не JWT: у внешней системы
   * нет пользователя (04_ROLES_PERMISSIONS.md, §вебхуки).
   */
  @Public()
  @Post('1c/webhook/:type')
  @ApiOperation({ summary: 'Вебхук 1С: POST /integrations/1c/webhook/{тип} (HMAC, идемпотентно)' })
  async receive(
    @Param('type') type: string,
    @Body() body: Record<string, any>,
    @Req() req: Request,
  ) {
    if (!KNOWN_INBOX_TYPES.includes(type)) {
      throw new BadRequestException({
        code: 'UNKNOWN_TYPE',
        message: `Неизвестный тип: ${type}. Допустимо: ${KNOWN_INBOX_TYPES.join(', ')}`,
      });
    }

    const signature = req.header('X-Signature');
    const raw = (req as any).rawBody ?? JSON.stringify(body);
    if (!this.integration.verifySignature(raw, signature)) {
      throw new UnauthorizedException({ code: 'INVALID_SIGNATURE', message: 'Подпись не совпала' });
    }

    // Ключ идемпотентности — GUID документа 1С: повторная доставка не применится дважды
    const externalKey = String(body.externalKey ?? body.guid ?? body.documentNumber ?? '');
    if (!externalKey) {
      throw new BadRequestException({
        code: 'MISSING_KEY',
        message: 'Нужен externalKey (GUID документа 1С) для идемпотентности',
      });
    }

    const { message, duplicate } = await this.integration.receive({ type, externalKey, payload: body });
    if (duplicate) {
      return { accepted: true, duplicate: true, messageId: message.id, status: message.status };
    }

    // Обрабатываем сразу; при ошибке сообщение останется в очереди на ретрай
    const result = await this.handlers.processPending(5);
    return { accepted: true, duplicate: false, messageId: message.id, result };
  }

  // ---------- Журнал обмена ----------

  @Get('status')
  @ApiBearerAuth()
  @Roles('admin', 'director')
  @ApiOperation({ summary: 'Состояние обмена: настроен ли, что ждёт отправки' })
  async status() {
    return runWithFallback(
      this.prisma,
      async () => {
        const [outbox, inbox] = await Promise.all([
          this.prisma.outboxMessage.groupBy({ by: ['status'], _count: { _all: true } }),
          this.prisma.inboxMessage.groupBy({ by: ['status'], _count: { _all: true } }),
        ]);
        const toMap = (rows: Array<{ status: string; _count: { _all: number } }>) =>
          Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
        const [syncedOrders, totalOrders] = await Promise.all([
          this.prisma.order.count({ where: { onecSyncedAt: { not: null } } }),
          this.prisma.order.count(),
        ]);
        return {
          configured: !!INTEGRATION_1C_URL,
          endpoint: INTEGRATION_1C_URL || null,
          // Приём данных: GET-запросы к HTTP-сервисам 1С
          pull: {
            configured: !!ONEC_BASE_URL,
            baseUrl: ONEC_BASE_URL || null,
            syncedOrders,
            totalOrders,
          },
          outbox: toMap(outbox as any),
          inbox: toMap(inbox as any),
        };
      },
      () => ({ configured: false, endpoint: null, pull: { configured: false, baseUrl: null, syncedOrders: 0, totalOrders: 0 }, outbox: {}, inbox: {} }),
    );
  }

  @Get('messages')
  @ApiBearerAuth()
  @Roles('admin', 'director')
  @ApiOperation({ summary: 'Журнал обмена: исходящие и входящие' })
  async messages(@Query() query: { direction?: string; status?: string; limit?: string }) {
    const take = Number(query.limit) || 50;
    const where = query.status ? { status: query.status as any } : {};

    return runWithFallback(
      this.prisma,
      async () => {
        const [outbox, inbox] = await Promise.all([
          query.direction === 'in'
            ? []
            : this.prisma.outboxMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take }),
          query.direction === 'out'
            ? []
            : this.prisma.inboxMessage.findMany({ where, orderBy: { receivedAt: 'desc' }, take }),
        ]);
        return { outbox, inbox };
      },
      () => ({ outbox: [], inbox: [] }),
    );
  }

  // ---------- Приём из 1С (GET-запросы, ТЗ v10) ----------

  @Post('1c/sync/orders')
  @ApiBearerAuth()
  @Roles('admin', 'sales_manager', 'director')
  @ApiOperation({ summary: 'Забрать заказы клиентов из 1С (GET A) — пакетом' })
  async syncOrders(@Body() body: { limit?: number; onlyActive?: boolean }) {
    return this.sync.syncOrders({ limit: body?.limit ?? 50, onlyActive: body?.onlyActive });
  }

  @Post('1c/sync/order/:orderNumber')
  @ApiBearerAuth()
  @Roles('admin', 'sales_manager', 'director')
  @ApiOperation({ summary: 'Забрать один заказ из 1С по номеру' })
  async syncOrder(@Param('orderNumber') orderNumber: string) {
    const report = {
      requested: 1, found: 0, updated: 0,
      notFound: [] as string[], unknownArticles: [] as string[],
      unknownStatuses: [] as string[], errors: [] as Array<{ orderNumber: string; error: string }>,
    };
    await this.sync.syncClientOrder(decodeURIComponent(orderNumber), report);
    return report;
  }

  @Post('1c/sync/procurement/:orderNumber')
  @ApiBearerAuth()
  @Roles('admin', 'procurement', 'director')
  @ApiOperation({ summary: 'Забрать закуп под заказ (GET D → GET C)' })
  async syncProcurement(@Param('orderNumber') orderNumber: string) {
    return this.sync.syncProcurementForOrder(decodeURIComponent(orderNumber));
  }

  @Get('1c/ping')
  @ApiBearerAuth()
  @Roles('admin', 'director')
  @ApiOperation({ summary: 'Проверить связь с 1С на примере номера заказа' })
  async ping(@Query('orderNumber') orderNumber?: string) {
    if (!orderNumber) {
      const sample = await this.prisma.order.findFirst({
        where: { NOT: { orderNumber: { contains: 'ROW' } } },
        select: { orderNumber: true },
      });
      orderNumber = sample?.orderNumber;
    }
    if (!orderNumber) return { ok: false, message: 'Нет заказа для проверки' };
    const res = await this.onec.ping(orderNumber);
    return { ...res, orderNumber };
  }

  @Post('outbox/flush')
  @ApiBearerAuth()
  @Roles('admin')
  @ApiOperation({ summary: 'Отправить накопленные исходящие сейчас' })
  async flush() {
    return this.integration.flushOutbox();
  }

  @Post('inbox/process')
  @ApiBearerAuth()
  @Roles('admin')
  @ApiOperation({ summary: 'Разобрать необработанные входящие' })
  async process() {
    return this.handlers.processPending();
  }

  @Post('messages/:id/retry')
  @ApiBearerAuth()
  @Roles('admin')
  @ApiOperation({ summary: 'Повторить доставку сообщения (сброс счётчика попыток)' })
  async retry(@Param('id') id: string) {
    const out = await this.prisma.outboxMessage.findUnique({ where: { id } });
    if (out) {
      await this.prisma.outboxMessage.update({
        where: { id },
        data: { status: 'PENDING', attempts: 0, nextRetryAt: null, lastError: null },
      });
      return { direction: 'out', requeued: true };
    }
    const inb = await this.prisma.inboxMessage.findUnique({ where: { id } });
    if (inb) {
      await this.prisma.inboxMessage.update({
        where: { id },
        data: { status: 'PENDING', attempts: 0, error: null },
      });
      return { direction: 'in', requeued: true };
    }
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'Сообщение не найдено' });
  }
}
