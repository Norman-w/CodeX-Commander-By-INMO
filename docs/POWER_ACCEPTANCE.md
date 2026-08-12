# AIR3 功耗验收

目标：8 小时息屏 A/B 测试中，相对同固件、同网络、同电量区间的 AIR3 空闲基线，CodeX Commander 增量耗电不超过 **3 个百分点**。未通过不能标记为日常可用版。

## 代码侧约束

- PTT 前不创建 `AudioRecord`；松开同步 `stop()`，后台强制 `release()`。
- Realtime 仅在按需语音时建立，Mac 端空闲 60 秒关闭。
- 没有 Service、前台通知、wakelock、定时轮询或 Canvas 帧循环。
- WebSocket 仅 Activity 前台持有；深度待机依赖重新打开后的 `state_sync`。
- 仅录音、播放、审批、看图时设置 `FLAG_KEEP_SCREEN_ON`；离开状态立即清除。
- 图片在 Mac 缩放/转码；眼镜只解码上限 5 MiB 的 WebP。

## A/B 测试方法

两个测试使用同一台眼镜、相同固件、相同屏幕/网络/蓝牙设置，从相近电量开始，拔掉充电线后各运行 8 小时。

### A：空闲基线

1. 卸载/强停 Commander，重启眼镜并静置。
2. `./scripts/power-reset.sh`
3. 记录起始电量和时间，息屏 8 小时。
4. `./scripts/power-snapshot.sh baseline-8h`
5. 记录结束电量。

### B：Commander 待机

1. 安装并完成一次配对，打开 HUD 等到“已连接”。
2. 不触发 PTT，让系统正常息屏；Mac 保持在线。
3. `./scripts/power-reset.sh`
4. 记录起始电量和时间，息屏 8 小时。
5. `./scripts/power-snapshot.sh commander-8h`
6. 记录结束电量。

结果：

```text
增量百分点 = (B 起始% - B 结束%) - (A 起始% - A 结束%)
```

通过条件：`增量百分点 <= 3`，且下面所有检查通过。

## 必查项

```bash
adb shell dumpsys media.audio_flinger
adb shell dumpsys audio
adb shell dumpsys power
adb shell dumpsys batterystats --charged
adb shell pidof com.codexcommander.inmo.debug
```

- [ ] 非 PTT/非播放时没有 Commander 的活跃录音或 AudioTrack。
- [ ] 息屏待机没有 Commander 长期 partial wakelock。
- [ ] 没有每帧 invalidation 或持续 GPU 合成。
- [ ] 松开 PTT 后 500 ms 内麦克风指示消失。
- [ ] 退后台后进程可以被系统回收，重新打开状态仍恢复。

## Perfetto 场景

分别录制 60–120 秒：空闲 HUD、一次 10 秒 PTT、一次语音播放、图片查看、退后台。关注：

- `audio` / `AudioRecord` 生命周期是否严格落在 PTT 区间。
- RenderThread 是否只在状态变化出现，而非周期唤醒。
- 应用后台是否仍有网络心跳或定时器。
- `PowerManager` / wakelock 是否为空。

如果增量超过 3 点，按优先级排查：后台未断连接、音频未释放、图片驻留、窗口未清除 KEEP_SCREEN_ON、固件将 Activity 锁定为常驻。修复并完整重跑 A/B，不以短测推算替代。

