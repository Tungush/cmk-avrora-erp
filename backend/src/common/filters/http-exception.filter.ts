import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected internal error occurred';
    let details: any = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse() as any;

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        message = res.message || exception.message;
        code = res.code || res.error || this.mapStatusToCode(status);
        details = res.details || (Array.isArray(res.message) ? res.message : null);
      }
    } else if (exception && exception.code) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = 'DUPLICATE_ENTITY';
        message = `Unique constraint failed on field(s): ${exception.meta?.target || 'unknown'}`;
      } else if (exception.code === 'P2003') {
        status = HttpStatus.BAD_REQUEST;
        code = 'FOREIGN_KEY_VIOLATION';
        message = 'Foreign key constraint violation';
      } else if (exception.code === 'BUSINESS_RULE_VIOLATION' || exception.name === 'BusinessGuardError') {
        status = HttpStatus.CONFLICT;
        code = exception.code || 'BUSINESS_RULE_VIOLATION';
        message = exception.message;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    response.status(status).json({
      error: {
        code,
        message,
        details,
      },
    });
  }

  private mapStatusToCode(status: number): string {
    switch (status) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      default:
        return 'INTERNAL_SERVER_ERROR';
    }
  }
}
