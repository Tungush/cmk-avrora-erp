package orders

// Перенос contractor-work.controller.ts — подряд на переделе («норматив
// молчит, подряд говорит»). Штат здесь не заводится никогда: остаток
// объёма (1 − Σ доля подряда) достаётся ему автоматически. Приёмка
// (actualQty + actualAmount) замораживает сумму. Сверка — против ДО из
// «Заказа поставщику» 1С: PaymentDocument.contractor — это Customer
// (контрагент), связь Contractor ↔ Customer только по БИН.

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
)

type ContractorWorkHandler struct{ pool *pgxpool.Pool }

func NewContractorWorkHandler(pool *pgxpool.Pool) *ContractorWorkHandler {
	return &ContractorWorkHandler{pool: pool}
}

func dbErr(c *gin.Context, err error) {
	common.DebugLog(err)
	common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Ошибка базы данных")
}

// jsNum — число в строке шаблона как у JS (`${12}` → "12", `${3.2}` → "3.2").
func jsNum(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// jsNumber — Number(v) для сырого JSON-значения: number как есть, строка
// парсится (""→0), null→0, отсутствие → NaN.
func jsNumber(raw json.RawMessage) float64 {
	if raw == nil {
		return math.NaN()
	}
	s := strings.TrimSpace(string(raw))
	if s == "null" {
		return 0
	}
	if s == "true" {
		return 1
	}
	if s == "false" {
		return 0
	}
	var str string
	if json.Unmarshal(raw, &str) == nil {
		str = strings.TrimSpace(str)
		if str == "" {
			return 0
		}
		v, err := strconv.ParseFloat(str, 64)
		if err != nil {
			return math.NaN()
		}
		return v
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return math.NaN()
	}
	return v
}

func trimOrNil(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		return nil
	}
	return &t
}

type createContractorBody struct {
	Name                *string         `json:"name"`
	BinIin              *string         `json:"binIin"`
	DefaultRateType     *string         `json:"defaultRateType"`
	DefaultRate         json.RawMessage `json:"defaultRate"`
	DefaultWorkLocation *string         `json:"defaultWorkLocation"`
	Notes               *string         `json:"notes"`
}

// CreateContractor — POST /contractors
func (h *ContractorWorkHandler) CreateContractor(c *gin.Context) {
	var body createContractorBody
	_ = c.ShouldBindJSON(&body)
	name := trimOrNil(body.Name)
	if name == nil {
		common.BadRequest(c, "NAME_REQUIRED", "Укажите название подрядчика")
		return
	}
	rateType := "PER_UNIT"
	if body.DefaultRateType != nil {
		rateType = *body.DefaultRateType
	}
	if !rateTypes[rateType] {
		common.BadRequest(c, "INVALID_RATE_TYPE", "Неизвестный тип ставки: "+rateType)
		return
	}
	ctx := c.Request.Context()
	binIin := trimOrNil(body.BinIin)
	if binIin != nil {
		// БИН — единственная связь с актами 1С: дубль сломал бы сверку
		var dupName string
		err := h.pool.QueryRow(ctx, "SELECT name FROM contractors WHERE bin_iin = $1", *binIin).Scan(&dupName)
		if err == nil {
			common.BadRequest(c, "BIN_TAKEN", "БИН "+*binIin+" уже у подрядчика «"+dupName+"»")
			return
		} else if err != pgx.ErrNoRows {
			dbErr(c, err)
			return
		}
	}
	rate := 0.0
	if v := jsNumber(body.DefaultRate); v > 0 {
		rate = v
	}
	loc := "CONTRACTOR_SITE"
	if body.DefaultWorkLocation != nil {
		loc = *body.DefaultWorkLocation
	}
	row, err := scanContractor(h.pool.QueryRow(ctx, "INSERT INTO contractors (id, name, bin_iin, default_rate_type, default_rate, default_work_location, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING "+contractorCols,
		uuid.NewString(), *name, binIin, rateType, decimal.NewFromFloat(rate), loc, trimOrNil(body.Notes)))
	if err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, row)
}

// Contractors — GET /contractors?activeOnly=false
func (h *ContractorWorkHandler) Contractors(c *gin.Context) {
	where := " WHERE is_active = true"
	if c.Query("activeOnly") == "false" {
		where = ""
	}
	rows, err := h.pool.Query(c.Request.Context(), "SELECT "+contractorCols+" FROM contractors"+where+" ORDER BY name ASC")
	if err != nil {
		c.JSON(http.StatusOK, []interface{}{}) // runWithFallback → []
		return
	}
	defer rows.Close()
	out := []contractorRow{}
	for rows.Next() {
		r, err := scanContractor(rows)
		if err != nil {
			dbErr(c, err)
			return
		}
		out = append(out, r)
	}
	c.JSON(http.StatusOK, out)
}

// AllWork — GET /contractor-work?contractorId=&onlyOpen=true — экран «Подряд».
func (h *ContractorWorkHandler) AllWork(c *gin.Context) {
	where, args := "WHERE o.is_archived = false", []interface{}{}
	if v := c.Query("contractorId"); v != "" {
		args = append(args, v)
		where += " AND w.contractor_id = $1"
	}
	if c.Query("onlyOpen") == "true" {
		where += " AND w.accepted_at IS NULL"
	}
	rows, err := h.pool.Query(c.Request.Context(), "SELECT "+cwCols+", ct.id, ct.name, ct.bin_iin, o.id, o.order_number, o.status, o.planned_shipment_date, r.id, r.number FROM contractor_works w JOIN contractors ct ON ct.id = w.contractor_id JOIN orders o ON o.id = w.order_id LEFT JOIN contractor_requests r ON r.id = w.request_id "+
		where+" ORDER BY w.accepted_at ASC NULLS FIRST, w.decided_at DESC LIMIT 300", args...)
	if err != nil {
		dbErr(c, err)
		return
	}
	defer rows.Close()
	type acc struct {
		ID       string  `json:"id"`
		Name     string  `json:"name"`
		Open     int     `json:"open"`
		Accepted int     `json:"accepted"`
		Amount   float64 `json:"amount"`
	}
	data := []gin.H{}
	byContractor := map[string]*acc{}
	var order []string
	for rows.Next() {
		var w contractorWorkRow
		var stage string
		var ct contractorBrief
		var oid, onum, ostatus string
		var planned common.PDate
		var rid, rnum *string
		if err := rows.Scan(&w.ID, &w.OrderID, &w.OrderLineID, &stage, &w.ContractorID, &w.Share, &w.RateType, &w.Rate, &w.ActualQty, &w.ActualWorkers, &w.ActualAmount,
			&w.WorkLocation, &w.PlannedHours, &w.RequestID, &w.DecidedByID, &w.DecidedAt, &w.Reason, &w.AcceptedByID, &w.AcceptedAt, &w.ContractDocID, &w.Note,
			&ct.ID, &ct.Name, &ct.BinIin, &oid, &onum, &ostatus, &planned, &rid, &rnum); err != nil {
			dbErr(c, err)
			return
		}
		w.RoutingStage = models.RoutingStageDBToAPI(stage)
		amount := workAmount(w)
		var req interface{}
		if rid != nil {
			req = gin.H{"id": *rid, "number": *rnum}
		}
		isAccepted := w.AcceptedAt.Valid
		data = append(data, gin.H{
			"id":         w.ID,
			"order":      gin.H{"id": oid, "orderNumber": onum, "status": ostatus, "plannedShipmentDate": planned},
			"contractor": ct, "request": req, "routingStage": w.RoutingStage,
			"share": w.Share.InexactFloat64(), "rateType": w.RateType, "rate": w.Rate.InexactFloat64(),
			"actualQty": fnum(w.ActualQty), "amount": amount, "workLocation": w.WorkLocation,
			"isAccepted": isAccepted, "acceptedAt": w.AcceptedAt, "decidedAt": w.DecidedAt, "reason": w.Reason,
		})
		a, ok := byContractor[ct.ID]
		if !ok {
			a = &acc{ID: ct.ID, Name: ct.Name}
			byContractor[ct.ID] = a
			order = append(order, ct.ID)
		}
		if isAccepted {
			a.Accepted++
			if amount != nil {
				a.Amount += *amount
			}
		} else {
			a.Open++
		}
	}
	byOut := make([]acc, 0, len(order))
	for _, id := range order {
		byOut = append(byOut, *byContractor[id])
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "byContractor": byOut, "total": len(data)})
}

type stageWork struct {
	contractorWorkRow
	contractor contractorBrief
}

// OrderWork — GET /orders/:id/contractor-work — подряд по заказу со сверкой
// против актов 1С и влиянием на трудозатраты.
func (h *ContractorWorkHandler) OrderWork(c *gin.Context) {
	orderID := c.Param("id")
	ctx := c.Request.Context()
	var exists string
	if err := h.pool.QueryRow(ctx, "SELECT id FROM orders WHERE id = $1", orderID).Scan(&exists); err == pgx.ErrNoRows {
		common.NotFound(c, "Order "+orderID+" not found")
		return
	} else if err != nil {
		dbErr(c, err)
		return
	}

	rows, err := h.pool.Query(ctx, "SELECT "+cwCols+", ct.id, ct.name, ct.bin_iin FROM contractor_works w JOIN contractors ct ON ct.id = w.contractor_id WHERE w.order_id = $1 ORDER BY w.routing_stage ASC, w.decided_at DESC", orderID)
	if err != nil {
		dbErr(c, err)
		return
	}
	var works []stageWork
	for rows.Next() {
		var w stageWork
		var stage string
		if err := rows.Scan(&w.ID, &w.OrderID, &w.OrderLineID, &stage, &w.ContractorID, &w.Share, &w.RateType, &w.Rate, &w.ActualQty, &w.ActualWorkers, &w.ActualAmount,
			&w.WorkLocation, &w.PlannedHours, &w.RequestID, &w.DecidedByID, &w.DecidedAt, &w.Reason, &w.AcceptedByID, &w.AcceptedAt, &w.ContractDocID, &w.Note,
			&w.contractor.ID, &w.contractor.Name, &w.contractor.BinIin); err != nil {
			rows.Close()
			dbErr(c, err)
			return
		}
		w.RoutingStage = models.RoutingStageDBToAPI(stage)
		works = append(works, w)
	}
	rows.Close()

	amountOf := func(w contractorWorkRow) float64 {
		if v := workAmount(w); v != nil {
			return *v
		}
		return 0
	}

	// Акты: PaymentDocument.contractor — Customer, матчим по БИН
	var bins []string
	seenBin := map[string]bool{}
	for _, w := range works {
		if w.contractor.BinIin != nil && *w.contractor.BinIin != "" && !seenBin[*w.contractor.BinIin] {
			seenBin[*w.contractor.BinIin] = true
			bins = append(bins, *w.contractor.BinIin)
		}
	}
	type act struct {
		bin   string
		total float64
	}
	var acts []act
	if len(bins) > 0 {
		arows, err := h.pool.Query(ctx, "SELECT cu.bin_iin, pd.total_amount FROM payment_documents pd JOIN customers cu ON cu.id = pd.contractor_id WHERE pd.order_id = $1 AND cu.bin_iin = ANY($2)", orderID, bins)
		if err != nil {
			dbErr(c, err)
			return
		}
		for arows.Next() {
			var a act
			var total decimal.Decimal
			if err := arows.Scan(&a.bin, &total); err != nil {
				arows.Close()
				dbErr(c, err)
				return
			}
			a.total = total.InexactFloat64()
			acts = append(acts, a)
		}
		arows.Close()
	}

	type recon struct {
		ContractorID string
		Name         string
		Logged       float64
		Acted        float64
	}
	byContractor := map[string]*recon{}
	var reconOrder []string
	for _, w := range works {
		r, ok := byContractor[w.ContractorID]
		if !ok {
			r = &recon{ContractorID: w.ContractorID, Name: w.contractor.Name}
			byContractor[w.ContractorID] = r
			reconOrder = append(reconOrder, w.ContractorID)
		}
		r.Logged += amountOf(w.contractorWorkRow)
	}
	for _, a := range acts {
		for _, w := range works {
			if w.contractor.BinIin != nil && *w.contractor.BinIin == a.bin {
				if r, ok := byContractor[w.ContractorID]; ok {
					r.Acted += a.total
				}
				break
			}
		}
	}
	reconciliation := make([]gin.H, 0, len(reconOrder))
	for _, id := range reconOrder {
		r := byContractor[id]
		status := "MISMATCH"
		if r.Acted == 0 {
			status = "WAITING_ACT"
		} else if math.Abs(r.Logged-r.Acted) < 0.01 {
			status = "MATCHED"
		}
		reconciliation = append(reconciliation, gin.H{
			"contractorId": r.ContractorID, "name": r.Name, "logged": round2(r.Logged), "acted": r.Acted,
			"delta": round2(r.Logged - r.Acted), "status": status,
		})
	}

	// Влияние подряда на трудозатраты: доля подряда вырезает свой кусок нормы
	type line struct {
		qty       float64
		articleID string
		resale    bool
	}
	lrows, err := h.pool.Query(ctx, "SELECT ol.qty, ol.article_id, a.is_material_resale FROM order_lines ol JOIN articles a ON a.id = ol.article_id WHERE ol.order_id = $1 AND ol.article_id IS NOT NULL", orderID)
	if err != nil {
		dbErr(c, err)
		return
	}
	var lines []line
	for lrows.Next() {
		var l line
		var qty decimal.Decimal
		if err := lrows.Scan(&qty, &l.articleID, &l.resale); err != nil {
			lrows.Close()
			dbErr(c, err)
			return
		}
		l.qty = qty.InexactFloat64()
		lines = append(lines, l)
	}
	lrows.Close()
	var articleIDs []string
	seenArt := map[string]bool{}
	for _, l := range lines {
		if !l.resale && !seenArt[l.articleID] {
			seenArt[l.articleID] = true
			articleIDs = append(articleIDs, l.articleID)
		}
	}
	normPerUnit := map[string]float64{}
	if len(articleIDs) > 0 {
		orows, err := h.pool.Query(ctx, "SELECT article_id, stage, workers, hours_per_unit FROM routing_operations WHERE article_id = ANY($1)", articleIDs)
		if err != nil {
			dbErr(c, err)
			return
		}
		for orows.Next() {
			var aid, stage string
			var workers, hpu decimal.Decimal
			if err := orows.Scan(&aid, &stage, &workers, &hpu); err != nil {
				orows.Close()
				dbErr(c, err)
				return
			}
			key := aid + ":" + models.RoutingStageDBToAPI(stage)
			normPerUnit[key] += workers.InexactFloat64() * hpu.InexactFloat64()
		}
		orows.Close()
	}

	laborImpact := []gin.H{}
	tNorm, tStaff, tContr, tAmount := 0.0, 0.0, 0.0, 0.0
	for _, stage := range []string{"CUTTING", "ASSEMBLY", "PAINTING"} {
		normHours := 0.0
		for _, l := range lines {
			if l.resale {
				continue
			}
			normHours += normPerUnit[l.articleID+":"+stage] * l.qty
		}
		shareSum, contractorAmount := 0.0, 0.0
		contractors := []gin.H{}
		for _, w := range works {
			if w.RoutingStage != stage {
				continue
			}
			shareSum += w.Share.InexactFloat64()
			contractorAmount += amountOf(w.contractorWorkRow)
			contractors = append(contractors, gin.H{"name": w.contractor.Name, "sharePct": common.JsRound(w.Share.InexactFloat64() * 100)})
		}
		share := math.Min(1, shareSum)
		row := gin.H{
			"stage": stage, "stageLabel": stageLabel(stage),
			"normHours":          round2(normHours),
			"contractorSharePct": common.JsRound(share * 100),
			"staffHours":         round2(normHours * (1 - share)),
			"contractorHours":    round2(normHours * share),
			"contractorAmount":   round2(contractorAmount),
			"contractors":        contractors,
		}
		if !(row["normHours"].(float64) > 0 || row["contractorSharePct"].(float64) > 0) {
			continue
		}
		laborImpact = append(laborImpact, row)
		tNorm += row["normHours"].(float64)
		tStaff += row["staffHours"].(float64)
		tContr += row["contractorHours"].(float64)
		tAmount += row["contractorAmount"].(float64)
	}

	data := make([]gin.H, 0, len(works))
	for _, w := range works {
		m := cwRaw(w.contractorWorkRow)
		m["contractor"] = w.contractor
		m["share"] = w.Share.InexactFloat64()
		m["rate"] = w.Rate.InexactFloat64()
		m["actualQty"] = fnum(w.ActualQty)
		m["actualAmount"] = fnum(w.ActualAmount)
		m["amount"] = amountOf(w.contractorWorkRow)
		m["isAccepted"] = w.AcceptedAt.Valid
		data = append(data, m)
	}

	c.JSON(http.StatusOK, gin.H{
		"laborImpact":    laborImpact,
		"laborTotals":    gin.H{"normHours": round2(tNorm), "staffHours": round2(tStaff), "contractorHours": round2(tContr), "contractorAmount": round2(tAmount)},
		"data":           data,
		"reconciliation": reconciliation,
	})
}

type assignBody struct {
	ContractorID string   `json:"contractorId"`
	OrderLineID  *string  `json:"orderLineId"`
	Share        *float64 `json:"share"`
	RateType     *string  `json:"rateType"`
	Rate         *float64 `json:"rate"`
	WorkLocation *string  `json:"workLocation"`
	PlannedHours *float64 `json:"plannedHours"`
	Reason       *string  `json:"reason"`
	Note         *string  `json:"note"`
}

// Assign — POST /orders/:id/stages/:stage/contractor — отдать передел
// подрядчику; повтор для пары «передел + подрядчик» обновляет строку.
func (h *ContractorWorkHandler) Assign(c *gin.Context) {
	orderID, stage := c.Param("id"), c.Param("stage")
	var body assignBody
	_ = c.ShouldBindJSON(&body)
	if !contractorStages[stage] {
		common.BadRequest(c, "INVALID_STAGE", "Передел: CUTTING, ASSEMBLY или PAINTING; получено "+stage)
		return
	}
	ctx := c.Request.Context()
	var exists string
	oerr := h.pool.QueryRow(ctx, "SELECT id FROM orders WHERE id = $1", orderID).Scan(&exists)
	contractor, cerr := scanContractor(h.pool.QueryRow(ctx, "SELECT "+contractorCols+" FROM contractors WHERE id = $1", body.ContractorID))
	if oerr == pgx.ErrNoRows {
		common.NotFound(c, "Order "+orderID+" not found")
		return
	} else if oerr != nil {
		dbErr(c, oerr)
		return
	}
	if cerr == pgx.ErrNoRows {
		common.NotFound(c, "Подрядчик не найден")
		return
	} else if cerr != nil {
		dbErr(c, cerr)
		return
	}

	share := 1.0
	if body.Share != nil {
		share = *body.Share
	}
	if !(share > 0) || share > 1 {
		common.BadRequest(c, "INVALID_SHARE", "Доля передела — больше нуля и не больше единицы")
		return
	}
	rateType := contractor.DefaultRateType
	if body.RateType != nil {
		rateType = *body.RateType
	}
	if !rateTypes[rateType] {
		common.BadRequest(c, "INVALID_RATE_TYPE", "Неизвестный тип ставки: "+rateType)
		return
	}
	workLocation := contractor.DefaultWorkLocation
	if body.WorkLocation != nil {
		workLocation = *body.WorkLocation
	}
	// Сдельная ставка не содержит часов: без оценки планирование мощности
	// покажет свободный участок, которого нет (та же защита, что в labor.ts)
	if workLocation == "OUR_SHOP" && rateType != "PER_HOUR" && !(body.PlannedHours != nil && *body.PlannedHours > 0) {
		common.BadRequest(c, "SHOP_HOURS_ESTIMATE_REQUIRED", "Работы в нашем цеху по сдельной ставке — нужна оценка часов")
		return
	}

	stageDB := models.RoutingStageAPIToDB(stage)
	// Заменяемую строку ищем ДО проверки долей: из знаменателя должна
	// выпадать ровно она
	var existingID *string
	err := h.pool.QueryRow(ctx, "SELECT id FROM contractor_works WHERE order_id = $1 AND order_line_id IS NOT DISTINCT FROM $2 AND routing_stage = $3 AND contractor_id = $4 LIMIT 1",
		orderID, body.OrderLineID, stageDB, body.ContractorID).Scan(&existingID)
	if err != nil && err != pgx.ErrNoRows {
		dbErr(c, err)
		return
	}
	taken, aerr := h.takenShare(c, orderID, stageDB, existingID, body.OrderLineID)
	if aerr != nil {
		dbErr(c, aerr)
		return
	}
	if taken+share > 1.0001 {
		scope := "на этих работах по заказу"
		if body.OrderLineID != nil {
			scope = "на этих работах по позиции"
		}
		common.BadRequest(c, "SHARE_OVERFLOW", "Уже отдано "+jsNum(common.JsRound(taken*100))+" % "+scope+", свободно "+jsNum(common.JsRound(math.Max(0, 1-taken)*100))+" %")
		return
	}

	rate := contractor.DefaultRate.InexactFloat64()
	if body.Rate != nil {
		rate = *body.Rate
	}
	user := authpkg.CurrentUser(c)
	decidedBy := dbUserID(user.UserID)
	var row contractorWorkRow
	if existingID != nil {
		row, err = scanContractorWork(h.pool.QueryRow(ctx, "UPDATE contractor_works AS w SET share = $1, rate_type = $2, rate = $3, work_location = $4, planned_hours = $5, reason = $6, note = $7, decided_by_id = $8 WHERE id = $9 RETURNING "+cwCols,
			share, rateType, rate, workLocation, body.PlannedHours, trimOrNil(body.Reason), trimOrNil(body.Note), decidedBy, *existingID))
	} else {
		row, err = scanContractorWork(h.pool.QueryRow(ctx, "INSERT INTO contractor_works AS w (id, order_id, order_line_id, routing_stage, contractor_id, share, rate_type, rate, work_location, planned_hours, reason, note, decided_by_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING "+cwCols,
			uuid.NewString(), orderID, body.OrderLineID, stageDB, body.ContractorID, share, rateType, rate, workLocation, body.PlannedHours, trimOrNil(body.Reason), trimOrNil(body.Note), decidedBy))
	}
	if err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, cwRaw(row))
}

// takenShare — сколько передела уже отдано с учётом ОБОИХ уровней: заказ-
// уровневые строки плюс строки позиции (для заказа целиком — самая занятая
// позиция). Доли складываются внутри позиции, а не по всему заказу.
func (h *ContractorWorkHandler) takenShare(c *gin.Context, orderID, stageDB string, excludeID, orderLineID *string) (float64, error) {
	rows, err := h.pool.Query(c.Request.Context(), "SELECT id, share, order_line_id FROM contractor_works WHERE order_id = $1 AND routing_stage = $2", orderID, stageDB)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	orderLevel := 0.0
	byLine := map[string]float64{}
	for rows.Next() {
		var id string
		var share decimal.Decimal
		var lineID *string
		if err := rows.Scan(&id, &share, &lineID); err != nil {
			return 0, err
		}
		if excludeID != nil && id == *excludeID {
			continue
		}
		if lineID == nil {
			orderLevel += share.InexactFloat64()
		} else {
			byLine[*lineID] += share.InexactFloat64()
		}
	}
	if orderLineID != nil {
		return orderLevel + byLine[*orderLineID], rows.Err()
	}
	maxLine := 0.0
	for _, v := range byLine {
		maxLine = math.Max(maxLine, v)
	}
	return orderLevel + maxLine, rows.Err()
}

type acceptWorkBody struct {
	ActualQty     json.RawMessage `json:"actualQty"`
	ActualWorkers *int            `json:"actualWorkers"`
	ActualAmount  *float64        `json:"actualAmount"`
	Note          *string         `json:"note"`
}

// Accept — PATCH /contractor-work/:id/accept — принять работу (замораживает сумму).
func (h *ContractorWorkHandler) Accept(c *gin.Context) {
	id := c.Param("id")
	var body acceptWorkBody
	_ = c.ShouldBindJSON(&body)
	ctx := c.Request.Context()
	work, reqNumber, err := h.workWithRequest(c, id)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Работа "+id+" не найдена")
		return
	} else if err != nil {
		dbErr(c, err)
		return
	}
	// Строка заявки — часть партии: её сумма выводится из акта заявки
	if work.RequestID != nil {
		common.BadRequest(c, "BELONGS_TO_REQUEST", "Строка разнесена из заявки "+reqNumber+" — акт принимают на самой заявке")
		return
	}
	qty := jsNumber(body.ActualQty)
	if !(qty >= 0) {
		common.BadRequest(c, "INVALID_QTY", "Объём не может быть отрицательным")
		return
	}
	var amount float64
	switch {
	case body.ActualAmount != nil:
		amount = *body.ActualAmount
	case work.RateType == "FIXED":
		amount = work.Rate.InexactFloat64()
	default:
		amount = round2(qty * work.Rate.InexactFloat64())
	}
	note := work.Note
	if t := trimOrNil(body.Note); t != nil {
		note = t
	}
	user := authpkg.CurrentUser(c)
	row, err := scanContractorWork(h.pool.QueryRow(ctx, "UPDATE contractor_works AS w SET actual_qty = $1, actual_workers = $2, actual_amount = $3, accepted_at = now(), accepted_by_id = $4, note = $5 WHERE id = $6 RETURNING "+cwCols,
		qty, body.ActualWorkers, amount, dbUserID(user.UserID), note, id))
	if err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusOK, cwRaw(row))
}

func (h *ContractorWorkHandler) workWithRequest(c *gin.Context, id string) (contractorWorkRow, string, error) {
	rows, err := h.pool.Query(c.Request.Context(), "SELECT "+cwCols+", r.number FROM contractor_works w LEFT JOIN contractor_requests r ON r.id = w.request_id WHERE w.id = $1", id)
	if err != nil {
		return contractorWorkRow{}, "", err
	}
	defer rows.Close()
	if !rows.Next() {
		return contractorWorkRow{}, "", pgx.ErrNoRows
	}
	var w contractorWorkRow
	var stage string
	var num *string
	if err := rows.Scan(&w.ID, &w.OrderID, &w.OrderLineID, &stage, &w.ContractorID, &w.Share, &w.RateType, &w.Rate, &w.ActualQty, &w.ActualWorkers, &w.ActualAmount,
		&w.WorkLocation, &w.PlannedHours, &w.RequestID, &w.DecidedByID, &w.DecidedAt, &w.Reason, &w.AcceptedByID, &w.AcceptedAt, &w.ContractDocID, &w.Note, &num); err != nil {
		return w, "", err
	}
	w.RoutingStage = models.RoutingStageDBToAPI(stage)
	n := ""
	if num != nil {
		n = *num
	}
	return w, n, nil
}

// Remove — DELETE /contractor-work/:id — объём возвращается штату по норме.
func (h *ContractorWorkHandler) Remove(c *gin.Context) {
	id := c.Param("id")
	work, reqNumber, err := h.workWithRequest(c, id)
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Работа "+id+" не найдена")
		return
	} else if err != nil {
		dbErr(c, err)
		return
	}
	if work.RequestID != nil {
		common.BadRequest(c, "BELONGS_TO_REQUEST", "Строка разнесена из заявки "+reqNumber+" — снимайте разнесение там, иначе суммы по остальным заказам не пересчитаются")
		return
	}
	if _, err := h.pool.Exec(c.Request.Context(), "DELETE FROM contractor_works WHERE id = $1", id); err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}
