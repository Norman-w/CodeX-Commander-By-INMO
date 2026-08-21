# visor.v1 wire protocol

Control messages are UTF-8 JSON validated by `mac-bridge-go/internal/protocol/protocol.go`. Audio is binary to avoid Base64 overhead between the glasses and the Mac:

- `0x01 + PCM16LE`: AIR3 microphone audio, mono, 24 kHz.
- `0x02 + PCM16LE`: Realtime assistant audio, mono, 24 kHz.

Codex Core realtime itself still receives Base64 inside its JSON-RPC payloads. The conversion happens only inside the Go Bridge.

Every client mutation carries a UUID `requestId`. The bridge keeps a bounded response cache so retransmission after reconnect does not execute a Codex command twice.
