import { BadRequestException } from '@nestjs/common';

export function assertNoCalculatedFieldUpdate(
  body: Record<string, unknown>,
  calculatedFields: string[],
  entityName: string,
) {
  const attempted = calculatedFields.filter((field) => field in body);
  if (attempted.length === 0) {
    return;
  }

  throw new BadRequestException({
    code: 'CALCULATED_FIELD_READ_ONLY',
    message: `Calculated field(s) cannot be updated directly for ${entityName}: ${attempted.join(', ')}`,
  });
}

export function pickEditableFields<T extends Record<string, unknown>>(
  body: T,
  editableFields: string[],
): Partial<T> {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => editableFields.includes(key)),
  ) as Partial<T>;
}
