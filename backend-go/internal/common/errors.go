// Package common держит то, что нужно каждому модулю: формат ошибки,
// который фронтенд уже понимает (не менять — фронт остаётся React и
// разбирает именно эту форму), и мелкие хелперы без явного дома.
package common

import (
	"log"
	"os"

	"github.com/gin-gonic/gin"
)

// DebugLog — печатает реальную ошибку в stdout сервера, когда DEBUG_ERRORS=1.
// Клиенту всегда уходит только общий INTERNAL_SERVER_ERROR (как у Nest-фильтра,
// который тоже не палит внутренности) — это только для разработки/сверки.
func DebugLog(err error) {
	if os.Getenv("DEBUG_ERRORS") == "1" {
		log.Printf("[DEBUG] %v", err)
	}
}

// APIError — тот же конверт, что отдавал HttpExceptionFilter в NestJS:
// { "error": { "code", "message", "details" } }. Фронтенд читает
// e.response.data.error.message повсеместно — менять форму нельзя,
// это был бы скрытый breaking change для уже написанного React.
type APIError struct {
	Code    string      `json:"code"`
	Message string      `json:"message"`
	Details interface{} `json:"details"`
}

func Fail(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"error": APIError{Code: code, Message: message, Details: nil}})
}

func FailDetails(c *gin.Context, status int, code, message string, details interface{}) {
	c.AbortWithStatusJSON(status, gin.H{"error": APIError{Code: code, Message: message, Details: details}})
}

func NotFound(c *gin.Context, message string) {
	Fail(c, 404, "NOT_FOUND", message)
}

func BadRequest(c *gin.Context, code, message string) {
	Fail(c, 400, code, message)
}

func Conflict(c *gin.Context, code, message string) {
	Fail(c, 409, code, message)
}

func Forbidden(c *gin.Context, message string) {
	Fail(c, 403, "FORBIDDEN", message)
}

func Unauthorized(c *gin.Context, code, message string) {
	Fail(c, 401, code, message)
}

// APIError404/APIError400/APIError409 — типизированные ошибки для слоёв без
// доступа к gin.Context (сервисы), чтобы HTTP-обработчик мог различить их
// error-веткой и ответить нужным статусом/кодом, а не общим 500.
type APIError404 struct {
	Code    string
	Message string
}

func (e *APIError404) Error() string { return e.Message }

type APIError400 struct {
	Code    string
	Message string
}

func (e *APIError400) Error() string { return e.Message }

type APIError409 struct {
	Code    string
	Message string
}

func (e *APIError409) Error() string { return e.Message }

type APIError403 struct {
	Code    string
	Message string
}

func (e *APIError403) Error() string { return e.Message }

// APIError503 — ServiceUnavailableException оригинала (1С не настроена).
type APIError503 struct {
	Code    string
	Message string
}

func (e *APIError503) Error() string { return e.Message }
