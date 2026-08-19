import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../services/prisma.service';
import { IntegrationService } from '../../services/integration.service';
import { MaterialReceiptService } from '../../services/material-receipt.service';

/**
 * Обработчики входящих сообщений 1С (08_INTEGRATION_1C.md §4).
 *
 * Принцип: обработчик применяет только то, чем 1С владеет по матрице §2.
 * Всё, что принадлежит нам (состав, нормы, план, резервы), из 1С не
 * перезаписывается — расхождение уходит в отчёт сверки, а не в молчаливую правку.
 */
@Injectable()
export class InboxHandlersService {
  private readonly logger = new Logger(InboxHandlersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integration: IntegrationService,
    private readonly receipts: MaterialReceiptService,
  ) {}

  /** Разбор накопленных входящих; вызывается после приёма и по расписанию */
  async processPending(limit = 50) {
    const messages = await this.prisma.inboxMessage.findMany({
      where: { status: { in: ['PENDING', 'FAILED'] } },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    });

    let processed = 0;
    let failed = 0;
    let ignored = 0;

    for (const m of messages) {
      try {
        const result = await this.dispatch(m.type, m.payload as Record<string, any>);
        if (result === 'IGNORED') {
          await this.prisma.inboxMessage.update({
            where: { id: m.id },
            data: { status: 'IGNORED', processedAt: new Date() },
          });
          ignored++;
        } else {
          await this.integration.markProcessed(m.id);
          processed++;
        }
      } catch (e) {
        await this.integration.markFailed(
          m.id,
          e instanceof Error ? e.message : 'Unknown error',
          m.attempts + 1,
        );
        failed++;
      }
    }
    return { processed, failed, ignored, total: messages.length };
  }

  private async dispatch(type: string, payload: Record<string, any>): Promise<'OK' | 'IGNORED'> {
    switch (type) {
      case 'nomenclature.created':
        return this.onNomenclatureCreated(payload);
      case 'receipt.posted':
        return this.onReceiptPosted(payload);
      case 'stock.snapshot':
        return this.onStockSnapshot(payload);
      default:
        this.logger.warn(`Неизвестный тип входящего сообщения: ${type}`);
        return 'IGNORED';
    }
  }

  /**
   * 1С создала номенклатуру по нашей заявке и вернула код (§4.1).
   * Закрывает цикл: заявка инженера → артикул из 1С → карточка изделия.
   */
  private async onNomenclatureCreated(p: Record<string, any>): Promise<'OK'> {
    const { requestId, articleCode, externalId, name } = p;
    if (!articleCode) throw new Error('nomenclature.created: нет articleCode');

    const request = requestId
      ? await this.prisma.nomenclatureRequest.findUnique({ where: { id: String(requestId) } })
      : null;

    let article = await this.prisma.article.findUnique({ where: { articleCode: String(articleCode) } });
    if (!article) {
      article = await this.prisma.article.create({
        data: {
          articleCode: String(articleCode),
          name: String(name ?? request?.proposedName ?? articleCode),
          series: request?.series ?? null,
          description: request?.description ?? null,
        },
      });
    }

    if (externalId) {
      await this.integration.linkExternal({
        entityType: 'Article',
        localId: article.id,
        externalId: String(externalId),
        externalCode: String(articleCode),
      });
    }

    if (request && request.status === 'PENDING') {
      await this.prisma.nomenclatureRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          articleId: article.id,
          decidedBy: '1С',
          decidedAt: new Date(),
          decisionComment: `Артикул присвоен в 1С: ${articleCode}`,
        },
      });
    }
    return 'OK';
  }

  /**
   * Проведён документ «Поступление товаров» (§4.4).
   * Материал ищем по коду или по маппингу ExternalRef; неизвестный —
   * это сигнал, что номенклатура завелась мимо нас, а не повод молча создать.
   */
  private async onReceiptPosted(p: Record<string, any>): Promise<'OK'> {
    const lines: any[] = Array.isArray(p.lines) ? p.lines : [p];
    const docNumber = p.documentNumber ? String(p.documentNumber) : null;
    const supplier = p.supplierName ? String(p.supplierName) : null;
    const date = p.date ? new Date(String(p.date)) : new Date();

    for (const line of lines) {
      const material = await this.resolveMaterial(line);
      if (!material) {
        throw new Error(
          `Материал не найден: код «${line.materialCode ?? line.externalId ?? '—'}». ` +
          'Заведите номенклатуру или сверьте справочники.',
        );
      }
      await this.receipts.receive({
        materialId: material,
        qty: Number(line.qty),
        unitPrice: Number(line.price ?? line.unitPrice ?? 0),
        movementDate: date,
        supplierName: supplier,
        documentNumber: docNumber,
        comment: line.comment ?? null,
      });
    }
    return 'OK';
  }

  /** Снимок остатков: не перезаписываем, а фиксируем расхождение (§5) */
  private async onStockSnapshot(p: Record<string, any>): Promise<'OK'> {
    const lines: any[] = Array.isArray(p.lines) ? p.lines : [];
    const divergences: Array<{ materialCode: string; ours: number; theirs: number }> = [];

    for (const line of lines) {
      const materialId = await this.resolveMaterial(line);
      if (!materialId) continue;
      const material = await this.prisma.material.findUnique({ where: { id: materialId } });
      if (!material) continue;
      const ours = Number(material.stockQty);
      const theirs = Number(line.qty ?? 0);
      if (Math.abs(ours - theirs) > 0.001) {
        divergences.push({ materialCode: material.materialCode, ours, theirs });
      }
    }

    if (divergences.length > 0) {
      // Расхождение — задача человеку: пишем в аудит, остатки не трогаем
      await this.prisma.auditLogEntry.create({
        data: {
          entityType: 'Material',
          entityId: '00000000-0000-0000-0000-000000000000',
          action: 'stock_divergence',
          after: { divergences: divergences.slice(0, 100), count: divergences.length } as any,
          userRole: '1С',
          comment: `Расхождение остатков с 1С по ${divergences.length} позициям`,
        },
      });
    }
    return 'OK';
  }

  /** Материал по маппингу 1С, коду или наименованию */
  private async resolveMaterial(line: Record<string, any>): Promise<string | null> {
    if (line.externalId) {
      const local = await this.integration.findLocalId('Material', String(line.externalId));
      if (local) return local;
    }
    if (line.materialCode) {
      const byCode = await this.prisma.material.findUnique({
        where: { materialCode: String(line.materialCode) },
        select: { id: true },
      });
      if (byCode) return byCode.id;
    }
    if (line.name) {
      const byName = await this.prisma.material.findFirst({
        where: { name: { equals: String(line.name), mode: 'insensitive' } },
        select: { id: true },
      });
      if (byName) return byName.id;
    }
    return null;
  }
}
