package voice

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/norman-w/codex-commander-go/internal/config"
	"github.com/norman-w/codex-commander-go/internal/log"
)

func TestMuLawRoundTrip(t *testing.T) {
	for _, want := range []int16{0, 1_000, -1_000, 8_000, -8_000, 20_000, -20_000, 32_000, -32_000} {
		got := muLawToLinear(linearToMuLaw(want))
		error := int(got) - int(want)
		if error < 0 {
			error = -error
		}
		limit := 500
		if absolute := int(want); absolute < 0 {
			absolute = -absolute
			if absolute/8 > limit {
				limit = absolute / 8
			}
		} else if absolute/8 > limit {
			limit = absolute / 8
		}
		if error > limit {
			t.Fatalf("mu-law round trip for %d: got %d, error %d > %d", want, got, error, limit)
		}
	}
	if got := muLawToLinear(linearToMuLaw(0)); got != 0 {
		t.Fatalf("mu-law silence changed: %d", got)
	}
}

func TestWebRTCPCMResampling(t *testing.T) {
	input := make([]byte, 6*2)
	for index, sample := range []int16{100, 200, 300, 400, 500, 600} {
		input[index*2] = byte(sample)
		input[index*2+1] = byte(uint16(sample) >> 8)
	}
	got := downsample24To8(input)
	if want := []int16{200, 500}; !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected 24 kHz → 8 kHz samples: got %v, want %v", got, want)
	}
	upsampled := upsample8To24(got)
	if len(upsampled) != len(got)*3*2 {
		t.Fatalf("unexpected upsampled byte count: got %d", len(upsampled))
	}
	for index, want := range []int16{200, 200, 200, 500, 500, 500} {
		got := int16(uint16(upsampled[index*2]) | uint16(upsampled[index*2+1])<<8)
		if got != want {
			t.Fatalf("upsample sample %d: got %d, want %d", index, got, want)
		}
	}
}

func TestHasAudiblePCMUsesQuantizationFloor(t *testing.T) {
	if hasAudiblePCM([]byte{0, 0, 8, 0, 0xf8, 0xff}) {
		t.Fatal("PCM quantization floor should not be treated as audible")
	}
	if !hasAudiblePCM([]byte{9, 0}) || !hasAudiblePCM([]byte{0xf7, 0xff}) {
		t.Fatal("quiet non-silent PCM should be delivered")
	}
}

func TestFindSDPInNestedRPCResult(t *testing.T) {
	want := "v=0\r\no=- pure-go-answer"
	value := map[string]any{
		"result": []any{
			map[string]any{
				"transport": map[string]any{"sdp": want},
			},
		},
	}
	if got := findSDP(value); got != want {
		t.Fatalf("findSDP: got %q, want %q", got, want)
	}
	if got := findSDP(map[string]any{"result": map[string]any{"message": "no answer"}}); got != "" {
		t.Fatalf("findSDP found an SDP where none existed: %q", got)
	}
}

func TestWebRTCDataChannelEvents(t *testing.T) {
	type caption struct {
		role string
		text string
		done bool
	}
	var captions []caption
	var received error
	session := newWebRTCSession(nil, config.Config{}, log.New("error"), webRTCEvents{
		Caption: func(role, text string, done bool) {
			captions = append(captions, caption{role: role, text: text, done: done})
		},
		Error: func(err error) { received = err },
	})
	session.handleDataChannel([]byte(`{"type":"response.audio_transcript.delta","delta":"你好"}`))
	session.handleDataChannel([]byte(`{"type":"conversation.item.input_audio_transcription.completed","transcript":"测试输入"}`))
	session.handleDataChannel([]byte(`{"type":"error","error":{"message":"realtime failed"}}`))
	if len(captions) != 2 || captions[0] != (caption{role: "assistant", text: "你好"}) || captions[1] != (caption{role: "user", text: "测试输入", done: true}) {
		t.Fatalf("unexpected data-channel captions: %#v", captions)
	}
	if received == nil || received.Error() != "realtime failed" {
		t.Fatalf("unexpected data-channel error: %v", received)
	}
}

func TestWebRTCFramelessBidiDataChannelEvents(t *testing.T) {
	type caption struct {
		role string
		text string
		done bool
	}
	var captions []caption
	session := newWebRTCSession(nil, config.Config{}, log.New("error"), webRTCEvents{
		Caption: func(role, text string, done bool) {
			captions = append(captions, caption{role: role, text: text, done: done})
		},
	})
	session.handleDataChannel([]byte(`{"type":"input_transcript.added","item":{"text":"你好"}}`))
	session.handleDataChannel([]byte(`{"type":"output_transcript.added","item":{"text":"我在。"}}`))
	session.handleDataChannel([]byte(`{"type":"turn.done","turn":{"role":"assistant","transcript":"我在。"}}`))
	want := []caption{
		{role: "user", text: "你好"},
		{role: "assistant", text: "我在。"},
		{role: "assistant", text: "我在。", done: true},
	}
	if !reflect.DeepEqual(captions, want) {
		t.Fatalf("unexpected Frameless Bidi captions: %#v", captions)
	}
}

func TestWebRTCInputLifecycleRequiresOpenDataChannel(t *testing.T) {
	session := newWebRTCSession(nil, config.Config{}, log.New("error"), webRTCEvents{})
	if err := session.BeginInput(); err == nil || !strings.Contains(err.Error(), "not open") {
		t.Fatalf("expected BeginInput to reject a session without a data channel, got %v", err)
	}
	if err := session.EndInput(context.Background()); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("expected EndInput to reject a session without a data channel, got %v", err)
	}
	if err := session.failStart(errors.New("test failure")); err == nil || err.Error() != "test failure" {
		t.Fatalf("unexpected failStart result: %v", err)
	}
}
