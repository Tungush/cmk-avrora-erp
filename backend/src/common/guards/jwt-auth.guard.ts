import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export const JWT_SECRET = process.env.JWT_SECRET || 'erp_super_secret_jwt_key';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Missing or malformed Authorization header Bearer token',
      });
    }

    const token = authHeader.substring(7);
    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      request.user = {
        userId: payload.userId || payload.sub,
        email: payload.email,
        roles: payload.roles || [],
      };
      return true;
    } catch (err) {
      throw new UnauthorizedException({
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired JWT access token',
      });
    }
  }
}
