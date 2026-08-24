import { Injectable, Logger } from '@nestjs/common';

const B24_WEBHOOK_URL = process.env.B24_WEBHOOK_URL ?? '';
const B24_OPERATOR_ID = process.env.B24_OPERATOR_ID ?? '1';

/**
 * Б24 — заявочная система со своей логикой; мы в неё не пишем ничего,
 * кроме задач оператору 1С (решение 22.08.2026): заявка на номенклатуру
 * живёт у нас (статусы, SLA), а Б24 лишь доносит работу до оператора,
 * которому так привычнее. Без вебхука — тихий no-op с записью в лог.
 */
@Injectable()
export class BitrixClientService {
  private readonly logger = new Logger(BitrixClientService.name);

  get configured(): boolean {
    return Boolean(B24_WEBHOOK_URL);
  }

  /** Задача оператору: завести номенклатуру в 1С по нашей заявке */
  async createNomenclatureTask(request: {
    id: string;
    proposedName: string;
    description?: string | null;
    reason?: string | null;
    requestedBy?: string | null;
  }): Promise<{ taskId: string } | null> {
    if (!this.configured) {
      this.logger.log(
        `B24_WEBHOOK_URL не задан — задача по заявке «${request.proposedName}» не создана (заявка ${request.id})`,
      );
      return null;
    }
    try {
      const res = await fetch(`${B24_WEBHOOK_URL.replace(/\/$/, '')}/tasks.task.add.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            TITLE: `Завести номенклатуру в 1С: ${request.proposedName}`,
            DESCRIPTION: [
              `Заявка из ERP ЦМК АВРОРА №${request.id}`,
              `Наименование (слова заявителя): ${request.proposedName}`,
              request.description ? `Описание: ${request.description}` : null,
              request.reason ? `Причина: ${request.reason}` : null,
              request.requestedBy ? `Заявитель: ${request.requestedBy}` : null,
              '',
              'После заведения в 1С код и имя подтянутся в ERP автоматически при синхронизации.',
            ].filter(Boolean).join('\n'),
            RESPONSIBLE_ID: B24_OPERATOR_ID,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`Б24 ответил ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json: any = await res.json();
      const taskId = String(json?.result?.task?.id ?? json?.result ?? '');
      if (!taskId) throw new Error('Б24 не вернул id задачи');
      return { taskId };
    } catch (e) {
      // Заявка не должна падать из-за Б24: она уже записана и уйдёт в 1С,
      // а задачу можно создать повторно вручную
      this.logger.error(
        `Не удалось создать задачу Б24 по заявке ${request.id}: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }
}
