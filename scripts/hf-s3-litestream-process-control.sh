#!/usr/bin/env bash

PROCESS_SIGNAL_WITH_SUDO="${PROCESS_SIGNAL_WITH_SUDO:-0}"
PIDFILE_HANDSHAKE_PID=""
PIDFILE_HANDSHAKE_START_IDENTITY=""
PIDFILE_HANDSHAKE_DURATION_MS=0
PIDFILE_HANDSHAKE_UID_VALID=false
PIDFILE_HANDSHAKE_NONCE_VALID=false
PIDFILE_HANDSHAKE_START_IDENTITY_VALID=false
PIDFILE_HANDSHAKE_FILE_EXISTS=false
PIDFILE_HANDSHAKE_FILE_OWNER_UID=""
PIDFILE_HANDSHAKE_FILE_MODE=""
PIDFILE_HANDSHAKE_PID_PARSED=false
PIDFILE_HANDSHAKE_OBSERVED_UID=""
PIDFILE_HANDSHAKE_RECORDED_START_TICKS=""
PIDFILE_HANDSHAKE_OBSERVED_START_TICKS=""
PIDFILE_HANDSHAKE_FAILURE_REASON="not-started"
PROCESS_TERMINATION_DURATION_MS=0
PROCESS_TERMINATION_USED_KILL=false
DIRECTORY_CLEANUP_STATUS="not-run"
DIRECTORY_CLEANUP_PERMISSION_REPAIR_APPLIED=false
DIRECTORY_CLEANUP_FAILURE_REASON="not-run"

signal_process() {
  local pid="$1"
  local signal_name="$2"
  if [[ "$PROCESS_SIGNAL_WITH_SUDO" == "1" ]]; then
    sudo kill "-$signal_name" "$pid" 2>/dev/null
  else
    kill "-$signal_name" "$pid" 2>/dev/null
  fi
}

process_is_alive() {
  local pid="$1"
  local process_stat process_state
  [[ "$pid" =~ ^[0-9]+$ ]] && ((pid > 1)) || return 1
  [[ -r "/proc/$pid/stat" ]] || return 1
  process_stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
  process_stat="${process_stat##*) }"
  process_state="${process_stat%% *}"
  [[ "$process_state" != "Z" && "$process_state" != "X" ]] || return 1
  signal_process "$pid" 0
}

process_start_identity() {
  local pid="$1"
  local process_stat
  process_stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
  process_stat="${process_stat##*) }"
  awk '{print $20}' <<<"$process_stat"
}

process_uid() {
  stat -Lc '%u' "/proc/$1"
}

write_pidfile_handshake() {
  local pid_file="$1"
  local nonce="$2"
  local start_identity temporary_file
  umask 077
  start_identity="$(process_start_identity "$$")"
  temporary_file="${pid_file}.tmp.$$"
  printf '%s\t%s\t%s\n' "$$" "$start_identity" "$nonce" >"$temporary_file"
  mv -f -- "$temporary_file" "$pid_file"
}

validate_pidfile_handshake() {
  local pid_file="$1"
  local expected_uid="$2"
  local expected_nonce="$3"
  local candidate_pid candidate_uid recorded_start_ticks candidate_nonce
  local observed_start_ticks
  local -a records=()
  local -a fields=()

  PIDFILE_HANDSHAKE_PID=""
  PIDFILE_HANDSHAKE_START_IDENTITY=""
  PIDFILE_HANDSHAKE_UID_VALID=false
  PIDFILE_HANDSHAKE_NONCE_VALID=false
  PIDFILE_HANDSHAKE_START_IDENTITY_VALID=false
  PIDFILE_HANDSHAKE_FILE_EXISTS=false
  PIDFILE_HANDSHAKE_FILE_OWNER_UID=""
  PIDFILE_HANDSHAKE_FILE_MODE=""
  PIDFILE_HANDSHAKE_PID_PARSED=false
  PIDFILE_HANDSHAKE_OBSERVED_UID=""
  PIDFILE_HANDSHAKE_RECORDED_START_TICKS=""
  PIDFILE_HANDSHAKE_OBSERVED_START_TICKS=""
  PIDFILE_HANDSHAKE_FAILURE_REASON="pidfile-missing"

  [[ -e "$pid_file" ]] || return 1
  PIDFILE_HANDSHAKE_FILE_EXISTS=true
  if [[ -L "$pid_file" ]]; then
    PIDFILE_HANDSHAKE_FAILURE_REASON="pidfile-symlink"
    return 1
  fi
  PIDFILE_HANDSHAKE_FILE_OWNER_UID="$(stat -Lc '%u' -- "$pid_file")" || {
    PIDFILE_HANDSHAKE_FAILURE_REASON="pidfile-owner-stat-failed"
    return 1
  }
  PIDFILE_HANDSHAKE_FILE_MODE="$(stat -Lc '%a' -- "$pid_file")" || {
    PIDFILE_HANDSHAKE_FAILURE_REASON="pidfile-mode-stat-failed"
    return 1
  }
  if [[ "$PIDFILE_HANDSHAKE_FILE_OWNER_UID" != "$expected_uid" ]]; then
    PIDFILE_HANDSHAKE_FAILURE_REASON="pidfile-owner-mismatch"
    return 1
  fi
  if (( (8#$PIDFILE_HANDSHAKE_FILE_MODE & 022) != 0 )); then
    PIDFILE_HANDSHAKE_FAILURE_REASON="pidfile-group-or-other-writable"
    return 1
  fi

  mapfile -t records <"$pid_file"
  if [[ "${#records[@]}" -ne 1 ]]; then
    PIDFILE_HANDSHAKE_FAILURE_REASON="handshake-record-line-count"
    return 1
  fi
  IFS=$'\t' read -r -a fields <<<"${records[0]}"
  if [[ "${#fields[@]}" -ne 3 ]]; then
    PIDFILE_HANDSHAKE_FAILURE_REASON="handshake-record-field-count"
    return 1
  fi
  candidate_pid="${fields[0]}"
  recorded_start_ticks="${fields[1]}"
  candidate_nonce="${fields[2]}"
  if [[ ! "$candidate_pid" =~ ^[0-9]+$ ]] || ((candidate_pid <= 1)); then
    PIDFILE_HANDSHAKE_FAILURE_REASON="pid-invalid"
    return 1
  fi
  PIDFILE_HANDSHAKE_PID_PARSED=true
  PIDFILE_HANDSHAKE_PID="$candidate_pid"
  if [[ ! "$recorded_start_ticks" =~ ^[0-9]+$ ]] || ((recorded_start_ticks <= 0)); then
    PIDFILE_HANDSHAKE_FAILURE_REASON="start-identity-invalid"
    return 1
  fi
  PIDFILE_HANDSHAKE_RECORDED_START_TICKS="$recorded_start_ticks"
  if [[ "$candidate_nonce" != "$expected_nonce" ]]; then
    PIDFILE_HANDSHAKE_FAILURE_REASON="nonce-mismatch"
    return 1
  fi
  PIDFILE_HANDSHAKE_NONCE_VALID=true
  if [[ ! -r "/proc/$candidate_pid/stat" ]]; then
    PIDFILE_HANDSHAKE_FAILURE_REASON="process-stat-unavailable"
    return 1
  fi
  if ! process_is_alive "$candidate_pid"; then
    PIDFILE_HANDSHAKE_FAILURE_REASON="process-not-alive"
    return 1
  fi

  candidate_uid="$(process_uid "$candidate_pid")" || {
    PIDFILE_HANDSHAKE_FAILURE_REASON="process-uid-stat-failed"
    return 1
  }
  PIDFILE_HANDSHAKE_OBSERVED_UID="$candidate_uid"
  if [[ "$candidate_uid" == "$expected_uid" ]]; then
    PIDFILE_HANDSHAKE_UID_VALID=true
  else
    PIDFILE_HANDSHAKE_FAILURE_REASON="process-uid-mismatch"
    return 1
  fi

  observed_start_ticks="$(process_start_identity "$candidate_pid")" || {
    PIDFILE_HANDSHAKE_FAILURE_REASON="process-start-identity-read-failed"
    return 1
  }
  PIDFILE_HANDSHAKE_OBSERVED_START_TICKS="$observed_start_ticks"
  if [[ "$observed_start_ticks" == "$recorded_start_ticks" ]]; then
    PIDFILE_HANDSHAKE_START_IDENTITY_VALID=true
  else
    PIDFILE_HANDSHAKE_FAILURE_REASON="process-start-identity-mismatch"
    return 1
  fi

  PIDFILE_HANDSHAKE_PID="$candidate_pid"
  PIDFILE_HANDSHAKE_START_IDENTITY="$recorded_start_ticks"
  PIDFILE_HANDSHAKE_FAILURE_REASON="none"
}

wait_for_pidfile_handshake() {
  local pid_file="$1"
  local expected_uid="$2"
  local expected_nonce="$3"
  local wrapper_pid="$4"
  local timeout_ms="$5"
  local poll_ms="$6"
  local started_ms deadline_ms now_ms

  started_ms="$(date +%s%3N)"
  deadline_ms=$((started_ms + timeout_ms))
  while true; do
    if validate_pidfile_handshake "$pid_file" "$expected_uid" "$expected_nonce" && process_is_alive "$wrapper_pid"; then
      now_ms="$(date +%s%3N)"
      PIDFILE_HANDSHAKE_DURATION_MS=$((now_ms - started_ms))
      return 0
    fi
    if ! process_is_alive "$wrapper_pid"; then
      now_ms="$(date +%s%3N)"
      PIDFILE_HANDSHAKE_DURATION_MS=$((now_ms - started_ms))
      return 1
    fi
    now_ms="$(date +%s%3N)"
    if ((now_ms >= deadline_ms)); then
      PIDFILE_HANDSHAKE_DURATION_MS=$((now_ms - started_ms))
      return 1
    fi
    sleep "$(awk -v milliseconds="$poll_ms" 'BEGIN { printf "%.3f", milliseconds / 1000 }')"
  done
}

remove_directory_with_permission_repair() {
  local target_directory="$1"
  local allowed_root="$2"
  local owner_uid="$3"
  local owner_gid="$4"
  local resolved_target resolved_root

  DIRECTORY_CLEANUP_STATUS="fail"
  DIRECTORY_CLEANUP_PERMISSION_REPAIR_APPLIED=false
  DIRECTORY_CLEANUP_FAILURE_REASON="unsafe-path"

  [[ -n "$target_directory" && "$target_directory" != "/" && "$target_directory" != "." ]] || return 1
  [[ -n "$allowed_root" && "$allowed_root" != "/" && "$allowed_root" != "." ]] || return 1
  resolved_target="$(realpath -m -- "$target_directory")" || return 1
  resolved_root="$(realpath -m -- "$allowed_root")" || return 1
  [[ "$resolved_target" != "$resolved_root" && "$resolved_target" == "$resolved_root/"* ]] || return 1

  if [[ ! -e "$resolved_target" ]]; then
    DIRECTORY_CLEANUP_STATUS="pass"
    DIRECTORY_CLEANUP_FAILURE_REASON="none"
    return 0
  fi

  DIRECTORY_CLEANUP_FAILURE_REASON="ownership-repair-failed"
  sudo chown -R "$owner_uid:$owner_gid" -- "$resolved_target" || return 1
  DIRECTORY_CLEANUP_PERMISSION_REPAIR_APPLIED=true
  DIRECTORY_CLEANUP_FAILURE_REASON="remove-failed"
  rm -rf -- "$resolved_target" || return 1
  [[ ! -e "$resolved_target" ]] || return 1

  DIRECTORY_CLEANUP_STATUS="pass"
  DIRECTORY_CLEANUP_FAILURE_REASON="none"
}

terminate_process_bounded() {
  local pid="$1"
  local term_timeout_seconds="$2"
  local kill_timeout_seconds="$3"
  local started_ms deadline_ms now_ms

  PROCESS_TERMINATION_DURATION_MS=0
  PROCESS_TERMINATION_USED_KILL=false
  process_is_alive "$pid" || return 0

  started_ms="$(date +%s%3N)"
  signal_process "$pid" TERM || true
  deadline_ms=$((started_ms + term_timeout_seconds * 1000))
  while process_is_alive "$pid"; do
    now_ms="$(date +%s%3N)"
    ((now_ms < deadline_ms)) || break
    sleep 0.1
  done

  if process_is_alive "$pid"; then
    PROCESS_TERMINATION_USED_KILL=true
    signal_process "$pid" KILL || true
    deadline_ms=$(( $(date +%s%3N) + kill_timeout_seconds * 1000 ))
    while process_is_alive "$pid"; do
      now_ms="$(date +%s%3N)"
      ((now_ms < deadline_ms)) || break
      sleep 0.1
    done
  fi

  now_ms="$(date +%s%3N)"
  PROCESS_TERMINATION_DURATION_MS=$((now_ms - started_ms))
  process_is_alive "$pid" && return 1
  return 0
}
