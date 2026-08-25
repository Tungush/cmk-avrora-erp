import type { PrismaService } from '../services/prisma.service';

type AsyncFactory<T> = () => Promise<T>;
type SyncFactory<T> = () => T;

/**
 * Порог был 2 с — при нём медленный запрос молча подменялся демо-данными.
 * Теперь таймаут означает честную ошибку, поэтому он должен быть не «когда
 * начинать врать», а «когда признать, что запрос завис»: тяжёлые выборки
 * по 16 тыс. позиций в 2 секунды не укладываются.
 */
const FALLBACK_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Запрос к базе не ответил за ${timeoutMs / 1000} с`)),
      timeoutMs,
    );
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
    // Базы нет вовсе — режим разработки без Docker. Это единственный
    // случай, когда показывать демо-данные честно: реальных просто нет.
    return fallbackFactory();
  }

  // База ЕСТЬ — значит ответ обязан быть настоящим. Раньше здесь любая
  // ошибка и любой запрос дольше 2 секунд молча подменялись демо-данными:
  // медленная выборка по 16 262 позициям возвращала выдуманные цифры,
  // и отличить их от настоящих было нельзя. Врать дороже, чем упасть.
  return withTimeout(queryFactory(), FALLBACK_TIMEOUT_MS);
}

export const mockIds = {
  customer: 'mock-customer-1',
  order: 'mock-order-1',
  article: 'mock-article-1',
  material: 'mock-material-1',
  paymentDoc: 'mock-payment-1',
  purchaseRequest: 'mock-pr-1',
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
