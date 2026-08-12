#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
endpoint=${1:-}
pairing_code=${2:-}

printf '%s' "$endpoint" | grep -Eq '^wss://[A-Za-z0-9.-]+(:[0-9]+)?/v1/visor$' || {
  echo "AIR3 自动配置需要规范的 wss://.../v1/visor 地址" >&2
  exit 1
}
printf '%s' "$pairing_code" | grep -Eq '^[0-9]{6}$' || {
  echo "AIR3 自动配置需要 6 位配对码" >&2
  exit 1
}

if [ -f "$project_root/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$project_root/.env"
  set +a
fi

android_root=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if command -v adb >/dev/null 2>&1; then
  adb_bin=$(command -v adb)
elif [ -n "$android_root" ] && [ -x "$android_root/platform-tools/adb" ]; then
  adb_bin="$android_root/platform-tools/adb"
else
  echo "找不到 adb" >&2
  exit 1
fi

device_count=$($adb_bin devices | awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }')
[ "$device_count" -eq 1 ] || { echo "需要且只能连接一台已授权的 AIR3；当前检测到 $device_count 台" >&2; exit 1; }

package_name=com.codexcommander.inmo.debug
component="$package_name/com.codexcommander.inmo.AdbProvisioningActivity"
$adb_bin shell am force-stop "$package_name"
provision_output=$($adb_bin shell am start -W -n "$component" \
  --es commander_endpoint "$endpoint" \
  --es commander_pairing_code "$pairing_code")
printf '%s' "$provision_output" | grep -Eq 'Status: ok|Complete' || {
  echo "AIR3 拒绝了自动配置，请在眼镜里手动填写连接信息" >&2
  exit 1
}

echo "AIR3 已写入本次私网连接配置并打开 Codex Commander"
