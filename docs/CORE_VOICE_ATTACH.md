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

| 场景 | 预期行为 | Bridge 策略 |
|------|----------|-------------|
| GUI Voice Chat 进行中，Bridge 对同 thread `realtime/start` | 可能拒绝或冲突 | **产品规则**：眼镜 PTT 前关闭 GUI Voice；HUD 提示 `realtime_unavailable` |
| GUI Voice 已关闭 | Bridge `realtime/start` 应成功 | 正常 PTT 流式语音 |
| Bridge session 收到 `thread/realtime/closed` | session 失效 | 下次 PTT 自动 `ensureSession()`；orchestrator 单次重试 |
| appendAudio 超时 | 临时失败 | stop + restart；仍失败则 `appendSpeech("继续")` |
| GUI 与 Bridge 同时 appendAudio | 未文档化；视为未定义 | 单一 owner：同一时刻只允许一个 PTT 客户端 |

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
- [`mac-bridge/src/voice/CodexRealtimeVoiceClient.ts`](../mac-bridge/src/voice/CodexRealtimeVoiceClient.ts) — websocket PCM 双向
- [`mac-bridge/src/voice/RealtimeSessionOrchestrator.ts`](../mac-bridge/src/voice/RealtimeSessionOrchestrator.ts) — closed/error 恢复
