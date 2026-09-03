// Go-бэкенд ЦМК АВРОРА (перепись с NestJS, начата 01.09.2026).
// Работает на ТОЙ ЖЕ Postgres-базе, что и старый сервис — данные не
// мигрируют, схему не трогаем. Slug модулей и порядок переноса — см.
// memory/go-rewrite-*.md. Не финальный порт: развивается модуль за
// модулем, старый бэкенд (backend/) остаётся источником истины, пока
// очередной модуль здесь не пройдёт те же тесты.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"cmk-avrora-erp/backend-go/internal/auth"
	"cmk-avrora-erp/backend-go/internal/common"
	"cmk-avrora-erp/backend-go/internal/db"
	"cmk-avrora-erp/backend-go/internal/integration"
	"cmk-avrora-erp/backend-go/internal/modules/catalog"
	"cmk-avrora-erp/backend-go/internal/modules/dashboards"
	"cmk-avrora-erp/backend-go/internal/modules/finance"
	integrationapi "cmk-avrora-erp/backend-go/internal/modules/integration"
	"cmk-avrora-erp/backend-go/internal/modules/misc"
	"cmk-avrora-erp/backend-go/internal/modules/orders"
	"cmk-avrora-erp/backend-go/internal/modules/platform"
	"cmk-avrora-erp/backend-go/internal/modules/sales"
	warehousepkg "cmk-avrora-erp/backend-go/internal/modules/warehouse"
)

func main() {
	ctx := context.Background()

	pool, err := db.Connect(ctx)
	if err != nil {
		log.Fatalf("не удалось подключиться к базе: %v", err)
	}
	defer pool.Close()
	log.Println("подключено к Postgres")

	// gin.Default() на панике отдаёт пустой 500; у Nest HttpExceptionFilter
	// всегда отдавал JSON-конверт — фронт читает e.response.data.error
	r := gin.New()
	r.Use(gin.Logger(), gin.CustomRecovery(func(c *gin.Context, rec interface{}) {
		log.Printf("panic: %v", rec)
		common.Fail(c, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "An unexpected internal error occurred")
	}))

	// Как app.enableCors() у Nest: любой origin, preflight 204
	r.Use(common.CORS())

	// Незамапленный роут у Nest отдаёт тот же JSON-конверт, что и любая
	// другая ошибка ("Cannot GET /путь") — Gin по умолчанию отдаёт голый
	// текст "404 page not found", это заметно на диффе с фронта.
	// Всё, что не /api — собранный фронтенд из STATIC_DIR (Docker-образ
	// кладёт туда vite build; локально переменная не задана — как раньше).
	staticDir := os.Getenv("STATIC_DIR")
	r.NoRoute(func(c *gin.Context) {
		if !strings.HasPrefix(c.Request.URL.Path, "/api/") && common.ServeSPA(c, staticDir) {
			return
		}
		common.Fail(c, http.StatusNotFound, "Not Found", "Cannot "+c.Request.Method+" "+c.Request.URL.Path)
	})

	// /api/v1 — тот же префикс, что и у NestJS (main.ts: app.setGlobalPrefix)
	api := r.Group("/api/v1")

	authHandler := platform.NewAuthHandler(pool)
	api.POST("/auth/login", authHandler.Login)
	healthH := platform.NewHealthHandler(pool)
	api.GET("/health", healthH.Health)
	api.HEAD("/health", healthH.Health) // Express отвечал на HEAD у любого GET; мониторы часто зондируют HEAD

	// Публичные роуты без JWT (@Public() в Nest): вебхук 1С — подпись HMAC
	// вместо пользователя (у внешней системы его нет); SSE-поток — EventSource
	// не ставит Authorization, токен приходит query-параметром
	intH := integrationapi.New(pool)
	api.POST("/integrations/1c/webhook/:type", intH.Receive)
	api.GET("/events/stream", platform.NewEventsHandler().Stream)

	protected := api.Group("")
	protected.Use(auth.Middleware())
	protected.GET("/auth/me", authHandler.Me)

	// Список ролей в RequireRoles — байт-в-байт как в @Roles(...) оригинала,
	// включая 'admin': сам admin проходит всегда (bypass в RequireRoles), но
	// текст отказа для остальных ролей цитирует ИМЕННО этот список — расхождение
	// нашлось диффом на Articles (см. memory/go-rewrite-progress.md)
	materials := catalog.NewMaterialsHandler(pool)
	protected.GET("/materials", materials.FindAll)
	protected.GET("/materials/:id", materials.FindOne)
	protected.POST("/materials", auth.RequireRoles("procurement", "warehouse_material", "admin"), materials.Create)
	protected.PATCH("/materials/:id", auth.RequireRoles("procurement", "warehouse_material", "admin"), materials.Update)

	articles := catalog.NewArticlesHandler(pool)
	protected.GET("/articles", articles.FindAll)
	// Сводка прайса — до маршрута /articles/:id
	protected.GET("/articles/price-digest", articles.PriceDigest)
	// Счётчики очередей работы инженера — до /articles/:id, иначе «gaps»
	// разберётся как идентификатор
	protected.GET("/articles/gaps", articles.Gaps)
	protected.GET("/articles/:id", articles.FindOne)
	protected.GET("/articles/:id/bom", articles.GetBom)
	protected.POST("/articles", auth.RequireRoles("engineer", "admin"), articles.Create)
	protected.PATCH("/articles/:id", auth.RequireRoles("engineer", "planner", "admin"), articles.Update)
	protected.POST("/articles/:id/bom", auth.RequireRoles("engineer", "admin"), articles.AddBomItem)
	protected.PUT("/articles/:id/bom", auth.RequireRoles("engineer", "admin"), articles.ReplaceBom)

	// Себестоимость (routing.controller.ts): нормы труда, факт из цеха,
	// пересчёт, «где применяется», версионируемые коэффициенты
	routing := catalog.NewRoutingHandler(pool)
	protected.GET("/articles/:id/routing", routing.GetRouting)
	protected.PUT("/articles/:id/routing/:stage", auth.RequireRoles("engineer", "admin"), routing.PutNorm)
	protected.POST("/articles/:id/routing/:stage/actual", auth.RequireRoles("shop_foreman", "admin"), routing.PostActual)
	protected.POST("/articles/:id/routing/:stage/promote", auth.RequireRoles("engineer", "admin"), routing.Promote)
	protected.GET("/articles/:id/routing/history", routing.History)
	protected.POST("/articles/:id/routing/recalculate", auth.RequireRoles("engineer", "admin"), routing.Recalculate)
	protected.POST("/articles/:id/routing/costing/preview", auth.RequireRoles("engineer", "admin"), routing.PreviewCosting)
	protected.GET("/articles/:id/routing/usage", routing.Usage)
	protected.GET("/articles/:id/routing/costing/history", routing.CostingHistory)
	protected.GET("/articles/:id/routing/costing", routing.Costing)

	workCenters := catalog.NewWorkCentersHandler(pool)
	protected.GET("/work-centers", workCenters.FindAll)

	costingConfig := catalog.NewCostingConfigHandler(pool)
	protected.GET("/costing-config", costingConfig.Active)
	protected.PUT("/costing-config", auth.RequireRoles("admin", "director"), costingConfig.Update)

	customers := catalog.NewCustomersHandler(pool)
	protected.GET("/customers", customers.FindAll)
	protected.GET("/customers/:id", customers.FindOne)
	protected.POST("/customers", auth.RequireRoles("sales_manager", "admin"), customers.Create)
	protected.PATCH("/customers/:id", auth.RequireRoles("sales_manager", "admin"), customers.Update)

	// Orders — базовая часть (без себестоимости заказа, см. memory/go-rewrite-progress.md)
	ordersH := orders.NewOrdersHandler(pool)
	protected.GET("/orders", ordersH.FindAll)
	protected.GET("/orders/inbox", auth.RequireRoles("planner", "sales_manager", "director", "admin"), ordersH.Inbox)
	// Объекты (базовые станции): срез по площадкам, до маршрута /orders/:id
	protected.GET("/orders/sites", ordersH.Sites)
	protected.POST("/orders/:id/accept", auth.RequireRoles("planner", "sales_manager", "director", "admin"), ordersH.AcceptOrder)
	protected.GET("/orders/:id", ordersH.FindOne)
	protected.GET("/orders/:id/material-availability", ordersH.MaterialAvailability)
	protected.PATCH("/orders/:id/lines/:lineId/site", auth.RequireRoles("sales_manager", "planner", "admin"), ordersH.SetLineSite)
	protected.POST("/orders/:id/status", auth.RequireRoles("sales_manager", "planner", "warehouse_fg", "accountant", "director", "admin"), ordersH.TransitionStatus)
	protected.PATCH("/orders/:id/status", auth.RequireRoles("sales_manager", "planner", "warehouse_fg", "accountant", "director", "admin"), ordersH.UpdateStatus)
	protected.PATCH("/orders/:id/stage-tracking-mode", auth.RequireRoles("planner", "shop_foreman", "admin"), ordersH.SetStageTrackingMode)
	protected.PATCH("/orders/:id/production-stages/:code", auth.RequireRoles("shop_foreman", "planner", "admin"), ordersH.UpdateProductionStage)
	protected.GET("/orders/:id/production-stages/:code/hours-allocation", ordersH.StageHoursAllocation)
	protected.PATCH("/orders/:id", auth.RequireRoles("sales_manager", "accountant", "planner", "warehouse_fg", "admin"), ordersH.Update)

	// Себестоимость заказа (order-costings.controller.ts) — версии-документы,
	// не пересчитываются никогда, + факторный разбор compare (costing-compare.ts).
	orderCostingsH := orders.NewOrderCostingsHandler(pool)
	protected.GET("/order-lines/:orderLineId/costings", orderCostingsH.List)
	protected.GET("/order-lines/:orderLineId/costings/:costingId", orderCostingsH.GetOne)
	protected.GET("/order-lines/:orderLineId/costings/compare/:baseId/:targetId", orderCostingsH.Compare)
	protected.POST("/order-lines/:orderLineId/costings", auth.RequireRoles("planner", "sales_manager", "procurement", "admin"), orderCostingsH.Build)
	protected.POST("/order-lines/:orderLineId/costings/:costingId/approve", auth.RequireRoles("director", "planner", "admin"), orderCostingsH.Approve)
	protected.POST("/order-lines/:orderLineId/costings/:costingId/materials/:rowId/ordered", auth.RequireRoles("planner", "sales_manager", "admin"), orderCostingsH.MarkOrdered)

	// Material batches (партии) + резервы/перехват (09 §4.4)
	matBatchesH := warehousepkg.NewMaterialBatchesHandler(pool)
	protected.GET("/material-batches/anomalies", matBatchesH.Anomalies)
	protected.POST("/material-batches/anomalies/:batchId/clear", auth.RequireRoles("procurement", "planner", "admin"), matBatchesH.ClearAnomaly)
	protected.GET("/material-batches/:materialId", matBatchesH.List)
	protected.POST("/material-batches/:materialId/price", matBatchesH.Price)

	reservationsH := warehousepkg.NewBatchReservationsHandler(pool)
	protected.GET("/batch-reservations/availability/:materialId", reservationsH.Availability)
	protected.POST("/batch-reservations/assess", reservationsH.Assess)
	protected.POST("/batch-reservations/from-costing/:costingId", auth.RequireRoles("procurement", "planner", "admin"), reservationsH.Reserve)
	protected.POST("/batch-reservations/overrides", auth.RequireRoles("sales_manager", "planner", "procurement", "admin"), reservationsH.RequestOverride)
	protected.GET("/batch-reservations/overrides", reservationsH.ListOverrides)
	protected.GET("/batch-reservations/expiring", reservationsH.ListExpiring)
	protected.GET("/batch-reservations/overrides/:requestId", reservationsH.OverrideContext)
	protected.POST("/batch-reservations/overrides/:requestId/decide", auth.RequireRoles("director", "admin"), reservationsH.Decide)
	protected.POST("/batch-reservations/expire-stale", auth.RequireRoles("admin"), reservationsH.ExpireStale)

	// warehouse.controller.ts — обрезки, остатки, приход, движения, ГП
	whH := warehousepkg.NewWarehouseHandler(pool)
	protected.GET("/warehouse/offcuts", whH.GetOffcuts)
	protected.GET("/warehouse/offcuts/for-order/:orderId", whH.OffcutsForOrder)
	protected.POST("/warehouse/offcuts/for-order/:orderId", auth.RequireRoles("warehouse_material", "shop_foreman", "planner", "admin"), whH.UseOffcutsForOrder)
	protected.POST("/warehouse/offcuts", auth.RequireRoles("warehouse_material", "shop_foreman", "admin"), whH.CreateOffcut)
	protected.PATCH("/warehouse/offcuts/:id", auth.RequireRoles("warehouse_material", "shop_foreman", "admin"), whH.UpdateOffcut)
	protected.DELETE("/warehouse/offcuts/:id", auth.RequireRoles("warehouse_material", "shop_foreman", "admin"), whH.DeleteOffcut)
	protected.GET("/warehouse/materials/balance", whH.GetMaterialBalance)
	protected.POST("/warehouse/materials/receipt", auth.RequireRoles("warehouse_material", "procurement", "admin"), whH.PostMaterialReceipt)
	protected.GET("/warehouse/materials/:id/movements", whH.GetMaterialMovements)
	protected.POST("/warehouse/materials/tolling-receipt", auth.RequireRoles("warehouse_material", "admin"), whH.PostTollingReceipt)
	protected.POST("/warehouse/materials/movements", auth.RequireRoles("warehouse_material", "admin"), whH.PostMaterialMovement)
	protected.GET("/warehouse/finished-goods", whH.GetFinishedGoods)
	protected.GET("/warehouse/finished-goods/balance", whH.GetFGBalance)
	protected.POST("/warehouse/finished-goods/movements", auth.RequireRoles("warehouse_fg", "shop_foreman", "admin"), whH.PostFGMovement)
	protected.GET("/warehouse/receipts", whH.GetReceipts)
	protected.GET("/warehouse/warehouses", whH.Warehouses)

	usersH := platform.NewUsersHandler(pool)
	protected.GET("/users", auth.RequireRoles("admin", "director"), usersH.FindAll)
	protected.GET("/users/roles", auth.RequireRoles("admin", "director"), usersH.Roles)
	protected.POST("/users", auth.RequireRoles("admin", "director"), usersH.Create)
	protected.PATCH("/users/:id", auth.RequireRoles("admin", "director"), usersH.Update)
	protected.POST("/users/:id/reset-password", auth.RequireRoles("admin", "director"), usersH.ResetPassword)
	protected.GET("/orders-dashboard", auth.RequireRoles("sales_manager", "accountant", "director", "admin"), orders.NewOrdersDashboardHandler(pool).Dashboard)

	// Finance (5 контроллеров, прямой доступ к БД без сервисов)
	pdH := finance.NewPaymentDocumentsHandler(pool)
	protected.GET("/payment-documents", pdH.FindAll)
	protected.GET("/payment-documents/customer-debts", auth.RequireRoles("accountant", "director", "sales_manager", "admin"), pdH.CustomerDebts)
	protected.GET("/payment-documents/receivables", pdH.Receivables)
	protected.GET("/payment-documents/reconciliation", auth.RequireRoles("accountant", "director", "sales_manager", "admin"), pdH.Reconciliation)
	protected.GET("/payment-documents/:id", pdH.FindOne)
	protected.POST("/payment-documents", auth.RequireRoles("accountant", "sales_manager", "admin"), pdH.Create)
	protected.POST("/payment-documents/:id/payments", auth.RequireRoles("accountant", "admin"), pdH.AddPayment)
	cpH := finance.NewCustomerPaymentsHandler(pool)
	protected.GET("/orders/:id/customer-payments", cpH.List)
	protected.POST("/orders/:id/customer-payments", auth.RequireRoles("accountant", "sales_manager", "admin"), cpH.Create)
	protected.DELETE("/customer-payments/:id", auth.RequireRoles("accountant", "admin"), cpH.Remove)
	aaH := finance.NewAcceptanceActsHandler(pool)
	protected.GET("/acceptance-acts", aaH.FindAll)
	protected.POST("/acceptance-acts", auth.RequireRoles("accountant", "sales_manager", "warehouse_fg", "admin"), aaH.Create)
	protected.GET("/credit-lines", auth.RequireRoles("accountant", "director", "admin"), finance.NewCreditLinesHandler(pool).FindAll)
	purH := finance.NewPurchasesHandler(pool)
	protected.GET("/purchases/dashboard", auth.RequireRoles("procurement", "accountant", "director", "admin"), purH.Dashboard)
	protected.GET("/purchases/documents", auth.RequireRoles("procurement", "accountant", "director", "admin"), purH.Documents)

	// misc: search, saved-views, audit-log, price-reviews, min-stock, nomenclature (bom-items/production-plan-items — не зарегистрированы в Nest, не портированы)
	platH := misc.NewPlatformHandler(pool)
	protected.GET("/search", platH.Search)
	protected.GET("/saved-views", platH.SavedViewsList)
	protected.POST("/saved-views", platH.SavedViewsCreate)
	protected.DELETE("/saved-views/:id", platH.SavedViewsDelete)
	protected.GET("/audit-log", auth.RequireRoles("admin", "director"), platH.AuditLog)
	cmH := misc.NewCatalogMiscHandler(pool)
	protected.POST("/articles/:id/price-review", auth.RequireRoles("engineer", "accountant", "sales_manager", "admin"), cmH.PriceReviewRequest)
	protected.GET("/price-reviews", auth.RequireRoles("director", "admin", "engineer", "accountant"), cmH.PriceReviewsList)
	protected.POST("/price-reviews/:id/approve", auth.RequireRoles("director", "admin"), cmH.PriceReviewApprove)
	protected.POST("/price-reviews/:id/reject", auth.RequireRoles("director", "admin"), cmH.PriceReviewReject)
	protected.GET("/min-stock-levels", cmH.MinStockList)
	protected.PATCH("/min-stock-levels/:id", auth.RequireRoles("planner", "admin"), cmH.MinStockUpdate)
	protected.DELETE("/min-stock-levels/:id", auth.RequireRoles("planner", "admin"), cmH.MinStockDelete)
	nomH := misc.NewNomenclatureHandler(pool)
	protected.GET("/nomenclature/search", nomH.Search)
	protected.GET("/nomenclature/suggest", nomH.Suggest)
	protected.GET("/nomenclature/duplicates", nomH.Duplicates)
	protected.GET("/nomenclature/stalled-requests", nomH.Stalled)
	protected.GET("/nomenclature/materials/:materialId/names", nomH.Names)
	protected.POST("/nomenclature/materials/:materialId/aliases", auth.RequireRoles("engineer", "procurement", "planner", "admin"), nomH.AddAlias)
	protected.POST("/nomenclature/search-misses/:missId/resolve", nomH.ResolveMiss)
	protected.POST("/nomenclature/requests/:requestId/onec-response", auth.RequireRoles("procurement", "admin"), nomH.OnecResponse)
	protected.POST("/nomenclature/materials/:materialId/onec-rename", auth.RequireRoles("procurement", "admin"), nomH.Rename)

	dashH := dashboards.New(pool)
	protected.GET("/dashboards/role-widgets", dashH.RoleWidgets)
	protected.GET("/dashboards/director", auth.RequireRoles("director", "admin"), dashH.Director)
	protected.GET("/dashboards/monthly-series", dashH.MonthlySeries)
	protected.GET("/dashboards/workload-forecast", dashH.WorkloadForecast)
	protected.GET("/dashboards/cash-forecast", dashH.CashForecast)
	protected.GET("/dashboards/production-summary", dashH.ProductionSummary)
	protected.GET("/dashboards/finished-goods-summary", dashH.FinishedGoodsSummary)

	nrqH := misc.NewNomenclatureRequestsHandler(pool)
	protected.POST("/nomenclature-requests", auth.RequireRoles("engineer", "sales_manager", "planner", "admin"), nrqH.Create)
	protected.GET("/nomenclature-requests", auth.RequireRoles("engineer", "sales_manager", "planner", "director", "admin"), nrqH.List)
	protected.POST("/nomenclature-requests/:id/approve", auth.RequireRoles("engineer", "admin"), nrqH.Approve)
	protected.POST("/nomenclature-requests/:id/reject", auth.RequireRoles("engineer", "admin"), nrqH.Reject)
	dealsH := sales.New(pool)
	protected.GET("/deals", auth.RequireRoles("sales_manager", "planner", "accountant", "director", "admin"), dealsH.FindAll)
	protected.POST("/deals", auth.RequireRoles("sales_manager", "planner", "accountant", "admin"), dealsH.Create)
	protected.PATCH("/deals/:id", auth.RequireRoles("sales_manager", "planner", "accountant", "admin"), dealsH.Update)
	protected.DELETE("/deals/:id", auth.RequireRoles("sales_manager", "admin"), dealsH.Remove)
	protected.PATCH("/deals/:id/status", auth.RequireRoles("sales_manager", "accountant", "admin"), dealsH.UpdateStatus)
	prH := warehousepkg.NewPurchaseRequestsHandler(pool)
	protected.GET("/purchase-requests", prH.FindAll)
	protected.POST("/purchase-requests", auth.RequireRoles("warehouse_material", "planner", "shop_foreman", "procurement", "admin"), prH.Create)
	protected.POST("/purchase-requests/from-order/:orderId", auth.RequireRoles("warehouse_material", "planner", "shop_foreman", "procurement", "admin"), prH.FromOrder)
	protected.POST("/purchase-requests/send-to-bitrix", auth.RequireRoles("procurement", "admin"), prH.SendToBitrix)
	protected.POST("/purchase-requests/:id/reject", auth.RequireRoles("procurement", "admin"), prH.Reject)
	protected.POST("/purchase-requests/:id/ordered", auth.RequireRoles("procurement", "admin"), prH.MarkOrdered)

	// Подряд (contractor-work.controller.ts + contractor-requests.controller.ts)
	cwH := orders.NewContractorWorkHandler(pool)
	protected.POST("/contractors", auth.RequireRoles("procurement", "planner", "sales_manager", "admin"), cwH.CreateContractor)
	protected.GET("/contractors", cwH.Contractors)
	protected.GET("/contractor-work", auth.RequireRoles("planner", "sales_manager", "director", "accountant", "admin"), cwH.AllWork)
	protected.GET("/orders/:id/contractor-work", cwH.OrderWork)
	protected.POST("/orders/:id/stages/:stage/contractor", auth.RequireRoles("shop_foreman", "planner", "sales_manager", "admin"), cwH.Assign)
	protected.PATCH("/contractor-work/:id/accept", auth.RequireRoles("shop_foreman", "planner", "admin"), cwH.Accept)
	protected.DELETE("/contractor-work/:id", auth.RequireRoles("shop_foreman", "planner", "admin"), cwH.Remove)
	crH := orders.NewContractorRequestsHandler(pool)
	crRead := auth.RequireRoles("planner", "sales_manager", "director", "accountant", "shop_foreman", "procurement", "admin")
	crWrite := auth.RequireRoles("shop_foreman", "planner", "sales_manager", "procurement", "admin")
	protected.GET("/contractor-requests", crRead, crH.FindAll)
	protected.GET("/contractor-requests/:id", crRead, crH.FindOne)
	protected.POST("/contractor-requests", crWrite, crH.Create)
	protected.PATCH("/contractor-requests/:id", crWrite, crH.Update)
	protected.POST("/contractor-requests/send-to-bitrix", crWrite, crH.SendToBitrix)
	protected.POST("/contractor-requests/:id/allocate", auth.RequireRoles("shop_foreman", "planner", "admin"), crH.Allocate)
	protected.DELETE("/contractor-requests/:id/allocations/:workId", auth.RequireRoles("shop_foreman", "planner", "admin"), crH.RemoveAllocation)
	protected.POST("/contractor-requests/:id/accept", auth.RequireRoles("procurement", "accountant", "planner", "admin"), crH.Accept)
	protected.POST("/contractor-requests/:id/cancel", auth.RequireRoles("planner", "procurement", "admin"), crH.Cancel)

	// production-plan.controller.ts
	ppH := orders.NewProductionPlanHandler(pool)
	protected.GET("/production-plan", ppH.FindAll)
	protected.GET("/production-plan/shop-floor", ppH.ShopFloor)
	protected.GET("/production-plan/matrix", ppH.Matrix)
	protected.PATCH("/production-plan/matrix", auth.RequireRoles("planner", "admin"), ppH.SetPlanCell)
	protected.GET("/production-plan/weekly", ppH.Weekly)
	protected.GET("/production-plan/:id", ppH.FindOne)
	protected.POST("/production-plan", auth.RequireRoles("planner", "admin"), ppH.Create)
	protected.PATCH("/production-plan/:id/status", auth.RequireRoles("shop_foreman", "planner", "admin"), ppH.UpdateStatus)

	// integration.controller.ts — журнал обмена, приём из 1С GET-запросами
	// (ТЗ v10), outbox/inbox вручную
	protected.GET("/integrations/status", auth.RequireRoles("admin", "director"), intH.Status)
	protected.GET("/integrations/messages", auth.RequireRoles("admin", "director"), intH.Messages)
	protected.POST("/integrations/1c/sync/orders", auth.RequireRoles("admin", "sales_manager", "director"), intH.SyncOrders)
	protected.POST("/integrations/1c/sync/order/:orderNumber", auth.RequireRoles("admin", "sales_manager", "director"), intH.SyncOrder)
	protected.POST("/integrations/1c/sync/procurement/:orderNumber", auth.RequireRoles("admin", "procurement", "director"), intH.SyncProcurement)
	protected.GET("/integrations/1c/ping", auth.RequireRoles("admin", "director"), intH.Ping)
	protected.POST("/integrations/outbox/flush", auth.RequireRoles("admin"), intH.Flush)
	protected.POST("/integrations/inbox/process", auth.RequireRoles("admin"), intH.Process)
	protected.POST("/integrations/messages/:id/retry", auth.RequireRoles("admin"), intH.Retry)

	// Плановая отправка outbox (IntegrationService.onModuleInit): раз в 5 минут,
	// только при настроенном адресе 1С — без него сообщения копятся в PENDING,
	// как и прежде, до кнопки админа
	if integration.URL() != "" {
		go func() {
			ticker := time.NewTicker(5 * time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				if _, err := integration.FlushOutbox(ctx, pool, 50); err != nil {
					log.Printf("Плановая отправка outbox упала: %v", err)
				}
			}
		}()
	}

	// REQUIRE_SECRETS=1 (docker-compose, профиль prod): с секретами по умолчанию
	// из кода наружу не стартуем — иначе любой в сети выпишет себе admin-токен
	if os.Getenv("REQUIRE_SECRETS") == "1" {
		if os.Getenv("JWT_SECRET") == "" || os.Getenv("INTEGRATION_1C_SECRET") == "" {
			log.Fatal("REQUIRE_SECRETS=1: задайте JWT_SECRET и INTEGRATION_1C_SECRET в backend/.env — значения по умолчанию из кода для сервера не годятся")
		}
	}

	port := os.Getenv("GO_PORT")
	if port == "" {
		port = os.Getenv("BACKEND_PORT")
	}
	if port == "" {
		port = "3100"
	}
	log.Printf("ERP ЦМК АВРОРА (Go) слушает :%s/api/v1", port)
	// Без WriteTimeout: /events/stream — SSE и живёт долго. ReadHeader/Idle
	// закрывают полуоткрытые соединения (порт :3000 смотрит в сеть напрямую).
	srv := &http.Server{Addr: ":" + port, Handler: r, ReadHeaderTimeout: 30 * time.Second, IdleTimeout: 120 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
