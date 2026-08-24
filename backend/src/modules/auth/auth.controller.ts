import { Controller, Post, Get, Body, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import { Public } from '../../common/decorators/public.decorator';
import { JWT_SECRET } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { permissionsForRoles, fieldGroupsForUi, ROLE_FAMILIES } from '../../common/field-access';

/** Семейство пользователя — по старшей роли (для навигации/онбординга) */
function familyForRoles(roles: string[]): string {
  if (roles.includes('admin')) return 'admin';
  for (const role of roles) {
    if (ROLE_FAMILIES[role]) return ROLE_FAMILIES[role];
  }
  return 'viewer';
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'User login & JWT token retrieval' })
  async login(@Body() body: { email: string; password?: string; roles?: string[] }) {
    if (!body.email) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Email is required' });
    }

    const selectedRoles = body.roles && body.roles.length > 0 ? body.roles : ['sales_manager'];

    const dbUser = await runWithFallback(
      this.prisma,
      () => this.prisma.user.findUnique({
        where: { email: body.email },
        include: { userRoles: { include: { role: true } } },
      }),
      () => null,
    );

    let userId: string;
    let email: string;
    let roles: string[];

    if (dbUser) {
      // Известный email обязан пройти пароль ВСЕГДА, демо-режим тут ни при
      // чём — тот управляет только доступом НЕИЗВЕСТНОГО email ниже. До этой
      // правки любой известный адрес пускал внутрь без проверки вовсе.
      const passwordOk = await bcrypt.compare(body.password ?? '', dbUser.passwordHash);
      if (!passwordOk) {
        throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Неверный email или пароль' });
      }
      userId = dbUser.id;
      email = dbUser.email;
      roles = dbUser.userRoles.map(ur => ur.role.code);
    } else {
      // Неизвестный email с ролями из тела запроса — это ДЕМО-режим:
      // удобно для показа, недопустимо на живых данных, где любой знающий
      // адрес получал бы полный доступ к заказам и ценам. Перед подключением
      // боевой 1С выключить: AUTH_DEMO_MODE=false в backend/.env
      const demoMode = process.env.AUTH_DEMO_MODE !== 'false';
      if (!demoMode) {
        throw new UnauthorizedException({
          code: 'UNKNOWN_USER',
          message: 'Пользователь не найден. Демо-вход отключён (AUTH_DEMO_MODE=false)',
        });
      }
      userId = `usr-${Date.now()}`;
      email = body.email;
      roles = selectedRoles;
    }

    // JWT несёт только роли — права вычисляются на сервере при каждом запросе,
    // чтобы смена матрицы прав действовала сразу, без перевыпуска токена.
    const payload = { userId, email, roles };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    return {
      accessToken,
      user: { userId, email, roles },
      permissions: permissionsForRoles(roles),
      family: familyForRoles(roles),
    };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current user: roles, permissions, field groups' })
  async me(@CurrentUser() user: UserPayload) {
    return {
      user: { userId: user.userId, email: user.email, roles: user.roles },
      family: familyForRoles(user.roles),
      permissions: permissionsForRoles(user.roles),
      fieldGroups: fieldGroupsForUi(),
    };
  }
}
