#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hf-s3-litestream-process-control.sh
source "$script_dir/hf-s3-litestream-process-control.sh"

test_root="$(mktemp -d)"
child_pid=""

cleanup_test() {
  if [[ -n "$child_pid" ]]; then
    kill -KILL "$child_pid" >/dev/null 2>&1 || true
    wait "$child_pid" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$test_root"
}
trap cleanup_test EXIT

renamed_binary="$test_root/renamed-process-binary"
pid_file="$test_root/process.pid"
cp /bin/sleep "$renamed_binary"
chmod 755 "$renamed_binary"

bash -c '
  pid_file=$1
  shift
  printf "%s\n" "$$" >"$pid_file"
  exec "$@"
' bash "$pid_file" "$renamed_binary" 30 &
child_pid=$!

expected_exe_identity="$(stat -Lc '%d:%i' "$renamed_binary")"
wait_for_pidfile_handshake \
  "$pid_file" \
  "$(id -u)" \
  "$expected_exe_identity" \
  "$child_pid" \
  2000 \
  100

[[ "$PIDFILE_HANDSHAKE_PID" == "$child_pid" ]]
[[ "$PIDFILE_HANDSHAKE_EXE_IDENTITY" == "$expected_exe_identity" ]]
[[ "$PIDFILE_HANDSHAKE_DURATION_MS" -le 2000 ]]

kill -TERM "$child_pid"
wait "$child_pid" 2>/dev/null || true
child_pid=""
printf 'PASS pidfile captures renamed executable PID across exec\n'

printf 'not-a-pid\n' >"$pid_file"
if validate_pidfile_handshake "$pid_file" "$(id -u)" "$expected_exe_identity"; then
  printf 'FAIL invalid PID was accepted\n' >&2
  exit 1
fi
printf 'PASS invalid PID is rejected\n'

"$renamed_binary" 30 &
child_pid=$!
printf '%s\n' "$child_pid" >"$pid_file"
mismatched_exe_identity="$(stat -Lc '%d:%i' /bin/true)"
if validate_pidfile_handshake "$pid_file" "$(id -u)" "$mismatched_exe_identity"; then
  printf 'FAIL executable identity mismatch was accepted\n' >&2
  exit 1
fi
kill -TERM "$child_pid"
wait "$child_pid" 2>/dev/null || true
child_pid=""
printf 'PASS executable identity mismatch is rejected\n'

"$renamed_binary" 30 &
child_pid=$!
terminate_process_bounded "$child_pid" 2 1
[[ "$PROCESS_TERMINATION_USED_KILL" == "false" ]]
[[ "$PROCESS_TERMINATION_DURATION_MS" -le 2500 ]]
process_is_alive "$child_pid" && exit 1
wait "$child_pid" 2>/dev/null || true
child_pid=""
printf 'PASS cooperative process terminates with TERM\n'

ready_file="$test_root/term-ignored.ready"
bash -c '
  trap "" TERM
  : >"$1"
  while true; do sleep 1; done
' bash "$ready_file" &
child_pid=$!
for _ in $(seq 1 20); do
  [[ -f "$ready_file" ]] && break
  sleep 0.05
done
[[ -f "$ready_file" ]]
termination_started_ms="$(date +%s%3N)"
terminate_process_bounded "$child_pid" 1 1
termination_elapsed_ms=$(( $(date +%s%3N) - termination_started_ms ))
[[ "$PROCESS_TERMINATION_USED_KILL" == "true" ]]
[[ "$termination_elapsed_ms" -le 2500 ]]
process_is_alive "$child_pid" && exit 1
wait "$child_pid" 2>/dev/null || true
child_pid=""
printf 'PASS TERM-resistant process uses bounded KILL fallback\n'

wrapper_ready_file="$test_root/wrapper.ready"
bash -c '
  trap "" TERM
  : >"$1"
  while true; do sleep 1; done
' bash "$wrapper_ready_file" &
child_pid=$!
for _ in $(seq 1 20); do
  [[ -f "$wrapper_ready_file" ]] && break
  sleep 0.05
done
[[ -f "$wrapper_ready_file" ]]
cleanup_started_ms="$(date +%s%3N)"
terminate_process_bounded "$child_pid" 1 1
process_is_alive "$child_pid" && exit 1
wait "$child_pid" 2>/dev/null || true
cleanup_elapsed_ms=$(( $(date +%s%3N) - cleanup_started_ms ))
[[ "$cleanup_elapsed_ms" -le 2500 ]]
child_pid=""
printf 'PASS wrapper wait occurs only after bounded termination\n'
