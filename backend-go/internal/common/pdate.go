package common

import (
	"database/sql/driver"
	"fmt"
	"time"
)

// PDate — дата/время, сериализующееся в JSON байт-в-байт как у Prisma:
// "2026-08-22T00:00:00.000Z" (три нуля миллисекунд всегда, не RFC3339Nano
// с их отбрасыванием при ровном времени). Использовать вместо *time.Time
// в КАЖДОЙ модели, где поле уходит в JSON-ответ — иначе расхождение
// всплывает тихо, по одному полю за раз, как это случилось с материалами.
type PDate struct {
	Time  time.Time
	Valid bool
}

func NewPDate(t time.Time) PDate { return PDate{Time: t, Valid: true} }

func (d PDate) MarshalJSON() ([]byte, error) {
	if !d.Valid {
		return []byte("null"), nil
	}
	return []byte(`"` + d.Time.UTC().Format("2006-01-02T15:04:05.000Z") + `"`), nil
}

func (d *PDate) UnmarshalJSON(b []byte) error {
	s := string(b)
	if s == "null" {
		d.Valid = false
		return nil
	}
	t, err := time.Parse(`"2006-01-02T15:04:05.000Z"`, s)
	if err != nil {
		t, err = time.Parse(`"2006-01-02T15:04:05Z"`, s)
		if err != nil {
			return err
		}
	}
	d.Time, d.Valid = t, true
	return nil
}

// Scan — реализует sql.Scanner, чтобы pgx мог писать сюда прямо из
// timestamp/date колонок, как в *time.Time.
func (d *PDate) Scan(value interface{}) error {
	if value == nil {
		d.Valid = false
		return nil
	}
	switch v := value.(type) {
	case time.Time:
		d.Time, d.Valid = v, true
		return nil
	default:
		return fmt.Errorf("PDate.Scan: неожиданный тип %T", value)
	}
}

func (d PDate) Value() (driver.Value, error) {
	if !d.Valid {
		return nil, nil
	}
	return d.Time, nil
}
