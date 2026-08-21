# Core 层语音附着调研

本文档记录 ChatGPT.app / Codex app-server 与 Go Bridge Core realtime 的附着方式、冲突行为与验证结果。

## 背景

眼镜语音应走 Codex **Core 层** `thread/realtime/*`，而不是：

- Mac STT + 文本 turn
- 直连 OpenAI Realtime API
- Loopback 虚拟声卡

在 `COMMANDER_APP_SERVER_MODE=gui_shared` 且 `COMMANDER_REALTIME_TRANSPORT=auto` 时，Bridge 由 Go/Pion 完成 WebRTC 的 SDP、ICE、RTP、音频编解码和 `oai-events` 数据通道。整个过程不会启动 Node、npm、Chromium、Electron 或隐藏网页。

独立 `stdio` app-server 默认使用 WebSocket + PCM `appendAudio` 兼容路径；显式设置 `COMMANDER_REALTIME_TRANSPORT=websocket` 也会选择这条路径。当前 Codex app-server 的独立 WebSocket 路径需要 API-key 认证，因此 ChatGPT managed 登录场景应使用 `gui_shared` + Go WebRTC。

## 架构

```text
AIR3 PCM → /v1/visor → Go Bridge
                         ├─ Pion WebRTC：RTP PCMU + oai-events
                         │       ↓ thread/realtime/start transport.webrtc
                         └─ WebSocket fallback：appendAudio / outputAudio
                                   ↓
                         Codex app-server → Core realtime
```

两条路径最终都保留 Codex thread 上下文；区别只在媒体承载层。Go Bridge 的 `/` 管理页是可选的诊断页，只在用户主动打开时使用，不参与默认启动或 WebRTC 建连。

## 探测与启动

构建 Go Bridge 后运行：

```bash
go -C mac-bridge-go test ./...
go -C mac-bridge-go build -o mac-bridge-go/bridge ./cmd/bridge
./mac-bridge-go/bridge
curl http://127.0.0.1:8787/readyz
COMMANDER_APP_SERVER_MODE=stdio ./mac-bridge-go/bridge     # 独立 app-server
```

### gui_shared 检查

检查：

- bundled codex：`/Applications/ChatGPT.app/Contents/Resources/codex`
- `~/.codex/app-server-control/app-server-control.sock`
- ChatGPT.app 是否运行
- `codex app-server daemon version`

### Go WebRTC attach 流程

前提：**ChatGPT.app 已打开且已登录**，且 control socket 存在。

1. Go/Pion 创建 PCMU 音频轨道和 `oai-events` data channel。
2. Go/Pion 生成并完成 ICE gathering 的 offer。
3. Bridge 请求 `thread/realtime/start`，携带 `transport: { type: "webrtc", sdp: offer }`、`version: "v3"` 与 `outputModality: "audio"`。
4. Bridge 接收 `thread/realtime/sdp` answer，设置远端 SDP，等待 data channel open。
5. AIR3 的 24 kHz PCM 在 Go 内降采样为 8 kHz PCMU RTP；远端音频再解码并升采样回 24 kHz PCM，字幕从 data channel 事件转发到 HUD。
6. PTT 松开后发送 `input_audio.pause`；停止会话时关闭 PeerConnection 并调用 `thread/realtime/stop`。

### stdio / WebSocket fallback

当 `COMMANDER_APP_SERVER_MODE=stdio` 或显式设置 `COMMANDER_REALTIME_TRANSPORT=websocket` 时，Go 会使用 `thread/realtime/start` + `appendAudio` + `outputAudio/delta`。该路径适用于具备相应 API-key 认证的 app-server；不应把它误认为 ChatGPT managed 登录的免 API-key 替代方案。

## 冲突矩阵（预期与协调）

| 场景 | 实测 / 预期 | Bridge 策略 |
|------|-------------|-------------|
| GUI Voice Chat 进行中，Bridge 对同 thread `realtime/start` | 两条会话可能属于不同 app-server 进程，具体冲突取决于 server 版本 | 产品规则建议眼镜 PTT 前关闭 GUI Voice；失败时提示 `realtime_unavailable`，不创建浏览器兜底 |
| GUI Voice 已关闭 | `gui_shared` + Go WebRTC 可以完成 SDP、音频轨道和 data channel attach | 正常 PTT 流式语音 |
| Bridge session 收到 `thread/realtime/closed` | 当前媒体会话失效 | 下次用户明确发起 PTT 时重新 start；不会在后台自动创建 thread |
| Pion WebRTC attach 失败 | 可能是 server 不支持该 thread 的 realtime 或 SDP 不兼容 | 先按 thread 能力尝试 `StartVoiceThread`；仍失败则返回可恢复错误 |
| 显式 WebSocket / `appendAudio` 超时 | 当前 turn 临时失败 | stop + restart；继续沿用现有恢复和超时提示 |
| `.env` 保留旧的桌面任务绑定 | 启动时不会自动恢复或 fork，也不会自动创建会话 | 用户从管理页明确选择已有会话或新建会话 |

## 实机附着笔记（2026-08-19）

- ChatGPT.app 自己的 `codex app-server` 默认 `--listen stdio://`，**不会**露出 `~/.codex/app-server-control/app-server-control.sock`。
- `codex app-server daemon start` 需要 managed standalone 路径 `~/.codex/packages/standalone/current/codex`。本机可将 ChatGPT 自带二进制链过去：
  ```bash
  mkdir -p ~/.codex/packages/standalone
  ln -s /Applications/ChatGPT.app/Contents/Resources ~/.codex/packages/standalone/current
  /Applications/ChatGPT.app/Contents/Resources/codex app-server daemon start
  /Applications/ChatGPT.app/Contents/Resources/codex app-server daemon enable-remote-control
  ```
- control socket 是 **Unix WebSocket**（HTTP 101 升级后的 JSON-RPC）。官方 `codex app-server proxy --sock` 在本机 **不会**把 stdio NDJSON 转到该 socket（进程不连接 named socket，initialize 超时）。Bridge 的 `gui_shared` 直连 Unix WebSocket，然后由 Go/Pion 处理 WebRTC 媒体。
- `initialize` 必须带 `capabilities.experimentalApi=true`，否则 `thread/realtime/start` 返回 `-32600`。
- 当前 Go Bridge 不再在启动阶段调用 `thread/fork`；新会话通过用户明确操作创建，并在创建时写入 `realtime_conversation` config。

## gui_shared 启用步骤

1. 打开 **ChatGPT.app** 并完成登录。
2. 若 `scripts/doctor.sh` 报告 socket 不存在：
   ```bash
   codex app-server daemon start
   codex app-server daemon enable-remote-control
   ```
3. `.env` 设置：
   ```dotenv
   COMMANDER_APP_SERVER_MODE=gui_shared
   COMMANDER_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex
   ```

Bridge 启动时会在需要时对当前 thread 做 `thread/realtime/start` 探针；失败则 Bridge 返回可恢复的 realtime 错误。

字幕：Core `thread/realtime/transcript/*` 经 `caption` 事件推到眼镜 HUD（`你：` / `Codex：`），助手最终转写同时进入 `assistant_audio_end.transcript`。

## Fallback：stdio 独立 app-server

若无法附着 GUI（无 socket、远程 CI 等）：

```dotenv
COMMANDER_APP_SERVER_MODE=stdio
```

Bridge 将 spawn 独立 `codex app-server --stdio`。仍走 Core realtime，但 **不与 GUI 共享进程**；`auto` 在这里选择 WebSocket + PCM。若 server 没有 API-key 认证，改用 `gui_shared` + Go WebRTC。

旧绑定配置说明：

```bash
# COMMANDER_THREAD_ID 仅保留兼容性，不会触发启动时创建或 fork。
```

Bridge 启动只连接 Codex app-server；用户选择会话或点击新建后，才会对目标会话执行操作。

## 实机验证记录（2026-08-21）

- Go/Pion `gui_shared` 实机完成 SDP/ICE、PCMU RTP、`oai-events` 和 assistant 音频/字幕回传。
- 管理页 WAV 样本实际收到输入帧，并观察到 `audio_start`、`audio_end` 和 assistant transcript。
- AIR3 `YM00FCF7RW0020` 触摸长按 PTT 实际向 Go Bridge 发送输入帧，输入电平有活动，松开后会话正常结束。
- 服务 LaunchAgent 只启动 `mac-bridge-go/bridge`；未发现项目 Node、Chrome 或 Chromium 进程。

## 上下文绑定验证

1. 在目标 Codex 任务终端运行 `bind-current-codex.sh`。
2. 使用 `gui_shared` 或 `stdio` 启动 Bridge。
3. 确认 `state_sync` 中 thread 标题含「眼镜遥控 ·」且 `read_summary` / 语音续聊能引用桌面任务内容。

## 相关代码

- [`mac-bridge-go/internal/appserver/client.go`](../mac-bridge-go/internal/appserver/client.go) — stdio/Unix WebSocket JSON-RPC
- [`mac-bridge-go/internal/codex/controller.go`](../mac-bridge-go/internal/codex/controller.go) — thread/turn/审批/图片控制
- [`mac-bridge-go/internal/voice/webrtc.go`](../mac-bridge-go/internal/voice/webrtc.go) — Go/Pion WebRTC、RTP、编解码与 data channel
- [`mac-bridge-go/internal/voice/direct.go`](../mac-bridge-go/internal/voice/direct.go) — 语音状态机与 WebSocket fallback
- [`mac-bridge-go/internal/server/server.go`](../mac-bridge-go/internal/server/server.go) — HTTP/WebSocket 边界
