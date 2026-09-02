// Точный перенос backend/src/common/field-access.ts. Единый источник
// правды о правах на уровне полей — используется и /auth/login (какие
// permissions отдать токену), и каждым модулем при проекции ответа.
// Синхронизировать руками с оригиналом, пока Nest жив параллельно —
// это тот файл, где расхождение тише всего и дороже всего.
package auth

import "sort"

type Grant string

const (
	GrantRead    Grant = "read"
	GrantWrite   Grant = "write"
	GrantApprove Grant = "approve"
)

type FieldGroupDef struct {
	Code         string
	Label        string
	Fields       []string
	IsCalculated bool
}

var FieldGroups = map[string][]FieldGroupDef{
	"order": {
		{Code: "core", Label: "Основное", Fields: []string{
			"orderNumber", "orderNumberAs", "orderNumberA77", "customerId", "customer",
			"region", "orderType", "status", "requestDate", "plannedShipmentDate",
			"planQuarter", "managerId", "manager", "comment", "projectId", "divisionId",
			"sourceSheet", "sourceRowNumber", "createdAt", "updatedAt",
		}},
		{Code: "commercial", Label: "Финансы", Fields: []string{
			"unitPrice", "lineTotalVat", "prepayment", "postPayment1", "postPayment2",
			"penalty", "balanceDue", "paymentDate", "paymentDocuments", "totalAmount",
		}},
		{Code: "production", Label: "Производство", Fields: []string{
			"reservedQty", "inStockQty", "qtyToProduce", "leadTimeDays",
			"productionStages", "overdueDays",
		}},
		{Code: "logistics", Label: "Отгрузка", Fields: []string{
			"shippedQty", "actNumber", "waybillNumber", "proxyNumber",
			"actualShipmentDate", "readyDate", "acceptanceActs",
		}},
		{Code: "cost", Label: "Себестоимость", IsCalculated: true, Fields: []string{
			"costPrice", "laborHours", "margin", "marginPct", "tonnage",
		}},
	},
	"article": {
		{Code: "core", Label: "Основное", Fields: []string{
			"articleCode", "legacyCode", "name", "weightKg", "series", "description",
			"palletCapacity", "isActive", "createdAt", "updatedAt",
		}},
		{Code: "price", Label: "Цены", Fields: []string{
			"approvedPrice", "priceHistory", "priceDeviationPct", "leadTimeDays",
		}},
		{Code: "cost", Label: "Себестоимость", IsCalculated: true, Fields: []string{
			"specPrice", "materialCost", "laborCost", "totalManHours", "margin",
		}},
	},
	"material": {
		{Code: "core", Label: "Основное", Fields: []string{
			"materialCode", "name", "category", "unit", "weightPerUnit", "isActive",
			"stockQty", "createdAt", "updatedAt",
		}},
		{Code: "price", Label: "Цены", Fields: []string{
			"purchasePrice", "priceUpdatedAt", "lastPurchasePrice",
		}},
	},
	"bom": {
		{Code: "core", Label: "Состав", Fields: []string{
			"articleId", "materialId", "qtyPerUnit", "unit", "operationType", "sortOrder", "notes",
		}},
		{Code: "cost", Label: "Стоимость", IsCalculated: true, Fields: []string{"lineCost", "lineMass"}},
	},
	"routing": {
		{Code: "norm", Label: "Норма", Fields: []string{"stage", "workers", "hoursPerUnit", "workCenterId", "notes"}},
		{Code: "actual", Label: "Факт", Fields: []string{"actualWorkers", "actualHours"}},
		{Code: "cost", Label: "Стоимость", IsCalculated: true, Fields: []string{"stageCost", "manHours"}},
	},
	"payment": {
		{Code: "core", Label: "Документ", Fields: []string{
			"doNumber", "doDate", "contractorId", "contractor", "currency", "category",
			"status", "orderId", "invoiceNumber", "invoiceDate", "binIin",
		}},
		{Code: "amounts", Label: "Суммы", Fields: []string{"totalAmount", "paidAmount", "unpaidAmount", "payments"}},
	},
	"stockFg": {
		{Code: "core", Label: "Движения ГП", Fields: []string{
			"articleId", "article", "movementType", "qty", "unitPrice", "totalAmount",
			"movementDate", "comment", "sourceDocumentId",
		}},
	},
	"stockMaterial": {
		{Code: "core", Label: "Движения ТМЦ", Fields: []string{
			"materialId", "material", "movementType", "qty", "unitPrice", "totalAmount",
			"movementDate", "comment", "sourceDocumentId",
		}},
	},
	"costingConfig": {
		{Code: "core", Label: "Коэффициенты", Fields: []string{
			"hourlyRate", "logisticsPct", "utilitiesPct", "vatPct", "marginPct",
			"paymentTermDays", "weldingFactor", "validFrom", "validTo",
		}},
	},
}

var roleMatrix = map[string]map[string]Grant{
	"sales_manager": {
		"order.core": GrantWrite, "order.commercial": GrantWrite, "order.production": GrantRead,
		"order.logistics": GrantRead, "article.core": GrantRead, "article.price": GrantRead,
		"payment.core": GrantRead, "payment.amounts": GrantRead, "stockFg.core": GrantRead,
	},
	"accountant": {
		"order.core": GrantRead, "order.commercial": GrantWrite, "order.logistics": GrantRead,
		"order.cost": GrantRead, "article.core": GrantRead, "article.price": GrantRead,
		"article.cost": GrantRead, "material.price": GrantRead, "payment.core": GrantWrite,
		"payment.amounts": GrantWrite, "stockFg.core": GrantRead,
	},
	"director": {
		"order.core": GrantRead, "order.commercial": GrantRead, "order.production": GrantRead,
		"order.logistics": GrantRead, "order.cost": GrantRead, "article.core": GrantRead,
		"article.price": GrantApprove, "article.cost": GrantRead, "bom.core": GrantRead,
		"bom.cost": GrantRead, "routing.norm": GrantRead, "routing.actual": GrantRead,
		"routing.cost": GrantRead, "material.core": GrantRead, "material.price": GrantRead,
		"payment.core": GrantRead, "payment.amounts": GrantRead, "stockFg.core": GrantRead,
		"stockMaterial.core": GrantRead, "costingConfig.core": GrantApprove, "audit": GrantRead,
	},
	"engineer": {
		"order.core": GrantRead, "order.production": GrantRead, "order.cost": GrantRead,
		"article.core": GrantWrite, "article.cost": GrantRead, "bom.core": GrantWrite,
		"bom.cost": GrantRead, "routing.norm": GrantWrite, "routing.actual": GrantRead,
		"routing.cost": GrantRead, "material.core": GrantRead, "material.price": GrantRead,
		"stockMaterial.core": GrantRead, "costingConfig.core": GrantRead,
	},
	"planner": {
		"order.core": GrantRead, "order.production": GrantWrite, "order.logistics": GrantRead,
		"article.core": GrantRead, "article.price": GrantRead, "bom.core": GrantRead,
		"routing.norm": GrantRead, "routing.actual": GrantRead, "material.core": GrantRead,
		"stockFg.core": GrantRead, "stockMaterial.core": GrantRead,
	},
	"shop_foreman": {
		"order.core": GrantRead, "order.production": GrantRead, "order.logistics": GrantRead,
		"article.core": GrantRead, "bom.core": GrantRead, "routing.norm": GrantRead,
		"routing.actual": GrantWrite, "stockFg.core": GrantRead,
	},
	"procurement": {
		"order.core": GrantRead, "order.commercial": GrantRead, "order.production": GrantRead,
		"article.core": GrantRead, "article.price": GrantRead, "bom.core": GrantRead,
		"material.core": GrantWrite, "material.price": GrantWrite, "payment.core": GrantWrite,
		"payment.amounts": GrantWrite, "stockMaterial.core": GrantRead,
	},
	"warehouse_material": {
		"order.core": GrantRead, "article.core": GrantRead, "material.core": GrantWrite,
		"material.price": GrantRead, "stockMaterial.core": GrantWrite,
	},
	"warehouse_fg": {
		"order.core": GrantRead, "order.production": GrantWrite, "order.logistics": GrantWrite,
		"article.core": GrantRead, "stockFg.core": GrantWrite,
	},
	"viewer": {
		"order.core": GrantRead, "order.logistics": GrantRead, "article.core": GrantRead,
	},
	"admin": {}, // admin получает всё через permissionsForRoles, матрица пуста намеренно
}

var RoleFamilies = map[string]string{
	"admin": "admin", "sales_manager": "commercial", "accountant": "commercial",
	"director": "commercial", "engineer": "engineering", "planner": "engineering",
	"shop_foreman": "engineering", "procurement": "supply", "warehouse_material": "supply",
	"warehouse_fg": "supply", "viewer": "viewer",
}

func permissionCode(resource, group string, action Grant) string {
	if group == "" {
		return resource + ":" + string(action)
	}
	return resource + "." + group + ":" + string(action)
}

func AllPermissionCodes() []string {
	var codes []string
	// map итерируется в случайном порядке в Go — сортируем ключи, чтобы
	// повторные вызовы (и сравнение с ответом Nest в тестах) были стабильны
	resources := make([]string, 0, len(FieldGroups))
	for r := range FieldGroups {
		resources = append(resources, r)
	}
	sort.Strings(resources)
	for _, resource := range resources {
		for _, g := range FieldGroups[resource] {
			codes = append(codes, permissionCode(resource, g.Code, GrantRead))
			if !g.IsCalculated {
				codes = append(codes, permissionCode(resource, g.Code, GrantWrite))
				codes = append(codes, permissionCode(resource, g.Code, GrantApprove))
			}
		}
	}
	codes = append(codes, "audit:read")
	return codes
}

func expandGrant(resource, group string, grant Grant) []string {
	read := permissionCode(resource, group, GrantRead)
	switch grant {
	case GrantRead:
		return []string{read}
	case GrantWrite:
		return []string{read, permissionCode(resource, group, GrantWrite)}
	default:
		return []string{read, permissionCode(resource, group, GrantApprove)}
	}
}

// splitKey — "order.commercial" → ("order", "commercial"); "audit" → ("audit", "")
func splitKey(key string) (string, string) {
	for i := 0; i < len(key); i++ {
		if key[i] == '.' {
			return key[:i], key[i+1:]
		}
	}
	return key, ""
}

func PermissionsForRoles(roles []string) []string {
	for _, r := range roles {
		if r == "admin" {
			return AllPermissionCodes()
		}
	}
	set := map[string]struct{}{}
	for _, role := range roles {
		matrix, ok := roleMatrix[role]
		if !ok {
			continue
		}
		for key, grant := range matrix {
			resource, group := splitKey(key)
			for _, c := range expandGrant(resource, group, grant) {
				set[c] = struct{}{}
			}
		}
	}
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

func FamilyForRoles(roles []string) string {
	for _, r := range roles {
		if r == "admin" {
			return "admin"
		}
	}
	for _, r := range roles {
		if f, ok := RoleFamilies[r]; ok {
			return f
		}
	}
	return "viewer"
}

type FieldGroupUI struct {
	Code         string   `json:"code"`
	Label        string   `json:"label"`
	Fields       []string `json:"fields"`
	IsCalculated bool     `json:"isCalculated"`
}

func FieldGroupsForUI() map[string][]FieldGroupUI {
	out := make(map[string][]FieldGroupUI, len(FieldGroups))
	for resource, groups := range FieldGroups {
		list := make([]FieldGroupUI, len(groups))
		for i, g := range groups {
			list[i] = FieldGroupUI{Code: g.Code, Label: g.Label, Fields: g.Fields, IsCalculated: g.IsCalculated}
		}
		out[resource] = list
	}
	return out
}

// HasPermission — хелпер для точечных проверок в контроллерах
// (аналог permissions.includes(...) в TS-коде).
func HasPermission(permissions []string, code string) bool {
	for _, p := range permissions {
		if p == code {
			return true
		}
	}
	return false
}

// RowScope — ограничение видимости строк (§1.8): "customer" — только
// строки привязанного заказчика (User.linkedCustomerId), "own" — только
// свои (Order.managerId = User.employeeId). Пусто — видит все строки.
type RowScope string

const (
	RowScopeOwn      RowScope = "own"
	RowScopeCustomer RowScope = "customer"
)

var roleRowScopes = map[string]map[string]RowScope{
	"viewer": {"order": RowScopeCustomer},
}

// RowScopeForRoles — скоуп набора ролей: объединение — если хоть одна
// роль видит всё, видит всё; admin всегда без ограничений. Возвращает ""
// (без ограничения), если нет строгого совпадения по всем ролям.
func RowScopeForRoles(roles []string, resource string) RowScope {
	if len(roles) == 0 {
		return ""
	}
	for _, r := range roles {
		if r == "admin" {
			return ""
		}
	}
	var scopes []RowScope
	for _, role := range roles {
		scope, ok := roleRowScopes[role][resource]
		if !ok {
			return "" // роль без ограничения расширяет видимость до всех строк
		}
		scopes = append(scopes, scope)
	}
	// 'own' уже, чем 'customer' — при нескольких ограниченных ролях берём более широкий
	for _, s := range scopes {
		if s == RowScopeCustomer {
			return RowScopeCustomer
		}
	}
	return scopes[0]
}
