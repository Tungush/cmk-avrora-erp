package orderstate

import (
	"fmt"
	"strings"
	"time"
)

const (
	StatusNew          = "NEW"
	StatusDraft        = "DRAFT"
	StatusConfirmed    = "CONFIRMED"
	StatusInProduction = "IN_PRODUCTION"
	StatusReadyToShip  = "READY_TO_SHIP"
	StatusShipped      = "SHIPPED"
	StatusClosed       = "CLOSED"
	StatusCancelled    = "CANCELLED"
)

// DeriveStatusFromStages — какой статус заказу положен по его этапам. ""
// — трогать не нужно. Работает только в коридоре
// CONFIRMED ↔ IN_PRODUCTION ↔ READY_TO_SHIP: отгруженный/закрытый заказ
// отметка этапа откатывать не должна, равно как и непринятый NEW.
func DeriveStatusFromStages(current string, stages []StageRow, productLineIDs []string) string {
	inCorridor := current == StatusConfirmed || current == StatusInProduction || current == StatusReadyToShip
	if !inCorridor {
		return ""
	}
	progress := StageProgress(stages, productLineIDs)
	var next string
	switch {
	case progress.AllDone:
		next = StatusReadyToShip
	case progress.AnyStarted:
		next = StatusInProduction
	default:
		next = StatusConfirmed
	}
	if next == current {
		return ""
	}
	return next
}

type OrderLineCtx struct {
	Qty         float64
	ReservedQty float64
	// ArticleCode — оригинал буквально передаёт сюда l.articleId (UUID), не
	// код артикула (articleCode: l.articleId ?? undefined в orders.controller.ts)
	// — это баг в тексте сообщений/условии "нет артикула", но повторяется как есть
	ArticleCode string
}

type OrderStateContext struct {
	OrderID              string
	CurrentStatus        string
	Lines                []OrderLineCtx
	CustomerBinIin       *string
	ProductionStages     []StageRow // Status в нижнем регистре
	ProductLineIDs       []string
	FinishedGoodsShipped bool
	BalanceDue           float64
	HasAcceptanceAct     bool
}

type TransitionRequest struct {
	TargetStatus string
	UserID       string
	UserRole     string
	Comment      *string
}

type AuditLogPayload struct {
	EntityType   string
	EntityID     string
	Action       string
	BeforeStatus string
	AfterStatus  string
	UserID       string
	UserRole     string
	Comment      *string
	Timestamp    time.Time
}

// Transition — перенос OrderStateMachine.transition: проверка допустимости
// перехода статуса и бизнес-условий. Возвращает *GuardError на нарушение
// (обработчик отвечает 409 с err.Code/err.Error()).
func Transition(ctx OrderStateContext, req TransitionRequest) (AuditLogPayload, error) {
	current := ctx.CurrentStatus
	target := req.TargetStatus

	if current == target {
		return AuditLogPayload{}, NewGuardError("Order is already in "+target+" status", "SAME_STATUS_TRANSITION")
	}

	if target == StatusCancelled {
		allowedRoles := []string{"sales_manager", "director", "admin"}
		if !contains(allowedRoles, req.UserRole) {
			return AuditLogPayload{}, NewGuardError("Role "+req.UserRole+" is not authorized to cancel orders", "UNAUTHORIZED_CANCELLATION")
		}
		if req.Comment == nil || strings.TrimSpace(*req.Comment) == "" {
			return AuditLogPayload{}, NewGuardError("Cancellation requires a mandatory non-empty comment", "MISSING_CANCELLATION_COMMENT")
		}
		return createAuditLog(ctx, target, req.UserID, req.UserRole, req.Comment), nil
	}

	switch current {
	case StatusNew:
		if target != StatusConfirmed && target != StatusDraft {
			return AuditLogPayload{}, NewGuardError("Invalid transition from NEW to "+target, "INVALID_TRANSITION")
		}
		if target == StatusConfirmed {
			if len(ctx.Lines) == 0 {
				return AuditLogPayload{}, NewGuardError("Нельзя принять заказ без позиций", "EMPTY_ORDER_LINES")
			}
			unresolved := 0
			for _, l := range ctx.Lines {
				if l.ArticleCode == "" {
					unresolved++
				}
			}
			if unresolved > 0 {
				return AuditLogPayload{}, NewGuardError(
					fmt.Sprintf("Нельзя принять заказ: %d позиций без сопоставленного артикула", unresolved),
					"UNRESOLVED_ORDER_LINES")
			}
			if ctx.CustomerBinIin == nil || strings.TrimSpace(*ctx.CustomerBinIin) == "" {
				return AuditLogPayload{}, NewGuardError("Нельзя принять заказ без БИН/ИИН заказчика", "MISSING_CUSTOMER_BIN")
			}
		}

	case StatusDraft:
		if target != StatusConfirmed {
			return AuditLogPayload{}, NewGuardError("Invalid transition from DRAFT to "+target, "INVALID_TRANSITION")
		}
		if len(ctx.Lines) == 0 {
			return AuditLogPayload{}, NewGuardError("Cannot confirm order: at least one order line is required", "EMPTY_ORDER_LINES")
		}
		if ctx.CustomerBinIin == nil || strings.TrimSpace(*ctx.CustomerBinIin) == "" {
			return AuditLogPayload{}, NewGuardError("Cannot confirm order: customer BIN/IIN is required", "MISSING_CUSTOMER_BIN")
		}

	case StatusConfirmed:
		if target != StatusInProduction {
			return AuditLogPayload{}, NewGuardError("Invalid transition from CONFIRMED to "+target, "INVALID_TRANSITION")
		}
		if len(ctx.ProductionStages) == 0 {
			return AuditLogPayload{}, NewGuardError("Cannot move to IN_PRODUCTION: no production stages initialized", "NO_PRODUCTION_STAGES")
		}
		hasInProgress := false
		for _, s := range ctx.ProductionStages {
			if s.Status == "in_progress" || s.Status == "done" {
				hasInProgress = true
				break
			}
		}
		if !hasInProgress {
			return AuditLogPayload{}, NewGuardError("Cannot move to IN_PRODUCTION: at least one production stage must be in_progress", "NO_STAGE_IN_PROGRESS")
		}

	case StatusInProduction:
		if target != StatusReadyToShip {
			return AuditLogPayload{}, NewGuardError("Invalid transition from IN_PRODUCTION to "+target, "INVALID_TRANSITION")
		}
		progress := StageProgress(ctx.ProductionStages, ctx.ProductLineIDs)
		if !progress.AllDone {
			return AuditLogPayload{}, NewGuardError(
				fmt.Sprintf("Нельзя в «готов к отгрузке»: изготовлено %d из %d изделий", progress.DoneCount, progress.TotalSteps),
				"UNFINISHED_PRODUCTION_STAGES")
		}

	case StatusReadyToShip:
		if target != StatusShipped {
			return AuditLogPayload{}, NewGuardError("Invalid transition from READY_TO_SHIP to "+target, "INVALID_TRANSITION")
		}
		resLines := make([]ReservationLine, len(ctx.Lines))
		for i, l := range ctx.Lines {
			resLines[i] = ReservationLine{Qty: l.Qty, ReservedQty: l.ReservedQty, ArticleCode: l.ArticleCode}
		}
		if err := ValidateShippedReservationGuard(resLines); err != nil {
			return AuditLogPayload{}, err
		}
		if !ctx.FinishedGoodsShipped {
			return AuditLogPayload{}, NewGuardError("Cannot move to SHIPPED: finished goods shipment movement is missing or incomplete", "INCOMPLETE_SHIPMENT_MOVEMENT")
		}

	case StatusShipped:
		if target != StatusClosed {
			return AuditLogPayload{}, NewGuardError("Invalid transition from SHIPPED to "+target, "INVALID_TRANSITION")
		}
		if ctx.BalanceDue > 0 {
			return AuditLogPayload{}, NewGuardError(
				fmt.Sprintf("Cannot close order: balance due is %s (must be 0)", trimFloat(ctx.BalanceDue)),
				"UNPAID_BALANCE")
		}
		if !ctx.HasAcceptanceAct {
			return AuditLogPayload{}, NewGuardError("Cannot close order: linked acceptance act (APP) does not exist", "MISSING_ACCEPTANCE_ACT")
		}

	case StatusClosed, StatusCancelled:
		return AuditLogPayload{}, NewGuardError("Order in terminal state "+current+" cannot transition to "+target, "TERMINAL_STATE")

	default:
		return AuditLogPayload{}, NewGuardError("Unknown status "+current, "UNKNOWN_STATUS")
	}

	return createAuditLog(ctx, target, req.UserID, req.UserRole, req.Comment), nil
}

func createAuditLog(ctx OrderStateContext, target, userID, userRole string, comment *string) AuditLogPayload {
	return AuditLogPayload{
		EntityType:   "Order",
		EntityID:     ctx.OrderID,
		Action:       "status_change",
		BeforeStatus: ctx.CurrentStatus,
		AfterStatus:  target,
		UserID:       userID,
		UserRole:     userRole,
		Comment:      comment,
		Timestamp:    time.Now(),
	}
}
