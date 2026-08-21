package voice

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/norman-w/codex-commander-go/internal/appserver"
	"github.com/norman-w/codex-commander-go/internal/config"
	"github.com/norman-w/codex-commander-go/internal/log"
)

type fakeHost struct {
	mu            sync.Mutex
	requests      []string
	notification  func(appserver.Notification)
	blockAppend   bool
	appendStarted chan struct{}
}

func (h *fakeHost) EnsureSelectedThread(context.Context) (string, error) { return "thread-1", nil }
func (h *fakeHost) StartVoiceThread(context.Context) (string, error)     { return "thread-voice", nil }
func (h *fakeHost) SubscribeNotifications(handler func(appserver.Notification)) func() {
	h.mu.Lock()
	h.notification = handler
	h.mu.Unlock()
	return func() {
		h.mu.Lock()
		h.notification = nil
		h.mu.Unlock()
	}
}
func (h *fakeHost) RequestJSONRPC(ctx context.Context, method string, params map[string]any, _ time.Duration) (any, error) {
	h.mu.Lock()
	h.requests = append(h.requests, method)
	block := h.blockAppend && method == "thread/realtime/appendAudio"
	if block && h.appendStarted != nil {
		select {
		case <-h.appendStarted:
		default:
			close(h.appendStarted)
		}
	}
	h.mu.Unlock()
	if block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return map[string]any{}, nil
}

func TestVoiceStreamsCoreRealtimePCMWithoutBrowser(t *testing.T) {
	host := &fakeHost{}
	audio := make(chan []byte, 1)
	audioEnd := make(chan string, 1)
	v := New(host, config.Config{CWD: t.TempDir(), AudioInputSource: "visor"}, log.New("error"), Events{
		Audio:    func(value []byte) { audio <- value },
		AudioEnd: func(value string) { audioEnd <- value },
	})
	ctx := context.Background()
	if err := v.BeginInput(ctx); err != nil {
		t.Fatal(err)
	}
	input := make([]byte, 4_800)
	input[0] = 1
	v.AppendInput(input)
	if err := v.EndInput(ctx); err != nil {
		t.Fatal(err)
	}
	host.mu.Lock()
	requests := append([]string(nil), host.requests...)
	host.mu.Unlock()
	if !containsRequest(requests, "thread/realtime/start") || !containsRequest(requests, "thread/realtime/appendAudio") {
		t.Fatalf("expected direct Core realtime requests, got %v", requests)
	}
	pcm := []byte{0x20, 0x03, 0x20, 0x03}
	v.HandleNotification("thread/realtime/outputAudio/delta", map[string]any{"threadId": "thread-1", "audio": map[string]any{"data": encodeBase64(pcm)}})
	v.HandleNotification("thread/realtime/transcript/delta", map[string]any{"threadId": "thread-1", "role": "assistant", "delta": "完成"})
	select {
	case got := <-audio:
		if len(got) != len(pcm) || got[0] != pcm[0] {
			t.Fatalf("unexpected output PCM: %v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("did not receive output PCM")
	}
	select {
	case got := <-audioEnd:
		if got != "完成" {
			t.Fatalf("unexpected transcript: %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not finish output audio")
	}
	_ = v.Close(context.Background())
}

func TestVoiceRejectsTooShortVisorInput(t *testing.T) {
	host := &fakeHost{}
	v := New(host, config.Config{CWD: t.TempDir(), AudioInputSource: "visor"}, log.New("error"), Events{})
	if err := v.BeginInput(context.Background()); err != nil {
		t.Fatal(err)
	}
	v.AppendInput([]byte{1, 0})
	if err := v.EndInput(context.Background()); err == nil {
		t.Fatal("expected short visor input to fail")
	}
}

func TestVoiceFailsOpenTurnWhenCoreDeniesAccess(t *testing.T) {
	host := &fakeHost{}
	errorsReceived := make(chan error, 1)
	v := New(host, config.Config{CWD: t.TempDir(), AudioInputSource: "visor"}, log.New("error"), Events{Error: func(err error) { errorsReceived <- err }})
	if err := v.BeginInput(context.Background()); err != nil {
		t.Fatal(err)
	}
	v.AppendInput(make([]byte, 4_800))
	v.HandleNotification("thread/realtime/error", map[string]any{"message": "stream disconnected before completion: Voice session access denied."})
	select {
	case err := <-errorsReceived:
		if !strings.Contains(err.Error(), "Voice Chat") {
			t.Fatalf("unexpected access error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("open voice turn did not fail")
	}
	if err := v.EndInput(context.Background()); err == nil {
		t.Fatal("expected failed turn to be closed")
	}
}

func TestVoiceAbortCancelsInFlightAppend(t *testing.T) {
	host := &fakeHost{blockAppend: true, appendStarted: make(chan struct{})}
	v := New(host, config.Config{CWD: t.TempDir(), AudioInputSource: "visor"}, log.New("error"), Events{})
	if err := v.BeginInput(context.Background()); err != nil {
		t.Fatal(err)
	}
	v.AppendInput(make([]byte, 4_800))
	select {
	case <-host.appendStarted:
	case <-time.After(time.Second):
		t.Fatal("append request did not start")
	}
	v.AbortInput()
	if err := v.EndInput(context.Background()); err == nil {
		t.Fatal("expected aborted input to be inactive")
	}
}

func containsRequest(requests []string, expected string) bool {
	for _, value := range requests {
		if value == expected {
			return true
		}
	}
	return false
}

func encodeBase64(value []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	result := make([]byte, 0, ((len(value)+2)/3)*4)
	for index := 0; index < len(value); index += 3 {
		remaining := len(value) - index
		one := value[index]
		result = append(result, alphabet[one>>2])
		if remaining == 1 {
			result = append(result, alphabet[(one&3)<<4], '=', '=')
			continue
		}
		two := value[index+1]
		result = append(result, alphabet[((one&3)<<4)|(two>>4)])
		if remaining == 2 {
			result = append(result, alphabet[(two&15)<<2], '=')
			continue
		}
		three := value[index+2]
		result = append(result, alphabet[((two&15)<<2)|(three>>6)], alphabet[three&63])
	}
	return string(result)
}
