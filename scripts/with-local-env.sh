#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$project_root/.env"

if [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi

if [ "$#" -eq 0 ]; then
  echo "usage: $0 command [args...]" >&2
  exit 2
fi

exec "$@"
