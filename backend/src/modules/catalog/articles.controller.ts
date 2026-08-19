import { Controller, Get, Post, Put, Patch, Param, Query, Body, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Resource } from '../../common/decorators/resource.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { assertFieldWriteAllowed, permissionsForRoles } from '../../common/field-access';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import { getMockArticles } from '../../common/mock-data';
import { ArticleCostingService } from '../../services/article-costing.service';

@ApiTags('Catalog - Articles')
@ApiBearerAuth()
@Resource('article')
@Controller('articles')
export class ArticlesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly costingService: ArticleCostingService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List articles with search & pagination' })
  async findAll(@Query() query: { search?: string; page?: string; pageSize?: string }) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 50;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (query.search) {
      where.OR = [
        { articleCode: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
        { legacyCode: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return runWithFallback(
      this.prisma,
      async () => {
        const [data, total] = await Promise.all([
          this.prisma.article.findMany({ where, skip, take: pageSize, orderBy: { name: 'asc' }, include: { bomItems: { include: { material: true } } } }),
          this.prisma.article.count({ where }),
        ]);

        return { data, meta: { page, pageSize, total } };
      },
      () => getMockArticles(page, pageSize),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get article by ID' })
  async findOne(@Param('id') id: string) {
    const a = await this.prisma.article.findUnique({ where: { id }, include: { bomItems: { include: { material: true } }, priceHistory: true } });
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: `Article ${id} not found` });
    return a;
  }

  @Post()
  @Roles('engineer', 'admin')
  @ApiOperation({ summary: 'Create article' })
  async create(@Body() body: any) {
    const existing = await this.prisma.article.findUnique({ where: { articleCode: body.articleCode } });
    if (existing) throw new ConflictException({ code: 'DUPLICATE_ENTITY', message: `Article code ${body.articleCode} already exists` });
    return this.prisma.article.create({ data: body });
  }

  @Patch(':id')
  @Roles('engineer', 'planner', 'admin')
  @ApiOperation({ summary: 'Update article (field-level RBAC)' })
  async update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: UserPayload) {
    // engineer может править article.core, но не approvedPrice (article.price — только Approve директора)
    assertFieldWriteAllowed(body, 'article', permissionsForRoles(user.roles));
    const a = await this.prisma.article.findUnique({ where: { id } });
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: `Article ${id} not found` });
    return this.prisma.article.update({ where: { id }, data: body });
  }

  @Get(':id/bom')
  @ApiOperation({ summary: 'Состав изделия (BOM): из чего оно собирается' })
  async getBom(@Param('id') id: string) {
    const a = await this.prisma.article.findUnique({ where: { id }, include: { bomItems: { include: { material: true }, orderBy: { lineCost: 'desc' } } } });
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: `Article ${id} not found` });
    return a.bomItems;
  }

  @Post(':id/bom')
  @Roles('engineer', 'admin')
  @ApiOperation({ summary: 'Добавить позицию состава (расход материала на единицу)' })
  async addBomItem(
    @Param('id') id: string,
    @Body() body: { materialId: string; qtyPerUnit: number; operationType?: string; laborHours?: number },
    @CurrentUser() user: UserPayload,
  ) {
    if (!body.materialId || !(Number(body.qtyPerUnit) > 0)) {
      throw new BadRequestException({ code: 'INVALID_BOM_ITEM', message: 'Нужны materialId и qtyPerUnit > 0' });
    }
    const [article, material] = await Promise.all([
      this.prisma.article.findUnique({ where: { id } }),
      this.prisma.material.findUnique({ where: { id: body.materialId } }),
    ]);
    if (!article) throw new NotFoundException({ code: 'NOT_FOUND', message: `Article ${id} not found` });
    if (!material) throw new NotFoundException({ code: 'NOT_FOUND', message: `Material ${body.materialId} not found` });

    const operationType = (body.operationType ?? 'WELDING_ASSEMBLY') as any;
    const qty = Number(body.qtyPerUnit);
    // Повторное добавление того же материала на ту же операцию — обновление расхода
    const item = await this.prisma.bomItem.upsert({
      where: { articleId_materialId_operationType: { articleId: id, materialId: body.materialId, operationType } },
      update: {
        qtyPerUnit: qty,
        laborHours: body.laborHours ?? 0,
        lineCost: Math.round(qty * Number(material.purchasePrice) * 100) / 100,
      },
      create: {
        articleId: id,
        materialId: body.materialId,
        operationType,
        qtyPerUnit: qty,
        laborHours: body.laborHours ?? 0,
        lineCost: Math.round(qty * Number(material.purchasePrice) * 100) / 100,
      },
      include: { material: true },
    });

    const costing = await this.costingService.recalculate(id, 'bom_change', user.userId);
    return { item, costing };
  }

  @Put(':id/bom')
  @Roles('engineer', 'admin')
  @ApiOperation({ summary: 'Заменить состав целиком («собрать ГП»: полный список расхода)' })
  async replaceBom(
    @Param('id') id: string,
    @Body() body: { items: Array<{ materialId: string; qtyPerUnit: number; operationType?: string; laborHours?: number }> },
    @CurrentUser() user: UserPayload,
  ) {
    const article = await this.prisma.article.findUnique({ where: { id } });
    if (!article) throw new NotFoundException({ code: 'NOT_FOUND', message: `Article ${id} not found` });
    const items = (body.items ?? []).filter((i) => i.materialId && Number(i.qtyPerUnit) > 0);
    const materials = await this.prisma.material.findMany({
      where: { id: { in: items.map((i) => i.materialId) } },
    });
    const priceById = new Map(materials.map((m) => [m.id, Number(m.purchasePrice)]));

    await this.prisma.$transaction([
      this.prisma.bomItem.deleteMany({ where: { articleId: id } }),
      this.prisma.bomItem.createMany({
        data: items.map((i) => ({
          articleId: id,
          materialId: i.materialId,
          operationType: (i.operationType ?? 'WELDING_ASSEMBLY') as any,
          qtyPerUnit: Number(i.qtyPerUnit),
          laborHours: i.laborHours ?? 0,
          lineCost: Math.round(Number(i.qtyPerUnit) * (priceById.get(i.materialId) ?? 0) * 100) / 100,
        })),
        skipDuplicates: true,
      }),
    ]);

    const costing = await this.costingService.recalculate(id, 'bom_change', user.userId);
    const bomItems = await this.prisma.bomItem.findMany({ where: { articleId: id }, include: { material: true } });
    return { items: bomItems, costing };
  }
}
