#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ -f "$project_root/.env" ] || { echo "缺少 .env" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. "$project_root/.env"
set +a

tailscale_bin=${COMMANDER_TAILSCALE_BIN:-tailscale}
if [ "$tailscale_bin" = "tailscale" ] && ! command -v tailscale >/dev/null 2>&1 && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  tailscale_bin=/Applications/Tailscale.app/Contents/MacOS/Tailscale
elif command -v "$tailscale_bin" >/dev/null 2>&1; then
  tailscale_bin=$(command -v "$tailscale_bin")
fi
[ -x "$tailscale_bin" ] || { echo "找不到 Tailscale CLI" >&2; exit 1; }
port=${COMMANDER_PORT:-8787}

serve_status=$($tailscale_bin serve status 2>&1 || true)
if printf '%s' "$serve_status" | grep -q "127.0.0.1:$port"; then
  echo "Tailscale Serve 已指向 CodeX Commander"
elif printf '%s' "$serve_status" | grep -Eiq 'no serve config|not configured|no serve configuration'; then
  "$tailscale_bin" serve --bg --yes "$port"
else
  echo "检测到现有 Tailscale Serve 配置。为避免覆盖其他本地服务，未自动修改：" >&2
  printf '%s\n' "$serve_status" >&2
  echo "请确认无冲突后手动运行：tailscale serve --bg $port" >&2
  exit 1
fi

dns_name=$($tailscale_bin status --json | go -C "$project_root/mac-bridge-go" run ./cmd/commanderctl tailscale-dns)

printf 'wss://%s/v1/visor\n' "$dns_name"
