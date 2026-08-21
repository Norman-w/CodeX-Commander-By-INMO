#!/bin/sh
set -eu
umask 077

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$project_root/.env"
thread_id=${CODEX_THREAD_ID:-}

[ -f "$env_file" ] || { echo "缺少 .env：先运行 cp .env.sample .env" >&2; exit 1; }
printf '%s' "$thread_id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' || {
  echo "当前终端没有可用的 CODEX_THREAD_ID；请从要遥控的 Codex 任务内运行本脚本" >&2
  exit 1
}

go -C "$project_root/mac-bridge-go" run ./cmd/commanderctl bind-current-codex \
  --env "$env_file" \
  --thread-id "$thread_id"

chmod 600 "$env_file"
echo "已设置当前 Codex 任务为上下文来源（ID 未显示）；Bridge 会创建眼镜专用分支，避免与桌面端争用写锁"
