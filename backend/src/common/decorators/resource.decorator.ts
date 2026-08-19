import { SetMetadata } from '@nestjs/common';

export const RESOURCE_KEY = 'fieldAccessResource';

/**
 * Помечает контроллер/эндпоинт ресурсом из FIELD_GROUPS.
 * FieldProjectionInterceptor использует это, чтобы вырезать из ответа
 * поля групп, на которые у пользователя нет права :read.
 */
export const Resource = (resource: string) => SetMetadata(RESOURCE_KEY, resource);
