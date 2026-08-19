# visor.v1 协议

传输地址默认 `/v1/visor`。控制帧是 UTF-8 JSON 文本，首次消息必须是 `hello`；音频是 WebSocket 二进制帧。

权威定义：

- TypeScript/Zod：`protocol/src/index.ts`
- 生成 JSON Schema：`protocol/schema/visor.v1.schema.json`
- Kotlin 线协议：`glasses-app/app/src/main/java/com/codexcommander/inmo/protocol/CommanderProtocol.kt`

Zod 是运行时验证的最终权威；生成的 Draft-07 JSON Schema 供跨语言工具/审阅使用，并明确编码 hello 的 token/pairingCode 二选一约束。

## 二进制音频

每帧第一个字节表示方向，后面是裸 PCM：

| 首字节 | 方向 | 内容 |
|---|---|---|
| `0x01` | AIR3 → Mac | 24,000 Hz、mono、signed PCM16 little-endian |
| `0x02` | Mac → AIR3 | 相同格式 |

没有 PTT 激活状态时，Bridge 丢弃客户端音频。AIR3 每 40 ms 发送一帧；首次 Core realtime 建连最多缓存 5 秒音频，断线时清空而不提交。

## 恢复与去重

- 客户端请求使用 UUID `requestId`；Bridge 在有界窗口内去重。
- 服务端事件有单调 `eventId`；眼镜持久化最后一个编号。
- 重连 `hello.lastEventId` 后回放可恢复事件，再发送完整 `state_sync`。
- 音频开始/结束是瞬时事件，不进入恢复日志；任务、审批和图片进入有界日志。

## 安全不变量

- `approval_decision.physicalConfirmation` 必须为 JSON `true`。
- 审批卡 `kind` 支持 `command`、`file_change` 与 `permissions`；额外权限批准只回传原请求的受限子集，Bridge 固定使用 turn 级作用域。
- 语音由 Codex app-server 的 `thread/realtime/*`（websocket transport）处理，保留 thread 上下文；不直连 OpenAI Realtime API。
- Core realtime 会话中没有审批工具；审批仍走 visor 审批卡。
- 图片 URL 只能是 `/media/<24位hex>.webp`，下载还需设备 token。
- Zod 在 Mac 边界校验每个控制消息，Kotlin 忽略未来字段以便向前兼容。
