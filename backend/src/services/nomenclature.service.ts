import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { runWithFallback } from '../common/fallback';
import {
  normalizeName, duplicateKey, suggestMatches, findDuplicateGroups,
  MatchSuggestion, AliasSourceValue,
} from '../common/nomenclature';

/** Сколько дней заявка может ждать код из 1С, прежде чем подсветится */
export const DEFAULT_NOMENCLATURE_SLA_DAYS = 5;

/**
 * Три контура защиты имён номенклатуры (09 §7):
 * не дать создать дубль → дать найти без знания имени 1С → поймать проскочившее.
 *
 * Опорный факт: в справочнике уже 82 группы дублей, а заявок на номенклатуру
 * всего две. Значит процессом заведения не пользуются, и одним поиском
 * проблему не закрыть — нужны все три контура сразу.
 */
@Injectable()
export class NomenclatureService {
  constructor(private readonly prisma: PrismaService) {}

  /** Контур 1: похожее уже есть? Ищет по всем именам, включая чужие формулировки */
  async suggest(query: string, limit = 5): Promise<MatchSuggestion[]> {
    if (!query?.trim()) return [];
    return runWithFallback(
      this.prisma,
      async () => {
        const materials = await this.prisma.material.findMany({
          select: { id: true, name: true, aliases: { select: { alias: true } } },
        });
        return suggestMatches(
          query,
          materials.map((m) => ({ id: m.id, name: m.name, aliases: m.aliases.map((a) => a.alias) })),
          limit,
        );
      },
      () => [],
    );
  }

  /**
   * Контур 2: поиск с логированием промахов. Запрос, не давший результата,
   * запоминается — если человек через минуту откроет нужный материал,
   * его слова станут алиасом.
   */
  async search(query: string, userId?: string) {
    const suggestions = await this.suggest(query, 10);
    if (suggestions.length === 0 && query?.trim()) {
      await runWithFallback(
        this.prisma,
        () => this.prisma.searchMiss.create({
          data: {
            query: query.trim(),
            normalized: normalizeName(query),
            userId: userId && !userId.startsWith('usr-') ? userId : null,
          },
        }),
        () => null,
      );
    }
    return { query, suggestions, total: suggestions.length };
  }

  /**
   * Промах привёл к материалу — его слова становятся именем.
   * Так справочник учится на неудачных поисках, а не ждёт идеальных имён.
   */
  async resolveMiss(missId: string, materialId: string, userId?: string) {
    const miss = await this.prisma.searchMiss.findUnique({ where: { id: missId } });
    if (!miss) throw new NotFoundException({ code: 'NOT_FOUND', message: `Запрос ${missId} не найден` });

    await this.prisma.searchMiss.update({
      where: { id: missId },
      data: { resolvedMaterialId: materialId, resolvedAt: new Date() },
    });
    return this.addAlias(materialId, miss.query, 'SEARCH_MISS', userId);
  }

  /** Алиас идемпотентен: повторное добавление того же имени ничего не ломает */
  async addAlias(materialId: string, alias: string, source: AliasSourceValue = 'MANUAL', userId?: string) {
    const trimmed = alias?.trim();
    if (!trimmed) {
      throw new BadRequestException({ code: 'EMPTY_ALIAS', message: 'Пустое имя добавить нельзя' });
    }
    const normalized = normalizeName(trimmed);
    const existing = await this.prisma.materialAlias.findFirst({
      where: { materialId, normalized },
    });
    if (existing) return existing;

    return this.prisma.materialAlias.create({
      data: {
        materialId,
        alias: trimmed,
        normalized,
        source: source as any,
        createdById: userId && !userId.startsWith('usr-') ? userId : null,
      },
    });
  }

  /** Все имена материала: своё, из 1С, из заявок, от поставщиков */
  async namesOf(materialId: string) {
    const material = await this.prisma.material.findUnique({
      where: { id: materialId },
      include: { aliases: { orderBy: { createdAt: 'asc' } } },
    });
    if (!material) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Материал ${materialId} не найден` });
    }
    return {
      id: material.id,
      materialCode: material.materialCode,
      name: material.name,
      aliases: material.aliases.map((a) => ({
        alias: a.alias,
        source: a.source,
        validFrom: a.validFrom,
        validTo: a.validTo,
        current: a.validTo == null,
      })),
    };
  }

  /**
   * Переименование в 1С: новое имя становится основным, старое уходит в
   * алиасы с датами. Ни поиск, ни старые калькуляции от этого не ломаются.
   */
  async applyOnecRename(materialId: string, newName: string, userId?: string) {
    const material = await this.prisma.material.findUnique({ where: { id: materialId } });
    if (!material) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Материал ${materialId} не найден` });
    }
    if (normalizeName(material.name) === normalizeName(newName)) return material;

    return this.prisma.$transaction(async (tx) => {
      const normalized = normalizeName(material.name);
      const existing = await tx.materialAlias.findFirst({ where: { materialId, normalized } });
      if (existing) {
        await tx.materialAlias.update({ where: { id: existing.id }, data: { validTo: new Date() } });
      } else {
        await tx.materialAlias.create({
          data: {
            materialId,
            alias: material.name,
            normalized,
            source: 'ONEC',
            validTo: new Date(),
            createdById: userId && !userId.startsWith('usr-') ? userId : null,
          },
        });
      }
      return tx.material.update({ where: { id: materialId }, data: { name: newName } });
    });
  }

  /** Контур 3: регулярный отчёт о дублях — сегодня их 82 группы */
  async duplicateReport() {
    return runWithFallback(
      this.prisma,
      async () => {
        const materials = await this.prisma.material.findMany({
          select: { id: true, name: true, materialCode: true, unit: true, stockQty: true },
        });
        const groups = findDuplicateGroups(materials as any);
        return {
          groups: groups.map((g) => ({
            key: g.key,
            items: g.items.map((i: any) => ({
              id: i.id, name: i.name, materialCode: i.materialCode,
              unit: i.unit, stockQty: Number(i.stockQty ?? 0),
            })),
          })),
          groupCount: groups.length,
          itemCount: groups.reduce((s, g) => s + g.items.length, 0),
        };
      },
      () => ({ groups: [], groupCount: 0, itemCount: 0 }),
    );
  }

  /**
   * Ответ 1С по заявке: имя и код прилетают сами и закрывают заявку.
   * Формулировка автора при этом сохраняется алиасом — искать через месяц
   * он будет именно своими словами.
   */
  async applyOnecResponse(requestId: string, response: {
    onecCode: string;
    onecName: string;
    onecGuid?: string;
    onecUnit?: string;
    linkedMaterialId?: string;
  }) {
    const request = await this.prisma.nomenclatureRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `Заявка ${requestId} не найдена` });
    }

    const updated = await this.prisma.nomenclatureRequest.update({
      where: { id: requestId },
      data: {
        onecCode: response.onecCode,
        onecName: response.onecName,
        onecGuid: response.onecGuid ?? null,
        onecUnit: response.onecUnit ?? null,
        linkedMaterialId: response.linkedMaterialId ?? null,
        syncedAt: new Date(),
        status: 'SYNCED',
      },
    });

    if (response.linkedMaterialId) {
      await this.addAlias(response.linkedMaterialId, request.proposedName, 'REQUEST');
      if (response.onecName) {
        await this.addAlias(response.linkedMaterialId, response.onecName, 'ONEC');
      }
    }
    return updated;
  }

  /** Заявки, зависшие в ожидании кода из 1С — иначе они тихо теряются */
  async stalledRequests(now = new Date()) {
    return runWithFallback(
      this.prisma,
      async () => {
        const rows = await this.prisma.nomenclatureRequest.findMany({
          where: { status: { in: ['APPROVED', 'WAITING_1C'] } },
          orderBy: { createdAt: 'asc' },
        });
        return rows
          .filter((r) => !r.slaDueAt || r.slaDueAt <= now)
          .map((r) => ({
            id: r.id,
            proposedName: r.proposedName,
            requestedBy: r.requestedBy,
            createdAt: r.createdAt,
            slaDueAt: r.slaDueAt,
            waitingDays: Math.floor((now.getTime() - new Date(r.createdAt).getTime()) / 86_400_000),
          }));
      },
      () => [],
    );
  }

  /** Ключ для сверки — тот же, что в отчёте о дублях */
  duplicateKeyOf(name: string) {
    return duplicateKey(name);
  }
}
