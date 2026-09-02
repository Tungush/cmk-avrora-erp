// Пакет misc — мелкие контроллеры: search, saved-views, audit-log,
// bom-items, price-reviews, min-stock-levels, production-plan-items,
// nomenclature, analytics.
package misc

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"cmk-avrora-erp/backend-go/internal/common"
)

func fail(c *gin.Context, err error) {
	common.DebugLog(err)
	common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
}

func dbUserID(userID string) *string {
	if userID == "" || strings.HasPrefix(userID, "usr-") {
		return nil
	}
	return &userID
}

func itoa(n int) string { return strconv.Itoa(n) }

func pageParams(c *gin.Context, def int) (int, int) {
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(c.Query("pageSize"))
	if size < 1 {
		size = def
	}
	return page, size
}

func mustJSON(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}

func parseJSDate(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}
