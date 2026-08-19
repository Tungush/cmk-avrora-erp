import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RbacGuard } from './common/guards/rbac.guard';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';
import { FieldProjectionInterceptor } from './common/interceptors/field-projection.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

import { PrismaService } from './services/prisma.service';
import { AuthController } from './modules/auth/auth.controller';
import { ArticlesController } from './modules/catalog/articles.controller';
import { RoutingController, WorkCentersController, CostingConfigController } from './modules/catalog/routing.controller';
import { PriceReviewsController } from './modules/catalog/price-reviews.controller';
import { NomenclatureRequestsController } from './modules/catalog/nomenclature-requests.controller';
import { SavedViewsController } from './modules/platform/saved-views.controller';
import { EventsController } from './modules/platform/events.controller';
import { EventsService } from './services/events.service';
import { ArticleCostingService } from './services/article-costing.service';
import { CascadeRecalcService } from './services/cascade-recalc.service';
import { IntegrationService } from './services/integration.service';
import { MaterialReceiptService } from './services/material-receipt.service';
import { MaterialBatchService } from './services/material-batch.service';
import { MaterialBatchesController } from './modules/warehouse/material-batches.controller';
import { IntegrationController } from './modules/integration/integration.controller';
import { InboxHandlersService } from './modules/integration/inbox-handlers.service';
import { OneCClientService } from './services/onec-client.service';
import { OneCSyncService } from './modules/integration/onec-sync.service';
import { MaterialsController } from './modules/catalog/materials.controller';
import { CustomersController } from './modules/catalog/customers.controller';
import { OrdersController } from './modules/orders/orders.controller';
import { ProductionPlanController } from './modules/orders/production-plan.controller';
import { MinStockController } from './modules/orders/min-stock.controller';
import { WarehouseController } from './modules/warehouse/warehouse.controller';
import { PurchaseRequestsController } from './modules/warehouse/purchase-requests.controller';
import { PaymentDocumentsController } from './modules/finance/payment-documents.controller';
import { AcceptanceActsController } from './modules/finance/acceptance-acts.controller';
import { AuditLogController } from './modules/platform/audit-log.controller';
import { SpreadsheetController } from './modules/spreadsheet/spreadsheet.controller';
import { DashboardsController } from './modules/dashboards/dashboards.controller';

@Module({
  controllers: [
    AuthController,
    ArticlesController,
    RoutingController,
    WorkCentersController,
    CostingConfigController,
    PriceReviewsController,
    NomenclatureRequestsController,
    SavedViewsController,
    IntegrationController,
    EventsController,
    MaterialsController,
    MaterialBatchesController,
    CustomersController,
    OrdersController,
    ProductionPlanController,
    MinStockController,
    WarehouseController,
    PurchaseRequestsController,
    PaymentDocumentsController,
    AcceptanceActsController,
    AuditLogController,
    SpreadsheetController,
    DashboardsController,
  ],
  providers: [
    PrismaService,
    EventsService,
    MaterialBatchService,
    ArticleCostingService,
    CascadeRecalcService,
    IntegrationService,
    MaterialReceiptService,
    InboxHandlersService,
    OneCClientService,
    OneCSyncService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RbacGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLogInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: FieldProjectionInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
