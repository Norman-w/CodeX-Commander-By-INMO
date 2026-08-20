#!/bin/sh
set -eu

if ! command -v adb >/dev/null 2>&1; then
  echo "找不到 adb" >&2
  exit 1
fi

package="com.codexcommander.inmo.debug"
activity="com.codexcommander.inmo.InputProbeActivity"
raw_log=$(mktemp "${TMPDIR:-/tmp}/air3-input-probe.XXXXXX")
raw_pid=""
tail_pid=""
log_pid=""

cleanup() {
  trap - INT TERM EXIT
  [ -z "$raw_pid" ] || kill "$raw_pid" 2>/dev/null || true
  [ -z "$tail_pid" ] || kill "$tail_pid" 2>/dev/null || true
  [ -z "$log_pid" ] || kill "$log_pid" 2>/dev/null || true
  wait "$raw_pid" 2>/dev/null || true
  wait "$tail_pid" 2>/dev/null || true
  wait "$log_pid" 2>/dev/null || true
  printf '\n--- raw Linux events captured ---\n'
  sed 's/^/[raw] /' "$raw_log"
  rm -f "$raw_log"
}

trap cleanup INT TERM EXIT
adb logcat -c
adb shell am start -n "$package/$activity" >/dev/null
echo "AIR3 input probe is running. Operate temple actions only; no action is bound."
echo "Press Ctrl-C to stop and print the complete raw Linux event stream."

adb shell getevent -lt >"$raw_log" 2>&1 &
raw_pid=$!
tail -f "$raw_log" | sed 's/^/[raw] /' &
tail_pid=$!
adb logcat -v time CodeXCommanderProbe:I CodeXCommanderInput:I '*:S' &
log_pid=$!
wait "$log_pid"
adb logcat -c
adb logcat -v time CodeXCommanderInput:I '*:S'
