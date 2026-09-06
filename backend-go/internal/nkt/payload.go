package nkt

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Группы атрибутов в теле заявки — значения перечисления NktAttrGroup.
const (
	GroupBase          = "BASE"
	GroupMainExt       = "MAIN_EXT"
	GroupAdditionalExt = "ADDITIONAL_EXT"
)

// SchemaAttr — атрибут из кэша схемы НКТ (таблица nkt_attributes).
type SchemaAttr struct {
	Code           string `json:"code"`
	Group          string `json:"group"`
	NameRu         string `json:"nameRu"`
	NameKk         string `json:"nameKk"`
	DescriptionRu  string `json:"descriptionRu"`
	DataType       string `json:"dataType"`
	IsRequired     bool   `json:"isRequired"`
	DictionaryCode string `json:"dictionaryCode"`
	Pattern        string `json:"pattern"`
	MaxLength      int    `json:"maxLength"`
	MinValue       string `json:"minValue"`
	MaxValue       string `json:"maxValue"`
	Order          int    `json:"order"`
}

// Passport — то, что заводит инженер: часть полей вынесена в колонки
// (по ним идёт отбор и поиск на экранах), остальное — пары «код → значение».
type Passport struct {
	Oktru      string            `json:"oktru"`
	Tnved      string            `json:"tnved"`
	Gtin       string            `json:"gtin"`
	NameRu     string            `json:"nameRu"`
	NameKk     string            `json:"nameKk"`
	Brand      string            `json:"brand"`
	Attributes map[string]string `json:"attributes"`
	Images     []ImageRef        `json:"images"`
}

// Коды атрибутов НКТ, которым соответствуют отдельные колонки карточки.
// Список нужен ровно для того, чтобы значение колонки попало в тело заявки
// под своим кодом; сами атрибуты всё равно берутся из схемы НКТ, и если
// какого-то из них в схеме нет — он в заявку не уйдёт.
const (
	attrNameRu = "name_ru"
	attrNameKk = "name_kk"
	attrBrand  = "brand"
	attrTnved  = "tnved"
	attrGtin   = "gtin"
)

// value — значение атрибута: сначала колонка, потом общая карта.
func (p Passport) value(code string) string {
	switch code {
	case attrNameRu:
		if p.NameRu != "" {
			return p.NameRu
		}
	case attrNameKk:
		if p.NameKk != "" {
			return p.NameKk
		}
	case attrBrand:
		if p.Brand != "" {
			return p.Brand
		}
	case attrTnved:
		if p.Tnved != "" {
			return p.Tnved
		}
	case attrGtin:
		if p.Gtin != "" {
			return p.Gtin
		}
	}
	return strings.TrimSpace(p.Attributes[code])
}

// BuildRequest — тело заявки по паспорту и схеме категории.
//
// Атрибуты раскладываются по группам так, как их задала схема: НКТ роняет
// валидацию, если атрибут пришёл не в своей группе, и мы не вправе решать
// это за них. Пустые значения не передаются вовсе — отсутствие атрибута
// и пустая строка для НКТ не одно и то же.
func BuildRequest(p Passport, schema []SchemaAttr, autoPublication bool) RequestBody {
	body := RequestBody{
		Oktru:           p.Oktru,
		AutoPublication: autoPublication,
		Attributes:      []AttributeValue{},
		ImageFiles:      p.Images,
	}

	ordered := append([]SchemaAttr(nil), schema...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].Order != ordered[j].Order {
			return ordered[i].Order < ordered[j].Order
		}
		return ordered[i].Code < ordered[j].Code
	})

	for _, a := range ordered {
		v := p.value(a.Code)
		if v == "" {
			continue
		}
		av := AttributeValue{Code: a.Code, Value: v}
		switch a.Group {
		case GroupMainExt:
			body.MainExtended = append(body.MainExtended, av)
		case GroupAdditionalExt:
			body.AdditionalExt = append(body.AdditionalExt, av)
		default:
			body.Attributes = append(body.Attributes, av)
		}
	}
	return body
}

// PayloadHash — SHA-256 тела заявки. По нему цикл доработки понимает, что
// менеджер нажал «отправить повторно», ничего не поправив: гонять модератору
// то же самое тело незачем.
func PayloadHash(body RequestBody) string {
	b, err := json.Marshal(body)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ValidationIssue — одна причина, по которой заявку нельзя отправлять.
type ValidationIssue struct {
	Code    string `json:"code"`
	Name    string `json:"name"`
	Message string `json:"message"`
}

// DictLookup — есть ли такое значение в кэше справочника НКТ.
type DictLookup func(dictionaryCode, value string) bool

// Validate — локальная проверка паспорта по схеме до отправки (ТЗ §12.3).
//
// Заведомо невалидная заявка в НКТ не уходит: у них полная валидация
// выполняется только на шаге модерации, и каждая такая попытка стоит цикла
// модерации, а не мгновенного отказа.
func Validate(p Passport, schema []SchemaAttr, dictOK DictLookup) []ValidationIssue {
	var issues []ValidationIssue

	if strings.TrimSpace(p.Oktru) == "" {
		issues = append(issues, ValidationIssue{
			Code: "oktru", Name: "Код категории ОКТРУ",
			Message: "не задан: без категории неизвестен набор обязательных характеристик",
		})
		// Без ОКТРУ схема пуста, дальше проверять нечего
		return issues
	}
	if len(schema) == 0 {
		issues = append(issues, ValidationIssue{
			Code: "schema", Name: "Схема категории",
			Message: "не выгружена из НКТ: запустите синхронизацию схемы",
		})
		return issues
	}

	for _, a := range schema {
		v := p.value(a.Code)

		if v == "" {
			if a.IsRequired {
				issues = append(issues, ValidationIssue{
					Code: a.Code, Name: a.NameRu, Message: "обязательная характеристика не заполнена",
				})
			}
			continue
		}
		if msg := checkValue(a, v, dictOK); msg != "" {
			issues = append(issues, ValidationIssue{Code: a.Code, Name: a.NameRu, Message: msg})
		}
	}
	return issues
}

func checkValue(a SchemaAttr, v string, dictOK DictLookup) string {
	if a.MaxLength > 0 && len([]rune(v)) > a.MaxLength {
		return fmt.Sprintf("длиннее %d символов", a.MaxLength)
	}
	if a.Pattern != "" {
		// Битое выражение на стороне НКТ не должно останавливать заявку:
		// проверку выполнят они сами, а мы не выдумываем отказ
		if re, err := regexp.Compile(a.Pattern); err == nil && !re.MatchString(v) {
			return "значение не соответствует формату " + a.Pattern
		}
	}

	switch a.DataType {
	case "number":
		n, err := strconv.ParseFloat(strings.ReplaceAll(v, ",", "."), 64)
		if err != nil {
			return "ожидается число"
		}
		if a.MinValue != "" {
			if min, err := strconv.ParseFloat(a.MinValue, 64); err == nil && n < min {
				return "меньше допустимого " + a.MinValue
			}
		}
		if a.MaxValue != "" {
			if max, err := strconv.ParseFloat(a.MaxValue, 64); err == nil && n > max {
				return "больше допустимого " + a.MaxValue
			}
		}
	case "boolean":
		if v != "true" && v != "false" {
			return "ожидается true или false"
		}
	case "dictionary", "multiDictionary":
		if a.DictionaryCode == "" || dictOK == nil {
			return ""
		}
		// У multiDictionary несколько значений передаются одной строкой
		// через «@» — каждое проверяется отдельно
		for _, part := range strings.Split(v, "@") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if !dictOK(a.DictionaryCode, part) {
				return "значения «" + part + "» нет в справочнике " + a.DictionaryCode
			}
		}
	}
	return ""
}
