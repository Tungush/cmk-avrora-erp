import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';

export interface DomainEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Шина живых событий (§3.4): «article:cost_updated» уходит подписчикам
 * экранов «Спецификации» и «Прайс». Реализовано как SSE, а не WebSocket:
 * оповещение одностороннее, EventSource переживает обрывы сам,
 * и не нужно ни одной новой зависимости. События несут только id —
 * данные клиент перечитывает через авторизованный API.
 */
@Injectable()
export class EventsService {
  private readonly subject = new Subject<DomainEvent>();

  emit(type: string, data: Record<string, unknown>): void {
    this.subject.next({ type, data });
  }

  stream(): Observable<DomainEvent> {
    return this.subject.asObservable();
  }
}
