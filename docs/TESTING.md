# 测试与验收矩阵

## 自动化覆盖

| 层 | 覆盖 |
|---|---|
| Protocol | hello 单一认证方式、消息校验、二进制音频方向、JSON Schema 生成 |
| Bridge | EventJournal 回放/容量、requestId 去重、realpath 白名单和 symlink 逃逸 |
| Codex | 假 App Server：initialize、新建/继续/steer、中断、JSON-RPC、审批、总结与图片 |
| Realtime | 假 WebSocket：PTT clear/append/commit、音频回传、函数工具输出 |
| Android | Hold/Toggle PTT 状态机、force stop、审批默认拒绝/循环、Kotlin 协议 |

```bash
./scripts/dev-check.sh
```

## AIR3 手工功能闭环

- [ ] 首次六位码配对，重启应用后使用 Keystore token，不再要求码。
- [ ] 错码和过期码被拒绝；Mac `SIGHUP` 后旧 token 失效。
- [ ] 按住说一个开发任务，松开后录音立即释放。
- [ ] Realtime 正确调用 `send_command`，Codex 新建/继续对应任务。
- [ ] 眼镜显示 working/progress/completed；断网重连不重复提交命令。
- [ ] 完成只提示音，不自动朗读；轻触后播放汇报。
- [ ] Codex 返回图片时显示缩放 WebP，左右滑动切换。
- [ ] 命令与文件修改审批默认拒绝；滑动选择，双击确认；60 秒自动取消。
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

没有接入本会话的 AIR3 实机，所以上述硬件、固件、网络、Perfetto 与 8 小时 A/B 项保持未勾选。自动化通过不代表实机功耗验收通过。
