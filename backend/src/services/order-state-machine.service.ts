import { OrderStatus } from '@prisma/client';
import { validateShippedReservationGuard, BusinessGuardError } from './guards.service';
import { stageProgress } from '../common/production-stages';

/**
 * Статусы, которые заказ занимает сам, по отметкам цеха, и которые поэтому
 * не нужно двигать руками (решение 23.08.2026). Дальше — склад и бухгалтерия:
 * отгрузка и закрытие остаются ручными, потому что их определяют не этапы.
 */
export const DERIVED_STATUSES: OrderStatus[] = [OrderStatus.IN_PRODUCTION, OrderStatus.READY_TO_SHIP];

/**
 * Какой статус заказу положен по его этапам. null — трогать не нужно.
 *
 * Работает только в коридоре CONFIRMED ↔ IN_PRODUCTION ↔ READY_TO_SHIP:
 * отгруженный или закрытый заказ отметка этапа откатывать не должна,
 * равно как и не принятый ещё NEW.
 */
export function deriveStatusFromStages(
  current: OrderStatus,
  stages: Array<{ stageCode: string; routingStage?: string | null; orderLineId?: string | null; status: string }>,
  /** В режиме LINE шаг закрыт, только когда отмечены ВСЕ позиции заказа */
  expectedLines = 1,
): OrderStatus | null {
  const inCorridor = current === OrderStatus.CONFIRMED
    || current === OrderStatus.IN_PRODUCTION
    || current === OrderStatus.READY_TO_SHIP;
  if (!inCorridor) return null;

  const { allDone, anyStarted } = stageProgress(stages, expectedLines);
  const next = allDone
    ? OrderStatus.READY_TO_SHIP
    : anyStarted
      ? OrderStatus.IN_PRODUCTION
      : OrderStatus.CONFIRMED;

  return next === current ? null : next;
}

export interface OrderStateContext {
  orderId: string;
  currentStatus: OrderStatus;
  lines: { qty: number; reservedQty: number; articleCode?: string }[];
  customerBinIin?: string | null;
  /// routingStage заполнен только у PRODUCTION: без него три передела
  /// неразличимы, и «все этапы готовы» считается по неполному списку
  productionStages: { stageCode: string; routingStage?: string | null; status: string }[];
  finishedGoodsShipped: boolean;
  balanceDue: number;
  hasAcceptanceAct: boolean;
}

export interface TransitionRequest {
  targetStatus: OrderStatus;
  userId: string;
  userRole: string;
  comment?: string;
}

export interface AuditLogPayload {
  entityType: string;
  entityId: string;
  action: string;
  before: { status: OrderStatus };
  after: { status: OrderStatus };
  userId: string;
  userRole: string;
  comment?: string;
  timestamp: Date;
}

export class OrderStateMachine {
  /**
   * Evaluates if a status transition is valid and returns audit payload on success.
   * Throws BusinessGuardError if transition conditions fail.
   */
  static transition(context: OrderStateContext, request: TransitionRequest): AuditLogPayload {
    const { currentStatus } = context;
    const { targetStatus, userId, userRole, comment } = request;

    if (currentStatus === targetStatus) {
      throw new BusinessGuardError(`Order is already in ${targetStatus} status`, 'SAME_STATUS_TRANSITION');
    }

    // Any status -> CANCELLED rule
    if (targetStatus === OrderStatus.CANCELLED) {
      const allowedRoles = ['sales_manager', 'director', 'admin'];
      if (!allowedRoles.includes(userRole)) {
        throw new BusinessGuardError(`Role ${userRole} is not authorized to cancel orders`, 'UNAUTHORIZED_CANCELLATION');
      }
      if (!comment || comment.trim().length === 0) {
        throw new BusinessGuardError('Cancellation requires a mandatory non-empty comment', 'MISSING_CANCELLATION_COMMENT');
      }
      return this.createAuditLog(context, targetStatus, userId, userRole, comment);
    }

    // State machine graph transitions
    switch (currentStatus) {
      case OrderStatus.NEW:
        // Из инбокса: явный «Принять в производство» → CONFIRMED, либо в DRAFT
        // на доработку. Приём блокируется теми же условиями, что и DRAFT→CONFIRMED,
        // плюс каждая позиция должна быть опознана (артикул сопоставлен).
        if (targetStatus !== OrderStatus.CONFIRMED && targetStatus !== OrderStatus.DRAFT) {
          throw new BusinessGuardError(`Invalid transition from NEW to ${targetStatus}`, 'INVALID_TRANSITION');
        }
        if (targetStatus === OrderStatus.CONFIRMED) {
          if (!context.lines || context.lines.length === 0) {
            throw new BusinessGuardError('Нельзя принять заказ без позиций', 'EMPTY_ORDER_LINES');
          }
          const unresolved = context.lines.filter((l) => !l.articleCode);
          if (unresolved.length > 0) {
            throw new BusinessGuardError(
              `Нельзя принять заказ: ${unresolved.length} позиций без сопоставленного артикула`,
              'UNRESOLVED_ORDER_LINES',
            );
          }
          if (!context.customerBinIin || context.customerBinIin.trim().length === 0) {
            throw new BusinessGuardError('Нельзя принять заказ без БИН/ИИН заказчика', 'MISSING_CUSTOMER_BIN');
          }
        }
        break;

      case OrderStatus.DRAFT:
        if (targetStatus !== OrderStatus.CONFIRMED) {
          throw new BusinessGuardError(`Invalid transition from DRAFT to ${targetStatus}`, 'INVALID_TRANSITION');
        }
        if (!context.lines || context.lines.length === 0) {
          throw new BusinessGuardError('Cannot confirm order: at least one order line is required', 'EMPTY_ORDER_LINES');
        }
        if (!context.customerBinIin || context.customerBinIin.trim().length === 0) {
          throw new BusinessGuardError('Cannot confirm order: customer BIN/IIN is required', 'MISSING_CUSTOMER_BIN');
        }
        break;

      case OrderStatus.CONFIRMED:
        if (targetStatus !== OrderStatus.IN_PRODUCTION) {
          throw new BusinessGuardError(`Invalid transition from CONFIRMED to ${targetStatus}`, 'INVALID_TRANSITION');
        }
        if (!context.productionStages || context.productionStages.length === 0) {
          throw new BusinessGuardError('Cannot move to IN_PRODUCTION: no production stages initialized', 'NO_PRODUCTION_STAGES');
        }
        const hasInProgress = context.productionStages.some((s) => s.status === 'in_progress' || s.status === 'done');
        if (!hasInProgress) {
          throw new BusinessGuardError('Cannot move to IN_PRODUCTION: at least one production stage must be in_progress', 'NO_STAGE_IN_PROGRESS');
        }
        break;

      case OrderStatus.IN_PRODUCTION:
        if (targetStatus !== OrderStatus.READY_TO_SHIP) {
          throw new BusinessGuardError(`Invalid transition from IN_PRODUCTION to ${targetStatus}`, 'INVALID_TRANSITION');
        }
        // Мерой служат все пять шагов, а не только отмеченные: строки этапов
        // создаются лениво, и `every(done)` по ним пропускал заказ с одной
        // отметкой «резка готова» вперёд, минуя сборку и покраску
        const progress = stageProgress(context.productionStages);
        if (!progress.allDone) {
          throw new BusinessGuardError(
            `Нельзя в «готов к отгрузке»: закрыто ${progress.doneCount} из ${progress.totalSteps} этапов`,
            'UNFINISHED_PRODUCTION_STAGES',
          );
        }
        break;

      case OrderStatus.READY_TO_SHIP:
        if (targetStatus !== OrderStatus.SHIPPED) {
          throw new BusinessGuardError(`Invalid transition from READY_TO_SHIP to ${targetStatus}`, 'INVALID_TRANSITION');
        }
        // Guard check for reserved_qty >= qty
        validateShippedReservationGuard(context.lines);
        if (!context.finishedGoodsShipped) {
          throw new BusinessGuardError('Cannot move to SHIPPED: finished goods shipment movement is missing or incomplete', 'INCOMPLETE_SHIPMENT_MOVEMENT');
        }
        break;

      case OrderStatus.SHIPPED:
        if (targetStatus !== OrderStatus.CLOSED) {
          throw new BusinessGuardError(`Invalid transition from SHIPPED to ${targetStatus}`, 'INVALID_TRANSITION');
        }
        if (context.balanceDue > 0) {
          throw new BusinessGuardError(`Cannot close order: balance due is ${context.balanceDue} (must be 0)`, 'UNPAID_BALANCE');
        }
        if (!context.hasAcceptanceAct) {
          throw new BusinessGuardError('Cannot close order: linked acceptance act (APP) does not exist', 'MISSING_ACCEPTANCE_ACT');
        }
        break;

      case OrderStatus.CLOSED:
      case OrderStatus.CANCELLED:
        throw new BusinessGuardError(`Order in terminal state ${currentStatus} cannot transition to ${targetStatus}`, 'TERMINAL_STATE');

      default:
        throw new BusinessGuardError(`Unknown status ${currentStatus}`, 'UNKNOWN_STATUS');
    }

    return this.createAuditLog(context, targetStatus, userId, userRole, comment);
  }

  private static createAuditLog(
    context: OrderStateContext,
    targetStatus: OrderStatus,
    userId: string,
    userRole: string,
    comment?: string
  ): AuditLogPayload {
    return {
      entityType: 'Order',
      entityId: context.orderId,
      action: 'status_change',
      before: { status: context.currentStatus },
      after: { status: targetStatus },
      userId,
      userRole,
      comment,
      timestamp: new Date(),
    };
  }
}
