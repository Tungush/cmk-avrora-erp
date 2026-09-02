// Package bitrix — перенос bitrix-client.service.ts. Без вебхука задача
// оператору — тихий no-op с логом, сделка снабжения — честная ошибка.
package bitrix

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"cmk-avrora-erp/backend-go/internal/common"
)

func webhookURL() string { return strings.TrimSuffix(os.Getenv("B24_WEBHOOK_URL"), "/") }
func Configured() bool   { return os.Getenv("B24_WEBHOOK_URL") != "" }
func operatorID() string {
	if v := os.Getenv("B24_OPERATOR_ID"); v != "" {
		return v
	}
	return "1"
}

var httpClient = &http.Client{Timeout: 15 * time.Second}

func post(ctx context.Context, method string, body interface{}) (map[string]interface{}, int, string, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", webhookURL()+"/"+method, bytes.NewReader(b))
	if err != nil {
		return nil, 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, 0, "", err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]interface{}
	_ = json.Unmarshal(raw, &out)
	return out, res.StatusCode, string(raw), nil
}

type NomenclatureRequest struct {
	ID, ProposedName                 string
	Description, Reason, RequestedBy *string
}

// CreateNomenclatureTask — задача оператору 1С; nil при отсутствии вебхука или ошибке.
func CreateNomenclatureTask(ctx context.Context, r NomenclatureRequest) *string {
	if !Configured() {
		log.Printf("B24_WEBHOOK_URL не задан — задача по заявке «%s» не создана (заявка %s)", r.ProposedName, r.ID)
		return nil
	}
	lines := []string{"Заявка из ERP ЦМК АВРОРА №" + r.ID, "Наименование (слова заявителя): " + r.ProposedName}
	if r.Description != nil && *r.Description != "" {
		lines = append(lines, "Описание: "+*r.Description)
	}
	if r.Reason != nil && *r.Reason != "" {
		lines = append(lines, "Причина: "+*r.Reason)
	}
	if r.RequestedBy != nil && *r.RequestedBy != "" {
		lines = append(lines, "Заявитель: "+*r.RequestedBy)
	}
	lines = append(lines, "", "После заведения в 1С код и имя подтянутся в ERP автоматически при синхронизации.")
	out, status, raw, err := post(ctx, "tasks.task.add.json", map[string]interface{}{"fields": map[string]interface{}{
		"TITLE": "Завести номенклатуру в 1С: " + r.ProposedName, "DESCRIPTION": strings.Join(lines, "\n"), "RESPONSIBLE_ID": operatorID(),
	}})
	if err == nil && (status < 200 || status >= 300) {
		if len(raw) > 200 {
			raw = raw[:200]
		}
		err = fmt.Errorf("Б24 ответил %d: %s", status, raw)
	}
	var taskID string
	if err == nil {
		if res, ok := out["result"].(map[string]interface{}); ok {
			if t, ok := res["task"].(map[string]interface{}); ok {
				taskID = fmt.Sprint(t["id"])
			}
		} else if out["result"] != nil {
			taskID = fmt.Sprint(out["result"])
		}
		if taskID == "" {
			err = errors.New("Б24 не вернул id задачи")
		}
	}
	if err != nil {
		log.Printf("Не удалось создать задачу Б24 по заявке %s: %v", r.ID, err)
		return nil
	}
	return &taskID
}

type SupplyLine struct {
	Code, Name, Unit string
	Qty, EstPrice    float64
}

var ErrNotConfigured = errors.New("B24_WEBHOOK_URL не задан — заявка не отправлена. Настройте вебхук Битрикс24.")

// CreateSupplyDeal — сводная заявка на закуп → одна сделка воронки снабжения.
func CreateSupplyDeal(ctx context.Context, title string, lines []SupplyLine, totalEstimate float64, requestedBy string) (string, error) {
	if !Configured() {
		return "", ErrNotConfigured
	}
	var parts []string
	for _, l := range lines {
		s := fmt.Sprintf("%s · %s — %s %s", l.Code, l.Name, trimFloat(l.Qty), l.Unit)
		if l.EstPrice != 0 {
			s += " (~" + common.FmtRu(common.JsRound(l.Qty*l.EstPrice)) + " ₸)"
		}
		parts = append(parts, s)
	}
	parts = append(parts, "", "Оценка итого: "+common.FmtRu(common.JsRound(totalEstimate))+" ₸")
	if requestedBy != "" {
		parts = append(parts, "Заявку сформировал: "+requestedBy)
	}
	fields := map[string]interface{}{"TITLE": title, "COMMENTS": strings.Join(parts, "\n"), "ASSIGNED_BY_ID": operatorID(),
		"OPPORTUNITY": common.JsRound(totalEstimate), "CURRENCY_ID": "KZT"}
	if v := os.Getenv("B24_SUPPLY_CATEGORY_ID"); v != "" {
		fields["CATEGORY_ID"] = v
	}
	return createDeal(ctx, fields)
}

func createDeal(ctx context.Context, fields map[string]interface{}) (string, error) {
	out, status, raw, err := post(ctx, "crm.deal.add.json", map[string]interface{}{"fields": fields})
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("Б24 ответил %d", status)
	}
	if out["result"] == nil {
		if len(raw) > 200 {
			raw = raw[:200]
		}
		return "", fmt.Errorf("Б24 не вернул id сделки: %s", raw)
	}
	return fmt.Sprint(out["result"]), nil
}

func trimFloat(n float64) string { return fmt.Sprintf("%v", n) }

// WorksLine — строка сводной заявки на подряд для сделки «Заказ на Работы».
type WorksLine struct {
	Number, StageLabel, Description string
	Qty, Rate, Estimate             *float64
	Unit                            string
	AtOurShop                       bool
	ContractorName                  *string
}

// CreateWorksRequestDeal — пачка заявок на подряд → одна сделка воронки
// «Заказ на Работы». Без вебхука — честная ошибка, не тихий no-op.
func CreateWorksRequestDeal(ctx context.Context, title string, lines []WorksLine, totalEstimate float64, requestedBy string) (string, error) {
	if !Configured() {
		return "", ErrNotConfigured
	}
	var parts []string
	for _, l := range lines {
		items := []string{l.Number + " · " + l.StageLabel + " — " + l.Description}
		if l.Qty != nil {
			items = append(items, "объём "+trimFloat(*l.Qty)+" "+l.Unit)
		}
		if l.Rate != nil {
			items = append(items, "ставка "+common.FmtRu(common.JsRound(*l.Rate))+" ₸/"+l.Unit)
		} else {
			items = append(items, "ставка не назначена")
		}
		if l.Estimate != nil && *l.Estimate != 0 {
			items = append(items, "~"+common.FmtRu(common.JsRound(*l.Estimate))+" ₸")
		}
		if l.AtOurShop {
			items = append(items, "работы в нашем цеху")
		} else {
			items = append(items, "на площадке подрядчика")
		}
		if l.ContractorName != nil && *l.ContractorName != "" {
			items = append(items, "подрядчик: "+*l.ContractorName)
		} else {
			items = append(items, "подрядчик не выбран — подобрать")
		}
		parts = append(parts, strings.Join(items, " · "))
	}
	parts = append(parts, "")
	if totalEstimate > 0 {
		parts = append(parts, "Оценка итого: "+common.FmtRu(common.JsRound(totalEstimate))+" ₸")
	} else {
		parts = append(parts, "Оценка не задана — назвать цену при подборе подрядчика")
	}
	parts = append(parts, "Оформить заказ поставщику от А77.")
	if requestedBy != "" {
		parts = append(parts, "Заявку сформировал: "+requestedBy)
	}
	fields := map[string]interface{}{"TITLE": title, "COMMENTS": strings.Join(parts, "\n"), "ASSIGNED_BY_ID": operatorID()}
	if totalEstimate > 0 {
		fields["OPPORTUNITY"] = common.JsRound(totalEstimate)
		fields["CURRENCY_ID"] = "KZT"
	}
	if v := os.Getenv("B24_WORKS_CATEGORY_ID"); v != "" {
		fields["CATEGORY_ID"] = v
	}
	return createDeal(ctx, fields)
}
