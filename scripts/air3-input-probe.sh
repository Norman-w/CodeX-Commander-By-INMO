#!/bin/sh
set -eu

if ! command -v adb >/dev/null 2>&1; then
  echo "找不到 adb" >&2
  exit 1
fi

echo "现在操作 AIR3 眼镜腿。按 Ctrl-C 结束；把输出填入 docs/AIR3_INPUT_COMPATIBILITY.md。"
adb logcat -c
adb logcat -v time CodeXCommanderInput:I '*:S'

