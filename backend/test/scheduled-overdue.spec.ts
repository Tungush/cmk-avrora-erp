import { ScheduledOverdueBatchJob, NotificationExtensionHook } from '../src/services/scheduled-overdue.service';

describe('Scheduled Overdue Batch Job Unit Tests', () => {
  it('should calculate overdue_days for active overdue orders and trigger notification hooks', () => {
    const job = new ScheduledOverdueBatchJob();

    const notifications: { orderNumber: string; overdueDays: number }[] = [];
    const mockHook: NotificationExtensionHook = {
      notifyOverdue: (evt) => {
        notifications.push({ orderNumber: evt.orderNumber, overdueDays: evt.overdueDays });
      },
    };
    job.registerNotificationHook(mockHook);

    const orders = [
      {
        orderId: 'ord-1',
        orderNumber: 'P-000001-26',
        plannedShipmentDate: new Date('2026-08-01'),
        actualShipmentDate: null,
        status: 'IN_PRODUCTION',
      },
      {
        orderId: 'ord-2',
        orderNumber: 'P-000002-26',
        plannedShipmentDate: new Date('2026-08-05'),
        actualShipmentDate: new Date('2026-08-05'), // Shipped on time
        status: 'SHIPPED',
      },
      {
        orderId: 'ord-3',
        orderNumber: 'P-000003-26',
        plannedShipmentDate: new Date('2026-08-01'),
        actualShipmentDate: null,
        status: 'CANCELLED', // Terminal state
      },
    ];

    const today = new Date('2026-08-11'); // 10 days past Aug 1
    const result = job.runDailyOverdueBatch(orders, today);

    expect(result.processedCount).toBe(3);
    expect(result.overdueOrdersCount).toBe(1);
    expect(result.updatedOrders[0].orderNumber).toBe('P-000001-26');
    expect(result.updatedOrders[0].overdueDays).toBe(10);

    // Verify notification hook triggered
    expect(notifications.length).toBe(1);
    expect(notifications[0].orderNumber).toBe('P-000001-26');
    expect(notifications[0].overdueDays).toBe(10);
  });
});
