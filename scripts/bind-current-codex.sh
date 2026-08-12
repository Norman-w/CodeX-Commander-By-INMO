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

node - "$env_file" "$thread_id" <<'NODE'
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const [, , file, threadId] = process.argv;
const lines = readFileSync(file, "utf8").split(/\r?\n/);
const bindingId = randomUUID();
let foundThread = false;
let foundBinding = false;
const next = lines.map((line) => {
  if (line.startsWith("COMMANDER_THREAD_ID=")) {
    foundThread = true;
    return `COMMANDER_THREAD_ID=${threadId}`;
  }
  if (line.startsWith("COMMANDER_CONTEXT_BINDING_ID=")) {
    foundBinding = true;
    return `COMMANDER_CONTEXT_BINDING_ID=${bindingId}`;
  }
  return line;
});
if (!foundThread) next.push(`COMMANDER_THREAD_ID=${threadId}`);
if (!foundBinding) next.push(`COMMANDER_CONTEXT_BINDING_ID=${bindingId}`);
const temporary = `${file}.bind-${process.pid}`;
writeFileSync(temporary, `${next.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
renameSync(temporary, file);
NODE

chmod 600 "$env_file"
echo "已设置当前 Codex 任务为上下文来源（ID 未显示）；Bridge 会创建眼镜专用分支，避免与桌面端争用写锁"
