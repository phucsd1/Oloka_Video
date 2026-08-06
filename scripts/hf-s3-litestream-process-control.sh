#!/usr/bin/env bash

PROCESS_SIGNAL_WITH_SUDO="${PROCESS_SIGNAL_WITH_SUDO:-0}"
PIDFILE_HANDSHAKE_PID=""
PIDFILE_HANDSHAKE_DURATION_MS=0
PIDFILE_HANDSHAKE_UID_VALID=false
PIDFILE_HANDSHAKE_EXE_VALID=false
PIDFILE_HANDSHAKE_EXE_IDENTITY=""
PROCESS_TERMINATION_DURATION_MS=0
PROCESS_TERMINATION_USED_KILL=false

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
  process_stat="$(<"/proc/$pid/stat")"
  process_stat="${process_stat#*) }"
  process_state="${process_stat%% *}"
  [[ "$process_state" != "Z" && "$process_state" != "X" ]] || return 1
  signal_process "$pid" 0
}

process_start_identity() {
  local pid="$1"
  local process_stat
  process_stat="$(<"/proc/$pid/stat")"
  process_stat="${process_stat#*) }"
  awk '{print $20}' <<<"$process_stat"
}

process_uid() {
  stat -Lc '%u' "/proc/$1"
}

process_executable_identity() {
  stat -Lc '%d:%i' "/proc/$1/exe"
}

validate_pidfile_handshake() {
  local pid_file="$1"
  local expected_uid="$2"
  local expected_exe_identity="$3"
  local candidate_pid candidate_uid candidate_exe_identity

  PIDFILE_HANDSHAKE_UID_VALID=false
  PIDFILE_HANDSHAKE_EXE_VALID=false
  [[ -s "$pid_file" ]] || return 1
  IFS= read -r candidate_pid <"$pid_file"
  [[ "$candidate_pid" =~ ^[0-9]+$ ]] && ((candidate_pid > 1)) || return 1
  [[ -d "/proc/$candidate_pid" ]] || return 1
  process_is_alive "$candidate_pid" || return 1

  candidate_uid="$(process_uid "$candidate_pid")" || return 1
  if [[ "$candidate_uid" == "$expected_uid" ]]; then
    PIDFILE_HANDSHAKE_UID_VALID=true
  else
    return 1
  fi

  candidate_exe_identity="$(process_executable_identity "$candidate_pid")" || return 1
  if [[ "$candidate_exe_identity" == "$expected_exe_identity" ]]; then
    PIDFILE_HANDSHAKE_EXE_VALID=true
  else
    return 1
  fi

  PIDFILE_HANDSHAKE_PID="$candidate_pid"
  PIDFILE_HANDSHAKE_EXE_IDENTITY="$candidate_exe_identity"
}

wait_for_pidfile_handshake() {
  local pid_file="$1"
  local expected_uid="$2"
  local expected_exe_identity="$3"
  local wrapper_pid="$4"
  local timeout_ms="$5"
  local poll_ms="$6"
  local started_ms deadline_ms now_ms

  started_ms="$(date +%s%3N)"
  deadline_ms=$((started_ms + timeout_ms))
  while true; do
    if validate_pidfile_handshake "$pid_file" "$expected_uid" "$expected_exe_identity"; then
      now_ms="$(date +%s%3N)"
      PIDFILE_HANDSHAKE_DURATION_MS=$((now_ms - started_ms))
      return 0
    fi
    process_is_alive "$wrapper_pid" || return 1
    now_ms="$(date +%s%3N)"
    if ((now_ms >= deadline_ms)); then
      PIDFILE_HANDSHAKE_DURATION_MS=$((now_ms - started_ms))
      return 1
    fi
    sleep "$(awk -v milliseconds="$poll_ms" 'BEGIN { printf "%.3f", milliseconds / 1000 }')"
  done
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
