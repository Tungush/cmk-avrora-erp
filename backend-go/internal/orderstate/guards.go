// Package orderstate — точный перенос guards.service.ts + production-stages.ts
// + order-state-machine.service.ts: чистая бизнес-логика статусов заказа и
// отметок цеха, без обращения к БД (как costing.service.ts для себестоимости).
package orderstate

import "strconv"

// trimFloat — как JS String(number): без лишних нулей после точки.
func trimFloat(n float64) string {
	return strconv.FormatFloat(n, 'f', -1, 64)
}

// GuardError — перенос BusinessGuardError. КРИТИЧНО: Nest строит message
// как `[${code}] ${message}` уже В КОНСТРУКТОРЕ (super(...)), и именно эта
// строка с префиксом уходит клиенту в HttpExceptionFilter (exception.message),
// а не голый текст — .Error() здесь обязан повторить префикс, иначе текст
// ошибки на фронте будет короче, чем у Nest.
type GuardError struct {
	Code       string
	RawMessage string
}

func NewGuardError(message, code string) *GuardError {
	if code == "" {
		code = "BUSINESS_RULE_VIOLATION"
	}
	return &GuardError{Code: code, RawMessage: message}
}

func (e *GuardError) Error() string { return "[" + e.Code + "] " + e.RawMessage }

// ReservationLine — позиция заказа для проверки резерва при отгрузке.
type ReservationLine struct {
	Qty         float64
	ReservedQty float64
	ArticleCode string
}

// ValidateShippedReservationGuard — запрещает переход в SHIPPED, если по
// какой-то позиции резерв меньше заказанного количества.
func ValidateShippedReservationGuard(lines []ReservationLine) error {
	for _, l := range lines {
		if l.ReservedQty < l.Qty {
			return NewGuardError(
				"Cannot ship order: item "+l.ArticleCode+" has reserved quantity ("+trimFloat(l.ReservedQty)+") less than required ("+trimFloat(l.Qty)+")",
				"INSUFFICIENT_RESERVED_QTY",
			)
		}
	}
	return nil
}
