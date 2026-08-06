#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hf-s3-litestream-process-control.sh
source "$script_dir/hf-s3-litestream-process-control.sh"

test_root="$(mktemp -d)"
child_pid=""
cross_daemon_pid=""
cross_wrapper_pid=""

cleanup_test() {
  if [[ -n "$child_pid" ]]; then
    kill -KILL "$child_pid" >/dev/null 2>&1 || true
    wait "$child_pid" >/dev/null 2>&1 || true
  fi
  PROCESS_SIGNAL_WITH_SUDO=1
  if [[ -n "$cross_daemon_pid" ]]; then
    terminate_process_bounded "$cross_daemon_pid" 1 1 || true
  fi
  if [[ -n "$cross_wrapper_pid" && "$cross_wrapper_pid" != "$cross_daemon_pid" ]]; then
    terminate_process_bounded "$cross_wrapper_pid" 1 1 || true
  fi
  if [[ -n "$cross_wrapper_pid" ]] && ! process_is_alive "$cross_wrapper_pid"; then
    wait "$cross_wrapper_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "${cross_uid_dir:-}" && -e "$cross_uid_dir" ]]; then
    remove_directory_with_permission_repair \
      "$cross_uid_dir" \
      "$test_root" \
      "$(id -u)" \
      "$(id -g)" || true
  fi
  rm -rf -- "$test_root"
}
trap cleanup_test EXIT

renamed_binary="$test_root/renamed-process-binary"
process_control_copy="$test_root/process-control.sh"
pid_file="$test_root/process.pid"
cp /bin/sleep "$renamed_binary"
chmod 755 "$renamed_binary"
cp "$script_dir/hf-s3-litestream-process-control.sh" "$process_control_copy"
chmod 644 "$process_control_copy"
handshake_nonce="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"

bash -c '
  set -Eeuo pipefail
  source "$1"
  pid_file=$2
  nonce=$3
  shift 3
  write_pidfile_handshake "$pid_file" "$nonce"
  exec "$@"
' bash "$process_control_copy" "$pid_file" "$handshake_nonce" "$renamed_binary" 30 &
child_pid=$!

wait_for_pidfile_handshake \
  "$pid_file" \
  "$(id -u)" \
  "$handshake_nonce" \
  "$child_pid" \
  2000 \
  100

[[ "$PIDFILE_HANDSHAKE_PID" == "$child_pid" ]]
[[ "$PIDFILE_HANDSHAKE_START_IDENTITY" == "$(process_start_identity "$child_pid")" ]]
[[ "$PIDFILE_HANDSHAKE_NONCE_VALID" == "true" ]]
[[ "$PIDFILE_HANDSHAKE_UID_VALID" == "true" ]]
[[ "$PIDFILE_HANDSHAKE_START_IDENTITY_VALID" == "true" ]]
[[ "$PIDFILE_HANDSHAKE_DURATION_MS" -le 2000 ]]

kill -TERM "$child_pid"
wait "$child_pid" 2>/dev/null || true
child_pid=""
printf 'PASS nonce handshake preserves PID and start identity across renamed exec\n'

"$renamed_binary" 30 &
child_pid=$!
recorded_start_ticks="$(process_start_identity "$child_pid")"
printf '%s\t%s\t%s\n' "$child_pid" "$recorded_start_ticks" "$handshake_nonce" >"$pid_file"
chmod 600 "$pid_file"
if validate_pidfile_handshake "$pid_file" "$(id -u)" "different-$handshake_nonce"; then
  printf 'FAIL invalid nonce was accepted\n' >&2
  exit 1
fi
[[ "$PIDFILE_HANDSHAKE_FAILURE_REASON" == "nonce-mismatch" ]]
kill -TERM "$child_pid"
wait "$child_pid" 2>/dev/null || true
child_pid=""
printf 'PASS invalid nonce is rejected\n'

"$renamed_binary" 30 &
child_pid=$!
recorded_start_ticks="$(process_start_identity "$child_pid")"
printf '%s\t%s\t%s\n' "$child_pid" "$((recorded_start_ticks + 1))" "$handshake_nonce" >"$pid_file"
chmod 600 "$pid_file"
if validate_pidfile_handshake "$pid_file" "$(id -u)" "$handshake_nonce"; then
  printf 'FAIL invalid start identity was accepted\n' >&2
  exit 1
fi
[[ "$PIDFILE_HANDSHAKE_FAILURE_REASON" == "process-start-identity-mismatch" ]]
kill -TERM "$child_pid"
wait "$child_pid" 2>/dev/null || true
child_pid=""
printf 'PASS invalid start identity is rejected\n'

"$renamed_binary" 30 &
child_pid=$!
recorded_start_ticks="$(process_start_identity "$child_pid")"
printf '%s\t%s\t%s\n' "$child_pid" "$recorded_start_ticks" "$handshake_nonce" >"$pid_file"
chmod 640 "$pid_file"
invalid_expected_uid=$(( $(id -u) + 1 ))
sudo chown "$invalid_expected_uid:$(id -g)" "$pid_file"
if validate_pidfile_handshake "$pid_file" "$invalid_expected_uid" "$handshake_nonce"; then
  printf 'FAIL invalid UID was accepted\n' >&2
  exit 1
fi
[[ "$PIDFILE_HANDSHAKE_FAILURE_REASON" == "process-uid-mismatch" ]]
sudo chown "$(id -u):$(id -g)" "$pid_file"
kill -TERM "$child_pid"
wait "$child_pid" 2>/dev/null || true
child_pid=""
printf 'PASS invalid UID is rejected\n'

"$renamed_binary" 30 &
child_pid=$!
recorded_start_ticks="$(process_start_identity "$child_pid")"
malformed_records=(
  ""
  $'not-a-pid\t1\tnonce'
  "$child_pid"$'\t\t'"$handshake_nonce"
  "$child_pid"$'\t'"$recorded_start_ticks"$'\t'
  "$child_pid"$'\t'"$recorded_start_ticks"$'\t'"$handshake_nonce"$'\textra'
)
for malformed_record in "${malformed_records[@]}"; do
  printf '%s\n' "$malformed_record" >"$pid_file"
  chmod 600 "$pid_file"
  if validate_pidfile_handshake "$pid_file" "$(id -u)" "$handshake_nonce"; then
    printf 'FAIL malformed handshake record was accepted\n' >&2
    exit 1
  fi
done
kill -TERM "$child_pid"
wait "$child_pid" 2>/dev/null || true
child_pid=""
printf 'PASS malformed handshake records are rejected\n'

"$renamed_binary" 30 &
child_pid=$!
recorded_start_ticks="$(process_start_identity "$child_pid")"
printf '%s\t%s\t%s\n' "$child_pid" "$recorded_start_ticks" "$handshake_nonce" >"$pid_file"
chmod 600 "$pid_file"
validate_pidfile_handshake "$pid_file" "$(id -u)" "$handshake_nonce"
kill -TERM "$child_pid"
wait "$child_pid" 2>/dev/null || true
child_pid=""
if validate_pidfile_handshake "$pid_file" "$(id -u)" "$handshake_nonce"; then
  printf 'FAIL dead process handshake was accepted\n' >&2
  exit 1
fi
[[ "$PIDFILE_HANDSHAKE_FAILURE_REASON" == "process-stat-unavailable" || "$PIDFILE_HANDSHAKE_FAILURE_REASON" == "process-not-alive" ]]
printf 'PASS dead process handshake is rejected\n'

cross_uid_dir="$test_root/cross-uid"
cross_uid_pid_file="$cross_uid_dir/process.pid"
cross_uid_nonce="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
mkdir -p "$cross_uid_dir"
chmod 711 "$test_root"
sudo chown "$(id -u nobody):$(id -g nobody)" "$cross_uid_dir"
PROCESS_SIGNAL_WITH_SUDO=1
sudo -u nobody -- bash -c '
  set -Eeuo pipefail
  source "$1"
  pid_file=$2
  nonce=$3
  shift 3
  write_pidfile_handshake "$pid_file" "$nonce"
  exec "$@"
' bash "$process_control_copy" "$cross_uid_pid_file" "$cross_uid_nonce" "$renamed_binary" 30 &
cross_wrapper_pid=$!
wait_for_pidfile_handshake \
  "$cross_uid_pid_file" \
  "$(id -u nobody)" \
  "$cross_uid_nonce" \
  "$cross_wrapper_pid" \
  3000 \
  100
cross_daemon_pid="$PIDFILE_HANDSHAKE_PID"
[[ "$PIDFILE_HANDSHAKE_NONCE_VALID" == "true" ]]
[[ "$PIDFILE_HANDSHAKE_UID_VALID" == "true" ]]
[[ "$PIDFILE_HANDSHAKE_START_IDENTITY_VALID" == "true" ]]
[[ "$PIDFILE_HANDSHAKE_FILE_OWNER_UID" == "$(id -u nobody)" ]]
[[ "$PIDFILE_HANDSHAKE_FILE_MODE" == "644" ]]
(( (8#$PIDFILE_HANDSHAKE_FILE_MODE & 022) == 0 ))
terminate_process_bounded "$cross_daemon_pid" 2 1
if [[ "$cross_wrapper_pid" != "$cross_daemon_pid" ]]; then
  terminate_process_bounded "$cross_wrapper_pid" 2 1
fi
if ! process_is_alive "$cross_wrapper_pid"; then
  wait "$cross_wrapper_pid" 2>/dev/null || true
fi
cross_daemon_pid=""
cross_wrapper_pid=""
remove_directory_with_permission_repair \
  "$cross_uid_dir" \
  "$test_root" \
  "$(id -u)" \
  "$(id -g)"
[[ "$DIRECTORY_CLEANUP_STATUS" == "pass" ]]
[[ "$DIRECTORY_CLEANUP_PERMISSION_REPAIR_APPLIED" == "true" ]]
[[ ! -e "$cross_uid_dir" ]]
PROCESS_SIGNAL_WITH_SUDO=0
printf 'PASS cross-UID nobody handshake and permission-repaired cleanup\n'

"$renamed_binary" 30 &
child_pid=$!
for _ in $(seq 1 20); do
  process_is_alive "$child_pid" && break
  sleep 0.05
done
process_is_alive "$child_pid"
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
