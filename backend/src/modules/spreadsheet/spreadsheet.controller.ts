import {
  Controller,
  Get,
  Param,
  Query,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../services/prisma.service';
import { runWithFallback } from '../../common/fallback';
import {
  getMockSpreadsheetImport,
  getMockSpreadsheetRows,
  getMockSpreadsheetSheet,
  getMockSpreadsheetSheets,
} from '../../common/mock-data';

@ApiTags('Spreadsheet')
@ApiBearerAuth()
@Controller('spreadsheet')
export class SpreadsheetController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('imports/latest')
  @ApiOperation({ summary: 'Get latest spreadsheet import metadata' })
  async getLatestImport() {
    return runWithFallback(
      this.prisma,
      async () => {
        const imp = await this.prisma.spreadsheetImport.findFirst({
          orderBy: { importedAt: 'desc' },
          include: {
            sheets: {
              orderBy: { name: 'asc' },
              select: {
                id: true,
                name: true,
                headerRow: true,
                colCount: true,
                rowCount: true,
                headers: true,
              },
            },
          },
        });
        if (!imp) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No import found' });
        return imp;
      },
      () => getMockSpreadsheetImport(),
    );
  }

  @Get('sheets')
  @ApiOperation({ summary: 'List all imported sheets' })
  async listSheets() {
    return runWithFallback(
      this.prisma,
      async () => {
        const imp = await this.prisma.spreadsheetImport.findFirst({
          orderBy: { importedAt: 'desc' },
        });
        if (!imp) return { data: [] };

        const sheets = await this.prisma.spreadsheetSheet.findMany({
          where: { importId: imp.id },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            headerRow: true,
            colCount: true,
            rowCount: true,
            headers: true,
            headerRows: true,
          },
        });
        return { data: sheets };
      },
      () => getMockSpreadsheetSheets(),
    );
  }

  @Get('sheets/:name')
  @ApiOperation({ summary: 'Get sheet metadata by name' })
  async getSheet(@Param('name') name: string) {
    return runWithFallback(
      this.prisma,
      async () => {
        const imp = await this.prisma.spreadsheetImport.findFirst({
          orderBy: { importedAt: 'desc' },
        });
        if (!imp) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No import found' });

        const sheet = await this.prisma.spreadsheetSheet.findUnique({
          where: { importId_name: { importId: imp.id, name: decodeURIComponent(name) } },
        });
        if (!sheet) throw new NotFoundException({ code: 'NOT_FOUND', message: `Sheet "${name}" not found` });
        return sheet;
      },
      () => getMockSpreadsheetSheet(decodeURIComponent(name)),
    );
  }

  @Get('sheets/:name/rows')
  @ApiOperation({ summary: 'Get sheet rows with all columns (paginated)' })
  async getSheetRows(
    @Param('name') name: string,
    @Query() query: { page?: string; pageSize?: string; search?: string; includeEmpty?: string },
  ) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 100));
    const sheetName = decodeURIComponent(name);

    return runWithFallback(
      this.prisma,
      async () => {
        const imp = await this.prisma.spreadsheetImport.findFirst({
          orderBy: { importedAt: 'desc' },
        });
        if (!imp) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No import found' });

        const sheet = await this.prisma.spreadsheetSheet.findUnique({
          where: { importId_name: { importId: imp.id, name: sheetName } },
        });
        if (!sheet) throw new NotFoundException({ code: 'NOT_FOUND', message: `Sheet "${sheetName}" not found` });

        const skip = (page - 1) * pageSize;
        const where: Record<string, unknown> = { sheetId: sheet.id };
        if (query.includeEmpty !== 'true') where.isEmpty = false;

        const [rows, total] = await Promise.all([
          this.prisma.spreadsheetRow.findMany({
            where,
            skip,
            take: pageSize,
            orderBy: { rowNumber: 'asc' },
            select: {
              id: true,
              rowNumber: true,
              cells: true,
              data: true,
              isEmpty: true,
            },
          }),
          this.prisma.spreadsheetRow.count({ where }),
        ]);

        return {
          sheet: {
            id: sheet.id,
            name: sheet.name,
            headers: sheet.headers,
            headerRows: sheet.headerRows,
            headerRow: sheet.headerRow,
            colCount: sheet.colCount,
            rowCount: sheet.rowCount,
          },
          data: rows,
          meta: { page, pageSize, total },
        };
      },
      () => getMockSpreadsheetRows(page, pageSize, sheetName),
    );
  }
}
