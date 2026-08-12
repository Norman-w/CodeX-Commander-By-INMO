#!/bin/sh
set -eu

if ! command -v adb >/dev/null 2>&1; then
  echo "找不到 adb" >&2
  exit 1
fi

adb shell dumpsys batterystats --reset
echo "BatteryStats 已重置。请拔掉充电线后开始同长度的 A/B 测试。"

