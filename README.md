# CodeX Commander By INMO

让 INMO AIR3 变成 Codex 的低功耗“可视对讲机”：按住眼镜腿说话，Mac 上的 Codex 执行任务，眼镜显示进度、审批卡和图片；完成后由用户触摸才播放语音汇报。

## 技术边界

Mac Bridge 已完全迁移到 Go：

- 不需要 Node.js、npm、pnpm、TypeScript 或 Chromium。
- HTTP、WebSocket、配对、媒体、安全、Codex JSON-RPC 和 Core realtime 全部由 Go 进程完成。
- 语音使用 Codex app-server 的 `thread/realtime/*`：`gui_shared` 默认由 Pion 在 Go 内完成 WebRTC/SDP/音频，`stdio` 默认走 app-server WebSocket + PCM；两条路径都不需要浏览器。
- macOS 麦克风和扬声器使用 Go 原生 CoreAudio；不会创建隐藏浏览器窗口。
- `/` 管理页是可选的本地页面，只在用户主动打开时使用。

官方 app-server 协议参考：[OpenAI Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)。

## 运行 Go Bridge

要求：Go 1.23+、已登录可用的 Codex（ChatGPT.app managed app-server 或 CLI）。

```bash
cp .env.sample .env
go -C mac-bridge-go test ./...
go -C mac-bridge-go build -o mac-bridge-go/bridge ./cmd/bridge
./mac-bridge-go/bridge
```

默认监听 `127.0.0.1:8787`。若从 `mac-bridge-go` 目录启动，程序会自动加载上级 `.env`，并把运行数据放在 `mac-bridge-go/data`、媒体放在 `mac-bridge-go/media`。

最少配置：

```dotenv
COMMANDER_APP_SERVER_MODE=gui_shared
COMMANDER_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex
COMMANDER_CWD=/absolute/path/to/the/project/codex/should/control
COMMANDER_AUDIO_INPUT_SOURCE=mac
COMMANDER_LOCAL_AUDIO_OUTPUT=mac_and_visor
COMMANDER_REALTIME_TRANSPORT=auto
COMMANDER_REALTIME_VOICE=juniper
```

`COMMANDER_REALTIME_TRANSPORT=auto` 会根据 app-server 模式选择传输：ChatGPT managed `gui_shared` 使用纯 Go Pion WebRTC，独立 `stdio` 使用 WebSocket + `appendAudio`。也可以明确设置 `webrtc` 或 `websocket`；后者依赖当前 Codex app-server 的 API-key 认证路径。

没有 GUI app-server 时使用：

```dotenv
COMMANDER_APP_SERVER_MODE=stdio
```

此模式由 Go 直接启动 `codex app-server --stdio --enable realtime_conversation`，仍然不需要 Node 或浏览器。

启动日志会显示一次性六位配对码。运行中的 Bridge 收到 `SIGHUP` 会由 Go 重置配对并签发新码：

```bash
./scripts/reset-pairing.sh --code-only
```

## AIR3 安装

Android 端是独立的 Kotlin/Gradle 工程，和 Go Bridge 通过 `visor.v1` 通信：

```bash
./scripts/doctor.sh
./scripts/dev-check.sh
./scripts/install-air3.sh
```

完整安装流程：

```bash
./scripts/one-click-install.sh
```

脚本只使用 Go、标准 Unix 工具和 Android Gradle Wrapper；不安装或调用 npm/pnpm。

Mac 与 AIR3 加入同一个 Tailscale 后，配置私网 WSS：

```bash
./scripts/configure-tailscale-serve.sh
```

眼镜端使用返回的 `wss://.../v1/visor` 地址。Bridge 仍只监听本机回环地址，TLS 由 Tailscale Serve 终止。

## 目录

- `mac-bridge-go/`：纯 Go Bridge、Codex app-server 客户端、Core realtime、CoreAudio、协议、安全、媒体和 HTTP/WebSocket 服务。
- `glasses-app/`：Kotlin/Android 14 AIR3 客户端。
- `protocol/schema/`：`visor.v1` 跨语言 JSON Schema；Go 的运行时协议定义在 `mac-bridge-go/internal/protocol`。
- `docs/`：协议、安全、语音附着、功耗和验收说明。
- `scripts/`：纯 Go Bridge 的安装、诊断、配对和 Android 辅助脚本。

眼镜端不监听环境声音：只有 PTT 或用户主动开启音频测试时才创建录音链路。Codex 登录只在 Mac；ChatGPT managed 的纯 Go WebRTC 路径不需要另配 OpenAI API Key。

## 验证

```bash
go -C mac-bridge-go test ./...
go -C mac-bridge-go test -race ./...
CGO_ENABLED=0 go -C mac-bridge-go test ./...
go -C mac-bridge-go vet ./...
go -C mac-bridge-go build -o mac-bridge-go/bridge ./cmd/bridge
./scripts/dev-check.sh
```

当前自动化覆盖 Go 协议解析、配对、防路径逃逸、隐私脱敏、图片 WebP、JSON-RPC、任务控制、语音状态机、HTTP 管理接口和 visor WebSocket；Android 覆盖 PTT、审批、WSS 地址和 Kotlin 协议。

## 安全与隐私

- `.env`、配对状态、媒体、日志和 Android 签名材料不进入 Git。
- 默认 `approvalPolicy=on-request`、`sandbox=workspace-write`、网络关闭。
- 图片 URL 只允许 `/media/<24 位 hex>.webp`，下载需要设备令牌。
- Bridge 不暴露 Codex app-server；AIR3 只连接 Bridge 的 `/v1/visor`。

请勿提交真实 `.env`、设备日志、配对数据、媒体文件、APK 或签名材料。公开提交前运行：

```bash
./scripts/public-audit.sh
```

本项目采用 [MIT License](LICENSE)。INMO、AIR3、OpenAI 与 Codex 是其各自权利人的商标；本项目是独立社区项目。
