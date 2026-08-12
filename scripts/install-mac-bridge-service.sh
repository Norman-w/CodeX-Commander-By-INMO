#!/bin/sh
set -eu
umask 077

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
data_dir="$project_root/mac-bridge/data"
env_file="$project_root/.env"
label="com.codexcommander.inmo.bridge"
launch_agents_dir="$HOME/Library/LaunchAgents"
plist="$launch_agents_dir/$label.plist"
stdout_log="$data_dir/bridge.stdout.log"
stderr_log="$data_dir/bridge.stderr.log"

[ -f "$env_file" ] || { echo "缺少 .env" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

[ -f "$project_root/mac-bridge/dist/index.js" ] || { echo "Bridge 尚未构建，请先运行 pnpm build" >&2; exit 1; }

node_bin=$(command -v node)
[ -n "$node_bin" ] && [ -x "$node_bin" ] || { echo "找不到 Node.js" >&2; exit 1; }
codex_bin=${COMMANDER_CODEX_BIN:-codex}
if command -v "$codex_bin" >/dev/null 2>&1; then codex_bin=$(command -v "$codex_bin"); fi
[ -x "$codex_bin" ] || { echo "COMMANDER_CODEX_BIN 不是可执行文件" >&2; exit 1; }
runtime_path="$(dirname -- "$node_bin"):$(dirname -- "$codex_bin"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$data_dir" "$launch_agents_dir"
chmod 700 "$data_dir"
touch "$stdout_log" "$stderr_log"
chmod 600 "$stdout_log" "$stderr_log"

temporary_plist=$(mktemp "${TMPDIR:-/tmp}/codex-commander-launch-agent.XXXXXX")
trap 'rm -f "$temporary_plist"' EXIT HUP INT TERM

node - "$temporary_plist" "$label" "$project_root" "$node_bin" "$stdout_log" "$stderr_log" "$runtime_path" <<'NODE'
import { writeFileSync } from "node:fs";

const [, , output, label, root, node, stdoutLog, stderrLog, pathValue] = process.argv;
const escapeXml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const string = (value) => `<string>${escapeXml(value)}</string>`;
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${string(label)}
  <key>ProgramArguments</key><array>
    ${string(`${root}/scripts/with-local-env.sh`)}
    ${string(node)}
    ${string(`${root}/mac-bridge/dist/index.js`)}
  </array>
  <key>WorkingDirectory</key>${string(`${root}/mac-bridge`)}
  <key>EnvironmentVariables</key><dict><key>PATH</key>${string(pathValue)}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key>${string(stdoutLog)}
  <key>StandardErrorPath</key>${string(stderrLog)}
</dict></plist>
`;
writeFileSync(output, plist, { mode: 0o600 });
NODE

plutil -lint "$temporary_plist" >/dev/null
cp "$temporary_plist" "$plist"
chmod 600 "$plist"

service_target="gui/$(id -u)/$label"
if launchctl print "$service_target" >/dev/null 2>&1; then
  launchctl bootout "$service_target"
fi
launchctl bootstrap "gui/$(id -u)" "$plist"
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
