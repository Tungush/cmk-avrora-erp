package common

import (
	"math"
	"strconv"
	"strings"
)

// FmtRu — n.toLocaleString('ru-RU'): U+00A0 группами по три, запятая, до 3 знаков.
func FmtRu(n float64) string {
	neg := n < 0
	a := math.Round(math.Abs(n)*1000) / 1000
	s := strconv.FormatFloat(a, 'f', -1, 64)
	intPart, frac := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart, frac = s[:i], s[i+1:]
	}
	var b strings.Builder
	for i, ch := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteString(" ")
		}
		b.WriteRune(ch)
	}
	out := b.String()
	if frac != "" {
		out += "," + frac
	}
	if neg {
		out = "-" + out
	}
	return out
}

// JsRound — Math.round: половинки к +∞.
func JsRound(x float64) float64 { return math.Floor(x + 0.5) }
