import { Controller, Sse, Query, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Observable, map } from 'rxjs';
import * as jwt from 'jsonwebtoken';
import { Public } from '../../common/decorators/public.decorator';
import { JWT_SECRET } from '../../common/guards/jwt-auth.guard';
import { EventsService } from '../../services/events.service';

@ApiTags('Platform - Events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * SSE-поток доменных событий. EventSource не умеет ставить Authorization,
   * поэтому токен приходит query-параметром и проверяется вручную.
   */
  @Public()
  @Sse('stream')
  @ApiOperation({ summary: 'SSE: article:cost_updated и другие живые события' })
  stream(@Query('token') token: string): Observable<MessageEvent> {
    try {
      jwt.verify(token ?? '', JWT_SECRET);
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Нужен действующий токен' });
    }
    return this.events.stream().pipe(
      map((e) => ({ data: { type: e.type, ...e.data } }) as MessageEvent),
    );
  }
}
