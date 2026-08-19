import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, UserPayload } from '../../common/decorators/current-user.decorator';
import { NomenclatureService } from '../../services/nomenclature.service';
import { AliasSourceValue } from '../../common/nomenclature';

/**
 * Имена номенклатуры (09 §7). Три контура: не дать создать дубль,
 * дать найти без знания имени 1С, поймать проскочившее.
 */
@ApiTags('Nomenclature')
@ApiBearerAuth()
@Controller('nomenclature')
export class NomenclatureController {
  constructor(private readonly nomenclature: NomenclatureService) {}

  @Get('search')
  @ApiOperation({ summary: 'Поиск по всем именам; промахи логируются и учат справочник' })
  async search(@Query('q') q: string, @CurrentUser() user: UserPayload) {
    return this.nomenclature.search(q ?? '', user?.userId);
  }

  @Get('suggest')
  @ApiOperation({ summary: 'Похожее уже есть? — проверка перед созданием заявки' })
  async suggest(@Query('q') q: string, @Query('limit') limit?: string) {
    const data = await this.nomenclature.suggest(q ?? '', Number(limit) || 5);
    return { data, total: data.length };
  }

  @Get('duplicates')
  @ApiOperation({ summary: 'Отчёт о возможных дублях справочника' })
  async duplicates() {
    return this.nomenclature.duplicateReport();
  }

  @Get('stalled-requests')
  @ApiOperation({ summary: 'Заявки, зависшие в ожидании кода из 1С' })
  async stalled() {
    const data = await this.nomenclature.stalledRequests();
    return { data, total: data.length };
  }

  @Get('materials/:materialId/names')
  @ApiOperation({ summary: 'Все имена материала: наше, из 1С, из заявок, от поставщиков' })
  async names(@Param('materialId') materialId: string) {
    return this.nomenclature.namesOf(materialId);
  }

  @Post('materials/:materialId/aliases')
  @Roles('engineer', 'procurement', 'planner', 'admin')
  @ApiOperation({ summary: 'Добавить имя, под которым материал знают люди' })
  async addAlias(
    @Param('materialId') materialId: string,
    @Body() body: { alias: string; source?: AliasSourceValue },
    @CurrentUser() user: UserPayload,
  ) {
    return this.nomenclature.addAlias(materialId, body.alias, body.source ?? 'MANUAL', user?.userId);
  }

  @Post('search-misses/:missId/resolve')
  @ApiOperation({ summary: 'Промах привёл к материалу — его слова становятся именем' })
  async resolveMiss(
    @Param('missId') missId: string,
    @Body() body: { materialId: string },
    @CurrentUser() user: UserPayload,
  ) {
    return this.nomenclature.resolveMiss(missId, body.materialId, user?.userId);
  }

  @Post('requests/:requestId/onec-response')
  @Roles('procurement', 'admin')
  @ApiOperation({ summary: 'Ответ 1С: код и имя закрывают заявку и становятся алиасами' })
  async onecResponse(
    @Param('requestId') requestId: string,
    @Body() body: { onecCode: string; onecName: string; onecGuid?: string; onecUnit?: string; linkedMaterialId?: string },
  ) {
    return this.nomenclature.applyOnecResponse(requestId, body);
  }

  @Post('materials/:materialId/onec-rename')
  @Roles('procurement', 'admin')
  @ApiOperation({ summary: 'Переименование в 1С: старое имя уходит в алиасы с датой' })
  async rename(
    @Param('materialId') materialId: string,
    @Body() body: { newName: string },
    @CurrentUser() user: UserPayload,
  ) {
    return this.nomenclature.applyOnecRename(materialId, body.newName, user?.userId);
  }
}
