import { calculateOverdueDays } from './formulas.service';

export interface OverdueOrderInput {
  orderId: string;
  orderNumber: string;
  plannedShipmentDate: Date | null;
  actualShipmentDate: Date | null;
  status: string;
}

export interface NotificationExtensionHook {
  notifyOverdue(event: { orderId: string; orderNumber: string; overdueDays: number }): void;
}

export class ScheduledOverdueBatchJob {
  private notificationHooks: NotificationExtensionHook[] = [];

  registerNotificationHook(hook: NotificationExtensionHook) {
    this.notificationHooks.push(hook);
  }

  /**
   * Executes daily batch job to recalculate overdue_days for active orders
   */
  runDailyOverdueBatch(orders: OverdueOrderInput[], currentDate: Date = new Date()) {
    const updatedOrders = [];

    for (const order of orders) {
      // Exclude terminal states (CANCELLED, CLOSED)
      if (['CANCELLED', 'CLOSED'].includes(order.status)) {
        continue;
      }

      const overdueDays = calculateOverdueDays(
        order.plannedShipmentDate,
        order.actualShipmentDate,
        currentDate
      );

      if (overdueDays > 0) {
        updatedOrders.push({
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          overdueDays,
        });

        // Trigger notification extension hooks for Stage 5 integration
        for (const hook of this.notificationHooks) {
          hook.notifyOverdue({
            orderId: order.orderId,
            orderNumber: order.orderNumber,
            overdueDays,
          });
        }
      }
    }

    return {
      type: 'DailyOverdueBatchCompleted',
      processedCount: orders.length,
      overdueOrdersCount: updatedOrders.length,
      updatedOrders,
    };
  }
}
