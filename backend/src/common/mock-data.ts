import { createPaginated, mockIds } from './fallback';

const mockCustomer = {
  id: mockIds.customer,
  name: 'ТОО "Телеком KZ"',
  binIin: '123456789012',
  region: 'Алматы',
  customerType: 'OUTSIDE',
};

const mockArticle = {
  id: mockIds.article,
  articleCode: 'BS-001',
  legacyCode: 'БС-Калина',
  name: 'Базовая станция "Калина-М"',
  weightKg: 120,
  series: 'K-M',
  description: 'Демо-изделие для локального режима',
  approvedPrice: 1200000,
  specPrice: 1140000,
  priceDeviationPct: 0.05,
  leadTimeDays: 14,
  palletCapacity: 2,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockMaterial = {
  id: mockIds.material,
  materialCode: 'MAT-001',
  category: 'METAL',
  name: 'Сталь листовая 2мм',
  unit: 'т',
  unitWeightKg: 1000,
  purchasePrice: 450000,
  purchasePriceUpdatedAt: new Date().toISOString(),
  priceListPrice: 470000,
  stockQty: 10,
};

const mockOrderLine = {
  id: 'mock-line-1',
  orderId: mockIds.order,
  articleId: mockIds.article,
  qty: 2,
  unit: 'шт',
  unitPrice: 1200000,
  lineTotalVat: 2400000,
  prepayment: 500000,
  postPayment1: 0,
  postPayment2: 0,
  penalty: 0,
  balanceDue: 1900000,
  reservedQty: 0,
  shippedQty: 0,
  article: mockArticle,
};

const mockOrder = {
  id: mockIds.order,
  orderNumber: 'ORD-LOCAL-001',
  customerId: mockIds.customer,
  region: 'Алматы',
  managerId: null,
  orderType: 'FZ',
  bitrixDealId: null,
  bitrixStage: null,
  status: 'IN_PRODUCTION',
  plannedShipmentDate: new Date(Date.now() + 7 * 86400000).toISOString(),
  actualShipmentDate: null,
  overdueDays: 0,
  requestDate: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  customer: mockCustomer,
  orderLines: [mockOrderLine],
  paymentDocuments: [],
  productionStages: [
    { id: 'mock-stage-1', orderId: mockIds.order, stageCode: 'DRAWINGS', status: 'DONE', completedAt: new Date().toISOString() },
    { id: 'mock-stage-2', orderId: mockIds.order, stageCode: 'CUTTING', status: 'IN_PROGRESS', completedAt: null },
  ],
};

const mockPaymentDoc = {
  id: mockIds.paymentDoc,
  doNumber: 'DO-LOCAL-001',
  doDate: new Date().toISOString(),
  contractorId: mockIds.customer,
  currency: 'KZT',
  totalAmount: 2400000,
  paidAmount: 500000,
  unpaidAmount: 1900000,
  category: 'Основной договор',
  status: 'PARTIALLY_PAID',
  orderId: mockIds.order,
  contractor: mockCustomer,
  order: mockOrder,
};

const mockSpreadsheetHeaders = ['Заказ', 'Клиент', 'Статус', 'Сумма'];

const mockSpreadsheetRows = [
  {
    id: 'mock-row-1',
    rowNumber: 1,
    cells: ['ORD-LOCAL-001', 'ТОО "Телеком KZ"', 'IN_PRODUCTION', '2400000'],
    data: {
      Заказ: 'ORD-LOCAL-001',
      Клиент: 'ТОО "Телеком KZ"',
      Статус: 'IN_PRODUCTION',
      Сумма: '2400000',
    },
    isEmpty: false,
  },
];

export function getMockAuthUser(email: string, roles: string[]) {
  return {
    accessToken: 'mock-access-token',
    user: {
      userId: 'mock-user-1',
      email,
      roles: roles.length ? roles : ['sales_manager'],
    },
  };
}

export function getMockArticles(page = 1, pageSize = 50) {
  return createPaginated([mockArticle], page, pageSize);
}

export function getMockCustomers(page = 1, pageSize = 50) {
  return createPaginated([mockCustomer], page, pageSize);
}

export function getMockMaterials(page = 1, pageSize = 50) {
  return createPaginated([mockMaterial], page, pageSize);
}

export function getMockOrders(page = 1, pageSize = 50) {
  return createPaginated([mockOrder], page, pageSize);
}

export function getMockDashboardSummary() {
  return {
    productionPlanFact: { planned: 210, actual: 205 },
    workshopLoadHours: { used: 1480, total: 1600 },
    receivablesTotal: 1900000,
    fgStockVsNorm: { inStock: 82, norm: 100 },
  };
}

export function getMockProductionPlan(page = 1, pageSize = 50) {
  return createPaginated(
    [
      {
        id: 'mock-stage-2',
        orderId: mockIds.order,
        stageCode: 'CUTTING',
        status: 'IN_PROGRESS',
        completedAt: null,
        order: {
          id: mockIds.order,
          orderNumber: 'ORD-LOCAL-001',
          customer: mockCustomer,
        },
      },
    ],
    page,
    pageSize,
  );
}

export function getMockMinStockLevels() {
  return [
    {
      id: 'mock-min-1',
      articleId: mockIds.article,
      periodMonths: 0.517,
      targetQty: 100,
      actualQty: 82,
      deficitQty: 18,
      readinessPct: 82,
      article: mockArticle,
    },
  ];
}

export function getMockMaterialBalance() {
  return [
    {
      materialId: mockIds.material,
      materialCode: 'MAT-001',
      name: 'Сталь листовая 2мм',
      category: 'METAL',
      unit: 'т',
      stockQty: 10,
      purchasePrice: 450000,
      totalValue: 4500000,
    },
  ];
}

export function getMockPurchaseRequests(page = 1, pageSize = 50) {
  return createPaginated(
    [
      {
        id: mockIds.purchaseRequest,
        materialId: mockIds.material,
        requestedQty: 3,
        status: 'APPROVED',
        createdAt: new Date().toISOString(),
        material: mockMaterial,
      },
    ],
    page,
    pageSize,
  );
}

export function getMockPaymentDocuments(page = 1, pageSize = 50) {
  return createPaginated([mockPaymentDoc], page, pageSize);
}

export function getMockReceivables() {
  return [
    {
      id: mockIds.paymentDoc,
      customer: mockCustomer.name,
      docNumber: mockPaymentDoc.doNumber,
      totalAmount: mockPaymentDoc.totalAmount,
      paidAmount: mockPaymentDoc.paidAmount,
      balanceDue: mockPaymentDoc.unpaidAmount,
      status: mockPaymentDoc.status,
      doDate: mockPaymentDoc.doDate,
    },
  ];
}

export function getMockAcceptanceActs() {
  return [
    {
      id: 'mock-act-1',
      appNumber: 'APP-LOCAL-001',
      customerId: mockIds.customer,
      orderId: mockIds.order,
      actDate: new Date().toISOString(),
      totalAmount: 2400000,
      customer: mockCustomer,
      order: mockOrder,
    },
  ];
}

export function getMockAuditLog(page = 1, pageSize = 50) {
  return createPaginated(
    [
      {
        id: 'mock-audit-1',
        entityType: 'order',
        entityId: mockIds.order,
        action: 'CREATE',
        before: null,
        after: { orderNumber: 'ORD-LOCAL-001' },
        userId: 'mock-user-1',
        userRole: 'admin',
        timestamp: new Date().toISOString(),
        comment: 'Fallback audit event',
      },
    ],
    page,
    pageSize,
  );
}

export function getMockSpreadsheetImport() {
  return {
    id: mockIds.spreadsheetImport,
    sourceFile: 'mock-local.xlsx',
    importedAt: new Date().toISOString(),
    totalSheets: 1,
    totalRows: mockSpreadsheetRows.length,
    status: 'completed',
    sheets: [
      {
        id: mockIds.spreadsheetSheet,
        name: 'Telecom',
        headerRow: 1,
        colCount: mockSpreadsheetHeaders.length,
        rowCount: mockSpreadsheetRows.length,
        headers: mockSpreadsheetHeaders,
      },
    ],
  };
}

export function getMockSpreadsheetSheets() {
  return {
    data: [
      {
        id: mockIds.spreadsheetSheet,
        name: 'Telecom',
        headerRow: 1,
        colCount: mockSpreadsheetHeaders.length,
        rowCount: mockSpreadsheetRows.length,
        headers: mockSpreadsheetHeaders,
        headerRows: [mockSpreadsheetHeaders],
      },
    ],
  };
}

export function getMockSpreadsheetSheet(name: string) {
  return {
    id: mockIds.spreadsheetSheet,
    name,
    headerRow: 1,
    colCount: mockSpreadsheetHeaders.length,
    rowCount: mockSpreadsheetRows.length,
    headers: mockSpreadsheetHeaders,
    headerRows: [mockSpreadsheetHeaders],
  };
}

export function getMockSpreadsheetRows(page = 1, pageSize = 100, name = 'Telecom') {
  return {
    sheet: {
      id: mockIds.spreadsheetSheet,
      name,
      headers: mockSpreadsheetHeaders,
      headerRows: [mockSpreadsheetHeaders],
      headerRow: 1,
      colCount: mockSpreadsheetHeaders.length,
      rowCount: mockSpreadsheetRows.length,
    },
    data: mockSpreadsheetRows,
    meta: {
      page,
      pageSize,
      total: mockSpreadsheetRows.length,
    },
  };
}
