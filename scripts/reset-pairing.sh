#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
label="com.codexcommander.inmo.bridge"
service_target="gui/$(id -u)/$label"
log_file="$project_root/mac-bridge-go/data/bridge.stdout.log"
control_binary="$project_root/mac-bridge-go/commanderctl"
code_only=false
if [ "${1:-}" = "--code-only" ]; then code_only=true; fi

launchctl print "$service_target" >/dev/null 2>&1 || { echo "Mac Bridge 登录服务尚未运行" >&2; exit 1; }
launchctl kill SIGHUP "$service_target"

if [ ! -x "$control_binary" ]; then
  go -C "$project_root/mac-bridge-go" build -o "$control_binary" ./cmd/commanderctl
  chmod 700 "$control_binary"
fi

attempt=0
while [ "$attempt" -lt 10 ]; do
  code=$("$control_binary" pairing-code --log "$log_file" 2>/dev/null || true)
  if [ -n "$code" ]; then
    if [ "$code_only" = true ]; then
      printf '%s\n' "$code"
    else
      printf '新配对码：%s（10 分钟内有效）\n' "$code"
    fi
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "未能从本机私有日志读取新配对码，请检查 $log_file" >&2
exit 1
