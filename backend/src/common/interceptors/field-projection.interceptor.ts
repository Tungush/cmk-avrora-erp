import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { RESOURCE_KEY } from '../decorators/resource.decorator';
import { projectByPermissions, permissionsForRoles } from '../field-access';
import { UserPayload } from '../decorators/current-user.decorator';

/**
 * Проекция ответа по правам на группы полей (§1.5 из 07_ARCHITECTURE_AND_UX.md).
 * Скрытие поля происходит на сервере: поле закрытой группы не попадает в JSON,
 * а не прячется на фронте через hidden-колонку.
 */
@Injectable()
export class FieldProjectionInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const resource = this.reflector.getAllAndOverride<string>(RESOURCE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!resource) return next.handle();

    const request = context.switchToHttp().getRequest();
    const user: UserPayload | undefined = request.user;
    if (!user?.roles) return next.handle();

    const permissions = permissionsForRoles(user.roles);
    return next.handle().pipe(map((payload) => projectByPermissions(payload, resource, permissions)));
  }
}
