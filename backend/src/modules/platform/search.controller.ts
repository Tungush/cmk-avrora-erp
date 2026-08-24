import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { permissionsForRoles } from '../../common/field-access';
import { PrismaService } from '../../services/prisma.service';
import { normalizeName } from '../../common/nomenclature';

const LIMIT = 8;

/**
 * Общий поиск (решение 23.08.2026).
 *
 * Поле поиска в шапке было `TextInput` без единого обработчика — оно
 * обещало поиск и не делало ничего. Между тем это второй вход в карточку
 * заказа и единственный, работающий там, где номер заказа не нарисован;
 * без него нельзя убирать разделы из меню — человек потеряет доступ
 * к тому, что раньше находил глазами.
 *
 * Заказ ищется не только по номеру: по номеру 1С, заказчику, конечному
 * заказчику и объекту — то есть по тем словам, которыми его называет
 * человек, а не по одному каноническому ключу.
 */
@ApiTags('Search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Общий поиск: заказы, изделия, материалы' })
  async search(@Query('q') q: string, @CurrentUser() user: UserPayload) {
    const query = (q ?? '').trim();
    if (query.length < 2) {
      return { query, orders: [], articles: [], materials: [] };
    }

    const perms = permissionsForRoles(user.roles);
    const has = (p: string) => perms.includes(p);
    const like = { contains: query, mode: 'insensitive' as const };

    const [orders, articles, materials] = await Promise.all([
      has('order.core:read')
        ? this.prisma.order.findMany({
            where: {
              OR: [
                { orderNumber: like },
                { onecNum: like },
                { customer: { name: like } },
                { finalCustomer: like },
                { projectSite: like },
                { customerOrderNum: like },
              ],
            },
            // Живые заказы выше архивных: искать обычно нужно текущее
            orderBy: [{ isArchived: 'asc' }, { createdAt: 'desc' }],
            take: LIMIT,
            select: {
              id: true, orderNumber: true, status: true, isArchived: true,
              onecNum: true, plannedShipmentDate: true,
              customer: { select: { name: true } },
            },
          })
        : [],

      has('article.core:read')
        ? this.prisma.article.findMany({
            where: { OR: [{ articleCode: like }, { name: like }] },
            orderBy: { articleCode: 'asc' },
            take: LIMIT,
            select: { id: true, articleCode: true, name: true, isActive: true },
          })
        : [],

      has('material.core:read')
        ? this.searchMaterials(query, like)
        : [],
    ]);

    return {
      query,
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        subtitle: [o.customer?.name, o.onecNum ? `1С: ${o.onecNum}` : null]
          .filter(Boolean).join(' · '),
        status: o.status,
        isArchived: o.isArchived,
      })),
      articles,
      materials,
    };
  }

  /**
   * Материал ищется и по алиасам — тем словам, которыми его называют
   * в цеху («сотка на три»), а не только по имени из 1С (09 §7.4).
   */
  private async searchMaterials(query: string, like: { contains: string; mode: 'insensitive' }) {
    const direct = await this.prisma.material.findMany({
      where: { OR: [{ materialCode: like }, { name: like }] },
      orderBy: { name: 'asc' },
      take: LIMIT,
      select: { id: true, materialCode: true, name: true, unit: true },
    });
    if (direct.length >= LIMIT) return direct.map((m) => ({ ...m, viaAlias: null as string | null }));

    const aliases = await this.prisma.materialAlias.findMany({
      where: {
        OR: [{ alias: like }, { normalized: { contains: normalizeName(query) } }],
        materialId: { notIn: direct.map((d) => d.id) },
      },
      take: LIMIT - direct.length,
      select: {
        alias: true,
        material: { select: { id: true, materialCode: true, name: true, unit: true } },
      },
    });

    return [
      ...direct.map((m) => ({ ...m, viaAlias: null as string | null })),
      ...aliases.map((a) => ({ ...a.material, viaAlias: a.alias })),
    ];
  }
}
