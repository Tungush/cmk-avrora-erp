import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserPayload } from '../decorators/current-user.decorator';

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true; // No explicit role restriction
    }

    const request = context.switchToHttp().getRequest();
    const user: UserPayload = request.user;

    if (!user || !user.roles) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Access denied: user has no roles assigned',
      });
    }

    // Admin role overrides all permission checks
    if (user.roles.includes('admin')) {
      return true;
    }

    const hasRole = requiredRoles.some((role) => user.roles.includes(role));
    if (!hasRole) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: `Access denied: required role(s): [${requiredRoles.join(', ')}], user has: [${user.roles.join(', ')}]`,
      });
    }

    return true;
  }
}
