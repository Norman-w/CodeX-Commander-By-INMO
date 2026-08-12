#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
apk="$project_root/glasses-app/app/build/outputs/apk/debug/app-debug.apk"

if [ ! -f "$apk" ]; then
  "$project_root/scripts/with-local-env.sh" "$project_root/glasses-app/gradlew" -p "$project_root/glasses-app" assembleDebug
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "找不到 adb，请把 Android SDK platform-tools 加入 PATH" >&2
  exit 1
fi

device_count=$(adb devices | awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }')
if [ "$device_count" -ne 1 ]; then
  echo "需要且只能连接一台已授权的 AIR3；当前检测到 $device_count 台" >&2
  adb devices >&2
  exit 1
fi

adb install -r "$apk"
adb shell am start -n com.codexcommander.inmo.debug/com.codexcommander.inmo.MainActivity
