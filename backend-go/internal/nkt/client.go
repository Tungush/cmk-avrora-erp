// Package nkt — обмен с Национальным каталогом товаров РК (nationalcatalog.kz):
// присвоение кодов NTIN изделиям ЦМК.
//
// Фактический контракт снят с боевой спецификации и разобран в
// docs/nkt/API.md; там же расхождения с ТЗ. Коротко о том, что важно знать
// при чтении этого файла:
//
//   - База — https://nationalcatalog.kz/gwp, дальше пути из спецификации.
//     Без префикса /gwp портал отдаёт HTML своего SPA со статусом 200,
//     и это выглядит как «сервер вернул мусор», хотя дело в адресе.
//   - Ключ — заголовок X-API-KEY, не Bearer.
//   - Поиск карточки и заявки — один сервис с одним ключом. Отдельного
//     «API поиска» из ТЗ не существует.
//   - Содержимое карточки — пары «код атрибута → значение», разложенные по
//     четырём массивам. Плоских полей name/brand/gtin в теле нет.
package nkt

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// BaseURL — адрес НКТ. Переопределяется для тестового контура (stg.nct.kz)
// без пересборки: среда меняется настройкой, а не кодом (ТЗ §14).
func BaseURL() string {
	if v := strings.TrimSuffix(os.Getenv("NKT_BASE_URL"), "/"); v != "" {
		return v
	}
	return "https://nationalcatalog.kz/gwp"
}

// APIKey — ключ из личного кабинета НКТ, раздел «Ключи API».
func APIKey() string { return os.Getenv("NKT_API_KEY") }

// Configured — без ключа фоновые задания не поднимаются и обмен не идёт:
// карточки просто копятся в очереди, как outbox без адреса 1С.
func Configured() bool { return APIKey() != "" }

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

// HTTPError — отказ НКТ. Код и тело нужны сервису, чтобы отличить ретраить
// от не ретраить (ТЗ §13): 5xx и таймаут — с задержкой, 4xx — сразу в разбор.
type HTTPError struct {
	Code       int
	Body       string
	RetryAfter time.Duration
}

func (e *HTTPError) Error() string {
	msg := strings.TrimSpace(e.Body)
	if len(msg) > 500 {
		msg = msg[:500] + "…"
	}
	return fmt.Sprintf("НКТ вернул %d: %s", e.Code, msg)
}

// Retryable — сетевые сбои, 5xx и 429 повторяются; 4xx (кроме 401 и 429) нет.
func (e *HTTPError) Retryable() bool {
	return e.Code >= 500 || e.Code == 429 || e.Code == 0
}

// ---------------------------------------------------------------------------
// Клиент
// ---------------------------------------------------------------------------

// Recorder пишет строку журнала обмена. Клиент зовёт его на каждый вызов,
// включая неуспешный: разбираться с модератором и с админом НКТ приходится
// по сырым телам, а не по нашей интерпретации.
type Recorder func(ctx context.Context, rec Record)

// Record — одна строка журнала. Заголовки не передаются вовсе: ключ не
// должен попасть ни в журнал, ни в текст ошибки (ТЗ §14).
type Record struct {
	Method     string
	URL        string
	HTTPCode   int
	Request    string
	Response   string
	DurationMs int
}

type Client struct {
	http     *http.Client
	recorder Recorder
}

func NewClient(rec Recorder) *Client {
	return &Client{
		// Модерация и публикация отвечают не мгновенно; при этом клиент
		// живёт в фоновом задании, а не в запросе пользователя
		http:     &http.Client{Timeout: 60 * time.Second},
		recorder: rec,
	}
}

// do — единственное место, где выполняется HTTP: авторизация, журнал и
// разбор ошибки одинаковы для всех методов.
func (c *Client) do(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	full := BaseURL() + path

	var reqBody []byte
	if body != nil {
		var err error
		reqBody, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}

	var reader io.Reader
	if reqBody != nil {
		reader = bytes.NewReader(reqBody)
	}
	req, err := http.NewRequestWithContext(ctx, method, full, reader)
	if err != nil {
		return err
	}
	req.Header.Set("X-API-KEY", APIKey())
	req.Header.Set("Accept", "application/json")
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	started := time.Now()
	res, err := c.http.Do(req)
	if err != nil {
		c.record(ctx, Record{Method: method, URL: full, Request: string(reqBody),
			Response: "сеть: " + err.Error(), DurationMs: msSince(started)})
		return &HTTPError{Code: 0, Body: err.Error()}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)

	c.record(ctx, Record{Method: method, URL: full, HTTPCode: res.StatusCode,
		Request: string(reqBody), Response: string(raw), DurationMs: msSince(started)})

	if res.StatusCode >= 400 {
		return &HTTPError{Code: res.StatusCode, Body: string(raw), RetryAfter: retryAfter(res)}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			// Не разобрали ответ — это не «всё хорошо»: полный ответ уже в
			// журнале, наверх уходит честная ошибка (ТЗ §13)
			return &HTTPError{Code: res.StatusCode, Body: "ответ не разобран: " + err.Error()}
		}
	}
	return nil
}

func (c *Client) record(ctx context.Context, rec Record) {
	if c.recorder != nil {
		c.recorder(ctx, rec)
	}
}

func msSince(t time.Time) int { return int(time.Since(t).Milliseconds()) }

func retryAfter(res *http.Response) time.Duration {
	if v := res.Header.Get("Retry-After"); v != "" {
		if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
			return time.Duration(secs) * time.Second
		}
	}
	return 0
}

// ---------------------------------------------------------------------------
// Тела запросов и ответов
// ---------------------------------------------------------------------------

// AttributeValue — пара «код атрибута → значение» в теле заявки.
// У multiDictionary несколько значений передаются одной строкой через «@».
type AttributeValue struct {
	Code   string `json:"code,omitempty"`
	Value  string `json:"value,omitempty"`
	NameRu string `json:"nameRu,omitempty"`
	NameKk string `json:"nameKk,omitempty"`
}

// ImageRef — предварительно загруженное изображение.
// imageType: front | back | left | right | top | bottom.
type ImageRef struct {
	FileName  string `json:"fileName"`
	ImageType string `json:"imageType"`
}

// RequestBody — тело создания и обновления заявки.
//
// Разложение по группам — не наша прихоть: атрибут, переданный не в своей
// группе, роняет валидацию с указанием его кода. Исключение — признаки
// формы szpt_category и is_domestic: они идут в Attributes.
type RequestBody struct {
	Oktru           string           `json:"oktru"`
	AutoPublication bool             `json:"autoPublication"`
	Ntin            string           `json:"ntin,omitempty"`
	IsGov           bool             `json:"isGov,omitempty"`
	Attributes      []AttributeValue `json:"attributes"`
	MainExtended    []AttributeValue `json:"mainExtendedAttributes,omitempty"`
	AdditionalExt   []AttributeValue `json:"additionalExtendedAttributes,omitempty"`
	ImageFiles      []ImageRef       `json:"imageFiles,omitempty"`
}

// Attribute — описание атрибута из схемы НКТ.
type Attribute struct {
	Code           string `json:"code"`
	NameRu         string `json:"nameRu"`
	NameKk         string `json:"nameKk"`
	DescriptionRu  string `json:"descriptionRu"`
	DataType       string `json:"dataType"`
	IsRequired     bool   `json:"isRequired"`
	DictionaryCode string `json:"dictionaryCode"`
	Pattern        string `json:"pattern"`
	MaxLength      int    `json:"maxLength"`
	MinValue       string `json:"minValue"`
	MaxValue       string `json:"maxValue"`
	AttributeOrder int    `json:"attributeOrder"`
}

// RequestStatus — ответ /requests/{id}/status.
type RequestStatus struct {
	Code            string           `json:"code"`
	Value           string           `json:"value"`
	NtinCode        string           `json:"ntinCode"`
	ProductURL      string           `json:"productUrl"`
	Comment         string           `json:"comment"`
	Reason          string           `json:"reason"`
	RevisionDetails []RevisionDetail `json:"revisionDetails"`
	PhotoModeration *PhotoModeration `json:"photoModeration"`
	NextAction      *NextAction      `json:"nextAction"`
	GzStatus        map[string]any   `json:"gzStatus"`
}

type RevisionDetail struct {
	AttributeCode string `json:"attributeCode"`
	Value         string `json:"value"`
	Comment       string `json:"comment"`
}

type PhotoModeration struct {
	Score   int    `json:"score"`
	Comment string `json:"comment"`
}

type NextAction struct {
	Description string `json:"description"`
	Method      string `json:"method"`
	Endpoint    string `json:"endpoint"`
}

// Duplicate — похожая карточка, найденная самим НКТ.
type Duplicate struct {
	OrderNumber int     `json:"orderNumber"`
	Name        string  `json:"name"`
	Brand       string  `json:"brand"`
	Gtin        string  `json:"gtin"`
	Ntin        string  `json:"ntin"`
	Similarity  float64 `json:"similarity"`
}

// Product — карточка из каталога (поиск по NTIN или GTIN).
type Product struct {
	Gtin       string      `json:"gtin"`
	Ntin       string      `json:"ntin"`
	NameRu     string      `json:"nameRu"`
	Attributes []Attribute `json:"attributes"`
}

// DictionaryItem — значение справочника НКТ.
type DictionaryItem struct {
	Code   string `json:"code"`
	NameRu string `json:"nameRu"`
	NameKk string `json:"nameKk"`
}

// ---------------------------------------------------------------------------
// Методы
// ---------------------------------------------------------------------------

const apiV1 = "/portal/api/v1"

// ProductByTIN — карточка по NTIN или GTIN, один и тот же путь.
// found = false при 404: товара в каталоге нет, это не ошибка обмена.
func (c *Client) ProductByTIN(ctx context.Context, tin string) (*Product, bool, error) {
	var out Product
	err := c.do(ctx, http.MethodGet, "/portal/api/v2/products/"+url.PathEscape(tin), nil, &out)
	if err != nil {
		var he *HTTPError
		if e, ok := err.(*HTTPError); ok {
			he = e
		}
		if he != nil && he.Code == http.StatusNotFound {
			return nil, false, nil
		}
		return nil, false, err
	}
	return &out, true, nil
}

// CreateRequest — черновик заявки. Возвращает идентификатор заявки в НКТ.
// На этом шаге выполняется только базовая проверка: полная — на модерации.
func (c *Client) CreateRequest(ctx context.Context, body RequestBody) (string, error) {
	var out struct {
		ID json.Number `json:"id"`
	}
	if err := c.do(ctx, http.MethodPost, apiV1+"/products/requests", body, &out); err != nil {
		return "", err
	}
	if out.ID.String() == "" {
		return "", fmt.Errorf("НКТ не вернул идентификатор заявки")
	}
	return out.ID.String(), nil
}

func (c *Client) UpdateRequest(ctx context.Context, id string, body RequestBody) error {
	return c.do(ctx, http.MethodPut, apiV1+"/products/requests/"+url.PathEscape(id), body, nil)
}

func (c *Client) SendToModeration(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPut, apiV1+"/products/requests/"+url.PathEscape(id)+"/moderation", nil, nil)
}

func (c *Client) Publish(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPut, apiV1+"/products/requests/"+url.PathEscape(id)+"/publish", nil, nil)
}

func (c *Client) Cancel(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPut, apiV1+"/products/requests/"+url.PathEscape(id)+"/cancel", nil, nil)
}

func (c *Client) Status(ctx context.Context, id string) (*RequestStatus, error) {
	var out RequestStatus
	if err := c.do(ctx, http.MethodGet, apiV1+"/products/requests/"+url.PathEscape(id)+"/status", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Duplicates(ctx context.Context, id string) ([]Duplicate, error) {
	var out []Duplicate
	if err := c.do(ctx, http.MethodGet, apiV1+"/products/requests/"+url.PathEscape(id)+"/duplicates", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DuplicateDecision — решение менеджера по найденным дублям.
// decision: CONTINUE — делать свою карточку; USE_EXISTING — взять чужую,
// тогда обязателен ntin выбранной.
func (c *Client) DuplicateDecision(ctx context.Context, id, decision, ntin string) error {
	body := map[string]string{"decision": decision}
	if ntin != "" {
		body["ntin"] = ntin
	}
	return c.do(ctx, http.MethodPost, apiV1+"/products/requests/"+url.PathEscape(id)+"/duplicate-decision", body, nil)
}

// BaseAttributes — базовые атрибуты, общие для всех категорий.
func (c *Client) BaseAttributes(ctx context.Context) ([]Attribute, error) {
	var out []Attribute
	if err := c.do(ctx, http.MethodGet, apiV1+"/products/requests/attributes", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GovAttributes — расширенные атрибуты категории: основные (единый набор
// ЦЭФ, без него не пройти модерацию) и дополнительные, свои у каждой ОКТРУ.
func (c *Client) GovAttributes(ctx context.Context, oktru string) (main, additional []Attribute, err error) {
	var out struct {
		MainAttributes       []Attribute `json:"mainAttributes"`
		AdditionalAttributes []Attribute `json:"additionalAttributes"`
	}
	path := apiV1 + "/products/requests/categories/" + url.PathEscape(oktru) + "/gov-attributes"
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, nil, err
	}
	return out.MainAttributes, out.AdditionalAttributes, nil
}

// DictionaryItems — значения справочника постранично.
// Возвращает страницу и общее число страниц.
func (c *Client) DictionaryItems(ctx context.Context, code string, page, size int) ([]DictionaryItem, int, error) {
	var out struct {
		Content    []DictionaryItem `json:"content"`
		TotalPages int              `json:"totalPages"`
	}
	path := fmt.Sprintf("%s/dictionaries/%s/items?page=%d&size=%d", apiV1, url.PathEscape(code), page, size)
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, 0, err
	}
	return out.Content, out.TotalPages, nil
}

// UploadImage — загрузка фотографии. Возвращает имя файла в хранилище НКТ,
// которое подставляется в imageFiles заявки.
func (c *Client) UploadImage(ctx context.Context, filename string, data []byte) (string, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	part, err := w.CreateFormFile("file", filename)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}

	full := BaseURL() + apiV1 + "/storage/upload"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, full, &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("X-API-KEY", APIKey())
	req.Header.Set("Content-Type", w.FormDataContentType())

	started := time.Now()
	res, err := c.http.Do(req)
	if err != nil {
		c.record(ctx, Record{Method: "POST uploadImage", URL: full,
			Response: "сеть: " + err.Error(), DurationMs: msSince(started)})
		return "", &HTTPError{Code: 0, Body: err.Error()}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	// Тело запроса — двоичный файл, в журнал попадает только его имя
	c.record(ctx, Record{Method: "POST uploadImage", URL: full, HTTPCode: res.StatusCode,
		Request: filename, Response: string(raw), DurationMs: msSince(started)})
	if res.StatusCode >= 400 {
		return "", &HTTPError{Code: res.StatusCode, Body: string(raw), RetryAfter: retryAfter(res)}
	}
	var out struct {
		Filename string `json:"filename"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Filename == "" {
		return "", &HTTPError{Code: res.StatusCode, Body: "ответ загрузки не разобран"}
	}
	return out.Filename, nil
}
