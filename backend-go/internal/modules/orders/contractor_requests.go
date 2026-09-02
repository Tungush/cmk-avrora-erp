package orders

// Перенос contractor-requests.controller.ts — заявки на подряд. Заявка
// заводится ПАРТИЕЙ до того, как известно, по каким заказам работа
// разойдётся → пачкой уходит одной сделкой в Б24 → цех разносит «на этот
// заказ ушло 3,2 т» → приходит акт, сумма замораживается и делится между
// заказами пропорционально объёму. Деньги входят в себестоимость
// СУЩЕСТВУЮЩИМ путём: разнесение создаёт обычную строку ContractorWork.

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	authpkg "cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/bitrix"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/models"
)

func itoa(n int) string { return strconv.Itoa(n) }

type ContractorRequestsHandler struct{ pool *pgxpool.Pool }

func NewContractorRequestsHandler(pool *pgxpool.Pool) *ContractorRequestsHandler {
	return &ContractorRequestsHandler{pool: pool}
}

// rawBody — тело с различением «ключа нет» / null / значение: контроллер
// оригинала опирается на `!== undefined` и `??`, и это разные ветки.
type rawBody map[string]json.RawMessage

func (b rawBody) has(k string) bool { _, ok := b[k]; return ok }

// str — строковое значение; ok=false для отсутствия, null и не-строки.
func (b rawBody) str(k string) (string, bool) {
	raw, ok := b[k]
	if !ok {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

// truthyStr — непустая строка (JS truthiness для строк).
func (b rawBody) truthyStr(k string) (string, bool) {
	s, ok := b.str(k)
	return s, ok && s != ""
}

func (b rawBody) num(k string) float64 { return jsNumber(b[k]) }

func (h *ContractorRequestsHandler) contractorBrief(c *gin.Context, id *string) (*contractorBrief, error) {
	if id == nil {
		return nil, nil
	}
	var ct contractorBrief
	err := h.pool.QueryRow(c.Request.Context(), "SELECT id, name, bin_iin FROM contractors WHERE id = $1", *id).Scan(&ct.ID, &ct.Name, &ct.BinIin)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &ct, err
}

// withContractor — запись + contractor{id,name}|null (include оригинала).
func (h *ContractorRequestsHandler) withContractor(c *gin.Context, r contractorRequestRow) (gin.H, error) {
	m := crRaw(r)
	ct, err := h.contractorBrief(c, r.ContractorID)
	if err != nil {
		return nil, err
	}
	if ct != nil {
		m["contractor"] = gin.H{"id": ct.ID, "name": ct.Name}
	} else {
		m["contractor"] = nil
	}
	return m, nil
}

func (h *ContractorRequestsHandler) getRequest(c *gin.Context, id string) (contractorRequestRow, bool) {
	r, err := scanContractorRequest(h.pool.QueryRow(c.Request.Context(), "SELECT "+crCols+" FROM contractor_requests r WHERE r.id = $1", id))
	if err == pgx.ErrNoRows {
		common.NotFound(c, "Заявка "+id+" не найдена")
		return r, false
	} else if err != nil {
		dbErr(c, err)
		return r, false
	}
	return r, true
}

// nextNumber — следующий свободный номер: ПОДР-001 → ПОДР-002 …
func (h *ContractorRequestsHandler) nextNumber(c *gin.Context) (string, error) {
	rows, err := h.pool.Query(c.Request.Context(), "SELECT number FROM contractor_requests WHERE number LIKE 'ПОДР-%' ORDER BY number DESC LIMIT 200")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	max := 0.0
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return "", err
		}
		v := jsNumber(json.RawMessage(strconv.Quote(strings.TrimPrefix(n, "ПОДР-"))))
		if !math.IsNaN(v) && !math.IsInf(v, 0) && v > max {
			max = v
		}
	}
	return fmt.Sprintf("ПОДР-%03d", int(max)+1), rows.Err()
}

// FindAll — GET /contractor-requests?status=&stage=&contractorId=
func (h *ContractorRequestsHandler) FindAll(c *gin.Context) {
	where, args := "WHERE 1=1", []interface{}{}
	if v := c.Query("status"); v != "" {
		args = append(args, v)
		where += " AND r.status = $" + itoa(len(args))
	}
	if v := c.Query("stage"); v != "" && contractorStages[v] {
		args = append(args, models.RoutingStageAPIToDB(v))
		where += " AND r.routing_stage = $" + itoa(len(args))
	}
	if v := c.Query("contractorId"); v != "" {
		args = append(args, v)
		where += " AND r.contractor_id = $" + itoa(len(args))
	}
	ctx := c.Request.Context()
	fallback := gin.H{"data": []interface{}{}, "unallocated": gin.H{"requests": 0, "amount": 0}, "total": 0}
	rows, err := h.pool.Query(ctx, "SELECT "+crCols+", ct.id, ct.name, ct.bin_iin, pd.do_number, pd.total_amount FROM contractor_requests r LEFT JOIN contractors ct ON ct.id = r.contractor_id LEFT JOIN payment_documents pd ON pd.id = r.payment_document_id "+
		where+" ORDER BY r.created_at DESC LIMIT 300", args...)
	if err != nil {
		common.DebugLog(err)
		c.JSON(http.StatusOK, fallback)
		return
	}
	type reqRow struct {
		r          contractorRequestRow
		contractor *contractorBrief
		doNumber   *string
		doTotal    *decimal.Decimal
	}
	var list []reqRow
	var ids []string
	for rows.Next() {
		var rr reqRow
		var stage string
		var ctID, ctName, ctBin *string
		r := &rr.r
		if err := rows.Scan(&r.ID, &r.Number, &stage, &r.Description, &r.RateType, &r.PlannedQty, &r.Rate, &r.EstimatedAmount, &r.ContractorID, &r.WorkLocation,
			&r.PlannedHours, &r.Status, &r.BitrixDealID, &r.BitrixSentAt, &r.ActualQty, &r.ActualAmount, &r.AcceptedAt, &r.AcceptedByID, &r.PaymentDocumentID,
			&r.CreatedByID, &r.CreatedAt, &r.UpdatedAt, &r.Note, &ctID, &ctName, &ctBin, &rr.doNumber, &rr.doTotal); err != nil {
			rows.Close()
			dbErr(c, err)
			return
		}
		r.RoutingStage = models.RoutingStageDBToAPI(stage)
		if ctID != nil {
			rr.contractor = &contractorBrief{ID: *ctID, Name: *ctName, BinIin: ctBin}
		}
		list = append(list, rr)
		ids = append(ids, r.ID)
	}
	rows.Close()
	works, err := loadWorkBriefs(ctx, h.pool, ids)
	if err != nil {
		dbErr(c, err)
		return
	}

	// «Ждём ответа от 1С» должно заканчиваться сигналом: по отправленным
	// заявкам ищем свежие непривязанные ДО их подрядчиков
	hasBin := func(rr reqRow) bool {
		return rr.r.BitrixSentAt.Valid && rr.r.PaymentDocumentID == nil && rr.contractor != nil && rr.contractor.BinIin != nil && *rr.contractor.BinIin != ""
	}
	var bins []string
	seen := map[string]bool{}
	for _, rr := range list {
		if hasBin(rr) && !seen[*rr.contractor.BinIin] {
			seen[*rr.contractor.BinIin] = true
			bins = append(bins, *rr.contractor.BinIin)
		}
	}
	type freshDoc struct {
		doNumber string
		doDate   *time.Time
		total    decimal.Decimal
		bin      string
	}
	var fresh []freshDoc
	if len(bins) > 0 {
		drows, err := h.pool.Query(ctx, "SELECT pd.do_number, pd.do_date, pd.total_amount, cu.bin_iin FROM payment_documents pd JOIN customers cu ON cu.id = pd.contractor_id LEFT JOIN contractor_requests cr ON cr.payment_document_id = pd.id WHERE cr.id IS NULL AND cu.bin_iin = ANY($1) ORDER BY pd.do_date DESC", bins)
		if err != nil {
			dbErr(c, err)
			return
		}
		for drows.Next() {
			var d freshDoc
			if err := drows.Scan(&d.doNumber, &d.doDate, &d.total, &d.bin); err != nil {
				drows.Close()
				dbErr(c, err)
				return
			}
			fresh = append(fresh, d)
		}
		drows.Close()
	}

	nowMs := time.Now().UnixMilli()
	data := make([]gin.H, 0, len(list))
	unallocReq, unallocAmount := 0, 0.0
	for _, rr := range list {
		m := allocationSummary(rr.r, rr.contractor, works[rr.r.ID], nowMs)
		if rr.doNumber != nil {
			m["supplierDoc"] = gin.H{"doNumber": *rr.doNumber, "totalAmount": rr.doTotal.InexactFloat64()}
		} else {
			m["supplierDoc"] = nil
		}
		m["candidateDoc"] = nil
		if hasBin(rr) {
			for _, d := range fresh {
				// ДО свежее отправки в Б24 — похоже, это ответ 1С на эту заявку
				if d.bin == *rr.contractor.BinIin && (d.doDate == nil || d.doDate.UnixMilli() >= rr.r.BitrixSentAt.Time.UnixMilli()-86400000) {
					m["candidateDoc"] = gin.H{"doNumber": d.doNumber, "totalAmount": d.total.InexactFloat64()}
					break
				}
			}
		}
		if m["needsAllocation"].(bool) {
			unallocReq++
			unallocAmount += m["unallocatedAmount"].(float64)
		}
		data = append(data, m)
	}
	c.JSON(http.StatusOK, gin.H{
		"data":        data,
		"unallocated": gin.H{"requests": unallocReq, "amount": round2(unallocAmount)},
		"total":       len(data),
	})
}

// FindOne — GET /contractor-requests/:id — со строками разнесения и сверкой
// с актами 1С на уровне ПОДРЯДЧИКА (акт существует именно там).
func (h *ContractorRequestsHandler) FindOne(c *gin.Context) {
	id := c.Param("id")
	req, ok := h.getRequest(c, id)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	contractor, err := h.contractorBrief(c, req.ContractorID)
	if err != nil {
		dbErr(c, err)
		return
	}
	var supplierDoc interface{}
	if req.PaymentDocumentID != nil {
		var pid, num string
		var date common.PDate
		var total decimal.Decimal
		err := h.pool.QueryRow(ctx, "SELECT id, do_number, do_date, total_amount FROM payment_documents WHERE id = $1", *req.PaymentDocumentID).Scan(&pid, &num, &date, &total)
		if err == nil {
			supplierDoc = gin.H{"id": pid, "doNumber": num, "doDate": date, "totalAmount": total.InexactFloat64()}
		} else if err != pgx.ErrNoRows {
			dbErr(c, err)
			return
		}
	}

	wrows, err := h.pool.Query(ctx, "SELECT w.id, w.order_id, w.order_line_id, w.share, w.actual_qty, w.actual_amount, w.planned_hours, w.decided_at, w.accepted_at, o.id, o.order_number, o.status, o.planned_shipment_date FROM contractor_works w LEFT JOIN orders o ON o.id = w.order_id WHERE w.request_id = $1 ORDER BY w.decided_at ASC", id)
	if err != nil {
		dbErr(c, err)
		return
	}
	var briefs []workBrief
	works := []gin.H{}
	for wrows.Next() {
		var w workBrief
		var decidedAt, acceptedAt, planned common.PDate
		var oid, onum, ostatus *string
		if err := wrows.Scan(&w.ID, &w.OrderID, &w.OrderLineID, &w.Share, &w.ActualQty, &w.ActualAmount, &w.PlannedHours, &decidedAt, &acceptedAt, &oid, &onum, &ostatus, &planned); err != nil {
			wrows.Close()
			dbErr(c, err)
			return
		}
		var order interface{}
		if oid != nil {
			oj := gin.H{"id": *oid, "orderNumber": *onum, "status": *ostatus, "plannedShipmentDate": planned}
			w.Order = &orderBrief{ID: *oid, JSON: oj}
			order = oj
		}
		briefs = append(briefs, w)
		works = append(works, gin.H{
			"id": w.ID, "order": order, "share": w.Share.InexactFloat64(), "qty": fnum(w.ActualQty), "amount": fnum(w.ActualAmount),
			"plannedHours": fnum(w.PlannedHours), "decidedAt": decidedAt, "acceptedAt": acceptedAt,
		})
	}
	wrows.Close()

	acts := []gin.H{}
	if contractor != nil && contractor.BinIin != nil && *contractor.BinIin != "" {
		arows, err := h.pool.Query(ctx, "SELECT pd.id, pd.do_number, pd.do_date, pd.total_amount, pd.order_id, cr.id, cr.number FROM payment_documents pd JOIN customers cu ON cu.id = pd.contractor_id LEFT JOIN contractor_requests cr ON cr.payment_document_id = pd.id WHERE cu.bin_iin = $1 ORDER BY pd.do_date DESC LIMIT 20", *contractor.BinIin)
		if err != nil {
			dbErr(c, err)
			return
		}
		for arows.Next() {
			var aid, num string
			var date common.PDate
			var total decimal.Decimal
			var orderID, crID, crNum *string
			if err := arows.Scan(&aid, &num, &date, &total, &orderID, &crID, &crNum); err != nil {
				arows.Close()
				dbErr(c, err)
				return
			}
			var linked *string
			// Занят другой заявкой — в кандидаты приёмки не годится
			if crID != nil && *crID != req.ID {
				linked = crNum
			}
			acts = append(acts, gin.H{"id": aid, "doNumber": num, "doDate": date, "totalAmount": total.InexactFloat64(), "orderId": orderID, "linkedRequestNumber": linked})
		}
		arows.Close()
	}

	m := allocationSummary(req, contractor, briefs, time.Now().UnixMilli())
	m["supplierDoc"] = supplierDoc
	m["description"] = req.Description
	m["note"] = req.Note
	m["works"] = works
	m["supplierActs"] = acts
	c.JSON(http.StatusOK, m)
}

type createRequestBody struct {
	RoutingStage    string          `json:"routingStage"`
	Description     *string         `json:"description"`
	RateType        *string         `json:"rateType"`
	PlannedQty      json.RawMessage `json:"plannedQty"`
	Rate            json.RawMessage `json:"rate"`
	EstimatedAmount json.RawMessage `json:"estimatedAmount"`
	ContractorID    *string         `json:"contractorId"`
	WorkLocation    *string         `json:"workLocation"`
	PlannedHours    json.RawMessage `json:"plannedHours"`
	Note            *string         `json:"note"`
}

func positiveOrNil(raw json.RawMessage) *float64 {
	v := jsNumber(raw)
	if v > 0 {
		return &v
	}
	return nil
}

// Create — POST /contractor-requests — заказ и подрядчик ещё не известны.
func (h *ContractorRequestsHandler) Create(c *gin.Context) {
	var body createRequestBody
	_ = c.ShouldBindJSON(&body)
	if !contractorStages[body.RoutingStage] {
		common.BadRequest(c, "INVALID_STAGE", "Вид работ: CUTTING, ASSEMBLY или PAINTING; получено "+body.RoutingStage)
		return
	}
	description := trimOrNil(body.Description)
	if description == nil {
		common.BadRequest(c, "DESCRIPTION_REQUIRED", "Опишите работу словами — по этому тексту её будут искать в Б24")
		return
	}
	rateType := "PER_UNIT"
	if body.RateType != nil {
		rateType = *body.RateType
	}
	if !rateTypes[rateType] {
		common.BadRequest(c, "INVALID_RATE_TYPE", "Неизвестный тип ставки: "+rateType)
		return
	}
	workLocation := "CONTRACTOR_SITE"
	if body.WorkLocation != nil {
		workLocation = *body.WorkLocation
	}
	if workLocation == "OUR_SHOP" && rateType != "PER_HOUR" && !(jsNumber(body.PlannedHours) > 0) {
		common.BadRequest(c, "SHOP_HOURS_ESTIMATE_REQUIRED", "Работы идут в нашем цеху по сдельной ставке — нужна оценка часов на всю партию")
		return
	}
	ctx := c.Request.Context()
	var contractorID *string
	if body.ContractorID != nil && *body.ContractorID != "" {
		var exists string
		if err := h.pool.QueryRow(ctx, "SELECT id FROM contractors WHERE id = $1", *body.ContractorID).Scan(&exists); err == pgx.ErrNoRows {
			common.NotFound(c, "Подрядчик не найден")
			return
		} else if err != nil {
			dbErr(c, err)
			return
		}
		contractorID = body.ContractorID
	}
	user := authpkg.CurrentUser(c)

	// Ретрай на занятый номер: двое заводят заявку одновременно — оба читают
	// тот же максимум; на пятой неудаче — как в оригинале, ошибка наружу
	for attempt := 0; attempt < 5; attempt++ {
		number, err := h.nextNumber(c)
		if err != nil {
			dbErr(c, err)
			return
		}
		row, err := scanContractorRequest(h.pool.QueryRow(ctx, "INSERT INTO contractor_requests AS r (id, number, routing_stage, description, rate_type, planned_qty, rate, estimated_amount, contractor_id, work_location, planned_hours, note, created_by_id, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()) RETURNING "+crCols,
			uuid.NewString(), number, models.RoutingStageAPIToDB(body.RoutingStage), *description, rateType, positiveOrNil(body.PlannedQty), positiveOrNil(body.Rate),
			positiveOrNil(body.EstimatedAmount), contractorID, workLocation, positiveOrNil(body.PlannedHours), trimOrNil(body.Note), dbUserID(user.UserID)))
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" && attempt < 4 {
				continue
			}
			dbErr(c, err)
			return
		}
		m, err := h.withContractor(c, row)
		if err != nil {
			dbErr(c, err)
			return
		}
		c.JSON(http.StatusCreated, m)
		return
	}
}

// Update — PATCH /contractor-requests/:id — проставить подрядчика и ставку
// (их назвали в Б24); уже разнесённые строки узнают об этом.
func (h *ContractorRequestsHandler) Update(c *gin.Context) {
	id := c.Param("id")
	body := rawBody{}
	_ = json.NewDecoder(c.Request.Body).Decode(&body)
	req, ok := h.getRequest(c, id)
	if !ok {
		return
	}
	if req.Status == "CANCELLED" {
		common.Conflict(c, "REQUEST_CANCELLED", "Заявка отменена")
		return
	}
	ctx := c.Request.Context()
	worksMap, err := loadWorkBriefs(ctx, h.pool, []string{id})
	if err != nil {
		dbErr(c, err)
		return
	}
	works := worksMap[id]

	rateTypeIn, hasRT := body.truthyStr("rateType")
	if hasRT && !rateTypes[rateTypeIn] {
		common.BadRequest(c, "INVALID_RATE_TYPE", "Неизвестный тип ставки: "+rateTypeIn)
		return
	}
	// Тип ставки после разнесения менять нельзя: единицы объёма уже записаны
	if hasRT && rateTypeIn != req.RateType && len(works) > 0 {
		common.Conflict(c, "RATE_TYPE_LOCKED", "Заявка уже разнесена на "+itoa(len(works))+" заказов — тип ставки не изменить, снимите разнесение")
		return
	}
	contractorIn, hasContractor := body.truthyStr("contractorId")
	if hasContractor {
		var exists string
		if err := h.pool.QueryRow(ctx, "SELECT id FROM contractors WHERE id = $1", contractorIn).Scan(&exists); err == pgx.ErrNoRows {
			common.NotFound(c, "Подрядчик не найден")
			return
		} else if err != nil {
			dbErr(c, err)
			return
		}
	}

	workLocation := req.WorkLocation
	if v, ok := body.str("workLocation"); ok {
		workLocation = v
	}
	rateType := req.RateType
	if v, ok := body.str("rateType"); ok {
		rateType = v
	}
	plannedHours := fnum(req.PlannedHours)
	if body.has("plannedHours") {
		plannedHours = positiveOrNil(body["plannedHours"])
	}
	if workLocation == "OUR_SHOP" && rateType != "PER_HOUR" && !(plannedHours != nil && *plannedHours > 0) {
		common.BadRequest(c, "SHOP_HOURS_ESTIMATE_REQUIRED", "Работы в нашем цеху по сдельной ставке — нужна оценка часов на всю партию")
		return
	}

	set, args := []string{"updated_at = now()"}, []interface{}{}
	add := func(col string, v interface{}) {
		args = append(args, v)
		set = append(set, col+" = $"+itoa(len(args)))
	}
	if body.has("contractorId") {
		if hasContractor {
			add("contractor_id", contractorIn)
		} else {
			add("contractor_id", nil)
		}
	}
	if body.has("rate") {
		add("rate", positiveOrNil(body["rate"]))
	}
	if hasRT {
		add("rate_type", rateTypeIn)
	}
	if body.has("plannedQty") {
		add("planned_qty", positiveOrNil(body["plannedQty"]))
	}
	if body.has("estimatedAmount") {
		add("estimated_amount", positiveOrNil(body["estimatedAmount"]))
	}
	if body.has("plannedHours") {
		add("planned_hours", plannedHours)
	}
	if d, ok := body.str("description"); ok && strings.TrimSpace(d) != "" {
		add("description", strings.TrimSpace(d))
	}
	if body.has("note") {
		if n, ok := body.str("note"); ok {
			add("note", trimOrNil(&n))
		} else {
			add("note", nil)
		}
	}
	workLocationIn, hasWL := body.truthyStr("workLocation")
	if hasWL {
		add("work_location", workLocationIn)
	}
	args = append(args, id)
	updated, err := scanContractorRequest(h.pool.QueryRow(ctx, "UPDATE contractor_requests AS r SET "+strings.Join(set, ", ")+" WHERE id = $"+itoa(len(args))+" RETURNING "+crCols, args...))
	if err != nil {
		dbErr(c, err)
		return
	}
	out, err := h.withContractor(c, updated)
	if err != nil {
		dbErr(c, err)
		return
	}

	// Ставка и подрядчик проставлены задним числом — уже разнесённые строки
	// должны узнать об этом, иначе подряд останется в расчёте по старой цене
	if len(works) > 0 {
		pset, pargs := []string{}, []interface{}{}
		padd := func(col string, v interface{}) {
			pargs = append(pargs, v)
			pset = append(pset, col+" = $"+itoa(len(pargs)))
		}
		if hasContractor {
			padd("contractor_id", contractorIn)
		}
		if body.has("rate") && body.num("rate") > 0 && updated.RateType != "FIXED" {
			padd("rate", body.num("rate"))
		}
		if hasWL {
			padd("work_location", workLocationIn)
		}
		if len(pset) > 0 {
			pargs = append(pargs, id)
			if _, err := h.pool.Exec(ctx, "UPDATE contractor_works SET "+strings.Join(pset, ", ")+" WHERE request_id = $"+itoa(len(pargs)), pargs...); err != nil {
				dbErr(c, err)
				return
			}
		}
		if _, err := redistribute(ctx, h.pool, id); err != nil {
			dbErr(c, err)
			return
		}
	}
	c.JSON(http.StatusOK, out)
}

// SendToBitrix — POST /contractor-requests/send-to-bitrix — пачка заявок →
// ОДНА сделка воронки «Заказ на Работы». Нет вебхука — честная ошибка.
func (h *ContractorRequestsHandler) SendToBitrix(c *gin.Context) {
	var body struct {
		IDs []string `json:"ids"`
	}
	_ = c.ShouldBindJSON(&body)
	if len(body.IDs) == 0 {
		common.BadRequest(c, "EMPTY_SELECTION", "Не выбрано ни одной заявки")
		return
	}
	ctx := c.Request.Context()
	rows, err := h.pool.Query(ctx, "SELECT "+crCols+", ct.name FROM contractor_requests r LEFT JOIN contractors ct ON ct.id = r.contractor_id WHERE r.id = ANY($1) AND r.status = 'DRAFT'", body.IDs)
	if err != nil {
		dbErr(c, err)
		return
	}
	var ids []string
	var lines []bitrix.WorksLine
	total := 0.0
	for rows.Next() {
		var r contractorRequestRow
		var stage string
		var ctName *string
		if err := rows.Scan(&r.ID, &r.Number, &stage, &r.Description, &r.RateType, &r.PlannedQty, &r.Rate, &r.EstimatedAmount, &r.ContractorID, &r.WorkLocation,
			&r.PlannedHours, &r.Status, &r.BitrixDealID, &r.BitrixSentAt, &r.ActualQty, &r.ActualAmount, &r.AcceptedAt, &r.AcceptedByID, &r.PaymentDocumentID,
			&r.CreatedByID, &r.CreatedAt, &r.UpdatedAt, &r.Note, &ctName); err != nil {
			rows.Close()
			dbErr(c, err)
			return
		}
		r.RoutingStage = models.RoutingStageDBToAPI(stage)
		ids = append(ids, r.ID)
		var estimate *float64
		if r.EstimatedAmount != nil {
			estimate = fnum(r.EstimatedAmount)
		} else if r.PlannedQty != nil && r.Rate != nil {
			v := r.PlannedQty.InexactFloat64() * r.Rate.InexactFloat64()
			estimate = &v
		}
		if estimate != nil {
			total += *estimate
		}
		lines = append(lines, bitrix.WorksLine{
			Number: r.Number, StageLabel: stageLabel(r.RoutingStage), Description: r.Description,
			Qty: fnum(r.PlannedQty), Unit: rateUnits[r.RateType], Rate: fnum(r.Rate), Estimate: estimate,
			AtOurShop: r.WorkLocation == "OUR_SHOP", ContractorName: ctName,
		})
	}
	rows.Close()
	if len(ids) == 0 {
		common.BadRequest(c, "NOTHING_TO_SEND", "Среди выбранных нет заявок в статусе «черновик»")
		return
	}
	title := "Заказ на работы: " + itoa(len(lines)) + " заявок"
	if total > 0 {
		title += " на " + common.FmtRu(common.JsRound(total)) + " ₸"
	}
	user := authpkg.CurrentUser(c)
	requestedBy := user.Email
	if requestedBy == "" && len(user.Roles) > 0 {
		requestedBy = user.Roles[0]
	}
	dealID, err := bitrix.CreateWorksRequestDeal(ctx, title, lines, total, requestedBy)
	if err != nil {
		common.BadRequest(c, "BITRIX_SEND_FAILED", err.Error())
		return
	}
	if _, err := h.pool.Exec(ctx, "UPDATE contractor_requests SET status = 'SENT', bitrix_deal_id = $1, bitrix_sent_at = now(), updated_at = now() WHERE id = ANY($2)", dealID, ids); err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"sent": len(ids), "dealId": dealID, "totalEstimate": common.JsRound(total)})
}

type allocateBody struct {
	OrderID     string   `json:"orderId"`
	OrderLineID *string  `json:"orderLineId"`
	Qty         *float64 `json:"qty"`
	Share       *float64 `json:"share"`
	Note        *string  `json:"note"`
}

func unitOr(rateType, def string) string {
	if u, ok := rateUnits[rateType]; ok {
		return u
	}
	return def
}

// Allocate — POST /contractor-requests/:id/allocate — «из ПОДР-007 на этот
// заказ ушло 3,2 т». Повтор по паре «заявка + заказ + позиция» ОБНОВЛЯЕТ строку.
func (h *ContractorRequestsHandler) Allocate(c *gin.Context) {
	id := c.Param("id")
	var body allocateBody
	_ = c.ShouldBindJSON(&body)
	req, ok := h.getRequest(c, id)
	if !ok {
		return
	}
	if req.Status == "CANCELLED" {
		common.Conflict(c, "REQUEST_CANCELLED", "Заявка отменена — разносить нечего")
		return
	}
	// Без подрядчика и ставки строка встала бы в расчёт нулём
	if req.ContractorID == nil {
		common.BadRequest(c, "CONTRACTOR_REQUIRED", "Укажите в заявке, кто выполнил работу — иначе она встанет в 0 ₸")
		return
	}
	hasPrice := fval(req.Rate) > 0
	if req.RateType == "FIXED" {
		hasPrice = fval(req.EstimatedAmount) > 0 || fval(req.ActualAmount) > 0
	}
	if !hasPrice {
		msg := "Укажите в заявке ставку — иначе работа встанет в 0 ₸"
		if req.RateType == "FIXED" {
			msg = "Укажите в заявке сумму — иначе работа встанет в 0 ₸"
		}
		common.BadRequest(c, "RATE_REQUIRED", msg)
		return
	}
	qty := math.NaN()
	if body.Qty != nil {
		qty = *body.Qty
	}
	if !(qty > 0) {
		common.BadRequest(c, "QTY_REQUIRED", "Сколько ушло на этот заказ? Объём в "+unitOr(req.RateType, "единицах ставки"))
		return
	}
	share := 1.0
	if body.Share != nil {
		share = *body.Share
	}
	if !(share > 0) || share > 1 {
		common.BadRequest(c, "INVALID_SHARE", "Доля вида работ — больше нуля и не больше единицы")
		return
	}
	ctx := c.Request.Context()
	var orderNumber string
	if err := h.pool.QueryRow(ctx, "SELECT order_number FROM orders WHERE id = $1", body.OrderID).Scan(&orderNumber); err == pgx.ErrNoRows {
		common.NotFound(c, "Заказ "+body.OrderID+" не найден")
		return
	} else if err != nil {
		dbErr(c, err)
		return
	}
	if body.OrderLineID != nil && *body.OrderLineID != "" {
		var lineOrder string
		err := h.pool.QueryRow(ctx, "SELECT order_id FROM order_lines WHERE id = $1", *body.OrderLineID).Scan(&lineOrder)
		if err != nil && err != pgx.ErrNoRows {
			dbErr(c, err)
			return
		}
		if err == pgx.ErrNoRows || lineOrder != body.OrderID {
			common.BadRequest(c, "LINE_MISMATCH", "Позиция не из этого заказа")
			return
		}
	}
	worksMap, err := loadWorkBriefs(ctx, h.pool, []string{id})
	if err != nil {
		dbErr(c, err)
		return
	}
	works := worksMap[id]
	var lineKey *string
	if body.OrderLineID != nil && *body.OrderLineID != "" {
		lineKey = body.OrderLineID
	}
	sameKey := func(w workBrief) bool {
		if w.OrderID != body.OrderID {
			return false
		}
		if w.OrderLineID == nil || lineKey == nil {
			return w.OrderLineID == nil && lineKey == nil
		}
		return *w.OrderLineID == *lineKey
	}

	// Принято 12 т — разнести 15 нельзя: подряд посчитался бы дважды
	if req.ActualQty != nil {
		others := 0.0
		for _, w := range works {
			if !sameKey(w) {
				others += fval(w.ActualQty)
			}
		}
		actual := req.ActualQty.InexactFloat64()
		if others+qty > actual+1e-6 {
			common.BadRequest(c, "QTY_OVERFLOW", "По заявке принято "+jsNum(actual)+" "+rateUnits[req.RateType]+", уже разнесено "+jsNum(round3(others))+" — свободно "+jsNum(round3(actual-others)))
			return
		}
	}
	var existingID *string
	for _, w := range works {
		if sameKey(w) {
			eid := w.ID
			existingID = &eid
			break
		}
	}

	// Больше целого вида работ отдать нельзя — на обоих уровнях
	cw := &ContractorWorkHandler{pool: h.pool}
	stageDB := models.RoutingStageAPIToDB(req.RoutingStage)
	taken, err := cw.takenShare(c, body.OrderID, stageDB, existingID, lineKey)
	if err != nil {
		dbErr(c, err)
		return
	}
	if taken+share > 1.0001 {
		common.BadRequest(c, "SHARE_OVERFLOW", "Уже отдано "+jsNum(common.JsRound(taken*100))+" % работ этого вида по заказу "+orderNumber+", свободно "+jsNum(common.JsRound(math.Max(0, 1-taken)*100))+" %")
		return
	}

	// FIXED получит поделённую сумму в redistribute; остальным ставка заявки
	// годится как есть — объём делит деньги сам
	rate := fval(req.Rate)
	if req.RateType == "FIXED" {
		rate = 0
	}
	user := authpkg.CurrentUser(c)
	decidedBy := dbUserID(user.UserID)
	var workID string
	if existingID != nil {
		err = h.pool.QueryRow(ctx, "UPDATE contractor_works SET share = $1, rate_type = $2, rate = $3, work_location = $4, contractor_id = $5, actual_qty = $6, note = $7, decided_by_id = $8, decided_at = now(), order_line_id = $9 WHERE id = $10 RETURNING id",
			share, req.RateType, rate, req.WorkLocation, *req.ContractorID, qty, trimOrNil(body.Note), decidedBy, lineKey, *existingID).Scan(&workID)
	} else {
		err = h.pool.QueryRow(ctx, "INSERT INTO contractor_works (id, order_id, order_line_id, routing_stage, contractor_id, share, rate_type, rate, work_location, actual_qty, note, decided_by_id, decided_at, request_id, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$14) RETURNING id",
			uuid.NewString(), body.OrderID, lineKey, stageDB, *req.ContractorID, share, req.RateType, rate, req.WorkLocation, qty, trimOrNil(body.Note), decidedBy, id, "Заявка на подряд "+req.Number).Scan(&workID)
	}
	if err != nil {
		dbErr(c, err)
		return
	}
	rowsN, err := redistribute(ctx, h.pool, id)
	if err != nil {
		dbErr(c, err)
		return
	}
	if req.Status == "DRAFT" || req.Status == "SENT" || req.Status == "ACCEPTED" {
		status := req.Status
		if req.AcceptedAt.Valid {
			status = "ALLOCATED"
		}
		if _, err := h.pool.Exec(ctx, "UPDATE contractor_requests SET status = $1, updated_at = now() WHERE id = $2", status, id); err != nil {
			dbErr(c, err)
			return
		}
	}

	var actualQty, plannedQty *decimal.Decimal
	var allocated decimal.NullDecimal
	if err := h.pool.QueryRow(ctx, "SELECT r.actual_qty, r.planned_qty, (SELECT sum(coalesce(w.actual_qty, 0)) FROM contractor_works w WHERE w.request_id = r.id) FROM contractor_requests r WHERE r.id = $1", id).Scan(&actualQty, &plannedQty, &allocated); err != nil {
		dbErr(c, err)
		return
	}
	// Σ Number(actualQty ?? 0) по строкам — в float, как в оригинале
	sumAllocated := 0.0
	if allocated.Valid {
		sumAllocated = h.sumWorksQty(c, id)
	}
	var remaining *float64
	if actualQty != nil {
		v := round3(actualQty.InexactFloat64() - sumAllocated)
		remaining = &v
	} else if plannedQty != nil {
		v := round3(plannedQty.InexactFloat64() - sumAllocated)
		remaining = &v
	}
	recalculated := 0
	if rowsN > 1 {
		recalculated = rowsN
	}
	c.JSON(http.StatusCreated, gin.H{
		"workId": workID, "orderNumber": orderNumber, "qty": qty, "unit": rateUnits[req.RateType],
		"stageLabel": stageLabel(req.RoutingStage), "recalculatedRows": recalculated, "remainingQty": remaining,
	})
}

func (h *ContractorRequestsHandler) sumWorksQty(c *gin.Context, requestID string) float64 {
	rows, err := h.pool.Query(c.Request.Context(), "SELECT actual_qty FROM contractor_works WHERE request_id = $1", requestID)
	if err != nil {
		return 0
	}
	defer rows.Close()
	sum := 0.0
	for rows.Next() {
		var q *decimal.Decimal
		if rows.Scan(&q) == nil {
			sum += fval(q)
		}
	}
	return sum
}

// RemoveAllocation — DELETE /contractor-requests/:id/allocations/:workId
func (h *ContractorRequestsHandler) RemoveAllocation(c *gin.Context) {
	id, workID := c.Param("id"), c.Param("workId")
	ctx := c.Request.Context()
	var reqID *string
	err := h.pool.QueryRow(ctx, "SELECT request_id FROM contractor_works WHERE id = $1", workID).Scan(&reqID)
	if err != nil && err != pgx.ErrNoRows {
		dbErr(c, err)
		return
	}
	if err == pgx.ErrNoRows || reqID == nil || *reqID != id {
		common.NotFound(c, "Разнесение не найдено в этой заявке")
		return
	}
	if _, err := h.pool.Exec(ctx, "DELETE FROM contractor_works WHERE id = $1", workID); err != nil {
		dbErr(c, err)
		return
	}
	rowsN, err := redistribute(ctx, h.pool, id)
	if err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true, "recalculatedRows": rowsN})
}

// Accept — POST /contractor-requests/:id/accept — приёмка партии целиком:
// сумма замораживается и делится между заказами пропорционально объёму.
func (h *ContractorRequestsHandler) Accept(c *gin.Context) {
	id := c.Param("id")
	body := rawBody{}
	_ = json.NewDecoder(c.Request.Body).Decode(&body)
	req, ok := h.getRequest(c, id)
	if !ok {
		return
	}
	if req.Status == "CANCELLED" {
		common.Conflict(c, "REQUEST_CANCELLED", "Заявка отменена")
		return
	}
	qty := body.num("actualQty")
	if !(qty > 0) {
		common.BadRequest(c, "INVALID_QTY", "Укажите принятый объём")
		return
	}
	ctx := c.Request.Context()
	contractor, err := h.contractorBrief(c, req.ContractorID)
	if err != nil {
		dbErr(c, err)
		return
	}
	worksMap, err := loadWorkBriefs(ctx, h.pool, []string{id})
	if err != nil {
		dbErr(c, err)
		return
	}
	works := worksMap[id]

	// Приёмка по ДО из 1С: его сумма и раскидывается по заказам
	type docInfo struct {
		id, number string
		total      decimal.Decimal
	}
	var doc *docInfo
	if pdID, ok := body.truthyStr("paymentDocumentId"); ok {
		var d docInfo
		var bin, cuName string
		var crID, crNum *string
		err := h.pool.QueryRow(ctx, "SELECT pd.id, pd.do_number, pd.total_amount, cu.bin_iin, cu.name, cr.id, cr.number FROM payment_documents pd JOIN customers cu ON cu.id = pd.contractor_id LEFT JOIN contractor_requests cr ON cr.payment_document_id = pd.id WHERE pd.id = $1", pdID).
			Scan(&d.id, &d.number, &d.total, &bin, &cuName, &crID, &crNum)
		if err == pgx.ErrNoRows {
			common.NotFound(c, "Заказ поставщику не найден")
			return
		} else if err != nil {
			dbErr(c, err)
			return
		}
		// Один ДО — одна заявка: иначе одна сумма 1С разнеслась бы дважды
		if crID != nil && *crID != id {
			common.Conflict(c, "DOC_TAKEN", "ДО "+d.number+" уже привязан к заявке "+*crNum)
			return
		}
		if contractor != nil && contractor.BinIin != nil && *contractor.BinIin != "" && bin != "" && *contractor.BinIin != bin {
			name := "—"
			if contractor != nil {
				name = contractor.Name
			}
			common.BadRequest(c, "DOC_CONTRACTOR_MISMATCH", "ДО "+d.number+" — контрагент «"+cuName+"», а в заявке подрядчик «"+name+"»")
			return
		}
		doc = &d
	}

	amount := math.NaN()
	amountGiven := false
	if raw, ok := body["actualAmount"]; ok && strings.TrimSpace(string(raw)) != "null" {
		amount = jsNumber(raw)
		amountGiven = true
	} else if doc != nil {
		amount = doc.total.InexactFloat64()
	}
	if !(amount >= 0) {
		msg := "Сумма акта не может быть отрицательной"
		if doc == nil && !amountGiven {
			msg = "Укажите сумму или выберите заказ поставщику из 1С"
		}
		common.BadRequest(c, "INVALID_AMOUNT", msg)
		return
	}
	// Разнесли 15 т, принимаем 12 — пусть человек сначала поправит разнесение
	allocated := 0.0
	for _, w := range works {
		allocated += fval(w.ActualQty)
	}
	if allocated > qty+1e-6 {
		common.Conflict(c, "ALLOCATED_EXCEEDS_ACT", "По заказам разнесено "+jsNum(round3(allocated))+" "+rateUnits[req.RateType]+", а принимается "+jsNum(qty)+" — поправьте разнесение")
		return
	}

	status := "ACCEPTED"
	if len(works) > 0 && allocated >= qty-1e-6 {
		status = "ALLOCATED"
	}
	user := authpkg.CurrentUser(c)
	acceptedBy := dbUserID(user.UserID)
	note := req.Note
	if n, ok := body.str("note"); ok {
		if t := trimOrNil(&n); t != nil {
			note = t
		}
	}
	set, args := []string{"accepted_at = now()", "updated_at = now()"}, []interface{}{}
	add := func(col string, v interface{}) {
		args = append(args, v)
		set = append(set, col+" = $"+itoa(len(args)))
	}
	add("actual_qty", qty)
	add("actual_amount", amount)
	add("accepted_by_id", acceptedBy)
	add("status", status)
	// Смена основания: новый ДО заменяет старый, отвязка — только с ДО
	if body.has("paymentDocumentId") {
		if doc != nil {
			add("payment_document_id", doc.id)
		} else {
			add("payment_document_id", nil)
		}
	}
	add("note", note)
	args = append(args, id)
	if _, err := h.pool.Exec(ctx, "UPDATE contractor_requests SET "+strings.Join(set, ", ")+" WHERE id = $"+itoa(len(args)), args...); err != nil {
		dbErr(c, err)
		return
	}
	if len(works) > 0 {
		if _, err := h.pool.Exec(ctx, "UPDATE contractor_works SET accepted_at = now(), accepted_by_id = $1 WHERE request_id = $2", acceptedBy, id); err != nil {
			dbErr(c, err)
			return
		}
	}
	rowsN, err := redistribute(ctx, h.pool, id)
	if err != nil {
		dbErr(c, err)
		return
	}

	split := []gin.H{}
	srows, err := h.pool.Query(ctx, "SELECT o.order_number, w.actual_qty, w.actual_amount FROM contractor_works w JOIN orders o ON o.id = w.order_id WHERE w.request_id = $1", id)
	if err != nil {
		dbErr(c, err)
		return
	}
	for srows.Next() {
		var num string
		var q, a *decimal.Decimal
		if err := srows.Scan(&num, &q, &a); err != nil {
			srows.Close()
			dbErr(c, err)
			return
		}
		split = append(split, gin.H{"orderNumber": num, "qty": fval(q), "amount": fval(a)})
	}
	srows.Close()
	var docNumber *string
	if doc != nil {
		docNumber = &doc.number
	}
	c.JSON(http.StatusCreated, gin.H{
		"accepted": true, "actualQty": qty, "actualAmount": amount, "supplierDocNumber": docNumber,
		"allocatedRows": rowsN, "split": split, "unallocatedQty": round3(qty - allocated),
	})
}

// Cancel — POST /contractor-requests/:id/cancel (нельзя, если уже разнесена).
func (h *ContractorRequestsHandler) Cancel(c *gin.Context) {
	id := c.Param("id")
	if _, ok := h.getRequest(c, id); !ok {
		return
	}
	ctx := c.Request.Context()
	var n int
	if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM contractor_works WHERE request_id = $1", id).Scan(&n); err != nil {
		dbErr(c, err)
		return
	}
	if n > 0 {
		common.Conflict(c, "HAS_ALLOCATIONS", "Заявка разнесена на "+itoa(n)+" заказов — сначала снимите разнесение")
		return
	}
	row, err := scanContractorRequest(h.pool.QueryRow(ctx, "UPDATE contractor_requests AS r SET status = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING "+crCols, id))
	if err != nil {
		dbErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, crRaw(row))
}
