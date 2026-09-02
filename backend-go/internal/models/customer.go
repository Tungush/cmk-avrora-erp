package models

// Customer — перенос Prisma.Customer (customers.controller.ts). Как и
// Material, без createdAt/updatedAt — этих полей нет в реальной модели.
type Customer struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	BinIin       string  `json:"binIin"`
	Region       *string `json:"region"`
	CustomerType string  `json:"customerType"` // API-код: OUTSIDE/INSIDE (см. CustomerTypeDBToAPI)
}

// Postgres хранит тип контрагента русской меткой (@map в schema.prisma),
// Prisma переводит в английский код enum на границе API — тот же паттерн,
// что CategoryDBToAPI/OperationTypeDBToAPI/RoutingStageDBToAPI.
var customerTypeDBToAPI = map[string]string{
	"Внешний":    "OUTSIDE",
	"Внутренний": "INSIDE",
}

var customerTypeAPIToDB = map[string]string{
	"OUTSIDE": "Внешний",
	"INSIDE":  "Внутренний",
}

func CustomerTypeDBToAPI(db string) string {
	if v, ok := customerTypeDBToAPI[db]; ok {
		return v
	}
	return db
}

func CustomerTypeAPIToDB(api string) string {
	if v, ok := customerTypeAPIToDB[api]; ok {
		return v
	}
	return api
}
