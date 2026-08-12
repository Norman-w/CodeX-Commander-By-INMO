#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
label=${1:-snapshot}
case "$label" in
  *[!A-Za-z0-9._-]*|'') echo "label 只能包含字母、数字、点、下划线或连字符" >&2; exit 1 ;;
esac

if ! command -v adb >/dev/null 2>&1; then
  echo "找不到 adb" >&2
  exit 1
fi

timestamp=$(date +%Y%m%d-%H%M%S)
output="$project_root/power-results/$timestamp-$label"
mkdir -p "$output"

adb shell dumpsys batterystats --charged > "$output/batterystats.txt"
adb shell dumpsys power > "$output/power.txt"
adb shell dumpsys media.audio_flinger > "$output/audio-flinger.txt"
adb shell dumpsys package com.codexcommander.inmo.debug > "$output/package.txt"
adb shell pidof com.codexcommander.inmo.debug > "$output/pid.txt" || true

echo "$output"

