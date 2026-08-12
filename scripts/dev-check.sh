#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"

"$project_root/scripts/with-local-env.sh" pnpm verify
"$project_root/scripts/with-local-env.sh" pnpm android:test
"$project_root/scripts/with-local-env.sh" pnpm android:assemble
