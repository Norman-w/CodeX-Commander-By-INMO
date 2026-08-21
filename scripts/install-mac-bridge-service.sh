#!/bin/sh
set -eu
umask 077

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
data_dir="$project_root/mac-bridge-go/data"
env_file="$project_root/.env"
label="com.codexcommander.inmo.bridge"
launch_agents_dir="$HOME/Library/LaunchAgents"
plist="$launch_agents_dir/$label.plist"
stdout_log="$data_dir/bridge.stdout.log"
stderr_log="$data_dir/bridge.stderr.log"
bridge_binary="$project_root/mac-bridge-go/bridge"
control_binary="$project_root/mac-bridge-go/commanderctl"

[ -f "$env_file" ] || { echo "缺少 .env" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

command -v go >/dev/null 2>&1 || { echo "找不到 Go 工具链" >&2; exit 1; }
go -C "$project_root/mac-bridge-go" build -o "$bridge_binary" ./cmd/bridge
go -C "$project_root/mac-bridge-go" build -o "$control_binary" ./cmd/commanderctl
chmod 700 "$bridge_binary" "$control_binary"

codex_bin=${COMMANDER_CODEX_BIN:-codex}
if command -v "$codex_bin" >/dev/null 2>&1; then codex_bin=$(command -v "$codex_bin"); fi
[ -x "$codex_bin" ] || { echo "COMMANDER_CODEX_BIN 不是可执行文件" >&2; exit 1; }
runtime_path="$(dirname -- "$bridge_binary"):$(dirname -- "$codex_bin"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$data_dir" "$launch_agents_dir"
chmod 700 "$data_dir"
touch "$stdout_log" "$stderr_log"
chmod 600 "$stdout_log" "$stderr_log"

temporary_plist=$(mktemp "${TMPDIR:-/tmp}/codex-commander-launch-agent.XXXXXX")
trap 'rm -f "$temporary_plist"' EXIT HUP INT TERM

"$control_binary" launch-agent \
  --output "$temporary_plist" \
  --label "$label" \
  --root "$project_root" \
  --binary "$bridge_binary" \
  --stdout "$stdout_log" \
  --stderr "$stderr_log" \
  --path "$runtime_path"

plutil -lint "$temporary_plist" >/dev/null
cp "$temporary_plist" "$plist"
chmod 600 "$plist"

service_target="gui/$(id -u)/$label"
if launchctl print "$service_target" >/dev/null 2>&1; then
	launchctl bootout "$service_target" || true
fi
bootstrap_attempt=0
while ! launchctl bootstrap "gui/$(id -u)" "$plist"; do
	bootstrap_attempt=$((bootstrap_attempt + 1))
	if [ "$bootstrap_attempt" -ge 5 ]; then
		echo "无法加载 Mac Bridge LaunchAgent：$label" >&2
		exit 1
	fi
	launchctl bootout "$service_target" >/dev/null 2>&1 || true
	sleep 1
done
launchctl kickstart -k "$service_target"

attempt=0
while [ "$attempt" -lt 20 ]; do
  if curl --silent --fail "http://127.0.0.1:${COMMANDER_PORT:-8787}/readyz" >/dev/null 2>&1; then
    echo "Mac Bridge 已作为登录服务启动"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "Mac Bridge 未在 20 秒内就绪，请检查：$stderr_log" >&2
exit 1
