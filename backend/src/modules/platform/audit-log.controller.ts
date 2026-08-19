import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockAuditLog } from '../../common/mock-data';

@ApiTags('Platform - Audit Log')
@ApiBearerAuth()
@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('admin', 'director')
  @ApiOperation({ summary: 'Get audit log' })
  async findAll(@Query() query: { userId?: string; entity?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 50;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (query.userId) where.userId = query.userId;
    if (query.entity) where.entityType = query.entity;

    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.auditLogEntry.findMany({ where, skip, take: pageSize, orderBy: { timestamp: 'desc' } }),
          this.prisma.auditLogEntry.count({ where }),
        ]);

        return { data, meta: { page, pageSize, total } };
      },
      () => getMockAuditLog(page, pageSize),
    );
  }
}
