// Package nomenclature — перенос backend/src/common/nomenclature.ts:
// нормализация имён, дубли, похожесть, подсказки (09 §7).
package nomenclature

import (
	"math"
	"regexp"
	"sort"
	"strings"
)

var lookalikes = map[rune]rune{
	'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
	'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x',
}

var (
	reDecimal = regexp.MustCompile(`(\d)\s*,\s*(\d)`)
	reDims    = regexp.MustCompile(`(\d)\s*[хx*×]\s*(\d)`)
	reSep     = regexp.MustCompile(`[^\p{L}\p{N}.×]+`)
	reSpaces  = regexp.MustCompile(`\s+`)
	reNumbers = regexp.MustCompile(`\d+(?:\.\d+)?`)
)

// NormalizeName — каноническое имя (09 §7.6).
func NormalizeName(raw string) string {
	if raw == "" {
		return ""
	}
	s := strings.ToLower(raw)
	s = reDecimal.ReplaceAllString(s, "$1.$2")
	s = reDims.ReplaceAllString(s, "$1×$2")
	var b strings.Builder
	for _, r := range s {
		if l, ok := lookalikes[r]; ok {
			b.WriteRune(l)
		} else {
			b.WriteRune(r)
		}
	}
	s = reSep.ReplaceAllString(b.String(), " ")
	// \.(?!\d) → ' ' — RE2 без lookahead, вручную
	rs := []rune(s)
	var out strings.Builder
	for i, r := range rs {
		if r == '.' && (i+1 >= len(rs) || rs[i+1] < '0' || rs[i+1] > '9') {
			out.WriteRune(' ')
		} else {
			out.WriteRune(r)
		}
	}
	return strings.TrimSpace(reSpaces.ReplaceAllString(out.String(), " "))
}

func DuplicateKey(raw string) string { return strings.ReplaceAll(NormalizeName(raw), " ", "") }

// NumbersOf — числа из имени, отсортированы как строки (JS default sort).
func NumbersOf(raw string) []string {
	n := reNumbers.FindAllString(NormalizeName(raw), -1)
	if n == nil {
		n = []string{}
	}
	sort.Strings(n)
	return n
}

func tokensOf(raw string) []string {
	var out []string
	for _, t := range strings.Split(NormalizeName(raw), " ") {
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}

// Similarity — похожесть имён 0..1; числа решают.
func Similarity(a, b string) float64 {
	ka, kb := DuplicateKey(a), DuplicateKey(b)
	if ka != "" && ka == kb {
		return 1
	}
	na, nb := NumbersOf(a), NumbersOf(b)
	numbersMatch := len(na) == len(nb)
	if numbersMatch {
		for i := range na {
			if na[i] != nb[i] {
				numbersMatch = false
				break
			}
		}
	}
	ta, tb := map[string]bool{}, map[string]bool{}
	for _, t := range tokensOf(a) {
		ta[t] = true
	}
	for _, t := range tokensOf(b) {
		tb[t] = true
	}
	if len(ta) == 0 || len(tb) == 0 {
		return 0
	}
	shared := 0
	for t := range ta {
		if tb[t] {
			shared++
		}
	}
	jaccard := float64(shared) / float64(len(ta)+len(tb)-shared)
	if numbersMatch {
		return jaccard
	}
	return math.Min(jaccard, 0.4) * 0.5
}

type NamedItem struct {
	ID      string
	Name    string
	Aliases []string
}

type MatchSuggestion struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Score      float64 `json:"score"`
	MatchedVia string  `json:"matchedVia"`
}

const SuggestThreshold = 0.55

func SuggestMatches(query string, items []NamedItem, limit int, threshold float64) []MatchSuggestion {
	scored := []MatchSuggestion{}
	for _, item := range items {
		cands := append([]string{item.Name}, item.Aliases...)
		best, via := 0.0, item.Name
		for _, c := range cands {
			if s := Similarity(query, c); s > best {
				best, via = s, c
			}
		}
		if best >= threshold {
			scored = append(scored, MatchSuggestion{ID: item.ID, Name: item.Name, Score: math.Round(best*100) / 100, MatchedVia: via})
		}
	}
	sort.SliceStable(scored, func(i, j int) bool { return scored[i].Score > scored[j].Score })
	if len(scored) > limit {
		scored = scored[:limit]
	}
	return scored
}

type DuplicateGroup struct {
	Key   string
	Items []NamedItem
}

func FindDuplicateGroups(items []NamedItem) []DuplicateGroup {
	byKey := map[string][]NamedItem{}
	var order []string
	for _, it := range items {
		k := DuplicateKey(it.Name)
		if k == "" {
			continue
		}
		if _, ok := byKey[k]; !ok {
			order = append(order, k)
		}
		byKey[k] = append(byKey[k], it)
	}
	var groups []DuplicateGroup
	for _, k := range order {
		if len(byKey[k]) > 1 {
			groups = append(groups, DuplicateGroup{Key: k, Items: byKey[k]})
		}
	}
	sort.SliceStable(groups, func(i, j int) bool { return len(groups[i].Items) > len(groups[j].Items) })
	if groups == nil {
		groups = []DuplicateGroup{}
	}
	return groups
}
