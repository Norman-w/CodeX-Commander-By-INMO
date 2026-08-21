#!/bin/sh
set -u

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$project_root/.env"
require_device=false
if [ "${1:-}" = "--require-device" ]; then require_device=true; fi

failures=0
ok() { printf '  [OK] %s\n' "$1"; }
fail() { printf '  [需处理] %s\n' "$1" >&2; failures=$((failures + 1)); }

printf 'CodeX Commander 安装检查\n'

if [ -f "$env_file" ]; then
  ok ".env 已创建且不会被 Git 跟踪"
  env_mode=$(stat -f '%Lp' "$env_file" 2>/dev/null || stat -c '%a' "$env_file" 2>/dev/null || printf 'unknown')
  case $env_mode in
    600|400) ok ".env 权限仅限当前用户" ;;
    *) fail ".env 权限为 ${env_mode}；请运行 chmod 600 .env" ;;
  esac
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
else
  fail "缺少 .env：先运行 cp .env.sample .env 并填写本机配置"
fi

if command -v go >/dev/null 2>&1; then
  go_version=$(go version 2>/dev/null || true)
  if [ -n "$go_version" ]; then ok "Go 工具链可用（${go_version}）"; else fail "Go 工具链不可用"; fi
else
  fail "找不到 Go 工具链"
fi

java_bin=""
if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME}/bin/java" ]; then
  java_bin="${JAVA_HOME}/bin/java"
elif command -v java >/dev/null 2>&1; then
  java_bin=$(command -v java)
fi
java_major=0
if [ -n "$java_bin" ]; then
  java_major=$("$java_bin" -version 2>&1 | awk -F'[".]' 'NR == 1 { if ($2 == "1") print $3; else print $2 }')
fi
if [ "${java_major:-0}" -ge 17 ] 2>/dev/null; then
  ok "JDK 17+ 可用（当前 ${java_major}，项目字节码目标为 17）"
else
  fail "需要 JDK 17 或更新兼容版本；可在 .env 设置 JAVA_HOME"
fi

android_root=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [ -n "$android_root" ] && [ -d "$android_root/platforms/android-34" ]; then
  ok "Android SDK 34 可用"
else
  fail "需要 Android SDK 34；可在 .env 设置 ANDROID_HOME"
fi

adb_bin=""
if command -v adb >/dev/null 2>&1; then
  adb_bin=$(command -v adb)
elif [ -n "$android_root" ] && [ -x "$android_root/platform-tools/adb" ]; then
  adb_bin="$android_root/platform-tools/adb"
fi
if [ -n "$adb_bin" ]; then ok "adb 可用"; else fail "找不到 Android platform-tools/adb"; fi

codex_bin=${COMMANDER_CODEX_BIN:-codex}
if command -v "$codex_bin" >/dev/null 2>&1; then codex_bin=$(command -v "$codex_bin"); fi
if [ -x "$codex_bin" ] && "$codex_bin" --version >/dev/null 2>&1; then
  ok "当前 Codex CLI / App Server 可用"
else
  fail "Codex 不可用；在 .env 把 COMMANDER_CODEX_BIN 设为当前 Codex 可执行文件的绝对路径"
fi

if [ -n "${COMMANDER_CWD:-}" ] && [ -d "$COMMANDER_CWD" ]; then
  ok "Codex 目标工作目录存在"
else
  fail "COMMANDER_CWD 不是可用目录"
fi

case ${COMMANDER_THREAD_ID:-} in
  '') ok "未绑定桌面任务；首次语音将创建 Commander 专用任务" ;;
  ????????-????-????-????-????????????) ok "已设置当前 Codex 上下文来源（未显示 ID；启动时创建眼镜专用分支）" ;;
  *) fail "COMMANDER_THREAD_ID 格式无效；可留空或运行 scripts/bind-current-codex.sh" ;;
esac

case ${COMMANDER_APP_SERVER_MODE:-gui_shared} in
  gui_shared) ok "app-server 模式：gui_shared（附着 ChatGPT）" ;;
  stdio) ok "app-server 模式：stdio（独立 spawn）" ;;
  *) fail "COMMANDER_APP_SERVER_MODE 无效；使用 gui_shared 或 stdio" ;;
esac

if [ -x "$codex_bin" ] || [ -f "/Applications/ChatGPT.app/Contents/Resources/codex" ]; then
  app_server_socket=${COMMANDER_APP_SERVER_SOCKET:-$HOME/.codex/app-server-control/app-server-control.sock}
  if [ -S "$app_server_socket" ]; then
    ok "GUI app-server Unix WebSocket 可用"
  else
    printf '  [提示] GUI app-server socket 不可用；请打开 ChatGPT.app 或设 COMMANDER_APP_SERVER_MODE=stdio\n'
  fi
else
  printf '  [提示] 跳过 app-server 附着探测（Codex 不可用）\n'
fi

tailscale_bin=${COMMANDER_TAILSCALE_BIN:-tailscale}
if [ "$tailscale_bin" = "tailscale" ] && ! command -v tailscale >/dev/null 2>&1 && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  tailscale_bin=/Applications/Tailscale.app/Contents/MacOS/Tailscale
elif command -v "$tailscale_bin" >/dev/null 2>&1; then
  tailscale_bin=$(command -v "$tailscale_bin")
fi
if [ -x "$tailscale_bin" ] && "$tailscale_bin" status --json >/dev/null 2>&1; then
  ok "Tailscale 已安装并登录"
else
  fail "Tailscale CLI 不可用或尚未登录"
fi

if [ "$require_device" = true ]; then
  if [ -z "$adb_bin" ]; then
    fail "无法检查 AIR3：adb 不可用"
  else
    device_count=$($adb_bin devices | awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }')
    if [ "$device_count" -eq 1 ]; then
      ok "检测到一台已授权 Android 设备"
    else
      fail "需要且只能连接一台已授权 AIR3；当前检测到 $device_count 台"
    fi
  fi
fi

if [ "$failures" -gt 0 ]; then
  printf '\n检查未通过：共 %s 项需要处理。未修改任何系统配置。\n' "$failures" >&2
  exit 1
fi

printf '\n检查通过。\n'
