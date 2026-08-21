package appserver

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/norman-w/codex-commander-go/internal/log"
)

func TestRPCIDAndMessageShapes(t *testing.T) {
	id := NumberID(7)
	message := map[string]any{"id": json.RawMessage(id.Raw), "method": "initialize"}
	data, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"id":7,"method":"initialize"}` {
		t.Fatalf("unexpected message: %s", data)
	}
}

func TestSanitizedEnvironment(t *testing.T) {
	result := sanitizedEnvironment([]string{"PATH=/bin", "COMMANDER_CWD=/tmp", "COMMANDER_PORT=8787", "OPENAI_API_KEY=secret"})
	if len(result) != 2 || result[1] != "COMMANDER_CWD=/tmp" {
		t.Fatalf("unexpected environment: %#v", result)
	}
}

type memoryTransport struct {
	mu     sync.Mutex
	writes [][]byte
	reads  chan []byte
	closed chan struct{}
}

func newMemoryTransport() *memoryTransport {
	return &memoryTransport{reads: make(chan []byte, 8), closed: make(chan struct{})}
}

func (m *memoryTransport) WriteMessage(data []byte) error {
	m.mu.Lock()
	m.writes = append(m.writes, append([]byte(nil), data...))
	m.mu.Unlock()
	return nil
}

func (m *memoryTransport) ReadMessage() ([]byte, error) {
	select {
	case data := <-m.reads:
		return data, nil
	case <-m.closed:
		return nil, errors.New("closed")
	}
}

func (m *memoryTransport) Close() error {
	select {
	case <-m.closed:
	default:
		close(m.closed)
	}
	return nil
}

func TestClientRequestAndNotificationLoop(t *testing.T) {
	transport := newMemoryTransport()
	notifications := make(chan Notification, 1)
	client := NewClient(Launch{Mode: "test"}, nilLogger(), Handlers{Notification: func(value Notification) { notifications <- value }})
	client.transport = transport
	client.closed = false
	go client.readLoop()

	resultDone := make(chan response, 1)
	go func() {
		value, err := client.RequestTimeout(context.Background(), "thread/list", map[string]any{"limit": 1}, time.Second)
		resultDone <- response{result: value, err: err}
	}()
	var request map[string]json.RawMessage
	deadline := time.Now().Add(time.Second)
	for {
		transport.mu.Lock()
		if len(transport.writes) > 0 {
			data := append([]byte(nil), transport.writes[0]...)
			transport.mu.Unlock()
			if err := json.Unmarshal(data, &request); err != nil {
				t.Fatal(err)
			}
			break
		}
		transport.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatal("request was not written")
		}
		time.Sleep(time.Millisecond)
	}
	transport.reads <- []byte(`{"id":1,"result":{"ok":true}}`)
	select {
	case result := <-resultDone:
		if result.err != nil || result.result.(map[string]any)["ok"] != true {
			t.Fatalf("unexpected result: %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("request did not complete")
	}
	transport.reads <- []byte(`{"method":"turn/started","params":{"threadId":"thread-1"}}`)
	select {
	case notification := <-notifications:
		if notification.Method != "turn/started" || notification.Params["threadId"] != "thread-1" {
			t.Fatalf("unexpected notification: %#v", notification)
		}
	case <-time.After(time.Second):
		t.Fatal("notification was not delivered")
	}
	_ = client.Stop()
}

func nilLogger() *log.Logger { return log.New("error") }
