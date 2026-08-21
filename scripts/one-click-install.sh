#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"

if [ -n "${CODEX_THREAD_ID:-}" ] && ! grep -Eq '^COMMANDER_THREAD_ID=.+$' "$project_root/.env" 2>/dev/null; then
  echo "检测到当前 Codex 任务，正在建立眼镜专用上下文分支配置"
  "$project_root/scripts/bind-current-codex.sh"
fi

echo "[1/8] 最终公开内容审计"
"$project_root/scripts/public-audit.sh"

echo "[2/8] 检查本机、私网与 AIR3"
"$project_root/scripts/doctor.sh" --require-device

echo "[3/8] 构建纯 Go Bridge"
go -C "$project_root/mac-bridge-go" build -o "$project_root/mac-bridge-go/bridge" ./cmd/bridge

echo "[4/8] 运行 Go Bridge 与 Android 自动验证"
"$project_root/scripts/dev-check.sh"

echo "[5/8] 启动可自动恢复的 Mac Bridge"
"$project_root/scripts/install-mac-bridge-service.sh"

echo "[6/8] 配置 tailnet 内的 HTTPS / WSS"
wss_endpoint=$("$project_root/scripts/configure-tailscale-serve.sh" | tail -1)

echo "[7/8] 安装 AIR3 应用并签发本次配对"
"$project_root/scripts/install-air3.sh" --install-only
pairing_code=$("$project_root/scripts/reset-pairing.sh" --code-only)

echo "[8/8] 安全写入配置并验证眼镜连接"
"$project_root/scripts/provision-air3.sh" "$wss_endpoint" "$pairing_code"

attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl --silent --fail "http://127.0.0.1:${COMMANDER_PORT:-8787}/api/audio-levels" | grep -q '"visorConnected":true'; then
    printf '\n安装完成：AIR3 已连接 Mac Bridge，并已继承配置的 Codex 上下文。\n'
    printf '麦克风只会在你按住眼镜腿或主动轻触开始时开启。\n'
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "AIR3 应用已安装并配置，但 30 秒内未连上 Bridge。请确认眼镜已登录同一 Tailscale，再重新运行本脚本。" >&2
exit 1
