import {
  normalizeName, duplicateKey, numbersOf, similarity, suggestMatches,
  findDuplicateGroups, SUGGEST_THRESHOLD,
} from '../src/common/nomenclature';

describe('Нормализация имён (09 §7.6)', () => {
  it('регистр и пунктуация не различают материалы', () => {
    expect(normalizeName('Уголок 50Х50, ст3')).toBe(normalizeName('уголок 50x50 Ст3'));
  });

  it('размерности приводятся к одному виду', () => {
    const forms = ['50х50', '50x50', '50*50', '50 × 50'];
    const keys = forms.map(duplicateKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('дробная часть сохраняется: 5х2,5 и 5х25 — разные кабели', () => {
    expect(duplicateKey('Кабель ВВГнг-LS 5х2,5'))
      .not.toBe(duplicateKey('Кабель ВВГнг-LS 5х25'));
  });

  it('пробелы внутри марки не мешают: «ВВГ нг LS» и «ВВГнг-LS» — одно и то же', () => {
    expect(duplicateKey('Кабель ВВГ нг LS 5х4'))
      .toBe(duplicateKey('Кабель ВВГнг-LS 5х4'));
  });

  it('кириллические и латинские близнецы совпадают', () => {
    expect(duplicateKey('Ст3')).toBe(duplicateKey('Cт3'));
  });

  it('точка как пунктуация не превращается в дробную часть', () => {
    expect(normalizeName('Труба проф. 80')).toBe(normalizeName('Труба проф 80'));
  });

  it('числа извлекаются вместе с дробной частью', () => {
    expect(numbersOf('Кабель 5х2,5')).toEqual(['2.5', '5']);
    expect(numbersOf('Лист 1500х6000х20мм')).toEqual(['1500', '20', '6000']);
  });

  it('пустое имя не ломает нормализацию', () => {
    expect(normalizeName('')).toBe('');
    expect(duplicateKey('   ')).toBe('');
  });
});

describe('Похожесть: числа решают', () => {
  it('совпадение по всем именам — единица', () => {
    expect(similarity('Уголок 50х50х5', 'уголок 50X50X5')).toBe(1);
  });

  it('разные размеры не считаются похожими, даже если слова те же', () => {
    expect(similarity('Уголок 50х50х5', 'Уголок 90х90х6')).toBeLessThan(SUGGEST_THRESHOLD);
  });

  it('разные слова при тех же числах — всё ещё кандидат', () => {
    const s = similarity('Уголок 50х50х5 ст3', 'Уголок равнополочный 50х50х5 ГОСТ 8509-93');
    expect(s).toBeGreaterThan(0);
  });

  it('пустой запрос ни на что не похож', () => {
    expect(similarity('', 'Уголок 50х50')).toBe(0);
  });
});

describe('Подсказка «похоже, это уже есть» (09 §7.3)', () => {
  const CATALOG = [
    {
      id: 'уголок',
      name: 'Уголок равнополочный 50×50×5 ГОСТ 8509-93',
      aliases: ['Уголок 50х50 ст3'],
    },
    { id: 'уголок-90', name: 'Уголок равнополочный 90×90×6 ГОСТ 8509-93' },
    { id: 'лист', name: 'Лист г/к 1500х6000х20мм' },
  ];

  it('находит по формулировке из заявки, а не по имени 1С', () => {
    const r = suggestMatches('уголок 50х50 ст3', CATALOG);
    expect(r[0].id).toBe('уголок');
    expect(r[0].matchedVia).toBe('Уголок 50х50 ст3');
  });

  it('слова заявки живут вечно: через месяц находится тем же запросом', () => {
    expect(suggestMatches('Уголок 50Х50 Ст3', CATALOG)[0].id).toBe('уголок');
  });

  it('не подсказывает чужой размер вместо нужного', () => {
    const r = suggestMatches('уголок 50х50 ст3', CATALOG);
    expect(r.map((x) => x.id)).not.toContain('уголок-90');
  });

  it('незнакомый материал не подсказывается наугад', () => {
    expect(suggestMatches('Швеллер 20П', CATALOG)).toEqual([]);
  });

  it('результаты отсортированы по убыванию похожести', () => {
    const r = suggestMatches('уголок равнополочный', [
      ...CATALOG,
      { id: 'точный', name: 'Уголок равнополочный' },
    ]);
    expect(r[0].id).toBe('точный');
    expect(r.map((x) => x.score)).toEqual([...r.map((x) => x.score)].sort((a, b) => b - a));
  });
});

describe('Отчёт о дублях (09 §7.5)', () => {
  it('находит буквальные дубли справочника', () => {
    const groups = findDuplicateGroups([
      { id: '1', name: 'Круг ф 12 мм' },
      { id: '2', name: 'Круг ф 12 мм' },
      { id: '3', name: 'Уголок 90х90х6 мм' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(['1', '2']);
  });

  it('находит дубли, различающиеся пробелами и дефисами', () => {
    const groups = findDuplicateGroups([
      { id: '1', name: 'Кабель ВВГнг-LS 5х4' },
      { id: '2', name: 'Кабель ВВГ нг LS 5х4' },
    ]);
    expect(groups).toHaveLength(1);
  });

  it('НЕ склеивает 5х2,5 и 5х25 — это ложный дубль наивной нормализации', () => {
    const groups = findDuplicateGroups([
      { id: '1', name: 'Кабель ВВГнг-LS 5х2,5' },
      { id: '2', name: 'Кабель ВВГнг-LS 5х25' },
    ]);
    expect(groups).toEqual([]);
  });

  it('группы отсортированы по размеру — сначала самое болезненное', () => {
    const groups = findDuplicateGroups([
      { id: '1', name: 'Коронка ЗУБР' }, { id: '2', name: 'Коронка ЗУБР' }, { id: '3', name: 'Коронка ЗУБР' },
      { id: '4', name: 'Круг ф 12' }, { id: '5', name: 'Круг ф 12' },
    ]);
    expect(groups[0].items).toHaveLength(3);
  });
});
