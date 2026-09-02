package misc

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
)

type CatalogMiscHandler struct{ pool *pgxpool.Pool }

func NewCatalogMiscHandler(pool *pgxpool.Pool) *CatalogMiscHandler {
	return &CatalogMiscHandler{pool: pool}
}

// --- price reviews ---

const reviewCols = "r.id, r.article_id, r.calculated_price, r.approved_price, r.deviation_pct, r.reason, r.status, r.requested_by_id, r.created_at, r.decided_by_id, r.decided_at, r.new_price, r.decision_comment"

type reviewRaw struct {
	ID              string           `json:"id"`
	ArticleID       string           `json:"articleId"`
	CalculatedPrice decimal.Decimal  `json:"calculatedPrice"`
	ApprovedPrice   decimal.Decimal  `json:"approvedPrice"`
	DeviationPct    decimal.Decimal  `json:"deviationPct"`
	Reason          *string          `json:"reason"`
	Status          string           `json:"status"`
	RequestedByID   *string          `json:"requestedById"`
	CreatedAt       common.PDate     `json:"createdAt"`
	DecidedByID     *string          `json:"decidedById"`
	DecidedAt       common.PDate     `json:"decidedAt"`
	NewPrice        *decimal.Decimal `json:"newPrice"`
	DecisionComment *string          `json:"decisionComment"`
	Article         gin.H            `json:"article"`
}

func scanReview(row pgx.Row, withPrices bool) (reviewRaw, error) {
	var r reviewRaw
	var code, name string
	var spec, approved decimal.Decimal
	var err error
	if withPrices {
		err = row.Scan(&r.ID, &r.ArticleID, &r.CalculatedPrice, &r.ApprovedPrice, &r.DeviationPct, &r.Reason, &r.Status, &r.RequestedByID, &r.CreatedAt, &r.DecidedByID, &r.DecidedAt, &r.NewPrice, &r.DecisionComment, &code, &name, &spec, &approved)
		r.Article = gin.H{"articleCode": code, "name": name, "specPrice": spec, "approvedPrice": approved}
	} else {
		err = row.Scan(&r.ID, &r.ArticleID, &r.CalculatedPrice, &r.ApprovedPrice, &r.DeviationPct, &r.Reason, &r.Status, &r.RequestedByID, &r.CreatedAt, &r.DecidedByID, &r.DecidedAt, &r.NewPrice, &r.DecisionComment, &code, &name)
		r.Article = gin.H{"articleCode": code, "name": name}
	}
	return r, err
}

func priceDeviationPct(approved, calculated float64) float64 {
	if calculated <= 0 {
		return 0
	}
	return round2(((approved - calculated) / calculated) * 100)
}

func round2(n float64) float64 { return float64(int64(n*100+copysign(0.5, n))) / 100 }
func copysign(a, b float64) float64 {
	if b < 0 {
		return -a
	}
	return a
}

// PriceReviewRequest — POST /articles/:id/price-review
func (h *CatalogMiscHandler) PriceReviewRequest(c *gin.Context) {
	articleID := c.Param("id")
	var body struct {
		Reason *string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&body)
	ctx := c.Request.Context()
	var code string
	var spec, approved float64
	if err := h.pool.QueryRow(ctx, "SELECT article_code, spec_price, approved_price FROM articles WHERE id = $1", articleID).Scan(&code, &spec, &approved); err == pgx.ErrNoRows {
		common.NotFound(c, "Article "+articleID+" not found")
		return
	} else if err != nil {
		fail(c, err)
		return
	}
	var pending string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM price_review_requests WHERE article_id = $1 AND status = 'PENDING' LIMIT 1", articleID).Scan(&pending); err == nil {
		common.Conflict(c, "REVIEW_ALREADY_PENDING", "Заявка на пересмотр цены "+code+" уже на рассмотрении")
		return
	} else if err != pgx.ErrNoRows {
		fail(c, err)
		return
	}
	user := authpkg.CurrentUser(c)
	r, err := scanReview(h.pool.QueryRow(ctx, `WITH ins AS (INSERT INTO price_review_requests (id, article_id, calculated_price, approved_price, deviation_pct, reason, requested_by_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *) SELECT `+strings.ReplaceAll(reviewCols, "r.", "ins.")+`, a.article_code, a.name FROM ins JOIN articles a ON a.id = ins.article_id`,
		uuid.NewString(), articleID, spec, approved, priceDeviationPct(approved, spec), body.Reason, dbUserID(user.UserID)), false)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, r)
}

// PriceReviewsList — GET /price-reviews?status=&page=&pageSize=
func (h *CatalogMiscHandler) PriceReviewsList(c *gin.Context) {
	page, size := pageParams(c, 25)
	where, args := "WHERE 1=1", []interface{}{}
	if v := c.Query("status"); v != "" {
		args = append(args, v)
		where += " AND r.status = $1"
	}
	ctx := c.Request.Context()
	var total int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM price_review_requests r "+where, args...).Scan(&total); err != nil {
		fail(c, err)
		return
	}
	largs := append(append([]interface{}{}, args...), size, (page-1)*size)
	rows, err := h.pool.Query(ctx, "SELECT "+reviewCols+", a.article_code, a.name, a.spec_price, a.approved_price FROM price_review_requests r JOIN articles a ON a.id = r.article_id "+where+" ORDER BY r.created_at DESC LIMIT $"+itoa(len(largs)-1)+" OFFSET $"+itoa(len(largs)), largs...)
	if err != nil {
		fail(c, err)
		return
	}
	defer rows.Close()
	data := []reviewRaw{}
	for rows.Next() {
		r, err := scanReview(rows, true)
		if err != nil {
			fail(c, err)
			return
		}
		data = append(data, r)
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "meta": gin.H{"page": page, "pageSize": size, "total": total}})
}

func (h *CatalogMiscHandler) findPending(c *gin.Context, id string) (articleID string, approvedBefore float64, ok bool) {
	var status string
	err := h.pool.QueryRow(c.Request.Context(), "SELECT r.article_id, r.status, a.approved_price FROM price_review_requests r JOIN articles a ON a.id = r.article_id WHERE r.id = $1", id).Scan(&articleID, &status, &approvedBefore)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Review "+id+" not found")
		return "", 0, false
	} else if err != nil {
		fail(c, err)
		return "", 0, false
	}
	if status != "PENDING" {
		common.Conflict(c, "REVIEW_ALREADY_DECIDED", "Заявка уже рассмотрена")
		return "", 0, false
	}
	return articleID, approvedBefore, true
}

// PriceReviewApprove — POST /price-reviews/:id/approve (director/admin)
func (h *CatalogMiscHandler) PriceReviewApprove(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		NewPrice float64 `json:"newPrice"`
		Comment  *string `json:"comment"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	if !(body.NewPrice > 0) {
		common.BadRequest(c, "INVALID_PRICE", "newPrice должен быть > 0")
		return
	}
	articleID, before, ok := h.findPending(c, id)
	if !ok {
		return
	}
	user := authpkg.CurrentUser(c)
	uid := dbUserID(user.UserID)
	ctx := c.Request.Context()
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		fail(c, err)
		return
	}
	defer tx.Rollback(ctx)
	now := time.Now().UTC()
	r, err := scanReview(tx.QueryRow(ctx, `WITH u AS (UPDATE price_review_requests SET status = 'APPROVED', new_price = $1, decision_comment = $2, decided_by_id = $3, decided_at = $4 WHERE id = $5 RETURNING *)
		SELECT `+strings.ReplaceAll(reviewCols, "r.", "u.")+`, a.article_code, a.name FROM u JOIN articles a ON a.id = u.article_id`, body.NewPrice, body.Comment, uid, now, id), false)
	if err != nil {
		fail(c, err)
		return
	}
	if _, err := tx.Exec(ctx, "UPDATE articles SET approved_price = $1, updated_at = now() WHERE id = $2", body.NewPrice, articleID); err != nil {
		fail(c, err)
		return
	}
	role := ""
	if len(user.Roles) > 0 {
		role = user.Roles[0]
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log (id, entity_type, entity_id, action, before, after, user_id, user_role, comment) VALUES ($1,'Article',$2,'price_approved',$3,$4,$5,$6,$7)`,
		uuid.NewString(), articleID, mustJSON(gin.H{"approvedPrice": before}), mustJSON(gin.H{"approvedPrice": body.NewPrice}), uid, role, body.Comment); err != nil {
		fail(c, err)
		return
	}
	if uid != nil {
		if _, err := tx.Exec(ctx, "INSERT INTO price_history (id, article_id, price, valid_from, changed_by) VALUES ($1,$2,$3,$4,$5)", uuid.NewString(), articleID, body.NewPrice, now, *uid); err != nil {
			fail(c, err)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, r)
}

// PriceReviewReject — POST /price-reviews/:id/reject (director/admin)
func (h *CatalogMiscHandler) PriceReviewReject(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Comment *string `json:"comment"`
	}
	_ = c.ShouldBindJSON(&body)
	if _, _, ok := h.findPending(c, id); !ok {
		return
	}
	user := authpkg.CurrentUser(c)
	r, err := scanReview(h.pool.QueryRow(c.Request.Context(), `WITH u AS (UPDATE price_review_requests SET status = 'REJECTED', decision_comment = $1, decided_by_id = $2, decided_at = $3 WHERE id = $4 RETURNING *)
		SELECT `+strings.ReplaceAll(reviewCols, "r.", "u.")+`, a.article_code, a.name FROM u JOIN articles a ON a.id = u.article_id`, body.Comment, dbUserID(user.UserID), time.Now().UTC(), id), false)
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusCreated, r)
}

// --- min stock levels ---

type minStockRaw struct {
	ID           string          `json:"id"`
	ArticleID    string          `json:"articleId"`
	PeriodMonths decimal.Decimal `json:"periodMonths"`
	TargetQty    decimal.Decimal `json:"targetQty"`
	ActualQty    decimal.Decimal `json:"actualQty"`
	DeficitQty   decimal.Decimal `json:"deficitQty"`
	ReadinessPct decimal.Decimal `json:"readinessPct"`
}

const minStockCols = "id, article_id, period_months, target_qty, actual_qty, deficit_qty, readiness_pct"

func scanMinStock(row pgx.Row) (minStockRaw, error) {
	var m minStockRaw
	err := row.Scan(&m.ID, &m.ArticleID, &m.PeriodMonths, &m.TargetQty, &m.ActualQty, &m.DeficitQty, &m.ReadinessPct)
	return m, err
}

// MinStockList — GET /min-stock-levels?articleId=&deficitOnly=
func (h *CatalogMiscHandler) MinStockList(c *gin.Context) {
	where, args := "", []interface{}{}
	if v := c.Query("articleId"); v != "" {
		args = append(args, v)
		where = " WHERE l.article_id = $1"
	}
	ctx := c.Request.Context()
	rows, err := h.pool.Query(ctx, "SELECT l.id, l.article_id, l.period_months, l.target_qty, a.id, a.article_code, a.name, a.approved_price FROM min_stock_levels l JOIN articles a ON a.id = l.article_id"+where, args...)
	if err != nil {
		fail(c, err)
		return
	}
	type lvl struct {
		ID, ArticleID, Code, Name string
		Period, Target            float64
		ApprovedPrice             decimal.Decimal
	}
	var levels []lvl
	var ids []string
	for rows.Next() {
		var l lvl
		var aid string
		if err := rows.Scan(&l.ID, &l.ArticleID, &l.Period, &l.Target, &aid, &l.Code, &l.Name, &l.ApprovedPrice); err != nil {
			rows.Close()
			fail(c, err)
			return
		}
		levels = append(levels, l)
		ids = append(ids, l.ArticleID)
	}
	rows.Close()
	if len(levels) == 0 {
		c.JSON(http.StatusOK, []interface{}{})
		return
	}
	grows, err := h.pool.Query(ctx, "SELECT item_id, movement_type, sum(qty) FROM finished_goods_movements WHERE item_id = ANY($1) GROUP BY item_id, movement_type", ids)
	if err != nil {
		fail(c, err)
		return
	}
	plus := map[string]bool{"RECEIPT": true, "FROM_PRODUCTION": true, "RETURN": true, "CORRECTION": true}
	stock := map[string]float64{}
	for grows.Next() {
		var item, mt string
		var q float64
		if err := grows.Scan(&item, &mt, &q); err != nil {
			grows.Close()
			fail(c, err)
			return
		}
		if plus[models.StockMovementTypeDBToAPI(mt)] {
			stock[item] += q
		} else {
			stock[item] -= q
		}
	}
	grows.Close()
	type row struct {
		H     gin.H
		Value float64
	}
	var out []row
	for _, l := range levels {
		actual := round3(stock[l.ArticleID])
		deficit := round3(l.Target - actual)
		if deficit < 0 {
			deficit = 0
		}
		readiness := 100.0
		if l.Target > 0 {
			readiness = float64(int64(actual/l.Target*1000+0.5)) / 10
			if readiness > 100 {
				readiness = 100
			}
		}
		ap, _ := l.ApprovedPrice.Float64()
		value := round2(deficit * ap)
		if c.Query("deficitOnly") == "true" && !(deficit > 0) {
			continue
		}
		out = append(out, row{Value: value, H: gin.H{"id": l.ID, "articleId": l.ArticleID, "article": gin.H{"id": l.ArticleID, "articleCode": l.Code, "name": l.Name, "approvedPrice": l.ApprovedPrice},
			"periodMonths": l.Period, "targetQty": l.Target, "actualQty": actual, "deficitQty": deficit, "readinessPct": readiness, "deficitValue": value}})
	}
	sortStable(out, func(i, j int) bool { return out[i].Value > out[j].Value })
	res := make([]gin.H, len(out))
	for i, r := range out {
		res[i] = r.H
	}
	c.JSON(http.StatusOK, res)
}

func round3(n float64) float64 { return float64(int64(n*1000+copysign(0.5, n))) / 1000 }

// MinStockUpdate — PATCH /min-stock-levels/:id (upsert по articleId)
func (h *CatalogMiscHandler) MinStockUpdate(c *gin.Context) {
	articleID := c.Param("id")
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	var x string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM articles WHERE id = $1", articleID).Scan(&x); err == pgx.ErrNoRows {
		common.NotFound(c, "Article "+articleID+" not found")
		return
	} else if err != nil {
		fail(c, err)
		return
	}
	sets, args := []string{}, []interface{}{}
	if v, ok := body["targetQty"]; ok {
		f, isNum := v.(float64)
		if !isNum || !(f >= 0) {
			common.BadRequest(c, "INVALID_QTY", "Норматив не может быть отрицательным")
			return
		}
		args = append(args, f)
		sets = append(sets, "target_qty = $"+itoa(len(args)))
	}
	if v, ok := body["periodMonths"]; ok {
		if f, isNum := v.(float64); isNum && f > 0 {
			args = append(args, f)
			sets = append(sets, "period_months = $"+itoa(len(args)))
		}
	}
	var existing string
	err := h.pool.QueryRow(ctx, "SELECT id FROM min_stock_levels WHERE article_id = $1 LIMIT 1", articleID).Scan(&existing)
	var m minStockRaw
	if err == nil {
		if len(sets) == 0 {
			m, err = scanMinStock(h.pool.QueryRow(ctx, "SELECT "+minStockCols+" FROM min_stock_levels WHERE id = $1", existing))
		} else {
			args = append(args, existing)
			m, err = scanMinStock(h.pool.QueryRow(ctx, "UPDATE min_stock_levels SET "+strings.Join(sets, ", ")+" WHERE id = $"+itoa(len(args))+" RETURNING "+minStockCols, args...))
		}
	} else if err == pgx.ErrNoRows {
		cols, vals := "id, article_id", "$1, $2"
		iargs := []interface{}{uuid.NewString(), articleID}
		for i, s := range sets {
			col := strings.Split(s, " = ")[0]
			iargs = append(iargs, args[i])
			cols += ", " + col
			vals += ", $" + itoa(len(iargs))
		}
		m, err = scanMinStock(h.pool.QueryRow(ctx, "INSERT INTO min_stock_levels ("+cols+") VALUES ("+vals+") RETURNING "+minStockCols, iargs...))
	}
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, m)
}

// MinStockDelete — DELETE /min-stock-levels/:id
func (h *CatalogMiscHandler) MinStockDelete(c *gin.Context) {
	articleID := c.Param("id")
	ctx := c.Request.Context()
	var existing string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM min_stock_levels WHERE article_id = $1 LIMIT 1", articleID).Scan(&existing); err == pgx.ErrNoRows {
		common.NotFound(c, "Норматив для "+articleID+" не найден")
		return
	} else if err != nil {
		fail(c, err)
		return
	}
	if _, err := h.pool.Exec(ctx, "DELETE FROM min_stock_levels WHERE id = $1", existing); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}

func loadMaterialRaw(c *gin.Context, pool *pgxpool.Pool, id string) (models.Material, error) {
	return catalogScanMaterial(pool.QueryRow(c.Request.Context(), "SELECT "+catalogMaterialCols+" FROM materials WHERE id = $1", id))
}

func sortStable[T any](s []T, less func(i, j int) bool) { sortSliceStable(s, less) }
