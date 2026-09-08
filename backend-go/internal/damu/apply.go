package damu

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// LineResult — что легло в базу по одному листу.
type LineResult struct {
	SheetName      string  `json:"sheetName"`
	ContractNumber string  `json:"contractNumber"`
	Name           string  `json:"name"`
	LimitAmount    float64 `json:"limitAmount"`
	UsedAmount     float64 `json:"usedAmount"`
	Tranches       int     `json:"tranches"`
	ScheduleRows   int     `json:"scheduleRows"`
	Payments       int     `json:"payments"`
	Created        bool    `json:"created"`
}

// Result — итог загрузки файла.
type Result struct {
	File         string       `json:"file"`
	Lines        []LineResult `json:"lines"`
	Skipped      []string     `json:"skipped"`
	PaymentSheet string       `json:"paymentSheet,omitempty"`
	Applied      bool         `json:"applied"`
}

// Preview — что даст загрузка, без записи. Тот же обход, что и Apply,
// только считает; человек видит цифры до того, как согласится.
func Preview(p *Parsed, displayName, fileName string) Result {
	res := Result{File: fileName, Skipped: p.Skipped, PaymentSheet: p.PaymentSheet}
	for _, l := range p.Lines {
		rows := 0
		for _, t := range l.Tranches {
			rows += len(t.Schedule)
		}
		res.Lines = append(res.Lines, LineResult{
			SheetName: l.SheetName, ContractNumber: l.ContractNumber,
			Name:        displayName + " · " + l.SheetName,
			LimitAmount: l.LimitAmount, UsedAmount: l.UsedAmount,
			Tranches: len(l.Tranches), ScheduleRows: rows, Payments: len(l.Payments),
		})
	}
	return res
}

// Apply — запись разобранного файла. Идемпотентна: линия находится по номеру
// договора, лимит и остаток перезаписываются снимком на дату загрузки, транши
// и график обновляются по своим ключам, факт погашений — по дате.
func Apply(ctx context.Context, pool *pgxpool.Pool, p *Parsed, displayName, fileName string) (Result, error) {
	res := Result{File: fileName, Skipped: p.Skipped, PaymentSheet: p.PaymentSheet, Applied: true}
	now := time.Now().In(time.Local)
	asOf := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	tx, err := pool.Begin(ctx)
	if err != nil {
		return res, err
	}
	defer tx.Rollback(ctx)

	for _, l := range p.Lines {
		name := displayName + " · " + l.SheetName
		var lineID string
		var created bool
		err := tx.QueryRow(ctx, `SELECT id FROM credit_lines WHERE contract_number = $1`, l.ContractNumber).Scan(&lineID)
		switch {
		case err == pgx.ErrNoRows:
			lineID = uuid.NewString()
			created = true
			// updated_at без серверного дефолта — заполняем сами, как везде
			if _, err := tx.Exec(ctx, `
				INSERT INTO credit_lines (id, name, contract_number, limit_amount, used_amount, available_amount,
					as_of_date, source_file, updated_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
				lineID, name, l.ContractNumber, l.LimitAmount, l.UsedAmount, l.AvailableAmount, asOf, fileName); err != nil {
				return res, err
			}
		case err != nil:
			return res, err
		default:
			if _, err := tx.Exec(ctx, `
				UPDATE credit_lines SET limit_amount = $2, used_amount = $3, available_amount = $4,
					as_of_date = $5, source_file = $6, updated_at = now() WHERE id = $1`,
				lineID, l.LimitAmount, l.UsedAmount, l.AvailableAmount, asOf, fileName); err != nil {
				return res, err
			}
		}

		scheduleRows := 0
		for _, t := range l.Tranches {
			var trancheID string
			err := tx.QueryRow(ctx, `SELECT id FROM credit_tranches WHERE credit_line_id = $1 AND contract_number = $2`,
				lineID, t.ContractNumber).Scan(&trancheID)
			if err == pgx.ErrNoRows {
				trancheID = uuid.NewString()
				if _, err := tx.Exec(ctx, `
					INSERT INTO credit_tranches (id, credit_line_id, contract_number, amount, start_date, end_date)
					VALUES ($1,$2,$3,$4,$5,$6)`,
					trancheID, lineID, t.ContractNumber, t.Amount, t.StartDate, t.EndDate); err != nil {
					return res, err
				}
			} else if err != nil {
				return res, err
			} else if _, err := tx.Exec(ctx, `
				UPDATE credit_tranches SET amount = $2, start_date = $3, end_date = $4 WHERE id = $1`,
				trancheID, t.Amount, t.StartDate, t.EndDate); err != nil {
				return res, err
			}

			for _, s := range t.Schedule {
				if _, err := tx.Exec(ctx, `
					INSERT INTO credit_schedule_entries (id, tranche_id, due_date, total_amount, principal_amount, interest_amount)
					VALUES ($1,$2,$3,$4,$5,$6)
					ON CONFLICT (tranche_id, due_date) DO UPDATE
					SET total_amount = EXCLUDED.total_amount,
						principal_amount = EXCLUDED.principal_amount,
						interest_amount = EXCLUDED.interest_amount`,
					uuid.NewString(), trancheID, s.DueDate, s.TotalAmount, s.PrincipalAmount, s.InterestAmount); err != nil {
					return res, err
				}
				scheduleRows++
			}
		}

		for _, pay := range l.Payments {
			if _, err := tx.Exec(ctx, `
				INSERT INTO credit_payments (id, credit_line_id, payment_date, total_amount, principal_amount, interest_amount, status)
				VALUES ($1,$2,$3,$4,$5,$6,$7)
				ON CONFLICT (credit_line_id, payment_date) DO UPDATE
				SET total_amount = EXCLUDED.total_amount,
					principal_amount = EXCLUDED.principal_amount,
					interest_amount = EXCLUDED.interest_amount,
					status = EXCLUDED.status`,
				uuid.NewString(), lineID, pay.PaymentDate, pay.TotalAmount, pay.PrincipalAmount, pay.InterestAmount, pay.Status); err != nil {
				return res, err
			}
		}

		res.Lines = append(res.Lines, LineResult{
			SheetName: l.SheetName, ContractNumber: l.ContractNumber, Name: name,
			LimitAmount: l.LimitAmount, UsedAmount: l.UsedAmount,
			Tranches: len(l.Tranches), ScheduleRows: scheduleRows, Payments: len(l.Payments),
			Created: created,
		})
	}

	if err := tx.Commit(ctx); err != nil {
		return res, err
	}
	return res, nil
}
