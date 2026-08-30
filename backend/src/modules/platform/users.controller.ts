import {
  Controller, Get, Post, Patch, Param, Body,
  NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import * as bcrypt from 'bcrypt';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';

/**
 * Управление пользователями (28.08.2026). Учётки жили только в сиде и
 * скрипте ротации паролей — завести человека или отобрать доступ через
 * интерфейс было нельзя, а на вопрос «кому мы дали доступ» сервис не
 * отвечал (в Excel это был список из 32 адресов).
 *
 * Роли берутся из справочника Role: вход по паролю читает их из базы,
 * так что смена ролей действует со следующего логина без перевыпуска
 * ничего.
 */
@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  private shape(u: any) {
    return {
      id: u.id,
      email: u.email,
      isActive: u.isActive,
      createdAt: u.createdAt,
      roles: u.userRoles.map((ur: any) => ({ code: ur.role.code, name: ur.role.name })),
      employee: u.employee ? { id: u.employee.id, name: u.employee.name } : null,
    };
  }

  @Get()
  @Roles('admin')
  @ApiOperation({ summary: 'Список пользователей с ролями' })
  async findAll() {
    return runWithFallback(
      this.prisma,
      async () => {
        const users = await this.prisma.user.findMany({
          orderBy: { email: 'asc' },
          include: {
            userRoles: { include: { role: true } },
            employee: { select: { id: true, name: true } },
          },
        });
        return users.map((u) => this.shape(u));
      },
      () => [],
    );
  }

  @Get('roles')
  @Roles('admin')
  @ApiOperation({ summary: 'Справочник ролей' })
  async roles() {
    return this.prisma.role.findMany({
      orderBy: [{ family: 'asc' }, { code: 'asc' }],
      select: { code: true, name: true, description: true, family: true, isSystem: true },
    });
  }

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Завести пользователя' })
  async create(@Body() body: { email: string; password: string; roles: string[]; employeeId?: string | null }) {
    const email = body.email?.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new BadRequestException({ code: 'INVALID_EMAIL', message: 'Укажите email' });
    }
    if (!body.password || body.password.length < 8) {
      throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'Пароль — минимум 8 символов' });
    }
    if (!body.roles?.length) {
      throw new BadRequestException({ code: 'ROLES_REQUIRED', message: 'Выберите хотя бы одну роль' });
    }
    const dup = await this.prisma.user.findUnique({ where: { email } });
    if (dup) throw new ConflictException({ code: 'EMAIL_TAKEN', message: `Пользователь ${email} уже есть` });

    const roleRows = await this.prisma.role.findMany({ where: { code: { in: body.roles } } });
    if (roleRows.length !== body.roles.length) {
      const known = new Set(roleRows.map((r) => r.code));
      const bad = body.roles.filter((r) => !known.has(r));
      throw new BadRequestException({ code: 'UNKNOWN_ROLE', message: `Неизвестные роли: ${bad.join(', ')}` });
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(body.password, 10),
        employeeId: body.employeeId || null,
        userRoles: { create: roleRows.map((r) => ({ roleId: r.id })) },
      },
      include: {
        userRoles: { include: { role: true } },
        employee: { select: { id: true, name: true } },
      },
    });
    return this.shape(user);
  }

  @Patch(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Роли, активность, привязка к сотруднику' })
  async update(
    @Param('id') id: string,
    @Body() body: { roles?: string[]; isActive?: boolean; employeeId?: string | null },
    @CurrentUser() me: UserPayload,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: `Пользователь ${id} не найден` });

    // Самому себе admin не снимается и доступ не отключается: иначе
    // единственный администратор запирает систему одним кликом
    const isSelf = me.userId === id;
    if (isSelf && body.isActive === false) {
      throw new ConflictException({ code: 'SELF_LOCKOUT', message: 'Нельзя отключить собственную учётку' });
    }
    if (isSelf && body.roles && !body.roles.includes('admin') && user.userRoles.some((ur) => ur.role.code === 'admin')) {
      throw new ConflictException({ code: 'SELF_LOCKOUT', message: 'Нельзя снять admin с собственной учётки' });
    }

    if (body.roles) {
      if (!body.roles.length) {
        throw new BadRequestException({ code: 'ROLES_REQUIRED', message: 'Хотя бы одна роль обязательна' });
      }
      const roleRows = await this.prisma.role.findMany({ where: { code: { in: body.roles } } });
      if (roleRows.length !== body.roles.length) {
        throw new BadRequestException({ code: 'UNKNOWN_ROLE', message: 'Среди ролей есть неизвестные' });
      }
      await this.prisma.$transaction([
        this.prisma.userRole.deleteMany({ where: { userId: id } }),
        this.prisma.userRole.createMany({ data: roleRows.map((r) => ({ userId: id, roleId: r.id })) }),
      ]);
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.employeeId !== undefined ? { employeeId: body.employeeId || null } : {}),
      },
      include: {
        userRoles: { include: { role: true } },
        employee: { select: { id: true, name: true } },
      },
    });
    return this.shape(updated);
  }

  @Post(':id/reset-password')
  @Roles('admin')
  @ApiOperation({ summary: 'Задать новый пароль' })
  async resetPassword(@Param('id') id: string, @Body() body: { password: string }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: `Пользователь ${id} не найден` });
    if (!body.password || body.password.length < 8) {
      throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'Пароль — минимум 8 символов' });
    }
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(body.password, 10) },
    });
    return { ok: true };
  }
}
