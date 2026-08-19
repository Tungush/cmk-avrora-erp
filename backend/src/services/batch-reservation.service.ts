import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { EventsService } from './events.service';
import { runWithFallback } from '../common/fallback';
import {
  availabilityOf, assessRequest, reservationExpiry, classifyReservations,
  ReservationLike, DEFAULT_RESERVATION_TTL_DAYS, DEFAULT_RESERVATION_WARN_DAYS,
} from '../common/batch-reservations';

/**
 * Резервы партий (09 §4.4). Согласование перехвата — за директором:
 * это чужие деньги и чужой срок отгрузки.
 */
@Injectable()
export class BatchReservationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  private toLike(rows: any[]): ReservationLike[] {
    return rows.map((r) => ({
      id: r.id,
      batchId: r.batchId,
      orderId: r.orderId,
      qty: Number(r.qty),
      status: r.status,
      expiresAt: r.expiresAt,
    }));
  }

  /** Доступность партий материала с учётом чужих резервов */
  async availability(materialId: string, forOrderId?: string | null) {
    return runWithFallback(
      this.prisma,
      async () => {
        const batches = await this.prisma.materialBatch.findMany({
          where: { materialId, qtyRemaining: { gt: 0 } },
          orderBy: { receiptDate: 'asc' },
        });
        const reservations = this.toLike(
          await this.prisma.batchReservation.findMany({
            where: { batchId: { in: batches.map((b) => b.id) }, status: 'ACTIVE' },
          }),
        );
        return batches.map((b) => ({
          ...availabilityOf({ id: b.id, qtyRemaining: Number(b.qtyRemaining) }, reservations, forOrderId),
          receiptDate: b.receiptDate,
          unitPrice: Number(b.unitPrice),
          supplierName: b.supplierName,
          documentNumber: b.documentNumber,
          priceAnomaly: b.priceAnomaly,
        }));
      },
      () => [],
    );
  }

  /**
   * Резервы под согласованную калькуляцию. Черновики не резервируют:
   * иначе металл окажется занят коммерческими предложениями, которые
   * никуда не пойдут.
   */
  async reserveForCosting(costingId: string, userId?: string, ttlDays = DEFAULT_RESERVATION_TTL_DAYS) {
    const costing = await this.prisma.orderCosting.findUnique({
      where: { id: costingId },
      include: { materials: true },
    });
    if (!costing) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Калькуляция ${costingId} не найдена` });
    }
    if (costing.status !== 'APPROVED') {
      throw new BadRequestException({
        code: 'COSTING_NOT_APPROVED',
        message: 'Резервировать партии можно только под согласованную калькуляцию',
      });
    }

    const expiresAt = reservationExpiry(new Date(), ttlDays);
    const created = [];

    for (const m of costing.materials) {
      const allocations = (m.allocations as any[]) ?? [];
      for (const a of allocations) {
        if (!a?.batchId || !(Number(a.qty) > 0)) continue;
        const existing = await this.prisma.batchReservation.findFirst({
          where: { batchId: a.batchId, orderCostingId: costingId, status: 'ACTIVE' },
        });
        if (existing) continue;
        created.push(await this.prisma.batchReservation.create({
          data: {
            batchId: a.batchId,
            orderId: costing.orderId,
            orderCostingId: costingId,
            qty: Number(a.qty),
            expiresAt,
            createdById: userId && !userId.startsWith('usr-') ? userId : null,
          },
        }));
      }
    }
    return { created: created.length, expiresAt, reservations: created };
  }

  /** Хватит ли объёма и нужно ли согласование — до создания резерва */
  async assess(batchId: string, orderId: string, wantQty: number) {
    const batch = await this.prisma.materialBatch.findUnique({ where: { id: batchId } });
    if (!batch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Партия ${batchId} не найдена` });
    }
    const reservations = this.toLike(
      await this.prisma.batchReservation.findMany({ where: { batchId, status: 'ACTIVE' } }),
    );
    const av = availabilityOf({ id: batchId, qtyRemaining: Number(batch.qtyRemaining) }, reservations, orderId);
    return { availability: av, assessment: assessRequest(av, wantQty) };
  }

  /** Запрос на перехват: причина обязательна — директор решает не вслепую */
  async requestOverride(input: {
    reservationId: string;
    requestedByOrderId: string;
    qtyRequested: number;
    reason: string;
  }, userId?: string) {
    const reservation = await this.prisma.batchReservation.findUnique({
      where: { id: input.reservationId },
    });
    if (!reservation) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Резерв ${input.reservationId} не найден` });
    }
    if (reservation.status !== 'ACTIVE') {
      throw new BadRequestException({
        code: 'RESERVATION_NOT_ACTIVE',
        message: `Резерв уже ${reservation.status} — перехватывать нечего`,
      });
    }
    if (reservation.orderId === input.requestedByOrderId) {
      throw new BadRequestException({
        code: 'SAME_ORDER',
        message: 'Это резерв того же заказа — перехват не нужен',
      });
    }
    if (!input.reason?.trim()) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'Нужна причина: директор решает, у кого забрать партию',
      });
    }

    const request = await this.prisma.batchOverrideRequest.create({
      data: {
        reservationId: input.reservationId,
        requestedByOrderId: input.requestedByOrderId,
        qtyRequested: input.qtyRequested,
        reason: input.reason.trim(),
        requestedById: userId && !userId.startsWith('usr-') ? userId : null,
      },
    });
    // Уведомление директору; менеджер при этом не заблокирован и считает дальше
    this.events.emit('batch:override_requested', {
      requestId: request.id,
      reservationId: input.reservationId,
      orderId: input.requestedByOrderId,
    });
    return request;
  }

  /** Обе стороны на одном экране: чей резерв, оба заказа, во что обойдётся */
  async overrideContext(requestId: string) {
    const request = await this.prisma.batchOverrideRequest.findUnique({
      where: { id: requestId },
      include: {
        reservation: {
          include: {
            batch: { include: { material: { select: { materialCode: true, name: true, unit: true } } } },
            order: { select: { id: true, orderNumber: true, plannedShipmentDate: true, status: true } },
          },
        },
      },
    });
    if (!request) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Запрос ${requestId} не найден` });
    }
    const requester = await this.prisma.order.findUnique({
      where: { id: request.requestedByOrderId },
      select: { id: true, orderNumber: true, plannedShipmentDate: true, status: true },
    });

    const batch = request.reservation.batch;
    const alternatives = await this.prisma.materialBatch.findMany({
      where: {
        materialId: batch.materialId,
        id: { not: batch.id },
        qtyRemaining: { gt: 0 },
        priceAnomaly: false,
      },
      orderBy: { unitPrice: 'asc' },
      take: 3,
    });

    const price = Number(batch.unitPrice);
    const cheapestAlternative = alternatives.length > 0 ? Number(alternatives[0].unitPrice) : null;

    return {
      request: {
        id: request.id,
        qtyRequested: Number(request.qtyRequested),
        reason: request.reason,
        status: request.status,
        createdAt: request.createdAt,
      },
      material: batch.material,
      batch: {
        id: batch.id,
        receiptDate: batch.receiptDate,
        unitPrice: price,
        qtyRemaining: Number(batch.qtyRemaining),
        supplierName: batch.supplierName,
      },
      holder: request.reservation.order,
      requester,
      // Во что обойдётся тому, у кого забирают: разница до ближайшей доступной партии
      impact: cheapestAlternative != null
        ? {
            alternativeUnitPrice: cheapestAlternative,
            deltaPerUnit: Math.round((cheapestAlternative - price) * 100) / 100,
            totalDelta: Math.round((cheapestAlternative - price) * Number(request.qtyRequested) * 100) / 100,
          }
        : { alternativeUnitPrice: null, deltaPerUnit: null, totalDelta: null, note: 'Других партий нет — придётся закупать' },
      alternatives: alternatives.map((b) => ({
        id: b.id, receiptDate: b.receiptDate, unitPrice: Number(b.unitPrice), qtyRemaining: Number(b.qtyRemaining),
      })),
    };
  }

  /**
   * Решение по перехвату. Только директор (09 §4.4) — проверка роли здесь,
   * а не только в декораторе: этот метод вызывается и из фоновых сценариев.
   *
   * При одобрении калькуляция пострадавшего заказа помечается «требует
   * пересчёта», но цена не меняется автоматически: она могла уже уйти клиенту.
   */
  async decideOverride(
    requestId: string,
    decision: { approve: boolean; comment?: string },
    user: { userId?: string; roles?: string[] },
  ) {
    const roles = user.roles ?? [];
    if (!roles.includes('director') && !roles.includes('admin')) {
      throw new ForbiddenException({
        code: 'DIRECTOR_ONLY',
        message: 'Перехват партии согласует директор',
      });
    }
    const request = await this.prisma.batchOverrideRequest.findUnique({
      where: { id: requestId },
      include: { reservation: true },
    });
    if (!request) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Запрос ${requestId} не найден` });
    }
    if (request.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'ALREADY_DECIDED',
        message: `Запрос уже ${request.status}`,
      });
    }

    const decidedById = user.userId && !user.userId.startsWith('usr-') ? user.userId : null;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.batchOverrideRequest.update({
        where: { id: requestId },
        data: {
          status: decision.approve ? 'APPROVED' : 'REJECTED',
          decidedById,
          decidedAt: new Date(),
          decisionComment: decision.comment?.trim() || null,
        },
      });
      if (!decision.approve) return { request: updated, affectedCostingId: null };

      await tx.batchReservation.update({
        where: { id: request.reservationId },
        data: {
          status: 'OVERRIDDEN',
          releasedAt: new Date(),
          releasedById: decidedById,
          releaseReason: `Перехват по решению директора: ${decision.comment?.trim() || request.reason}`,
        },
      });

      // Пострадавшему заказу — пометка и задача, а не тихий пересчёт
      const affected = request.reservation.orderCostingId;
      if (affected) {
        await tx.orderCosting.update({
          where: { id: affected },
          data: {
            note: 'Требует пересчёта: партия передана другому заказу по решению директора',
          },
        });
      }
      return { request: updated, affectedCostingId: affected };
    });
  }

  /**
   * Фоновое снятие протухших резервов и предупреждения за N дней.
   * Без этого через полгода весь металл окажется «занят».
   */
  async expireStale(now = new Date(), warnDays = DEFAULT_RESERVATION_WARN_DAYS) {
    const active = await this.prisma.batchReservation.findMany({ where: { status: 'ACTIVE' } });
    const { expired, expiringSoon } = classifyReservations(this.toLike(active), now, warnDays);

    if (expired.length > 0) {
      await this.prisma.batchReservation.updateMany({
        where: { id: { in: expired.map((r) => r.id) } },
        data: {
          status: 'EXPIRED',
          releasedAt: now,
          releaseReason: 'Заказ не ушёл в производство в срок — резерв снят автоматически',
        },
      });
    }
    for (const r of expiringSoon) {
      this.events.emit('batch:reservation_expiring', { reservationId: r.id, orderId: r.orderId, expiresAt: r.expiresAt });
    }
    return { expired: expired.length, warned: expiringSoon.length };
  }
}
