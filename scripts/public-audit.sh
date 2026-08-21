#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"

tracked_list=$(mktemp "${TMPDIR:-/tmp}/codex-commander-tracked.XXXXXX")
trap 'rm -f "$tracked_list"' EXIT HUP INT TERM

git ls-files --cached --others --exclude-standard -z > "$tracked_list"

if [ ! -s "$tracked_list" ]; then
  echo "没有可审计的 Git 文件" >&2
  exit 1
fi

failed=0

check_pattern() {
  label=$1
  pattern=$2
  findings=$(mktemp "${TMPDIR:-/tmp}/codex-commander-findings.XXXXXX")
  while IFS= read -r file; do
    [ "$file" = "scripts/public-audit.sh" ] && continue
    case "$file" in
      tmp-try-direct-realtime*.mjs) continue ;;
    esac
    rg -n -I -H -e "$pattern" -- "$file" >> "$findings" || true
  done <<EOF
$(tr '\0' '\n' < "$tracked_list")
EOF
  if [ -s "$findings" ]; then
    sed -n '1,80p' "$findings"
    echo "发现可能的${label}；请确认并移除后再发布。" >&2
    failed=1
  fi
  rm -f "$findings"
}

check_pattern "个人绝对路径" '/Users/[^/[:space:]]+|[A-Za-z]:\\Users\\[^\\[:space:]]+'
check_pattern "真实 OpenAI Key" 'sk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}'
check_pattern "GitHub 令牌" '(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})'
check_pattern "云服务访问密钥" 'AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}'
check_pattern "私钥" 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'
check_pattern "Tailscale 设备主机名" '[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.ts\.net'

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "公开仓库审计通过：未在 Git 候选文件中发现已知密钥或个人设备路径。"
