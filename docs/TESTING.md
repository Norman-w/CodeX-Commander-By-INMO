# 测试与验收矩阵

## 自动化覆盖

| 层 | 覆盖 |
|---|---|
| Protocol | hello 单一认证方式、消息校验、二进制音频方向 |
| Bridge | EventJournal 回放/容量、requestId 去重、realpath 白名单和 symlink 逃逸 |
| Codex | 假 App Server：initialize、登录检查、当前任务上下文分支、Commander 任务续接、新建/继续/steer、中断、命令/文件/额外权限审批、总结与图片 |
| Realtime | Go Core `thread/realtime` 假 host、PCM 输入队列、输出音频、字幕、恢复与超时 |
| Android | Hold/Toggle PTT 状态机、force stop、审批默认拒绝/循环、WSS 地址边界、Kotlin 协议 |

```bash
./scripts/dev-check.sh
```

Mac Bridge 的完整纯 Go 检查也可以单独运行：

```bash
go -C mac-bridge-go test ./...
go -C mac-bridge-go test -race ./...
CGO_ENABLED=0 go -C mac-bridge-go test ./...
go -C mac-bridge-go vet ./...
```

## AIR3 手工功能闭环

- [ ] 一键脚本通过 USB 调试自动写入 WSS/短时码并等到 Bridge 认证成功；重启应用后使用 Keystore token，不再要求码。
- [ ] 错码和过期码被拒绝；Mac `SIGHUP` 后旧 token 失效。
- [x] AIR3 触摸长按 PTT 后录音立即释放；实机 `YM00FCF7RW0020` 已观察到 Go Bridge 收到输入帧和活动电平。
- [x] 管理页 WAV 音频样本通过 Core realtime 返回 Codex 音频、字幕及 `audio_start`/`audio_end` 事件。
- [x] Go Bridge 在 ChatGPT 运行且 daemon socket 可用时通过 `gui_shared` + Pion 纯 Go WebRTC 完成 SDP/ICE、RTP 和 `oai-events` 冒烟。
- [ ] AIR3 现场人声完整说一个开发任务并验证 Codex 执行结果。
- [ ] 眼镜显示 working/progress/completed；断网重连不重复提交命令。
- [ ] 完成只提示音，不自动朗读；轻触后播放汇报。
- [ ] Codex 返回图片时显示缩放 WebP，左右滑动切换。
- [ ] 命令与文件修改审批默认拒绝；滑动选择，双击确认；60 秒自动取消。
- [ ] 额外网络/文件权限显示明确范围；允许时只授予请求内的子集且仅限当前 turn。
- [ ] 说“批准”不能绕过物理审批。
- [ ] 执行中可中断，最终显示 interrupted。

## 网络与生命周期

每个场景验证状态同步、没有重复命令和没有卡死录音：

- [ ] 家庭 Wi-Fi。
- [ ] 手机热点。
- [ ] Wi-Fi ↔ 热点切换。
- [ ] Mac Bridge 重启。
- [ ] Mac 休眠后恢复。
- [ ] AIR3 息屏、返回 Amu、系统回收进程。
- [ ] PTT 期间断网：未完成音频必须丢弃，不提交半句话。

## 当前未执行项

本会话已接入 AIR3 `YM00FCF7RW0020` 并完成触摸 PTT 输入链路冒烟；仍未完成现场人声任务、家庭 Wi-Fi/热点切换、休眠恢复、Perfetto 与 8 小时功耗 A/B。自动化和冒烟通过不代表完整硬件功耗验收通过。
