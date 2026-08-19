import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from './prisma.service';

/** Транзакционный клиент Prisma — чтобы outbox писался вместе с самим изменением */
type TxClient = Prisma.TransactionClient | PrismaService;

export const INTEGRATION_SECRET = process.env.INTEGRATION_1C_SECRET || 'dev-1c-secret';
/** Пока адрес не задан — сообщения копятся в PENDING, а не заваливают лог ошибками */
export const INTEGRATION_1C_URL = process.env.INTEGRATION_1C_URL || '';

const MAX_ATTEMPTS = 5;
/** Экспоненциальная задержка: 1, 2, 4, 8, 16 минут */
const backoffMinutes = (attempt: number) => Math.min(2 ** attempt, 16);

/**
 * Каркас обмена с внешними системами (08_INTEGRATION_1C.md §3).
 *
 * Три задачи:
 *  - маппинг ID (ExternalRef) — чтобы повторная выгрузка не плодила дубли;
 *  - исходящие (Outbox) — запись в одной транзакции с изменением + ретраи;
 *  - входящие (Inbox) — идемпотентность по ключу документа внешней системы.
 *
 * Ядро о существовании 1С не знает: оно вызывает enqueue с доменным типом
 * события, а перевод в объекты 1С живёт в адаптере.
 */
@Injectable()
export class IntegrationService {
  private readonly logger = new Logger(IntegrationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------- Маппинг ID ----------

  async linkExternal(input: {
    entityType: string;
    localId: string;
    externalId: string;
    externalCode?: string | null;
    system?: string;
  }) {
    const system = input.system ?? '1C';
    return this.prisma.externalRef.upsert({
      where: { system_entityType_localId: { system, entityType: input.entityType, localId: input.localId } },
      update: { externalId: input.externalId, externalCode: input.externalCode ?? null },
      create: {
        system,
        entityType: input.entityType,
        localId: input.localId,
        externalId: input.externalId,
        externalCode: input.externalCode ?? null,
      },
    });
  }

  /** Наш объект по идентификатору внешней системы (для входящих сообщений) */
  async findLocalId(entityType: string, externalId: string, system = '1C'): Promise<string | null> {
    const ref = await this.prisma.externalRef.findUnique({
      where: { system_entityType_externalId: { system, entityType, externalId } },
    });
    return ref?.localId ?? null;
  }

  // ---------- Исходящие ----------

  /**
   * Поставить сообщение в очередь. Вызывать ВНУТРИ транзакции с изменением:
   * `prisma.$transaction(async (tx) => { ...; await integration.enqueue(tx, {...}) })`
   */
  async enqueue(
    tx: TxClient,
    msg: { type: string; entityType: string; entityId: string; payload: Record<string, unknown>; system?: string },
  ) {
    return tx.outboxMessage.create({
      data: {
        system: msg.system ?? '1C',
        type: msg.type,
        entityType: msg.entityType,
        entityId: msg.entityId,
        payload: msg.payload as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Отправка накопленного. Возвращает сводку — её же показывает журнал обмена.
   * Без настроенного адреса 1С ничего не отправляет: сообщения ждут в PENDING.
   */
  async flushOutbox(limit = 50) {
    if (!INTEGRATION_1C_URL) {
      const waiting = await this.prisma.outboxMessage.count({ where: { status: 'PENDING' } });
      return { skipped: true, reason: 'INTEGRATION_1C_URL не задан', waiting, sent: 0, failed: 0 };
    }

    const now = new Date();
    const messages = await this.prisma.outboxMessage.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    let sent = 0;
    let failed = 0;
    for (const m of messages) {
      try {
        await this.send(m.type, m.payload);
        await this.prisma.outboxMessage.update({
          where: { id: m.id },
          data: { status: 'SENT', sentAt: new Date(), attempts: m.attempts + 1, lastError: null },
        });
        sent++;
      } catch (e) {
        const attempts = m.attempts + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        await this.prisma.outboxMessage.update({
          where: { id: m.id },
          data: {
            status: dead ? 'DEAD' : 'FAILED',
            attempts,
            lastError: e instanceof Error ? e.message : 'Unknown error',
            nextRetryAt: dead ? null : new Date(Date.now() + backoffMinutes(attempts) * 60_000),
          },
        });
        failed++;
        if (dead) {
          // Мёртвое сообщение — повод для человека, а не молчаливая потеря
          this.logger.error(`Сообщение ${m.type} (${m.id}) не доставлено после ${attempts} попыток`);
        }
      }
    }
    return { skipped: false, sent, failed, processed: messages.length };
  }

  /** Транспорт до 1С. Подпись — HMAC, как для входящих (04_ROLES_PERMISSIONS.md) */
  private async send(type: string, payload: unknown) {
    const body = JSON.stringify({ type, payload });
    const signature = crypto.createHmac('sha256', INTEGRATION_SECRET).update(body).digest('hex');
    const res = await fetch(`${INTEGRATION_1C_URL.replace(/\/$/, '')}/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`1С ответила ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json().catch(() => ({}));
  }

  // ---------- Входящие ----------

  /** Проверка подписи: вебхуки подписываются HMAC, а не JWT */
  verifySignature(rawBody: string, signature?: string): boolean {
    if (!signature) return false;
    const expected = crypto.createHmac('sha256', INTEGRATION_SECRET).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Принять сообщение. Повторная доставка того же externalKey не создаёт
   * второй записи — уникальный индекс (system, type, externalKey).
   */
  async receive(input: { type: string; externalKey: string; payload: Record<string, unknown>; system?: string }) {
    const system = input.system ?? '1C';
    const existing = await this.prisma.inboxMessage.findUnique({
      where: { system_type_externalKey: { system, type: input.type, externalKey: input.externalKey } },
    });
    if (existing) {
      return { message: existing, duplicate: true };
    }
    const message = await this.prisma.inboxMessage.create({
      data: {
        system,
        type: input.type,
        externalKey: input.externalKey,
        payload: input.payload as Prisma.InputJsonValue,
      },
    });
    return { message, duplicate: false };
  }

  async markProcessed(id: string) {
    return this.prisma.inboxMessage.update({
      where: { id },
      data: { status: 'PROCESSED', processedAt: new Date(), error: null },
    });
  }

  async markFailed(id: string, error: string, attempts: number) {
    return this.prisma.inboxMessage.update({
      where: { id },
      data: {
        status: attempts >= MAX_ATTEMPTS ? 'DEAD' : 'FAILED',
        attempts,
        error: error.slice(0, 1000),
      },
    });
  }
}
