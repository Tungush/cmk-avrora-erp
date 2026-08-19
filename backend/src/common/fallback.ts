import type { PrismaService } from '../services/prisma.service';

type AsyncFactory<T> = () => Promise<T>;
type SyncFactory<T> = () => T;

const FALLBACK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function runWithFallback<T>(
  prisma: PrismaService,
  queryFactory: AsyncFactory<T>,
  fallbackFactory: SyncFactory<any>,
): Promise<T> {
  const hasDb = await prisma.ensureConnection();
  if (!hasDb) {
    return fallbackFactory();
  }

  try {
    return await withTimeout(queryFactory(), FALLBACK_TIMEOUT_MS);
  } catch {
    return fallbackFactory();
  }
}

export const mockIds = {
  customer: 'mock-customer-1',
  order: 'mock-order-1',
  article: 'mock-article-1',
  material: 'mock-material-1',
  paymentDoc: 'mock-payment-1',
  purchaseRequest: 'mock-pr-1',
  spreadsheetImport: 'mock-import-1',
  spreadsheetSheet: 'mock-sheet-1',
};

export function createPaginated<T>(data: T[], page = 1, pageSize = 50) {
  return {
    data,
    meta: {
      page,
      pageSize,
      total: data.length,
    },
  };
}
