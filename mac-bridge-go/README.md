# CodeX Commander Go Bridge

这是 CodeX Commander 的纯 Go Mac Bridge。它只使用 Go 进程完成 HTTP、WebSocket、配对、Codex app-server JSON-RPC、Core realtime PCM、任务审批和图片服务，不会启动 Google Chrome、Chromium、Electron 或任何隐藏网页。

语音链路直接使用 Codex Core realtime。默认 `auto` 在 ChatGPT managed `gui_shared` 中使用 Pion 纯 Go WebRTC，在独立 `stdio` 中使用 app-server WebSocket + PCM：

```text
AIR3 PCM → /v1/visor → Go Bridge/Pion RTP → thread/realtime/start (webrtc)
Codex RTP/audio ← /v1/visor ← Go Bridge/Pion ← oai-events + Core realtime

stdio/API-key fallback:
AIR3 PCM → /v1/visor → Go Bridge → thread/realtime/appendAudio
Codex PCM ← /v1/visor ← Go Bridge ← thread/realtime/outputAudio/delta
```

macOS 的电脑麦克风和扬声器由 Go 的 CoreAudio 原生层直接处理（24 kHz、单声道、PCM16），不会启动浏览器或创建隐藏页面。根目录 `/` 只是可选的本地诊断/设置页；只有用户主动访问它时，才会请求麦克风并把诊断 PCM 发到 `/v1/management-audio`。

## 运行

```bash
go -C mac-bridge-go test ./...
go -C mac-bridge-go build -o mac-bridge-go/bridge ./cmd/bridge
./mac-bridge-go/bridge
```

默认监听 `127.0.0.1:8787`。配置示例：

```dotenv
COMMANDER_APP_SERVER_MODE=gui_shared
COMMANDER_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex
COMMANDER_CWD=/absolute/path/to/workspace
COMMANDER_AUDIO_INPUT_SOURCE=visor
# bridge=Go Bridge/Mac 扬声器，web=8787 指挥中心网页扬声器，visor=AIR3 扬声器；可用 none 全部关闭
COMMANDER_AUDIO_OUTPUTS=bridge,visor
COMMANDER_REALTIME_TRANSPORT=auto
COMMANDER_REALTIME_VOICE=juniper
```

`gui_shared` 直接连接 `~/.codex/app-server-control/app-server-control.sock`；没有 socket 时可使用 `COMMANDER_APP_SERVER_MODE=stdio`，Go 会启动 `codex app-server --stdio --enable realtime_conversation`。

## 兼容性边界

- 对 AIR3 保留 `visor.v1`、`/v1/visor`、二进制 PCM 帧和配对协议。
- 对管理页保留原来的 HTTP API、`/v1/management-audio` 和带设备令牌的 `/media/*.webp`。
- 对 Codex 保留任务列表、创建/选择/恢复、turn、审批、图片和 realtime websocket 调用。
- 不启动 Chromium、Electron、隐藏页面或空白浏览器窗口。WebRTC 的 SDP、ICE、RTP 和 `oai-events` 数据通道由 Go/Pion 完成。
- `COMMANDER_REALTIME_TRANSPORT=auto`：`gui_shared` 选择 Go/Pion WebRTC，`stdio` 选择 WebSocket + PCM；`webrtc`/`websocket` 可显式覆盖。
- `websocket` 是兼容的 API-key app-server 路径；ChatGPT managed 登录场景使用 `gui_shared` + Go WebRTC。
