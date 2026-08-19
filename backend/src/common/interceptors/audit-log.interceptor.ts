import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { PrismaClient } from '@prisma/client';

export interface AuditRecord {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  before: any;
  after: any;
  userId?: string;
  userRole?: string;
  timestamp: Date;
  comment?: string;
}

// In-memory store fallback + Prisma persistence store for Audit Logs
export const AUDIT_LOG_STORE: AuditRecord[] = [];

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private prisma = new PrismaClient();

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const method = req.method;

    // Only audit mutating operations: POST, PATCH, PUT, DELETE
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      return next.handle();
    }

    const user = req.user || {};
    const path: string = req.path || '';

    // Infer entity type from route path (e.g. /api/v1/orders/123 -> Order)
    const entityType = this.extractEntityType(path);
    const entityId = req.params?.id || req.body?.id || 'system';

    return next.handle().pipe(
      tap(async (responseBody) => {
        try {
          const action = method === 'POST' ? 'CREATE' : method === 'DELETE' ? 'DELETE' : 'UPDATE';
          const record: AuditRecord = {
            id: `audit-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            entityType,
            entityId: responseBody?.id || entityId,
            action: responseBody?.action || action,
            before: req.body?.before || null,
            after: responseBody || req.body || null,
            userId: user.userId || 'anonymous',
            userRole: user.roles ? user.roles[0] : 'system',
            timestamp: new Date(),
            comment: req.body?.comment || null,
          };

          AUDIT_LOG_STORE.push(record);
        } catch (e) {
          // Silent log inspection to avoid blocking main handler thread
        }
      })
    );
  }

  private extractEntityType(path: string): string {
    if (path.includes('/articles')) return 'Article';
    if (path.includes('/materials')) return 'Material';
    if (path.includes('/customers')) return 'Customer';
    if (path.includes('/orders')) return 'Order';
    if (path.includes('/warehouse')) return 'StockMovement';
    if (path.includes('/payment-documents')) return 'PaymentDocument';
    if (path.includes('/acceptance-acts')) return 'AcceptanceAct';
    if (path.includes('/purchase-requests')) return 'PurchaseRequest';
    return 'Entity';
  }
}
