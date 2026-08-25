export interface Article {
  id: string;
  articleCode: string;
  legacyCode?: string;
  name: string;
  weightKg: number;
  series?: string;
  description?: string;
  approvedPrice: number;
  // Calculated
  specPrice: number;
  priceDeviationPct: number;
  leadTimeDays: number;
  palletCapacity?: number;
  isActive: boolean;
  createdAt: string;
  /// Список артикулов (GET /articles) отдаёт состав вместе с карточкой —
  /// используется, чтобы честно пометить карточки без BOM в интерфейсе
  bomItems?: unknown[];
  /// true — это не изделие, а прямая продажа сырья/хозтоваров без изготовления
  /// (карточка «Изделия» заведена под кодом реального материала, см. mark-material-resale-articles.ts)
  isMaterialResale?: boolean;
  updatedAt: string;
}

export interface PriceHistory {
  id: string;
  articleId: string;
  price: number;
  validFrom: string;
  changedBy: string;
}

export interface Material {
  id: string;
  materialCode: string;
  category: string;
  name: string;
  unit: string;
  unitWeightKg?: number;
  purchasePrice?: number;
  purchasePriceUpdatedAt?: string;
  priceListPrice?: number;
  // Calculated
  stockQty: number;
}

export interface BomItem {
  id: string;
  articleId: string;
  materialId: string;
  materialName?: string;
  materialCode?: string;
  qtyPerUnit: number;
  operationType: string;
  laborHours: number;
  // Calculated
  lineCost: number;
}

export interface Customer {
  id: string;
  name: string;
  binIin: string;
  region: string;
  customerType: string;
}

export interface OrderLine {
  id: string;
  orderId: string;
  articleId: string;
  articleCode?: string;
  qty: number;
  unit: string;
  // Calculated
  unitPrice: number;
  lineTotalVat: number;
  // Input
  prepayment: number;
  postPayment1: number;
  postPayment2: number;
  penalty: number;
  // Calculated
  balanceDue: number;
  reservedQty: number;
  shippedQty: number;
}

export type OrderStatus =
  | 'NEW'
  | 'DRAFT'
  | 'CONFIRMED'
  | 'IN_PRODUCTION'
  | 'READY_TO_SHIP'
  | 'SHIPPED'
  | 'CLOSED'
  | 'CANCELLED';

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName?: string;
  region?: string;
  managerId?: string;
  orderType: string;
  bitrixDealId?: string;
  bitrixStage?: string;
  status: OrderStatus;
  plannedShipmentDate?: string;
  actualShipmentDate?: string;
  overdueDays: number;
  requestDate: string;
  lines: OrderLine[];
  balanceDue: number;
  createdAt: string;
  updatedAt: string;
  // Данные из 1С (владелец — 1С)
  onecNum?: string | null;
  onecStatus?: string | null;
  onecApprovalStatus?: string | null;
  onecSyncedAt?: string | null;
  // Приём из инбокса и архив Excel-миграции
  acceptedAt?: string | null;
  isArchived?: boolean;
}

export interface ProductionPlanItem {
  articleId: string;
  articleName?: string;
  articleCode?: string;
  periodKey: string;
  qtyFromOrders: number;
  qtyMinStock: number;
  qtyReserved: number;
  qtyInStock: number;
  qtyToProduce: number;
}

export type StageStatus = 'not_started' | 'in_progress' | 'done';

/** Веха заказа; передел заполнен только у PRODUCTION (09 §2.1) */
export type OrderStageCode = 'DESIGN' | 'SUPPLY' | 'PRODUCTION';
export type RoutingStageCode = 'CUTTING' | 'ASSEMBLY' | 'PAINTING';

export interface ProductionStage {
  orderId: string;
  orderNumber?: string;
  /** NULL в режиме ORDER — этап отмечен на заказе целиком */
  orderLineId?: string | null;
  stageCode: OrderStageCode;
  routingStage?: RoutingStageCode | null;
  status: StageStatus;
  actualWorkers?: number | null;
  actualHours?: number | null;
  completedAt?: string;
  completedBy?: string;
  defectPhotoUrl?: string;
}

export interface PaymentDocument {
  id: string;
  doNumber: string;
  doDate?: string;
  contractorId: string;
  contractorName?: string;
  currency: string;
  totalAmount: number;
  // Calculated
  paidAmount: number;
  unpaidAmount: number;
  status: string;
  category?: string;
  orderId?: string;
}

export interface Payment {
  id: string;
  paymentDocumentId: string;
  amount: number;
  paidAt: string;
}

export interface AcceptanceAct {
  id: string;
  orderId: string;
  appNumber: string;
  actDate: string;
  amount: number;
}

export interface MaterialStockMovement {
  id: string;
  materialId: string;
  materialCode?: string;
  materialName?: string;
  movementType: string;
  qty: number;
  unitPrice?: number;
  movementDate: string;
  project?: string;
}

export interface FinishedGoodsMovement {
  id: string;
  articleId: string;
  articleCode?: string;
  movementType: string;
  qty: number;
  orderId?: string;
  movementDate: string;
}

export interface MinStockLevel {
  articleId: string;
  articleCode?: string;
  articleName?: string;
  periodMonths: number;
  targetQty: number;
  // Calculated
  actualQty: number;
  deficitQty: number;
  readinessPct: number;
}

export interface PurchaseRequest {
  id: string;
  materialId: string;
  materialCode?: string;
  materialName?: string;
  materialGroup?: string;
  qty: number;
  estimatedPrice?: number;
  totalAmount?: number;
  status: string;
}

export interface MaterialBalance {
  materialId: string;
  materialCode: string;
  name?: string;
  stockQty: number;
  unit: string;
  sumAmount?: number;
}

export interface ReceivableSummary {
  customerId: string;
  customerName: string;
  totalDebt: number;
  overdueDebt: number;
  orders: { orderId: string; orderNumber: string; balanceDue: number; overdueDays: number }[];
}

export interface DashboardSummary {
  productionPlanFact: { planned: number; actual: number };
  workshopLoadHours: { used: number; total: number };
  receivablesTotal: number;
  fgStockVsNorm: { inStock: number; norm: number };
}

export interface AuditLogEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  userId: string;
  userRole: string;
  timestamp: string;
  comment?: string;
}

export interface UserPayload {
  userId: string;
  email: string;
  roles: string[];
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
  };
}
