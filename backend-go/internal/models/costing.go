package models

// RoutingStage — Postgres хранит русскую метку (@map в schema.prisma),
// Prisma переводит в английское имя enum на границе API. Тот же паттерн,
// что CategoryDBToAPI/OperationTypeDBToAPI.
var routingStageDBToAPI = map[string]string{
	"резка": "CUTTING",
	"сборка/сварка/обшивка": "ASSEMBLY",
	"зачистка/покраска":     "PAINTING",
}

var routingStageAPIToDB = map[string]string{
	"CUTTING":  "резка",
	"ASSEMBLY": "сборка/сварка/обшивка",
	"PAINTING": "зачистка/покраска",
}

func RoutingStageDBToAPI(db string) string {
	if v, ok := routingStageDBToAPI[db]; ok {
		return v
	}
	return db
}

func RoutingStageAPIToDB(api string) string {
	if v, ok := routingStageAPIToDB[api]; ok {
		return v
	}
	return api
}
