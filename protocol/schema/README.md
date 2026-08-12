# visor.v1 wire protocol

Control messages are UTF-8 JSON validated by `protocol/src/index.ts`. Audio is binary to avoid Base64 overhead between the glasses and the Mac:

- `0x01 + PCM16LE`: AIR3 microphone audio, mono, 24 kHz.
- `0x02 + PCM16LE`: Realtime assistant audio, mono, 24 kHz.

OpenAI Realtime itself still receives Base64 inside its JSON WebSocket events, as required by that API. The conversion happens only on the Mac.

Every client mutation carries a UUID `requestId`. The bridge keeps a bounded response cache so retransmission after reconnect does not execute a Codex command twice.

