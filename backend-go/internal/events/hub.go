// Package events — перенос events.service.ts: in-process шина живых событий
// (§3.4). У Nest это rxjs Subject; подписчик один — SSE-поток
// GET /events/stream (platform/events.go). События несут только id —
// данные клиент перечитывает через авторизованный API.
package events

import "sync"

// Event — DomainEvent оригинала: { type, data }.
type Event struct {
	Type string
	Data map[string]interface{}
}

// Буфер на подписчика: Subject.next() у rxjs никогда не ждёт получателя,
// поэтому и здесь издатель не блокируется — медленный подписчик с полным
// буфером событие теряет (не накапливаем очередь в памяти сервера).
const subscriberBuffer = 64

var (
	mu     sync.RWMutex
	subs   = map[uint64]chan Event{}
	nextID uint64
)

// Emit — subject.next({ type, data }): рассылка всем текущим подписчикам,
// без блокировки издателя.
func Emit(typ string, data map[string]interface{}) {
	ev := Event{Type: typ, Data: data}
	mu.RLock()
	defer mu.RUnlock()
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// Subscribe — subject.asObservable(): буферизованный канал событий и
// функция отписки (идемпотентна). Канал не закрывается — читатель
// завершает цикл сам по своему контексту.
func Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, subscriberBuffer)
	mu.Lock()
	id := nextID
	nextID++
	subs[id] = ch
	mu.Unlock()

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			mu.Lock()
			delete(subs, id)
			mu.Unlock()
		})
	}
	return ch, cancel
}
