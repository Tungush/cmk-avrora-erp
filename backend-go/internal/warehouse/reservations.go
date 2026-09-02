// Перенос backend/src/common/batch-reservations.ts — резервы партий и
// перехват (09_COSTING_AND_STAGES.md §4.4). Резерв мягкий: не мешает
// кладовщику выдать металл, но не даёт второму менеджеру молча посчитать
// заказ по партии, которой ему не достанется.
package warehouse

import "math"

type ReservationStatus string

const (
	ReservationActive     ReservationStatus = "ACTIVE"
	ReservationReleased   ReservationStatus = "RELEASED"
	ReservationOverridden ReservationStatus = "OVERRIDDEN"
	ReservationExpired    ReservationStatus = "EXPIRED"
)

const DefaultReservationTTLDays = 30
const DefaultReservationWarnDays = 3

const dayMs = 24 * 60 * 60 * 1000

// ReservationLike — expiresAt/now в unix millis, чтобы пакет оставался без
// зависимости от конкретики time.Time на границе (как ReceiptDate в BatchLike).
type ReservationLike struct {
	ID        string
	BatchID   string
	OrderID   string
	Qty       float64
	Status    ReservationStatus
	ExpiresAt int64
}

func ReservationExpiry(fromMillis int64, ttlDays int) int64 {
	return fromMillis + int64(ttlDays)*dayMs
}

func DaysUntil(expiresAtMillis, nowMillis int64) int {
	return int(math.Ceil(float64(expiresAtMillis-nowMillis) / dayMs))
}

func IsExpired(r ReservationLike, nowMillis int64) bool {
	return r.Status == ReservationActive && r.ExpiresAt <= nowMillis
}

func IsExpiringSoon(r ReservationLike, nowMillis int64, warnDays int) bool {
	if r.Status != ReservationActive {
		return false
	}
	left := DaysUntil(r.ExpiresAt, nowMillis)
	return left > 0 && left <= warnDays
}

type BatchAvailability struct {
	BatchID             string                `json:"batchId"`
	QtyRemaining        float64               `json:"qtyRemaining"`
	ReservedByOthers    float64               `json:"reservedByOthers"`
	ReservedByThisOrder float64               `json:"reservedByThisOrder"`
	FreeQty             float64               `json:"freeQty"`
	Blockers            []AvailabilityBlocker `json:"blockers"`
}

type AvailabilityBlocker struct {
	ReservationID string  `json:"reservationId"`
	OrderID       string  `json:"orderId"`
	Qty           float64 `json:"qty"`
	ExpiresAt     int64   `json:"expiresAt"`
}

// AvailabilityOf — свободный остаток партии с точки зрения конкретного
// заказа. Собственный резерв не считается препятствием.
func AvailabilityOf(batchID string, qtyRemaining float64, reservations []ReservationLike, forOrderID *string) BatchAvailability {
	var others []ReservationLike
	reservedByOthers, reservedByThisOrder := 0.0, 0.0
	for _, r := range reservations {
		if r.Status != ReservationActive || r.BatchID != batchID {
			continue
		}
		if forOrderID != nil && r.OrderID == *forOrderID {
			reservedByThisOrder += r.Qty
		} else {
			reservedByOthers += r.Qty
			others = append(others, r)
		}
	}
	blockers := make([]AvailabilityBlocker, len(others))
	for i, r := range others {
		blockers[i] = AvailabilityBlocker{ReservationID: r.ID, OrderID: r.OrderID, Qty: r.Qty, ExpiresAt: r.ExpiresAt}
	}
	return BatchAvailability{
		BatchID: batchID, QtyRemaining: round3(qtyRemaining), ReservedByOthers: round3(reservedByOthers),
		ReservedByThisOrder: round3(reservedByThisOrder), FreeQty: round3(math.Max(0, qtyRemaining-reservedByOthers)),
		Blockers: blockers,
	}
}

type AssessResult struct {
	Fits          bool    `json:"fits"`
	Shortfall     float64 `json:"shortfall"`
	NeedsOverride bool    `json:"needsOverride"`
	Message       string  `json:"message"`
}

// AssessRequest — что мешает взять нужный объём и можно ли обойтись без
// согласования. Пока запрос висит, менеджер не заблокирован.
func AssessRequest(availability BatchAvailability, wantQty float64) AssessResult {
	shortfall := round3(math.Max(0, wantQty-availability.FreeQty))
	if shortfall <= 0 {
		return AssessResult{Fits: true, Message: "Партия доступна"}
	}
	if availability.ReservedByOthers <= 0 {
		return AssessResult{
			Fits: false, Shortfall: shortfall,
			Message: "Не хватает " + trimFloat(shortfall) + " — на складе просто нет столько",
		}
	}
	return AssessResult{
		Fits: false, Shortfall: shortfall, NeedsOverride: true,
		Message: "Свободно " + trimFloat(availability.FreeQty) + ", ещё " + trimFloat(shortfall) + " зарезервировано под другие заказы",
	}
}

// ClassifyReservations — разбор пачки резервов на «просрочены» и «истекают».
func ClassifyReservations(reservations []ReservationLike, nowMillis int64, warnDays int) (expired, expiringSoon []ReservationLike) {
	for _, r := range reservations {
		if IsExpired(r, nowMillis) {
			expired = append(expired, r)
		}
		if IsExpiringSoon(r, nowMillis, warnDays) {
			expiringSoon = append(expiringSoon, r)
		}
	}
	return expired, expiringSoon
}
