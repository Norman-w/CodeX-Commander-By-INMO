package protocol

import (
	"bytes"
	"testing"
)

const testRequestID = "550e8400-e29b-41d4-a716-446655440000"

func TestParseClientControlHelloAndAudio(t *testing.T) {
	raw := []byte(`{"type":"hello","protocol":"visor.v1","requestId":"550e8400-e29b-41d4-a716-446655440000","deviceId":"air3-device","deviceName":"AIR3","appVersion":"1.0","pairingCode":"123456"}`)
	message, err := ParseClientControl(raw)
	if err != nil {
		t.Fatal(err)
	}
	if message.Type != "hello" || message.PairingCode != "123456" {
		t.Fatalf("unexpected message: %#v", message)
	}

	ptt, err := ParseClientControl([]byte(`{"type":"ptt_start","requestId":"550e8400-e29b-41d4-a716-446655440000","sampleRate":24000,"channels":1,"encoding":"pcm16le"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ptt.Type != "ptt_start" {
		t.Fatalf("unexpected ptt message: %#v", ptt)
	}
}

func TestParseClientControlRejectsUnsafeMessages(t *testing.T) {
	tests := [][]byte{
		[]byte(`{"type":"ping","requestId":"not-a-uuid"}`),
		[]byte(`{"type":"hello","protocol":"visor.v1","requestId":"550e8400-e29b-41d4-a716-446655440000","deviceId":"air3-device","deviceName":"AIR3","appVersion":"1.0","token":"short"}`),
		[]byte(`{"type":"approval_decision","requestId":"550e8400-e29b-41d4-a716-446655440000","approvalRequestId":"x","decision":"accept"}`),
		[]byte(`{"type":"ptt_start","requestId":"550e8400-e29b-41d4-a716-446655440000","sampleRate":16000,"channels":1,"encoding":"pcm16le"}`),
	}
	for _, raw := range tests {
		if _, err := ParseClientControl(raw); err == nil {
			t.Fatalf("expected rejection for %s", raw)
		}
	}
}

func TestBinaryFrameRoundTrip(t *testing.T) {
	payload := []byte{0, 1, 2, 255}
	frame := EncodeBinaryFrame(ClientAudioFrame, payload)
	kind, decoded, err := DecodeBinaryFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	if kind != ClientAudioFrame || !bytes.Equal(payload, decoded) {
		t.Fatalf("unexpected frame: kind=%x payload=%v", kind, decoded)
	}
	if _, _, err := DecodeBinaryFrame([]byte{ClientAudioFrame}); err == nil {
		t.Fatal("expected empty payload to be rejected")
	}
}
