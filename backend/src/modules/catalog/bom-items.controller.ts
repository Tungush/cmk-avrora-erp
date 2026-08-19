import { Body, Controller, Delete, NotFoundException, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { assertNoCalculatedFieldUpdate, pickEditableFields } from '../../common/calculated-fields';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { CascadeRecalcService } from '../../services/cascade-recalc.service';

@ApiTags('Catalog - BOM Items')
@ApiBearerAuth()
@Controller('bom-items')
export class BomItemsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cascadeRecalcService: CascadeRecalcService,
  ) {}

  @Patch(':id')
  @Roles('engineer', 'admin')
  @ApiOperation({ summary: 'Update BOM item and trigger article cost recalculation' })
  async update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: UserPayload,
  ) {
    assertNoCalculatedFieldUpdate(body, ['lineCost'], 'BomItem');
    const data = pickEditableFields(body, ['materialId', 'qtyPerUnit', 'operationType', 'laborHours']);

    const bomItem = await this.prisma.bomItem.findUnique({ where: { id } });
    if (!bomItem) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `BomItem ${id} not found` });
    }

    const updated = await this.prisma.bomItem.update({
      where: { id },
      data,
    });
    const recalc = this.cascadeRecalcService.enqueueArticleBomRecalc(updated.articleId, user?.userId);

    return {
      ...updated,
      recalculation: recalc,
    };
  }

  @Delete(':id')
  @Roles('engineer', 'admin')
  @ApiOperation({ summary: 'Убрать позицию из состава (каскадный пересчёт)' })
  async remove(@Param('id') id: string, @CurrentUser() user: UserPayload) {
    const bomItem = await this.prisma.bomItem.findUnique({ where: { id } });
    if (!bomItem) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `BomItem ${id} not found` });
    }
    await this.prisma.bomItem.delete({ where: { id } });
    const recalc = this.cascadeRecalcService.enqueueArticleBomRecalc(bomItem.articleId, user?.userId);
    return { deleted: true, recalculation: recalc };
  }
}
