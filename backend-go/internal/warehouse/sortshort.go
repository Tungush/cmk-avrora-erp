package warehouse

import "sort"

func sortShortages(s []Shortage) {
	sort.SliceStable(s, func(i, j int) bool { return s[i].Shortage*s[i].EstimatedPrice > s[j].Shortage*s[j].EstimatedPrice })
}
