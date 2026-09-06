package nkt

import "strings"

// NormalizeGTIN — проверка штрихкода по правилам GS1 и приведение к
// хранимому виду.
//
// Возвращает нормализованный код и признак валидности. Невалидный штрихкод
// считается отсутствующим (ТЗ §10.2): подать заявку с чужой или битой
// цифрой хуже, чем без штрихкода вовсе — карточка уйдёт не тому товару.
//
// Допустимые длины — 8, 12, 13 и 14 цифр (EAN-8, UPC-A, EAN-13, ITF-14).
// Контрольная цифра считается по GS1: разряды справа налево от
// предпоследнего, чередование весов 3 и 1, дополнение суммы до десятка.
func NormalizeGTIN(raw string) (string, bool) {
	s := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		// Пробелы и дефисы из Excel-выгрузок отбрасываются, любой другой
		// символ делает штрихкод невалидным — он вернётся через проверку длины
		if r == ' ' || r == '-' || r == '\t' {
			return -1
		}
		return 'x'
	}, strings.TrimSpace(raw))

	if strings.ContainsRune(s, 'x') {
		return "", false
	}
	switch len(s) {
	case 8, 12, 13, 14:
	default:
		return "", false
	}

	sum := 0
	weight := 3
	for i := len(s) - 2; i >= 0; i-- {
		sum += int(s[i]-'0') * weight
		weight = 4 - weight // 3 → 1 → 3 …
	}
	check := (10 - sum%10) % 10
	if check != int(s[len(s)-1]-'0') {
		return "", false
	}
	return s, true
}
