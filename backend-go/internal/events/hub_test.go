package events

import (
	"testing"
	"time"
)

func TestEmitDeliversAndCancelStops(t *testing.T) {
	ch, cancel := Subscribe()

	Emit("article:cost_updated", map[string]interface{}{"articleId": "a1"})
	select {
	case ev := <-ch:
		if ev.Type != "article:cost_updated" || ev.Data["articleId"] != "a1" {
			t.Fatalf("пришло не то событие: %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("событие не дошло до подписчика")
	}

	cancel()
	Emit("after:cancel", nil)
	select {
	case ev := <-ch:
		t.Fatalf("после отписки пришло %+v", ev)
	default:
	}
	cancel() // отписка идемпотентна
}

func TestEmitDoesNotBlockOnSlowSubscriber(t *testing.T) {
	_, cancel := Subscribe() // никто не читает
	defer cancel()

	done := make(chan struct{})
	go func() {
		for i := 0; i < subscriberBuffer*3; i++ {
			Emit("z", nil)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Emit заблокировался на медленном подписчике")
	}
}
