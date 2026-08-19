# CodeX Commander By INMO

让 INMO AIR3 变成 Codex 的低功耗“可视对讲机”：按住眼镜腿说话，Mac 上的 Codex 执行任务，眼镜显示进度、审批卡和图片；完成后由用户触摸才播放语音汇报。

> 当前状态：可构建的开源 MVP。Mac/协议自动测试和 Android 单元测试已完成；AIR3 的真实触控事件、8 小时功耗和切网恢复必须拿到实机后按文档验收，未通过前不应称为日常可用版。

## 到货后一键安装

Mac 首次只需准备一次 `.env`，填入要让 Codex 操作的 `COMMANDER_CWD` 和 Codex 可执行文件路径。Core realtime 不需要 `OPENAI_API_KEY`。`.env` 永远不会提交：

```bash
cp .env.sample .env
./scripts/doctor.sh
```

AIR3 到货后，在 Mac 与眼镜都登录同一个 Tailscale、打开 AIR3 USB 调试并授权，然后运行：

```bash
./scripts/one-click-install.sh
```

脚本会按锁文件安装依赖、运行全部自动测试、构建 APK、把 Bridge 安装成 Mac 登录服务、配置 tailnet 私有 WSS、安装眼镜应用，并通过已授权的 USB 调试连接写入短时配对配置。最后它会等到 AIR3 真实连上 Bridge 才报告完成；正常路径不需要在眼镜里手输长地址或配对码。自动配置入口只存在于本地 debug APK，并受 Android 的 shell 调试权限保护，release APK 不包含它。脚本不会自动安装 Tailscale、不会登录账户，也不会覆盖已有的 Tailscale Serve 配置；这些需要用户明确完成一次。

默认 `COMMANDER_AUTO_SELECT_LATEST=true`：Bridge 重启后会续接 `COMMANDER_CWD` 中最近的 Commander 专用任务；全新安装还没有这类任务时，第一次语音指令才会创建。设为 `false` 可要求每次无绑定启动都等待新指令。普通桌面任务永远不会被自动选择或被第二个 App Server 抢占；Bridge 也不操纵 Codex 桌面输入框。

若要继承此刻打开的 Codex 任务上下文，在该任务的终端中提前运行一次（任务 ID 只写入本机 `.env`，不会显示或提交）：

```bash
./scripts/bind-current-codex.sh
```

Bridge 会从该任务创建一个持久的“眼镜遥控”分支并继承截至启动时的上下文；之后由 Bridge 独占分支写入，桌面原任务可继续使用，不会触发 App Server 的 active-writer 冲突。Bridge 重启会复用该分支；再次主动运行绑定脚本会生成新的本地 binding ID，从最新上下文创建新分支。上下文来源优先于“最近任务”自动选择。Bridge 的真实 App Server 冒烟会在安装前验证分支可创建。

## 隐私与本地配置

仓库不包含 API Key、配对令牌、设备 ID、Tailscale 主机名、个人目录、Android SDK/JDK 路径或签名密钥。所有用户/设备相关配置都放在本地 `.env`、Android 应用私有存储或被忽略的运行时目录中。

```bash
cp .env.sample .env
```

- `.env` 只在本机使用，已被 Git 忽略；不要把真实值贴进 Issue、日志或截图。
- `.env.sample` 只包含占位符和安全默认值，可以提交。
- Android 的 WSS 地址、设备 ID 和配对信息由本机安装脚本通过 ADB 注入，或在应用里手动录入；令牌由 Android Keystore 保护，不写入 APK 源码。
- 发布签名请使用本机 `keystore.properties`/`signing.properties` 和 keystore；这些文件均被忽略。
- 提交前可运行 `./scripts/public-audit.sh`，检查实际将被 Git 跟踪的内容。

## 架构与技术栈

```text
INMO AIR3 (Kotlin / Android 14)
  触控 + AudioRecord + Canvas HUD
              │ WSS：visor.v1 + PCM16
              ▼
Mac Bridge (Node.js 20 / TypeScript)
  ├─ Codex app-server Core realtime（thread/realtime websocket）
  ├─ 可选 gui_shared：proxy 附着 ChatGPT.app 同一 app-server
  └─ sharp（图片限制尺寸后转 WebP）
```

- `glasses-app/`：单 Activity、原生 View/Canvas、Coroutines/Flow、OkHttp、AudioRecord/AudioTrack、Android Keystore。
- `mac-bridge/`：Node.js 20、TypeScript、ws、Zod、sharp；通过 `codex app-server` 的 `thread/realtime/*` 处理语音。
- `protocol/`：Zod 源协议、二进制帧约定和生成的 JSON Schema。
- `docs/`：配对、安全、AIR3 输入探针、功耗和测试说明。

眼镜端没有 Compose、Unity、Flutter、React Native、本地模型、常驻前台服务或后台录音。Codex 登录只在 Mac；Core realtime 不需要 OpenAI API Key。

## 1. Mac Bridge

要求：Node.js 20、pnpm 9、已登录可用的 Codex（ChatGPT.app 或 CLI）。项目会在每次构建时用当前 Codex CLI 生成 App Server TypeScript 绑定；生成物不提交 Git，以免跨版本漂移。

```bash
git clone https://github.com/Norman-w/CodeX-Commander-By-INMO.git
cd CodeX-Commander-By-INMO
pnpm install
cp .env.sample .env
```

编辑 `.env`，最少设置：

```dotenv
COMMANDER_VOICE=codex-realtime
COMMANDER_APP_SERVER_MODE=gui_shared
COMMANDER_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex
COMMANDER_CWD=/absolute/path/to/the/project/codex/should/control
COMMANDER_THREAD_ID=
COMMANDER_CONTEXT_BINDING_ID=
COMMANDER_AUTO_SELECT_LATEST=true
```

默认 `COMMANDER_APP_SERVER_MODE=gui_shared` 会 proxy 附着 ChatGPT.app 已运行的 app-server；若无 GUI，改为 `stdio`。详见 [Core 层语音附着](docs/CORE_VOICE_ATTACH.md)。

默认安全配置是 `approvalPolicy=on-request`、`sandbox=workspace-write`、沙箱内网络关闭；需要 Codex 命令直接联网时再显式设置 `COMMANDER_NETWORK_ACCESS=true`。Bridge 仅监听 `127.0.0.1:8787`，不把 App Server 暴露到网络。Bridge 进程会把当前工作目录与一次性配对码写到本机终端，请勿公开分享启动日志。

```bash
pnpm build
pnpm --filter @codex-commander/mac-bridge start
```

启动日志会显示有效 10 分钟的六位配对码。若需撤销已配对眼镜并签发新码，可向已核对的 Bridge 进程发送 `SIGHUP`：

前台启动时可先用 `pgrep -f 'mac-bridge/dist/index.js'` 确认 PID，再执行 `kill -HUP <bridge-pid>`。不要对未核对的进程发信号。

若不再需要开机登录服务，可运行 `./scripts/uninstall-mac-bridge-service.sh`；它只移除 LaunchAgent，保留本机 `.env`、配对状态与日志，避免误删个人配置。

## 2. Tailscale 私网 WSS

Mac 与 AIR3 加入同一个 tailnet，启用 MagicDNS/HTTPS，然后把本机端口反向代理到 tailnet 内的 HTTPS：

```bash
tailscale serve --bg --yes 8787
tailscale serve status
```

终端会返回该设备在 tailnet 内的私有 HTTPS 地址。眼镜填写对应 WSS 地址：

```text
wss://<tailscale-https-host>/v1/visor
```

不要使用 Funnel；本项目只需要 tailnet 私网。Bridge 继续绑定 loopback，TLS 由 Tailscale Serve 终止。当前 Serve 命令语法以 [Tailscale 官方文档](https://tailscale.com/docs/reference/tailscale-cli/serve) 为准。

## 3. 构建与安装 AIR3 APK

要求 Android SDK 34 和 JDK 17 或更新兼容版本（项目源与字节码目标固定为 Java 17）。可以在当前 shell 导出工具路径，也可以仅把它们写入不会提交的 `.env`：

```bash
ANDROID_HOME=/absolute/path/to/Android/sdk
JAVA_HOME=/absolute/path/to/jdk-17
pnpm android:assemble
```

APK：`glasses-app/app/build/outputs/apk/debug/app-debug.apk`。

AIR3 开启开发者模式和 USB 调试、授权后：

```bash
./scripts/install-air3.sh
```

单独运行该脚本只负责安装并打开应用，因此首次启动仍可手动输入 WSS 地址和六位配对码；完整的 `one-click-install.sh` 会自动写入并验证连接。应用只接受 `wss://`；debug/release APK 都禁止明文传输。设备令牌随后使用 Android Keystore 的 AES-GCM 密钥加密；一次性配对码会从眼镜偏好中删除。

## 4. 眼镜交互

- 默认：眼镜腿按下/持续触摸开始录音，松开立即 stop/release 并提交。
- 实机若没有可靠的 `ACTION_UP`：返回键打开设置，启用“轻触开始 / 再次轻触提交”。
- 非 PTT 不创建 `AudioRecord`，不监听或分析环境声音。
- 左右滑动：空闲时切换任务；图片中翻页；审批卡上选择决定。Codex 执行期间不会误切任务。
- 完成卡轻触：请求语音汇报；继续按住仍可追加指令；图片轻触关闭。
- 审批默认“拒绝”；滑动选择，双击才确认。语音管家没有审批工具。
- 命令、文件修改和额外权限请求都必须使用实体审批卡；额外权限即使允许也只授予当前 Codex turn。
- 应用进入后台：立即停止录音/播放、断开网络，不保持进程常驻。重新打开后同步遗漏事件。

## 5. 验证

```bash
./scripts/dev-check.sh
```

分别运行：

```bash
pnpm typecheck     # Zod 协议 + 当前 Codex 生成类型
pnpm test          # 协议、路径安全、事件恢复、假 App Server/Realtime
pnpm android:test  # PTT、审批和 Android 协议单元测试
pnpm android:assemble
```

实机验收见 [AIR3 输入兼容](docs/AIR3_INPUT_COMPATIBILITY.md)、[功耗验收](docs/POWER_ACCEPTANCE.md) 和 [测试矩阵](docs/TESTING.md)。

## 已知边界

- v1 通过 App Server 管理同一 Codex 任务记录，但不操纵 Codex 桌面 App 当前输入框。
- 默认由第一次眼镜指令创建 Commander 专用任务；可选开启最近 Commander 任务续接。若绑定了当前桌面任务，则创建继承上下文的专用分支。正在由其他客户端执行或等待审批的任务不会被 Bridge 自动接管。
- Mac 必须保持开机，Codex 和 OpenAI 登录必须有效。
- 深度待机下没有常驻服务，完成通知是尽力送达；重新打开强制同步。
- INMO AIR3 当前公开 SDK 主要是 Unity 包，内部依赖 `UnityPlayer`。本项目不把它塞入原生 APK；实际按键码用标准 Android 事件探针确认，必要时只为已证实的原生 AAR 接口增加薄适配层。详情见兼容文档。

## 参与开发

欢迎提交 Issue 和 Pull Request。公开提交前请先运行：

```bash
./scripts/dev-check.sh
./scripts/public-audit.sh
```

请勿提交真实 `.env`、设备日志、功耗快照、配对数据、媒体文件、APK、签名材料或自动生成的 Codex App Server 类型。

本项目采用 [MIT License](LICENSE)。INMO、AIR3、OpenAI 与 Codex 是其各自权利人的商标；本项目是独立社区项目，不代表官方背书。

## 上游资料

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI Realtime WebSocket](https://developers.openai.com/api/docs/guides/realtime-websocket)
- [OpenAI Realtime 对话](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [INMO 官方 Gitee 组织](https://gitee.com/inmolens)
- [INMO AIR3 开发支持](https://support.inmoxr.com/air3/)
