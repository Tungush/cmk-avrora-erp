package orderstate

import "strings"

// Пара складов для «изготовлено → списание» (01.09.2026, подтверждено
// разбором расширения «Аврора»: `avr_СкладПолучательПоПравилу`). Приёмник
// зависит не от подразделения, а от того, на какой склад ГП оформлен заказ
// (свободный текст 1С в rawColumns['Склад']). Источник всегда один.
const sourceWarehouse = "74п_Склад Сырья"
const defaultTargetWarehouse = "74п_Кладовая_ЦМК"
const cmk2TargetWarehouse = "74п_ЦМК2_Кладовая_ЦМК"

// ResolveProductionWarehouses — rawColumns передаётся как уже распарсенная
// map[string]interface{} (JSON-поле raw_columns), значение 'Склад' читается
// как строка.
func ResolveProductionWarehouses(rawColumns map[string]interface{}) (fromWarehouse, toWarehouse string) {
	raw := ""
	if rawColumns != nil {
		if v, ok := rawColumns["Склад"]; ok {
			if s, ok := v.(string); ok {
				raw = s
			}
		}
	}
	raw = strings.ToUpper(raw)
	raw = strings.NewReplacer(" ", "", "_", "", "-", "").Replace(raw)
	isCmk2 := strings.Contains(raw, "ЦМК2")
	toWarehouse = defaultTargetWarehouse
	if isCmk2 {
		toWarehouse = cmk2TargetWarehouse
	}
	return sourceWarehouse, toWarehouse
}
