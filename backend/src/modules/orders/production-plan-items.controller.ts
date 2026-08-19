import { Body, Controller, NotFoundException, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { assertNoCalculatedFieldUpdate, pickEditableFields } from '../../common/calculated-fields';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../services/prisma.service';
import { CascadeRecalcService } from '../../services/cascade-recalc.service';

@ApiTags('Production Plan Items')
@ApiBearerAuth()
@Controller('production-plan-items')
export class ProductionPlanItemsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cascadeRecalcService: CascadeRecalcService,
  ) {}

  @Patch(':id')
  @Roles('planner', 'shop_foreman', 'admin')
  @ApiOperation({ summary: 'Update production plan item and trigger procurement recalculation' })
  async update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: UserPayload,
  ) {
    assertNoCalculatedFieldUpdate(
      body,
      ['qtyFromOrders', 'qtyMinStock', 'qtyReserved', 'qtyInStock', 'qtyToProduce'],
      'ProductionPlanItem',
    );
    const data = pickEditableFields(body, ['periodType', 'periodKey']);

    const item = await this.prisma.productionPlanItem.findUnique({ where: { id } });
    if (!item) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `ProductionPlanItem ${id} not found` });
    }

    const updated = await this.prisma.productionPlanItem.update({
      where: { id },
      data,
    });
    const recalc = this.cascadeRecalcService.enqueueProcurementRecalc(updated.periodKey, user?.userId);

    return {
      ...updated,
      recalculation: recalc,
    };
  }
}
