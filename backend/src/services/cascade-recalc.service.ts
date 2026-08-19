import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from './prisma.service';
import { ArticleCostingService } from './article-costing.service';

type RecalcJobType = 'material-price' | 'article-bom' | 'procurement-period';
type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

interface RecalcJobRecord {
  id: string;
  type: RecalcJobType;
  targetId: string;
  triggeredBy?: string;
  status: JobStatus;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

interface ProcurementViewRow {
  material_id: string;
  purchase_qty: Prisma.Decimal | number;
}

@Injectable()
export class CascadeRecalcService {
  private readonly logger = new Logger(CascadeRecalcService.name);
  private readonly jobs = new Map<string, RecalcJobRecord>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly articleCosting: ArticleCostingService,
  ) {}

  enqueueMaterialPriceRecalc(materialId: string, triggeredBy?: string) {
    return this.enqueue('material-price', materialId, triggeredBy, () =>
      this.recalcBomCostsByMaterial(materialId, triggeredBy),
    );
  }

  enqueueArticleBomRecalc(articleId: string, triggeredBy?: string) {
    return this.enqueue('article-bom', articleId, triggeredBy, () =>
      this.recalcArticleCost(articleId, triggeredBy),
    );
  }

  enqueueProcurementRecalc(periodKey: string, triggeredBy?: string) {
    return this.enqueue('procurement-period', periodKey, triggeredBy, () =>
      this.recalcProcurementNeed(periodKey, triggeredBy),
    );
  }

  getJob(jobId: string) {
    return this.jobs.get(jobId) || null;
  }

  private enqueue(
    type: RecalcJobType,
    targetId: string,
    triggeredBy: string | undefined,
    handler: () => Promise<void>,
  ) {
    const id = randomUUID();
    this.jobs.set(id, {
      id,
      type,
      targetId,
      triggeredBy,
      status: 'queued',
      createdAt: new Date().toISOString(),
    });

    setTimeout(() => {
      void this.runJob(id, handler);
    }, 0);

    return { jobId: id, status: 'queued' as const };
  }

  private async runJob(jobId: string, handler: () => Promise<void>) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    job.status = 'running';
    try {
      await handler();
      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : 'Unknown recalculation error';
      this.logger.error(`Recalculation job ${jobId} failed: ${job.error}`);
    }
  }

  async recalcBomCostsByMaterial(materialId: string, triggeredBy = 'system') {
    const material = await this.prisma.material.findUnique({
      where: { id: materialId },
      select: { id: true, materialCode: true, purchasePrice: true },
    });
    if (!material) {
      return;
    }

    const bomItems = await this.prisma.bomItem.findMany({
      where: { materialId },
      select: { id: true, articleId: true, qtyPerUnit: true },
    });

    const articleIds = [...new Set(bomItems.map((item) => item.articleId))];
    await this.prisma.$transaction(
      bomItems.map((item) =>
        this.prisma.bomItem.update({
          where: { id: item.id },
          data: {
            lineCost: Number(item.qtyPerUnit) * Number(material.purchasePrice),
          },
        }),
      ),
    );

    for (const articleId of articleIds) {
      await this.recalcArticleCost(articleId, triggeredBy);
    }

    await this.createAuditLog('Material', materialId, 'RECALC_BOM_COSTS', triggeredBy, {
      materialCode: material.materialCode,
      affectedArticleIds: articleIds,
    });
  }

  async recalcArticleCost(articleId: string, triggeredBy = 'system') {
    // Единый каскад Этапа 3: нормы труда + состав + снимок + SSE (§3.4)
    const result = await this.articleCosting.recalculate(articleId, 'bom_change', triggeredBy);
    await this.createAuditLog('Article', articleId, 'RECALC_ARTICLE_COST', triggeredBy, {
      specPrice: result.price,
      totalCost: result.totalCost,
    });
  }

  async recalcProcurementNeed(periodKey: string, triggeredBy = 'system') {
    const rows = await this.prisma.$queryRaw<ProcurementViewRow[]>`
      SELECT material_id, purchase_qty
      FROM v_procurement_needed
      WHERE period_key = ${periodKey}
    `;

    for (const row of rows) {
      const requestedQty = Number(row.purchase_qty);
      const existingDraft = await this.prisma.purchaseRequest.findFirst({
        where: {
          materialId: row.material_id,
          status: 'DRAFT',
        },
      });

      if (requestedQty <= 0) {
        continue;
      }

      if (existingDraft) {
        await this.prisma.purchaseRequest.update({
          where: { id: existingDraft.id },
          data: { requestedQty },
        });
        continue;
      }

      await this.prisma.purchaseRequest.create({
        data: {
          materialId: row.material_id,
          requestedQty,
          status: 'DRAFT',
        },
      });
    }

    await this.createAuditLog('PurchaseRequest', periodKey, 'RECALC_PROCUREMENT_NEED', triggeredBy, {
      periodKey,
      affectedRows: rows.length,
    });
  }

  private async createAuditLog(
    entityType: string,
    entityId: string,
    action: string,
    triggeredBy: string,
    after: Record<string, unknown>,
  ) {
    const userId = triggeredBy && triggeredBy !== 'system' ? triggeredBy : null;
    await this.prisma.auditLogEntry.create({
      data: {
        entityType,
        entityId,
        action,
        before: Prisma.JsonNull,
        after: after as Prisma.InputJsonValue,
        userId,
        userRole: 'system',
        comment: `Triggered by ${triggeredBy}`,
      },
    });
  }
}
