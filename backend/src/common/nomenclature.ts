/**
 * Имена номенклатуры: нормализация, поиск дублей и алиасы
 * (09_COSTING_AND_STAGES.md §7).
 *
 * Через два месяца сотрудник не помнит, как номенклатуру назвали в 1С, —
 * и это нормально. Поэтому память человека не должна быть частью механизма:
 * материал обязан находиться по тем словам, которыми его назвал он сам.
 */

export type AliasSourceValue =
  | 'REQUEST'      // формулировка из заявки — живёт вечно
  | 'ONEC'         // имя из 1С
  | 'EXCEL'        // как называлось в исходной книге
  | 'SUPPLIER'
  | 'SEARCH_MISS'  // запрос, который не нашёлся, но привёл к материалу
  | 'MANUAL';

/** Кириллические и латинские близнецы: «Ст3» и «Cт3» для человека одно и то же */
const LOOKALIKES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o',
  р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
};

/**
 * Каноническое имя (09 §7.6).
 *
 * Числа нормализуются отдельно от текста, и это не придирка: наивная
 * нормализация «убрать всё, кроме букв и цифр» превращает «5х2,5» в «5х25»
 * и предлагает слить два разных кабеля. В базе такой ложный дубль есть.
 */
export function normalizeName(raw: string): string {
  if (!raw) return '';
  let s = raw.toLowerCase();

  // Десятичный разделитель сохраняется: 2,5 → 2.5, но «шт, 10» не склеивается
  s = s.replace(/(\d)\s*,\s*(\d)/g, '$1.$2');
  // Размерности к одному виду: 50х50, 50x50, 50*50, 50 × 50 → 50×50
  s = s.replace(/(\d)\s*[хx*×]\s*(\d)/g, '$1×$2');
  // Близнецы кириллицы и латиницы — к одной форме
  s = s.replace(/[авекмнорстух]/g, (c) => LOOKALIKES[c] ?? c);
  // Всё прочее — разделитель слов. Точка и × остаются: они внутри чисел
  s = s.replace(/[^\p{L}\p{N}.×]+/gu, ' ');
  // Точка на конце слова — пунктуация, а не дробная часть
  s = s.replace(/\.(?!\d)/g, ' ');

  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Ключ для поиска дублей: то же самое, но без пробелов.
 *
 * Ловит «ВВГ нг LS» против «ВВГнг-LS» — это один кабель, записанный
 * двумя людьми. И при этом не склеивает 5×2.5 с 5×25, потому что
 * разделитель дробной части уже сохранён.
 */
export function duplicateKey(raw: string): string {
  return normalizeName(raw).replace(/\s+/g, '');
}

/** Числа из имени: для металла именно они отличают материал от материала */
export function numbersOf(raw: string): string[] {
  const normalized = normalizeName(raw);
  return (normalized.match(/\d+(?:\.\d+)?/g) ?? []).sort();
}

const tokensOf = (raw: string) => normalizeName(raw).split(' ').filter(Boolean);

/**
 * Похожесть имён от 0 до 1.
 *
 * Числа решают: «уголок 50×50» и «уголок 90×90» состоят из одних слов,
 * но это разные материалы, и подсказывать одно вместо другого опаснее,
 * чем не подсказать ничего.
 */
export function similarity(a: string, b: string): number {
  const ka = duplicateKey(a);
  const kb = duplicateKey(b);
  if (ka && ka === kb) return 1;

  const na = numbersOf(a);
  const nb = numbersOf(b);
  const numbersMatch = na.length === nb.length && na.every((v, i) => v === nb[i]);

  const ta = new Set(tokensOf(a));
  const tb = new Set(tokensOf(b));
  if (ta.size === 0 || tb.size === 0) return 0;

  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const jaccard = shared / (ta.size + tb.size - shared);

  // Разные числа — потолок ниже порога подсказки: пусть лучше человек
  // заведёт заявку, чем возьмёт похожий по словам, но чужой материал
  return numbersMatch ? jaccard : Math.min(jaccard, 0.4) * 0.5;
}

export interface NamedItem {
  id: string;
  name: string;
  /** Все известные имена: из заявки, из 1С, из Excel, от поставщика */
  aliases?: string[];
}

export interface MatchSuggestion {
  id: string;
  name: string;
  score: number;
  matchedVia: string;
}

/** Порог, ниже которого подсказка молчит */
export const SUGGEST_THRESHOLD = 0.55;

/**
 * Подсказка «похоже, это уже есть» перед созданием заявки (09 §7.3).
 * Ищет по всем именам сразу — в том числе по тем, которыми материал
 * назвал кто-то другой полгода назад.
 */
export function suggestMatches(
  query: string,
  items: NamedItem[],
  limit = 5,
  threshold = SUGGEST_THRESHOLD,
): MatchSuggestion[] {
  const scored: MatchSuggestion[] = [];
  for (const item of items) {
    const candidates = [item.name, ...(item.aliases ?? [])];
    let best = 0;
    let via = item.name;
    for (const c of candidates) {
      const s = similarity(query, c);
      if (s > best) { best = s; via = c; }
    }
    if (best >= threshold) scored.push({ id: item.id, name: item.name, score: Math.round(best * 100) / 100, matchedVia: via });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface DuplicateGroup {
  key: string;
  items: NamedItem[];
}

/**
 * Группы дублей для регулярного отчёта (09 §7.5). На текущем справочнике
 * находит 79 групп — работа разовая, но без неё они копятся дальше.
 */
export function findDuplicateGroups(items: NamedItem[]): DuplicateGroup[] {
  const byKey = new Map<string, NamedItem[]>();
  for (const item of items) {
    const key = duplicateKey(item.name);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, items: group }))
    .sort((a, b) => b.items.length - a.items.length);
}
