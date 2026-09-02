/** Типы экрана «Цех» — общие для списка, шторки изделий и листа отклонений */

export interface ProductRow {
  id: string;
  lineNo: number;
  isDuplicateCode: boolean;
  articleId: string | null;
  /** Нет состава — изготовление записать нельзя: списывать нечего */
  missingBom: boolean;
  /** Нет норм труда — себестоимость труда встанет в ноль */
  missingNorms: boolean;
  articleCode: string;
  articleName: string;
  /** Объект/БС — мастер видит, для какой площадки изделие */
  siteCode: string | null;
  qty: number;
  unit: string;
  status: string;
  normHours: number;
  actualHours: number | null;
  contractors: Array<{ name: string; sharePct: number; isAccepted: boolean }>;
}

export interface ShopFloorOrder {
  id: string;
  orderNumber: string;
  customerName: string | null;
  status: string;
  plannedShipmentDate: string | null;
  overdueDays: number;
  products: ProductRow[];
  doneCount: number;
  totalProducts: number;
  blockedCount: number;
  resaleCount: number;
}

export interface OpenRequest {
  id: string;
  number: string;
  routingStage: string;
  description: string;
  contractorName: string | null;
  rateType: string;
  unit: string;
  allocatedQty: number;
  targetQty: number | null;
  remainingQty: number | null;
  isAccepted: boolean;
}

export interface ShopFloorResponse {
  orders: ShopFloorOrder[];
  total: number;
  totalProducts: number;
  doneProducts: number;
  waitingProducts: number;
  /** Изделия без спецификации — отметить нельзя, пока её не заведут */
  blockedProducts: number;
  /** Заявки на подряд, ждущие разнесения. К заказу заранее не привязаны —
      мастер сам говорит, сколько из партии ушло на этот заказ */
  openRequests: OpenRequest[];
}

/** Единственное действие цеха: изделие сделано / отметка снята */
export interface MarkVars {
  orderId: string;
  productId: string;
  done: boolean;
}

/** Вид работ в подписи заявки: мастер его не выбирает, но узнать должен */
export const STAGE_SHORT: Record<string, string> = {
  CUTTING: 'резка', ASSEMBLY: 'сборка', PAINTING: 'покраска',
};

export const RATE_TYPE_LABELS: Record<string, string> = {
  PER_HOUR: 'за час', PER_UNIT: 'за штуку', PER_KG: 'за кг',
  PER_TON: 'за тонну', FIXED: 'фиксированная',
};
