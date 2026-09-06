package nkt

import "testing"

// Схема-образец: базовые атрибуты, обязательный расширенный и один
// справочный. Ровно та форма, в которой её отдаёт НКТ.
func testSchema() []SchemaAttr {
	return []SchemaAttr{
		{Code: "name_ru", Group: GroupBase, NameRu: "Наименование", DataType: "string", IsRequired: true, Order: 1},
		{Code: "brand", Group: GroupBase, NameRu: "Бренд", DataType: "string", IsRequired: true, Order: 2},
		{Code: "tnved", Group: GroupBase, NameRu: "ТН ВЭД", DataType: "string", Order: 3},
		{Code: "is_domestic", Group: GroupBase, NameRu: "Отечественный", DataType: "boolean", Order: 4},
		{Code: "net_weight", Group: GroupMainExt, NameRu: "Вес нетто", DataType: "number", IsRequired: true, MinValue: "0", Order: 1},
		{Code: "standards", Group: GroupMainExt, NameRu: "Стандарты", DataType: "string", Order: 2},
		{Code: "material", Group: GroupAdditionalExt, NameRu: "Материал", DataType: "dictionary",
			DictionaryCode: "MATERIALS", IsRequired: true, Order: 1},
	}
}

func fullPassport() Passport {
	return Passport{
		Oktru:  "25.99.29.900",
		NameRu: "Лоток кабельный ЦМК Л-200",
		Brand:  "ЦМК АВРОРА",
		Tnved:  "7326909807",
		Attributes: map[string]string{
			"is_domestic": "true",
			"net_weight":  "12.5",
			"standards":   "ГОСТ 52868-2007",
			"material":    "STEEL",
		},
	}
}

// Атрибут, переданный не в своей группе, роняет валидацию на стороне НКТ с
// указанием его кода — раскладка групп проверяется именно поэтому.
func TestBuildRequestSplitsGroups(t *testing.T) {
	body := BuildRequest(fullPassport(), testSchema(), false)

	if body.Oktru != "25.99.29.900" {
		t.Fatalf("ОКТРУ не попал в тело: %q", body.Oktru)
	}
	got := map[string]string{}
	for _, a := range body.Attributes {
		got[a.Code] = "base"
	}
	for _, a := range body.MainExtended {
		got[a.Code] = "main"
	}
	for _, a := range body.AdditionalExt {
		got[a.Code] = "additional"
	}
	want := map[string]string{
		"name_ru": "base", "brand": "base", "tnved": "base", "is_domestic": "base",
		"net_weight": "main", "standards": "main",
		"material": "additional",
	}
	for code, group := range want {
		if got[code] != group {
			t.Errorf("атрибут %s ушёл в группу %q, ожидалась %q", code, got[code], group)
		}
	}
}

// Пустое значение и отсутствие атрибута для НКТ не одно и то же.
func TestBuildRequestSkipsEmpty(t *testing.T) {
	p := fullPassport()
	p.Tnved = ""
	delete(p.Attributes, "standards")

	body := BuildRequest(p, testSchema(), false)
	for _, a := range append(body.Attributes, body.MainExtended...) {
		if a.Code == "tnved" || a.Code == "standards" {
			t.Errorf("пустой атрибут %s всё-таки ушёл в заявку", a.Code)
		}
	}
}

// Хэш держит цикл доработки: не поправив паспорт, повторно отправлять нечего.
func TestPayloadHashChangesWithContent(t *testing.T) {
	schema := testSchema()
	base := PayloadHash(BuildRequest(fullPassport(), schema, false))

	same := PayloadHash(BuildRequest(fullPassport(), schema, false))
	if base != same {
		t.Error("одно и то же тело дало разные хэши")
	}

	p := fullPassport()
	p.Attributes["net_weight"] = "12.6"
	if PayloadHash(BuildRequest(p, schema, false)) == base {
		t.Error("правка веса не изменила хэш — цикл доработки зациклится")
	}
}

func TestValidate(t *testing.T) {
	schema := testSchema()
	dictOK := func(code, value string) bool { return code == "MATERIALS" && value == "STEEL" }

	if issues := Validate(fullPassport(), schema, dictOK); len(issues) != 0 {
		t.Errorf("полный паспорт признан невалидным: %+v", issues)
	}

	t.Run("без ОКТРУ дальше не идём", func(t *testing.T) {
		p := fullPassport()
		p.Oktru = ""
		issues := Validate(p, schema, dictOK)
		if len(issues) != 1 || issues[0].Code != "oktru" {
			t.Errorf("ожидалась одна претензия по ОКТРУ, получено %+v", issues)
		}
	})

	t.Run("обязательный расширенный атрибут", func(t *testing.T) {
		p := fullPassport()
		delete(p.Attributes, "net_weight")
		issues := Validate(p, schema, dictOK)
		if len(issues) != 1 || issues[0].Code != "net_weight" {
			t.Errorf("незаполненный вес не пойман: %+v", issues)
		}
	})

	t.Run("число вместо текста", func(t *testing.T) {
		p := fullPassport()
		p.Attributes["net_weight"] = "двенадцать"
		issues := Validate(p, schema, dictOK)
		if len(issues) != 1 || issues[0].Code != "net_weight" {
			t.Errorf("нечисловой вес не пойман: %+v", issues)
		}
	})

	t.Run("значения нет в справочнике НКТ", func(t *testing.T) {
		p := fullPassport()
		p.Attributes["material"] = "ДЕРЕВО"
		issues := Validate(p, schema, dictOK)
		if len(issues) != 1 || issues[0].Code != "material" {
			t.Errorf("чужое справочное значение не поймано: %+v", issues)
		}
	})

	t.Run("справочник ещё не выгружен — не выдумываем отказ", func(t *testing.T) {
		p := fullPassport()
		p.Attributes["material"] = "ЧТО УГОДНО"
		// nil-lookup означает «сравнивать не с чем»
		if issues := Validate(p, schema, nil); len(issues) != 0 {
			t.Errorf("без кэша справочника выдуман отказ: %+v", issues)
		}
	})

	t.Run("multiDictionary разбирается по @", func(t *testing.T) {
		s := append(testSchema(), SchemaAttr{
			Code: "colors", Group: GroupAdditionalExt, NameRu: "Цвета",
			DataType: "multiDictionary", DictionaryCode: "COLORS",
		})
		known := func(code, value string) bool {
			return (code == "MATERIALS" && value == "STEEL") ||
				(code == "COLORS" && (value == "RAL7035" || value == "RAL9005"))
		}
		p := fullPassport()
		p.Attributes["colors"] = "RAL7035@RAL9005"
		if issues := Validate(p, s, known); len(issues) != 0 {
			t.Errorf("верные значения multiDictionary отвергнуты: %+v", issues)
		}
		p.Attributes["colors"] = "RAL7035@RAL0000"
		if issues := Validate(p, s, known); len(issues) != 1 {
			t.Errorf("неверное значение в списке не поймано: %+v", issues)
		}
	})

	t.Run("схема не выгружена", func(t *testing.T) {
		issues := Validate(fullPassport(), nil, dictOK)
		if len(issues) != 1 || issues[0].Code != "schema" {
			t.Errorf("пустая схема не отмечена: %+v", issues)
		}
	})
}
