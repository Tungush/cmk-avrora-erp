// Точный перенос warehouse.controller.ts: обрезки, остатки материалов,
// приход (с каскадом в себестоимость), история движений, склад ГП,
// журнал приходов, давальческое сырьё, справочник складов, списание
// (с FIFO-расходом партий), остатки и движения ГП.
package warehouse

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
)

type WarehouseHandler struct {
	pool *pgxpool.Pool
}

func NewWarehouseHandler(pool *pgxpool.Pool) *WarehouseHandler {
	return &WarehouseHandler{pool: pool}
}

// --- Offcuts (обрезки) ---

type offcutOut struct {
	ID         string      `json:"id"`
	MaterialID string      `json:"materialId"`
	LengthMm   interface{} `json:"lengthMm"`
	WidthMm    interface{} `json:"widthMm"`
	Qty        interface{} `json:"qty"`
	Note       *string     `json:"note"`
	CreatedAt  interface{} `json:"createdAt"`
	UpdatedAt  interface{} `json:"updatedAt"`
	Material   gin.H       `json:"material"`
}

func (h *WarehouseHandler) scanOffcutWithMaterial(row pgx.Row) (offcutOut, error) {
	var o models.Offcut
	var matID, matCode, matName, matUnit, matCategory string
	err := row.Scan(&o.ID, &o.MaterialID, &o.LengthMm, &o.WidthMm, &o.Qty, &o.Note, &o.CreatedAt, &o.UpdatedAt,
		&matID, &matCode, &matName, &matUnit, &matCategory)
	if err != nil {
		return offcutOut{}, err
	}
	return offcutOut{
		ID: o.ID, MaterialID: o.MaterialID, LengthMm: o.LengthMm, WidthMm: o.WidthMm, Qty: o.Qty,
		Note: o.Note, CreatedAt: o.CreatedAt, UpdatedAt: o.UpdatedAt,
		Material: gin.H{"id": matID, "materialCode": matCode, "name": matName, "unit": matUnit, "category": models.CategoryDBToAPI(matCategory)},
	}, nil
}

const offcutSelectCols = `o.id, o.material_id, o.length_mm, o.width_mm, o.qty, o.note, o.created_at, o.updated_at,
	m.id, m.material_code, m.name, m.unit, m.category`

// GetOffcuts — GET /warehouse/offcuts.
func (h *WarehouseHandler) GetOffcuts(c *gin.Context) {
	ctx := c.Request.Context()
	sql := `SELECT ` + offcutSelectCols + ` FROM offcuts o JOIN materials m ON m.id = o.material_id`
	args := []interface{}{}
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		args = append(args, "%"+search+"%")
		sql += " WHERE (m.name ILIKE $1 OR m.material_code ILIKE $1)"
	}
	sql += " ORDER BY m.name ASC, o.length_mm DESC LIMIT 500"

	rows, err := h.pool.Query(ctx, sql, args...)
	if err != nil {
		respondErr(c, err)
		return
	}
	defer rows.Close()
	data := []offcutOut{}
	for rows.Next() {
		o, err := h.scanOffcutWithMaterial(rows)
		if err != nil {
			respondErr(c, err)
			return
		}
		data = append(data, o)
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "total": len(data)})
}

// OffcutsForOrder — GET /warehouse/offcuts/for-order/:orderId.
func (h *WarehouseHandler) OffcutsForOrder(c *gin.Context) {
	orderID := c.Param("orderId")
	ctx := c.Request.Context()

	rows, err := h.pool.Query(ctx, `
		SELECT ol.qty, ol.article_id FROM order_lines ol
		JOIN articles a ON a.id = ol.article_id
		WHERE ol.order_id = $1 AND a.is_material_resale = false`, orderID)
	if err != nil {
		respondErr(c, err)
		return
	}
	type lineT struct {
		Qty       float64
		ArticleID string
	}
	var lines []lineT
	articleIDSet := map[string]bool{}
	for rows.Next() {
		var l lineT
		var articleID *string
		if err := rows.Scan(&l.Qty, &articleID); err != nil {
			rows.Close()
			respondErr(c, err)
			return
		}
		if articleID == nil {
			continue
		}
		l.ArticleID = *articleID
		lines = append(lines, l)
		articleIDSet[l.ArticleID] = true
	}
	rows.Close()
	if len(articleIDSet) == 0 {
		c.JSON(http.StatusOK, gin.H{"materials": []interface{}{}, "usedBefore": []interface{}{}})
		return
	}
	articleIDs := make([]string, 0, len(articleIDSet))
	for id := range articleIDSet {
		articleIDs = append(articleIDs, id)
	}

	brows, err := h.pool.Query(ctx, `
		SELECT bi.article_id, bi.qty_per_unit, m.id, m.material_code, m.name, m.unit
		FROM bom_items bi JOIN materials m ON m.id = bi.material_id
		WHERE bi.article_id = ANY($1)`, articleIDs)
	if err != nil {
		respondErr(c, err)
		return
	}
	type bomT struct {
		ArticleID                                    string
		QtyPerUnit                                   float64
		MaterialID, MaterialCode, MaterialName, Unit string
	}
	var bom []bomT
	for brows.Next() {
		var b bomT
		if err := brows.Scan(&b.ArticleID, &b.QtyPerUnit, &b.MaterialID, &b.MaterialCode, &b.MaterialName, &b.Unit); err != nil {
			brows.Close()
			respondErr(c, err)
			return
		}
		bom = append(bom, b)
	}
	brows.Close()

	type needT struct {
		MaterialCode, Name, Unit string
		Qty                      float64
	}
	need := map[string]*needT{}
	needOrder := []string{}
	for _, l := range lines {
		for _, b := range bom {
			if b.ArticleID != l.ArticleID {
				continue
			}
			n, ok := need[b.MaterialID]
			if !ok {
				n = &needT{MaterialCode: b.MaterialCode, Name: b.MaterialName, Unit: b.Unit}
				need[b.MaterialID] = n
				needOrder = append(needOrder, b.MaterialID)
			}
			n.Qty += b.QtyPerUnit * l.Qty
		}
	}
	if len(need) == 0 {
		c.JSON(http.StatusOK, gin.H{"materials": []interface{}{}, "usedBefore": []interface{}{}})
		return
	}

	materialIDs := make([]string, 0, len(need))
	for id := range need {
		materialIDs = append(materialIDs, id)
	}
	orows, err := h.pool.Query(ctx, `
		SELECT id, material_id, length_mm, width_mm, qty, note FROM offcuts
		WHERE material_id = ANY($1) ORDER BY length_mm DESC`, materialIDs)
	if err != nil {
		respondErr(c, err)
		return
	}
	type offcutT struct {
		ID, MaterialID string
		LengthMm       float64
		WidthMm        *float64
		Qty            float64
		Note           *string
	}
	var offcuts []offcutT
	for orows.Next() {
		var o offcutT
		if err := orows.Scan(&o.ID, &o.MaterialID, &o.LengthMm, &o.WidthMm, &o.Qty, &o.Note); err != nil {
			orows.Close()
			respondErr(c, err)
			return
		}
		offcuts = append(offcuts, o)
	}
	orows.Close()

	urows, err := h.pool.Query(ctx, `
		SELECT material_code, material_name, length_mm, qty, used_at FROM offcut_usages
		WHERE order_id = $1 ORDER BY used_at DESC`, orderID)
	if err != nil {
		respondErr(c, err)
		return
	}
	usedBefore := []gin.H{}
	for urows.Next() {
		var code, name string
		var lengthMm, qty float64
		var usedAt time.Time
		if err := urows.Scan(&code, &name, &lengthMm, &qty, &usedAt); err != nil {
			urows.Close()
			respondErr(c, err)
			return
		}
		usedBefore = append(usedBefore, gin.H{
			"materialCode": code, "materialName": name, "lengthMm": lengthMm, "qty": qty,
			"usedAt": usedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		})
	}
	urows.Close()

	materials := []gin.H{}
	for _, materialID := range needOrder {
		var matching []offcutT
		for _, o := range offcuts {
			if o.MaterialID == materialID {
				matching = append(matching, o)
			}
		}
		if len(matching) == 0 {
			continue
		}
		offcutsOut := make([]gin.H, len(matching))
		for i, o := range matching {
			offcutsOut[i] = gin.H{"id": o.ID, "lengthMm": o.LengthMm, "widthMm": o.WidthMm, "qty": o.Qty, "note": o.Note}
		}
		n := need[materialID]
		materials = append(materials, gin.H{
			"materialId": materialID, "materialCode": n.MaterialCode, "name": n.Name,
			"needQty": round3f(n.Qty), "unit": n.Unit, "offcuts": offcutsOut,
		})
	}

	c.JSON(http.StatusOK, gin.H{"materials": materials, "usedBefore": usedBefore})
}

func round3f(n float64) float64 {
	return float64(int64(n*1000+0.5)) / 1000
}

type useOffcutsBody struct {
	Usages []struct {
		OffcutID string  `json:"offcutId"`
		Qty      float64 `json:"qty"`
	} `json:"usages"`
}

// UseOffcutsForOrder — POST /warehouse/offcuts/for-order/:orderId (warehouse_material/shop_foreman/planner/admin).
func (h *WarehouseHandler) UseOffcutsForOrder(c *gin.Context) {
	orderID := c.Param("orderId")
	var body useOffcutsBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	var orderNumber string
	err := h.pool.QueryRow(ctx, "SELECT order_number FROM orders WHERE id = $1", orderID).Scan(&orderNumber)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Заказ "+orderID+" не найден")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}

	var usages []struct {
		OffcutID string
		Qty      float64
	}
	for _, u := range body.Usages {
		if u.Qty > 0 {
			usages = append(usages, struct {
				OffcutID string
				Qty      float64
			}{u.OffcutID, u.Qty})
		}
	}
	if len(usages) == 0 {
		common.BadRequest(c, "EMPTY", "Укажите хотя бы один обрезок и количество")
		return
	}

	user := authpkg.CurrentUser(c)
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		respondErr(c, err)
		return
	}
	defer tx.Rollback(ctx)

	type recordedT struct {
		MaterialCode string
		LengthMm     float64
		Qty          float64
	}
	var recorded []recordedT
	for _, u := range usages {
		var matID, matCode, matName string
		var lengthMm, qty float64
		var widthMm *float64
		err := tx.QueryRow(ctx, `
			SELECT o.qty, o.length_mm, o.width_mm, m.id, m.material_code, m.name
			FROM offcuts o JOIN materials m ON m.id = o.material_id WHERE o.id = $1`, u.OffcutID).
			Scan(&qty, &lengthMm, &widthMm, &matID, &matCode, &matName)
		if err == pgx.ErrNoRows {
			common.NotFound(c, "Обрезок "+u.OffcutID+" не найден")
			return
		} else if err != nil {
			respondErr(c, err)
			return
		}
		take := roundInt(u.Qty)
		if take > qty {
			common.BadRequest(c, "NOT_ENOUGH", "Обрезков «"+matName+"» "+trimF(lengthMm)+" мм на складе "+trimF(qty)+" шт — нельзя забрать "+trimF(take))
			return
		}
		left := qty - take
		if left == 0 {
			if _, err := tx.Exec(ctx, "DELETE FROM offcuts WHERE id = $1", u.OffcutID); err != nil {
				respondErr(c, err)
				return
			}
		} else {
			if _, err := tx.Exec(ctx, "UPDATE offcuts SET qty = $1 WHERE id = $2", left, u.OffcutID); err != nil {
				respondErr(c, err)
				return
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO offcut_usages (id, order_id, material_id, material_code, material_name, length_mm, width_mm, qty)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			uuid.NewString(), orderID, matID, matCode, matName, lengthMm, widthMm, take); err != nil {
			respondErr(c, err)
			return
		}
		recorded = append(recorded, recordedT{MaterialCode: matCode, LengthMm: lengthMm, Qty: take})
	}

	comment := "Обрезки под заказ " + orderNumber + ": "
	parts := make([]string, len(recorded))
	for i, r := range recorded {
		parts[i] = r.MaterialCode + " " + trimF(r.LengthMm) + " мм × " + trimF(r.Qty)
	}
	comment += strings.Join(parts, ", ")
	afterJSON := mustJSONPub(gin.H{"recorded": recorded})
	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_log (id, entity_type, entity_id, action, after, user_id, user_role, comment)
		VALUES ($1,'Order',$2,'offcuts_used',$3,$4,$5,$6)`,
		uuid.NewString(), orderID, afterJSON, dbUserIDLocal(user.UserID), firstOrEmptyLocal(user.Roles), comment); err != nil {
		respondErr(c, err)
		return
	}

	if err := tx.Commit(ctx); err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"recorded": len(recorded)})
}

func roundInt(n float64) float64 { return float64(int64(n + 0.5)) }
func trimF(n float64) string {
	s := strconv.FormatFloat(n, 'f', -1, 64)
	return s
}
func dbUserIDLocal(userID string) *string {
	if userID == "" || strings.HasPrefix(userID, "usr-") {
		return nil
	}
	return &userID
}
func firstOrEmptyLocal(list []string) string {
	if len(list) == 0 {
		return ""
	}
	return list[0]
}

type createOffcutBody struct {
	MaterialID string   `json:"materialId"`
	LengthMm   float64  `json:"lengthMm"`
	WidthMm    *float64 `json:"widthMm"`
	Qty        float64  `json:"qty"`
	Note       *string  `json:"note"`
}

// CreateOffcut — POST /warehouse/offcuts (warehouse_material/shop_foreman/admin).
func (h *WarehouseHandler) CreateOffcut(c *gin.Context) {
	var body createOffcutBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM materials WHERE id = $1", body.MaterialID).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Материал "+body.MaterialID+" не найден")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	if !(body.LengthMm > 0) {
		common.BadRequest(c, "INVALID_LENGTH", "Длина обрезка — обязательна и больше нуля")
		return
	}
	if !(body.Qty > 0) {
		common.BadRequest(c, "INVALID_QTY", "Количество — целое число штук больше нуля")
		return
	}
	var widthMm *float64
	if body.WidthMm != nil && *body.WidthMm > 0 {
		widthMm = body.WidthMm
	}
	var note *string
	if body.Note != nil {
		trimmed := strings.TrimSpace(*body.Note)
		if trimmed != "" {
			note = &trimmed
		}
	}
	id := uuid.NewString()
	if _, err := h.pool.Exec(ctx, `
		INSERT INTO offcuts (id, material_id, length_mm, width_mm, qty, note, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,now())`,
		id, body.MaterialID, body.LengthMm, widthMm, roundInt(body.Qty), note); err != nil {
		respondErr(c, err)
		return
	}
	row := h.pool.QueryRow(ctx, "SELECT "+offcutSelectCols+" FROM offcuts o JOIN materials m ON m.id = o.material_id WHERE o.id = $1", id)
	out, err := h.scanOffcutWithMaterial(row)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, out)
}

type updateOffcutBody struct {
	Qty  *float64 `json:"qty"`
	Note *string  `json:"note"`
}

// UpdateOffcut — PATCH /warehouse/offcuts/:id (warehouse_material/shop_foreman/admin).
func (h *WarehouseHandler) UpdateOffcut(c *gin.Context) {
	id := c.Param("id")
	var body updateOffcutBody
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "VALIDATION_ERROR", err.Error())
		return
	}
	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM offcuts WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Обрезок "+id+" не найден")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	var qty *float64
	if body.Qty != nil {
		v := roundInt(*body.Qty)
		qty = &v
	}
	if qty != nil && *qty < 0 {
		common.BadRequest(c, "INVALID_QTY", "Количество не бывает отрицательным")
		return
	}
	if qty != nil && *qty == 0 {
		if _, err := h.pool.Exec(ctx, "DELETE FROM offcuts WHERE id = $1", id); err != nil {
			respondErr(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"deleted": true})
		return
	}

	setParts := []string{}
	args := []interface{}{}
	if qty != nil {
		args = append(args, *qty)
		setParts = append(setParts, "qty = $"+strconv.Itoa(len(args)))
	}
	if body.Note != nil {
		trimmed := strings.TrimSpace(*body.Note)
		var noteVal *string
		if trimmed != "" {
			noteVal = &trimmed
		}
		args = append(args, noteVal)
		setParts = append(setParts, "note = $"+strconv.Itoa(len(args)))
	}
	setParts = append(setParts, "updated_at = now()")
	args = append(args, id)
	sql := "UPDATE offcuts SET " + strings.Join(setParts, ", ") + " WHERE id = $" + strconv.Itoa(len(args))
	if _, err := h.pool.Exec(ctx, sql, args...); err != nil {
		respondErr(c, err)
		return
	}
	row := h.pool.QueryRow(ctx, "SELECT "+offcutSelectCols+" FROM offcuts o JOIN materials m ON m.id = o.material_id WHERE o.id = $1", id)
	out, err := h.scanOffcutWithMaterial(row)
	if err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}

// DeleteOffcut — DELETE /warehouse/offcuts/:id (warehouse_material/shop_foreman/admin).
func (h *WarehouseHandler) DeleteOffcut(c *gin.Context) {
	id := c.Param("id")
	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM offcuts WHERE id = $1", id).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Обрезок "+id+" не найден")
		return
	} else if err != nil {
		respondErr(c, err)
		return
	}
	if _, err := h.pool.Exec(ctx, "DELETE FROM offcuts WHERE id = $1", id); err != nil {
		respondErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}

func mustJSONPub(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}
