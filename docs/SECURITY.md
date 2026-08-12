# 安全模型

## 信任边界

- **Mac 是可信执行端**：保存 OpenAI API Key、Codex 登录、工作区权限、设备 token 哈希。
- **AIR3 是受限遥控端**：只保存 WSS 地址、设备 ID 和 Keystore 加密 token；不拿 API Key、Codex凭据或任意文件权限。
- **Tailscale 是网络边界**：Bridge 只监听 loopback，Tailscale Serve 提供 tailnet 内 HTTPS/WSS；不要启用 Funnel。
- AIR3 配置只接受 `wss://`，debug 和 release APK 都禁用明文网络。

## 配对

- 六位码由密码学安全随机数生成，有效期 10 分钟，仅在 Mac 日志中显示。
- 服务端只持久化配对码/token 的 SHA-256 哈希；token 是 32 字节随机值。
- 当前 MVP 只允许一台设备。新连接会踢掉同设备旧连接。
- 连续 10 次错码会轮换配对码，新码只写入 Mac Bridge 日志。
- `SIGHUP` 清除原设备、签发新码并关闭当前眼镜连接。
- Bridge 启动日志包含本机工作目录与短时配对码，应仅保存在可信终端，不应贴入公开 Issue 或截图。

## Codex 权限

- App Server 通过子进程 stdio JSONL 通信，绝不直接暴露网络 WebSocket。
- 默认 sandbox 为 `workspace-write`，写根只包含 `COMMANDER_CWD`；默认审批策略为 `on-request`。
- 命令/文件审批显示实体卡，默认拒绝，60 秒到期自动取消。
- 未支持或并发的 App Server 请求采取 fail-closed 策略。
- 语音工具只允许：列出/选择任务、发送指令、中断、读状态/总结、显示白名单图片。

## 媒体

- 只允许 `COMMANDER_CWD` 和显式 `COMMANDER_MEDIA_ROOTS` 内的真实路径。
- 输入和根目录都先 `realpath`，阻断 `..` 和符号链接逃逸。
- sharp 限制输入像素并缩到 1280×720 内、WebP；输出文件名不包含原路径。
- 媒体 HTTP 请求仍需 Bearer 设备 token 与设备 ID。

## 剩余风险

- 已解锁眼镜可能被本地攻击者读取应用 UI；Keystore 降低 token 静态提取风险，但不代替设备锁。
- 六位码强度依赖短有效期和 tailnet/本机可见性；不要把 Bridge 暴露公网。
- 语音可能误解自然语言，因此 Codex 的 sandbox 和物理审批仍是最终安全边界。
