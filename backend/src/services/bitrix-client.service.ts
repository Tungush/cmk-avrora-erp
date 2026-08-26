import { Injectable, Logger } from '@nestjs/common';

const B24_WEBHOOK_URL = process.env.B24_WEBHOOK_URL ?? '';
const B24_OPERATOR_ID = process.env.B24_OPERATOR_ID ?? '1';
/** Воронка снабжения: сводные заявки на закуп недостающего сырья */
const B24_SUPPLY_CATEGORY_ID = process.env.B24_SUPPLY_CATEGORY_ID ?? '';
/** Воронка «Заказ на Работы»: подряд, по ней оформляют заказ поставщику от А77 */
const B24_WORKS_CATEGORY_ID = process.env.B24_WORKS_CATEGORY_ID ?? '';

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

  /**
   * Сводная заявка на закуп → сделка в воронке снабжения (26.08.2026).
   * Одна сделка на пачку позиций — «не из-за одного болта» (решение
   * пользователя). В отличие от createNomenclatureTask, отсутствие
   * вебхука здесь — честная ошибка, а не тихий no-op: снабженец нажал
   * кнопку и должен знать, ушла заявка или нет.
   */
  async createSupplyDeal(input: {
    title: string;
    lines: Array<{ code: string; name: string; qty: number; unit: string; estPrice: number }>;
    totalEstimate: number;
    requestedBy?: string | null;
  }): Promise<string> {
    if (!B24_WEBHOOK_URL) {
      throw new Error('B24_WEBHOOK_URL не задан — заявка не отправлена. Настройте вебхук Битрикс24.');
    }
    const comments = [
      ...input.lines.map((l) =>
        `${l.code} · ${l.name} — ${l.qty} ${l.unit}` + (l.estPrice ? ` (~${Math.round(l.qty * l.estPrice).toLocaleString('ru-RU')} ₸)` : '')),
      '',
      `Оценка итого: ${Math.round(input.totalEstimate).toLocaleString('ru-RU')} ₸`,
      input.requestedBy ? `Заявку сформировал: ${input.requestedBy}` : '',
    ].filter(Boolean).join('\n');

    const fields: Record<string, unknown> = {
      TITLE: input.title,
      COMMENTS: comments,
      ASSIGNED_BY_ID: B24_OPERATOR_ID,
      OPPORTUNITY: Math.round(input.totalEstimate),
      CURRENCY_ID: 'KZT',
    };
    if (B24_SUPPLY_CATEGORY_ID) fields.CATEGORY_ID = B24_SUPPLY_CATEGORY_ID;
    return this.createDeal(fields);
  }

  /**
   * Пачка заявок на подряд → ОДНА сделка в воронке «Заказ на Работы»
   * (26.08.2026). По ней в Б24 подбирают подрядчика, называют ставку и
   * оформляют заказ поставщику от А77; появление ДО подрядчика мы увидим
   * в «Закупках», сверка с актами — по БИН.
   *
   * Дверь в Б24 одна: штучная отправка строки подряда убрана вместе с
   * полями ContractorWork.bitrixDealId/bitrixSentAt — иначе через месяц
   * никто не вспомнит, откуда ушла сделка.
   */
  async createWorksRequestDeal(input: {
    title: string;
    lines: Array<{
      number: string;
      stageLabel: string;
      description: string;
      qty: number | null;
      unit: string;
      rate: number | null;
      estimate: number | null;
      atOurShop: boolean;
      contractorName?: string | null;
    }>;
    totalEstimate: number;
    requestedBy?: string | null;
  }): Promise<string> {
    if (!B24_WEBHOOK_URL) {
      throw new Error('B24_WEBHOOK_URL не задан — заявка не отправлена. Настройте вебхук Битрикс24.');
    }
    const comments = [
      ...input.lines.map((l) => [
        `${l.number} · ${l.stageLabel} — ${l.description}`,
        l.qty != null ? `объём ${l.qty} ${l.unit}` : null,
        l.rate != null ? `ставка ${Math.round(l.rate).toLocaleString('ru-RU')} ₸/${l.unit}` : 'ставка не назначена',
        l.estimate ? `~${Math.round(l.estimate).toLocaleString('ru-RU')} ₸` : null,
        l.atOurShop ? 'работы в нашем цеху' : 'на площадке подрядчика',
        l.contractorName ? `подрядчик: ${l.contractorName}` : 'подрядчик не выбран — подобрать',
      ].filter(Boolean).join(' · ')),
      '',
      input.totalEstimate > 0
        ? `Оценка итого: ${Math.round(input.totalEstimate).toLocaleString('ru-RU')} ₸`
        : 'Оценка не задана — назвать цену при подборе подрядчика',
      'Оформить заказ поставщику от А77.',
      input.requestedBy ? `Заявку сформировал: ${input.requestedBy}` : '',
    ].filter(Boolean).join('\n');

    const fields: Record<string, unknown> = {
      TITLE: input.title,
      COMMENTS: comments,
      ASSIGNED_BY_ID: B24_OPERATOR_ID,
      ...(input.totalEstimate > 0
        ? { OPPORTUNITY: Math.round(input.totalEstimate), CURRENCY_ID: 'KZT' }
        : {}),
    };
    if (B24_WORKS_CATEGORY_ID) fields.CATEGORY_ID = B24_WORKS_CATEGORY_ID;
    return this.createDeal(fields);
  }

  private async createDeal(fields: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${B24_WEBHOOK_URL.replace(/\/$/, '')}/crm.deal.add.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Б24 ответил ${res.status}`);
    const json: any = await res.json().catch(() => ({}));
    const dealId = json?.result;
    if (!dealId) throw new Error(`Б24 не вернул id сделки: ${JSON.stringify(json).slice(0, 200)}`);
    return String(dealId);
  }
}
