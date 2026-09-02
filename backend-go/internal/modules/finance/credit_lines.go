package finance

import (
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"cmk-avrora-erp/backend-go/internal/common"
)

// Перенос credit-lines.controller.ts — кредитные линии ДАМУ (только чтение).
type CreditLinesHandler struct{ pool *pgxpool.Pool }

func NewCreditLinesHandler(pool *pgxpool.Pool) *CreditLinesHandler {
	return &CreditLinesHandler{pool: pool}
}

// FindAll — GET /credit-lines (accountant/director/admin).
func (h *CreditLinesHandler) FindAll(c *gin.Context) {
	ctx := c.Request.Context()
	lrows, err := h.pool.Query(ctx, "SELECT id, name, contract_number, limit_amount, used_amount, available_amount, interest_rate_pct, as_of_date, source_file FROM credit_lines ORDER BY name ASC")
	if err != nil {
		respondErr(c, err)
		return
	}
	type line struct {
		ID, Name, Contract, SourceFile string
		Limit, Used, Available, Rate   float64
		AsOf                           common.PDate
	}
	var lines []line
	for lrows.Next() {
		var l line
		if err := lrows.Scan(&l.ID, &l.Name, &l.Contract, &l.Limit, &l.Used, &l.Available, &l.Rate, &l.AsOf, &l.SourceFile); err != nil {
			lrows.Close()
			respondErr(c, err)
			return
		}
		lines = append(lines, l)
	}
	lrows.Close()

	// today = локальная полночь (setHours(0,0,0,0) в TZ сервера — Node и Go на одной машине)
	now := time.Now().In(time.Local)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)

	type sched struct {
		ID, TrancheID              string
		DueDate                    common.PDate
		Total, Principal, Interest decimal.Decimal
		Contract                   string
	}
	out := []gin.H{}
	for _, l := range lines {
		srows, err := h.pool.Query(ctx, `SELECT s.id, s.tranche_id, s.due_date, s.total_amount, s.principal_amount, s.interest_amount, t.contract_number
			FROM credit_tranches t JOIN credit_schedule_entries s ON s.tranche_id = t.id
			WHERE t.credit_line_id = $1 ORDER BY t.start_date ASC, s.due_date ASC`, l.ID)
		if err != nil {
			respondErr(c, err)
			return
		}
		var all []sched
		for srows.Next() {
			var s sched
			if err := srows.Scan(&s.ID, &s.TrancheID, &s.DueDate, &s.Total, &s.Principal, &s.Interest, &s.Contract); err != nil {
				srows.Close()
				respondErr(c, err)
				return
			}
			all = append(all, s)
		}
		srows.Close()
		var tranchesCount int
		if err := h.pool.QueryRow(ctx, "SELECT count(*) FROM credit_tranches WHERE credit_line_id = $1", l.ID).Scan(&tranchesCount); err != nil {
			respondErr(c, err)
			return
		}
		var upcoming []sched
		for _, s := range all {
			if !s.DueDate.Time.Before(today) {
				upcoming = append(upcoming, s)
			}
		}
		sort.SliceStable(upcoming, func(i, j int) bool { return upcoming[i].DueDate.Time.Before(upcoming[j].DueDate.Time) })
		upTotal := 0.0
		for _, s := range upcoming {
			v, _ := s.Total.Float64()
			upTotal += v
		}
		var next interface{}
		if len(upcoming) > 0 {
			s := upcoming[0]
			next = gin.H{"id": s.ID, "trancheId": s.TrancheID, "dueDate": s.DueDate, "totalAmount": s.Total, "principalAmount": s.Principal,
				"interestAmount": s.Interest, "trancheContract": s.Contract}
		}
		prows, err := h.pool.Query(ctx, "SELECT payment_date, total_amount, principal_amount, interest_amount, status FROM credit_payments WHERE credit_line_id = $1 ORDER BY payment_date DESC LIMIT 12", l.ID)
		if err != nil {
			respondErr(c, err)
			return
		}
		recent := []gin.H{}
		for prows.Next() {
			var d common.PDate
			var t, p, i float64
			var st string
			if err := prows.Scan(&d, &t, &p, &i, &st); err != nil {
				prows.Close()
				respondErr(c, err)
				return
			}
			recent = append(recent, gin.H{"paymentDate": d, "totalAmount": t, "principalAmount": p, "interestAmount": i, "status": st})
		}
		prows.Close()
		out = append(out, gin.H{"id": l.ID, "name": l.Name, "contractNumber": l.Contract, "limitAmount": l.Limit, "usedAmount": l.Used,
			"availableAmount": l.Available, "interestRatePct": l.Rate, "asOfDate": l.AsOf, "sourceFile": l.SourceFile,
			"tranchesCount": tranchesCount, "nextPayment": next, "upcomingTotal": round2(upTotal), "recentPayments": recent})
	}
	c.JSON(http.StatusOK, out)
}
