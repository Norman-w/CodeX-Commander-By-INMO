#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"

"$project_root/scripts/with-local-env.sh" go -C "$project_root/mac-bridge-go" test -race ./...
"$project_root/scripts/with-local-env.sh" go -C "$project_root/mac-bridge-go" vet ./...
"$project_root/scripts/with-local-env.sh" go -C "$project_root/mac-bridge-go" build -o "$project_root/mac-bridge-go/bridge" ./cmd/bridge
"$project_root/scripts/with-local-env.sh" "$project_root/glasses-app/gradlew" -p "$project_root/glasses-app" testDebugUnitTest
"$project_root/scripts/with-local-env.sh" "$project_root/glasses-app/gradlew" -p "$project_root/glasses-app" assembleDebug
