# INMO AIR3 输入兼容与实机记录

## 已知公开资料结论

INMO 官方公开的 AIR3 SDK/示例目前以 Unity 为主。公开的 `air3_core-debug.aar` 内部引用 `com.unity3d.player.UnityPlayer`，Unity 示例还通过 `inmolib_common.Input.GetKeyDown/GetKeyUp(KeyCode.Return)` 获取按键。这不足以证明普通 Android `Activity` 能直接收到同样的按下/抬起事件，也不适合把完整 Unity 运行时加入这个低功耗原生 APK。

因此 v1 的兼容策略是：

1. 原生 Activity 先监听标准 Android `dispatchKeyEvent`：Enter、DPAD Center、Headset Hook、Button A。
2. 原生 View 同时提供持续触摸 PTT 和滑动/双击手势。
3. 如果 AIR3 只产生可靠单击、不产生可靠抬起，在设置中固定使用“两次单击”模式。
4. 只有拿到 INMO 提供、且不依赖 UnityPlayer 的原生 Android AAR/API 后，才在 `input/` 下加薄适配器；业务、网络、音频和 HUD 不依赖厂商层。

## 2026-08-20 实机设备枚举

`adb shell getevent -lp` 在当前 AIR3 上看到的输入设备如下。这里只记录系统暴露的能力，不把它们绑定到业务动作：

| Linux device | name | capabilities |
| --- | --- | --- |
| `/dev/input/event3` | `iqs7211e_keys` | `KEY_ENTER`, `KEY_UP`, `KEY_LEFT`, `KEY_RIGHT`, `KEY_DOWN`, `KEY_BACK`, `KEY_HOMEPAGE` |
| `/dev/input/event1` | `pmic_pwrkey` | `KEY_POWER` |
| `/dev/input/event2` | `pmic_resin` | `KEY_VOLUMEDOWN` |
| `/dev/input/event0` | `gpio-keys` | `KEY_VOLUMEUP` |
| `/dev/input/event5` | `INMO Touchpad Consumer Control` | media, volume, power and navigation consumer keys |
| `/dev/input/event6` | `INMO Touchpad` | pointer coordinates and `BTN_TOUCH` |

一次实机抓取已经确认 `event3` 会产生 `KEY_ENTER`、`KEY_LEFT`、`KEY_RIGHT`，实体音量键会分别产生 `KEY_VOLUMEDOWN`、`KEY_VOLUMEUP`，电源键会产生 `KEY_POWER`。物理动作与这些事件的最终对应关系仍需用探针逐个记录，不能据此直接推断 PTT 或会话切换。

公开的 `air3_core-debug.aar` 只包含 ATW、IMU、VIO、显示和 Ring 相关类及 native 库，未发现可供原生 Activity 直接注册镜腿按键回调的 API；公开 SDK 仍然是 Unity 集成路径。

## 输入探针

安装 debug APK 后执行：

```bash
./scripts/air3-input-probe.sh
```

依次操作并记录：

| 动作 | keyCode / scanCode | DOWN | UP | repeat | 结果 |
|---|---:|---|---|---:|---|
| 眼镜腿短按 | 待实机 | 待实机 | 待实机 | 待实机 | ☐ |
| 眼镜腿长按 2 秒 | 待实机 | 待实机 | 待实机 | 待实机 | ☐ |
| 左滑 | 待实机 | — | — | — | ☐ |
| 右滑 | 待实机 | — | — | — | ☐ |
| 双击 | 待实机 | — | — | — | ☐ |

若完全没有 `CodeXCommanderInput` 日志但 View 触摸可用，说明事件被映射为触摸，继续使用 View 路线。若长按只有 DOWN、没有 UP，必须启用 toggle 模式，不能用超时猜测松开时间。

## 实机通过条件

- [ ] Hold 模式：按下到录音开始主观延迟可接受；松开后 500 ms 内系统不再显示麦克风占用。
- [ ] 快速点击/滑动不会意外启动环境录音。
- [ ] Toggle 模式：第一次点击开启、第二次关闭；应用退后台强制关闭。
- [ ] 审批卡双击与普通语音输入不会冲突。
- [ ] 审批决定提交后滑动和重复双击均无效，直到 Codex 返回处理结果。
- [ ] 系统息屏、Amu/快捷栏返回应用后能重连并同步状态。
- [ ] 记录 AIR3 系统版本、SDK/固件版本和实际 keyCode，提交到上表。

## 不接受的实现

- 为了读一个按键而打包 UnityPlayer 或启动持续帧循环。
- 后台无用户动作时保持 `AudioRecord`。
- 缺少抬起事件时用固定录音时长冒充 PTT。
- 语音直接批准危险操作。
