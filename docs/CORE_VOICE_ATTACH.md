# Core 层语音附着调研

本文档记录 **ChatGPT.app / codex app-server** 与 **Bridge Core realtime** 的附着方式、冲突行为与推荐策略。

## 背景

眼镜语音应走 Codex **Core 层** `thread/realtime/*`（websocket transport），而不是：

- Mac STT + 文本 turn
- 直连 OpenAI Realtime API
- Loopback 虚拟声卡

GUI Voice Chat 在 Renderer 内使用 **WebRTC**（`transport: { type: "webrtc" }`）；Bridge 使用 **websocket + appendAudio**，共享同一 app-server 与 thread 上下文，但 I/O 路径不同。

## 架构

```text
眼镜 PCM → mac-bridge (visor.v1)
              ↓ JSON-RPC
ChatGPT 拉起的 codex app-server  （gui_shared / proxy）
              ↓ thread/realtime/*
realtime_conversation (Core)
              ↓
OpenAI Realtime（带 thread 上下文）
```

## 探测脚本

在 `mac-bridge` 构建后运行：

```bash
pnpm --filter @codex-commander/mac-bridge build
node mac-bridge/scripts/probe-app-server-attach.mjs
node mac-bridge/scripts/probe-realtime.mjs          # standalone stdio 冒烟
node mac-bridge/scripts/probe-realtime-attach.mjs   # 附着 GUI app-server 冒烟
```

### probe-app-server-attach

检查：

- bundled codex：`/Applications/ChatGPT.app/Contents/Resources/codex`
- `~/.codex/app-server-control/app-server-control.sock`
- ChatGPT.app 是否运行
- `codex app-server daemon version`

### probe-realtime-attach

前提：**ChatGPT.app 已打开且已登录**，且 control socket 存在。

流程：

1. `COMMANDER_APP_SERVER_MODE=gui_shared` 通过 proxy 附着
2. 选择 thread（`COMMANDER_THREAD_ID` 或最近 Commander 任务）
3. `thread/realtime/start`（websocket, v3, audio）
4. 发送短 PCM `appendAudio`
5. 监听 `outputAudio/delta` / `transcript/*`
6. `thread/realtime/stop`

## 冲突矩阵（预期与协调）

| 场景 | 实测 / 预期 | Bridge 策略 |
|------|-------------|-------------|
| GUI Voice Chat 进行中，Bridge 对同 thread `realtime/start` | ChatGPT GUI Voice 走 **独立 stdio app-server**（WebRTC），与 managed daemon **不是同一进程**。在 daemon 上对同 thread 第二次 websocket `realtime/start` **返回成功**，第一路未收到 `closed`。 | **产品规则仍建议**：眼镜 PTT 前关闭 GUI Voice；同时 `appendAudio` 视为未定义。HUD 仅在 `realtime/start` 真正失败时提示 `realtime_unavailable`。 |
| GUI Voice 已关闭 | `probe-realtime-attach.mjs`：`ok: true`（静音 PCM 时 `sawAudio` 可为 false） | 正常 PTT 流式语音 |
| Bridge session 收到 `thread/realtime/closed` | session 失效 | 下次 PTT 自动 `ensureSession()`；orchestrator 单次重试；`CommanderBridge.start()` 会先做一次轻量 `realtime/start` 探针 |
| appendAudio 超时 | 临时失败 | stop + restart；仍失败则 `appendSpeech("继续")` |
| GUI 与 Bridge 同时 appendAudio | 未文档化；视为未定义 | 单一 owner：同一时刻只允许一个 PTT 客户端 |
| 绑定桌面任务后 `gui_shared` | `bind-current-codex.sh` 后 fork 标题为「眼镜遥控 · …」，preview / `latestSummary` 能引用桌面任务内容；对该 fork `realtime/start` 成功 | 眼镜专用 writer，避免与桌面争用 |

## 实机附着笔记（2026-08-19）

- ChatGPT.app 自己的 `codex app-server` 默认 `--listen stdio://`，**不会**露出 `~/.codex/app-server-control/app-server-control.sock`。
- `codex app-server daemon start` 需要 managed standalone 路径 `~/.codex/packages/standalone/current/codex`。本机可将 ChatGPT 自带二进制链过去：
  ```bash
  mkdir -p ~/.codex/packages/standalone
  ln -s /Applications/ChatGPT.app/Contents/Resources ~/.codex/packages/standalone/current
  /Applications/ChatGPT.app/Contents/Resources/codex app-server daemon start
  /Applications/ChatGPT.app/Contents/Resources/codex app-server daemon enable-remote-control
  ```
- control socket 是 **Unix WebSocket**（HTTP 101 升级后的 JSON-RPC）。官方 `codex app-server proxy --sock` 在本机 **不会**把 stdio NDJSON 转到该 socket（进程不连接 named socket，initialize 超时）。Bridge 的 `gui_shared` 改为直连 Unix WebSocket。
- `initialize` 必须带 `capabilities.experimentalApi=true`，否则 `thread/realtime/start` 返回 `-32600`。
- 从桌面任务 `thread/fork` 时写入 `realtime_conversation` config，否则 fork 出的 thread 会报 `does not support realtime conversation`；语音客户端仍会 `startVoiceThread()` 兜底。

## gui_shared 启用步骤

1. 打开 **ChatGPT.app** 并完成登录。
2. 若 `probe-app-server-attach` 报告 socket 不存在：
   ```bash
   codex app-server daemon start
   codex app-server daemon enable-remote-control
   ```
3. `.env` 设置：
   ```dotenv
   COMMANDER_APP_SERVER_MODE=gui_shared
   COMMANDER_VOICE=codex-realtime
   COMMANDER_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex
   ```

Bridge 启动时会对当前 thread 做一次 `thread/realtime/start` 探针；失败则 Bridge 视为未就绪。

字幕：Core `thread/realtime/transcript/*` 经 `caption` 事件推到眼镜 HUD（`你：` / `Codex：`），助手最终转写同时进入 `assistant_audio_end.transcript`。

## Fallback：stdio 独立 app-server

若无法附着 GUI（无 socket、远程 CI 等）：

```dotenv
COMMANDER_APP_SERVER_MODE=stdio
```

Bridge 将 spawn 独立 `codex app-server --stdio`。仍走 Core realtime，但 **不与 GUI 共享进程**。

继承 GUI 任务上下文：

```bash
# 在 Codex 任务终端内
./scripts/bind-current-codex.sh
```

Bridge 会 fork 出 Commander 专用分支，避免与桌面 writer 冲突。

## 上下文绑定验证

1. 在目标 Codex 任务终端运行 `bind-current-codex.sh`。
2. 使用 `gui_shared` 或 `stdio` 启动 Bridge。
3. 确认 `state_sync` 中 thread 标题含「眼镜遥控 ·」且 `read_summary` / 语音续聊能引用桌面任务内容。

## 相关代码

- [`mac-bridge/src/app-server/discover.ts`](../mac-bridge/src/app-server/discover.ts) — socket 探测与 launch 解析
- [`mac-bridge/src/app-server/unixWsJsonRpc.ts`](../mac-bridge/src/app-server/unixWsJsonRpc.ts) — gui_shared Unix WebSocket JSON-RPC
- [`mac-bridge/src/voice/CodexRealtimeVoiceClient.ts`](../mac-bridge/src/voice/CodexRealtimeVoiceClient.ts) — websocket PCM 双向
- [`mac-bridge/src/voice/RealtimeSessionOrchestrator.ts`](../mac-bridge/src/voice/RealtimeSessionOrchestrator.ts) — closed/error 恢复
