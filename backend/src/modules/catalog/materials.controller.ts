import { Controller, Get, Post, Patch, Param, Query, Body, NotFoundException, ConflictException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Resource } from '../../common/decorators/resource.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { assertFieldWriteAllowed, permissionsForRoles } from '../../common/field-access';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockMaterials } from '../../common/mock-data';

@ApiTags('Catalog - Materials')
@ApiBearerAuth()
@Resource('material')
@Controller('materials')
export class MaterialsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List materials with search & pagination' })
  async findAll(@Query() query: { category?: string; search?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 50;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (query.category) where.category = query.category;
    if (query.search) {
      where.OR = [
        { materialCode: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.material.findMany({ where, skip, take: pageSize, orderBy: { name: 'asc' } }),
          this.prisma.material.count({ where }),
        ]);

        return { data, meta: { page, pageSize, total } };
      },
      () => getMockMaterials(page, pageSize),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get material by ID' })
  async findOne(@Param('id') id: string) {
    const mat = await this.prisma.material.findUnique({ where: { id }, include: { bomItems: true } });
    if (!mat) throw new NotFoundException({ code: 'NOT_FOUND', message: `Material ${id} not found` });
    return mat;
  }

  @Post()
  @Roles('procurement', 'warehouse_material', 'admin')
  @ApiOperation({ summary: 'Create material' })
  async create(@Body() body: any) {
    const existing = await this.prisma.material.findUnique({ where: { materialCode: body.materialCode } });
    if (existing) throw new ConflictException({ code: 'DUPLICATE_ENTITY', message: `Material code ${body.materialCode} already exists` });
    return this.prisma.material.create({ data: body });
  }

  @Patch(':id')
  @Roles('procurement', 'warehouse_material', 'admin')
  @ApiOperation({ summary: 'Update material (field-level RBAC)' })
  async update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: UserPayload) {
    // warehouse_material правит material.core, но не purchasePrice (material.price — только procurement)
    assertFieldWriteAllowed(body, 'material', permissionsForRoles(user.roles));
    const mat = await this.prisma.material.findUnique({ where: { id } });
    if (!mat) throw new NotFoundException({ code: 'NOT_FOUND', message: `Material ${id} not found` });
    return this.prisma.material.update({ where: { id }, data: body });
  }
}
