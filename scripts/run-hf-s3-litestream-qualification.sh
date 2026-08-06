#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hf-s3-litestream-process-control.sh
source "$script_dir/hf-s3-litestream-process-control.sh"
PROCESS_SIGNAL_WITH_SUDO=1

: "${HF_S3_ACCESS_KEY_ID:?HF_S3_ACCESS_KEY_ID is required}"
: "${HF_S3_SECRET_ACCESS_KEY:?HF_S3_SECRET_ACCESS_KEY is required}"
: "${HF_S3_ENDPOINT:?HF_S3_ENDPOINT is required}"
: "${HF_S3_REGION:?HF_S3_REGION is required}"
: "${HF_S3_BUCKET:?HF_S3_BUCKET is required}"
: "${QUALIFICATION_RUN_ID:?QUALIFICATION_RUN_ID is required}"
: "${LITESTREAM_BIN:?LITESTREAM_BIN is required}"
: "${QUALIFICATION_REPORT_PATH:?QUALIFICATION_REPORT_PATH is required}"

prefix="qualification/sqlite-litestream/${QUALIFICATION_RUN_ID}"
if [[ "$prefix" != qualification/sqlite-litestream/* ]]; then
  echo "Unsafe qualification prefix" >&2
  exit 1
fi

export AWS_ACCESS_KEY_ID="$HF_S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$HF_S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="$HF_S3_REGION"
export AWS_REGION="$HF_S3_REGION"
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
export LITESTREAM_ACCESS_KEY_ID="$HF_S3_ACCESS_KEY_ID"
export LITESTREAM_SECRET_ACCESS_KEY="$HF_S3_SECRET_ACCESS_KEY"

work_root="$(mktemp -d)"
live_dir="$work_root/live"
database_path="$live_dir/oloka.db"
config_path="$work_root/litestream.yml"
database_script="scripts/hf-s3-qualification-database.mjs"
daemon_pid=""
daemon_wrapper_pid=""
current_stage="initialization"
failure_code=""
failure_message=""
failure_diagnostics='null'
retry_uid=""
retry_gid=""
retry_dir=""
retry_pid_file=""
retry_handshake_nonce=""
retry_directory_cleanup="not-needed"
cleanup_permission_repair_applied=false
rule_comment="oloka-litestream-${QUALIFICATION_RUN_ID}"
ipv4_rejected_packets=0
ipv6_rejected_packets=0
ipv4_baseline_packets=0
ipv6_baseline_packets=0
declare -a ipv4_rule_ips=()
declare -a ipv6_rule_ips=()

atomic_report() {
  local temporary_path="${QUALIFICATION_REPORT_PATH}.tmp.$$"
  jq "$@" "$QUALIFICATION_REPORT_PATH" >"$temporary_path"
  mv -f -- "$temporary_path" "$QUALIFICATION_REPORT_PATH"
}

set_report_stage() {
  current_stage="$1"
  atomic_report --arg stage "$current_stage" '.currentStage = $stage'
}

set_report_test() {
  local test_name="$1"
  local test_json="$2"
  atomic_report \
    --arg testName "$test_name" \
    --argjson testValue "$test_json" \
    '.tests[$testName] = $testValue'
}

finalize_failure_report() {
  local exit_code="$1"
  atomic_report \
    --arg stage "$current_stage" \
    --arg code "${failure_code:-QUALIFICATION_COMMAND_FAILED}" \
    --arg message "${failure_message:-A qualification command failed; inspect the named stage and safe diagnostics.}" \
    --argjson exitCode "$exit_code" \
    --argjson diagnostics "$failure_diagnostics" \
    '.status = "failure"
      | .currentStage = $stage
      | .failure = {
          code: $code,
          message: $message,
          exitCode: $exitCode,
          diagnostics: $diagnostics
        }'
}

fail_qualification() {
  failure_code="$1"
  failure_message="$2"
  return 1
}

remove_network_rules() {
  local ip
  local removal_failed=0
  local -a remaining_ipv4=()
  local -a remaining_ipv6=()
  for ip in "${ipv4_rule_ips[@]}"; do
    if ! sudo iptables -D OUTPUT \
      -p tcp -d "$ip" --dport 443 \
      -m owner --uid-owner "$retry_uid" \
      -m comment --comment "$rule_comment" \
      -j REJECT >/dev/null 2>&1; then
      remaining_ipv4+=("$ip")
      removal_failed=1
    fi
  done
  for ip in "${ipv6_rule_ips[@]}"; do
    if ! sudo ip6tables -D OUTPUT \
      -p tcp -d "$ip" --dport 443 \
      -m owner --uid-owner "$retry_uid" \
      -m comment --comment "$rule_comment" \
      -j REJECT >/dev/null 2>&1; then
      remaining_ipv6+=("$ip")
      removal_failed=1
    fi
  done
  ipv4_rule_ips=("${remaining_ipv4[@]}")
  ipv6_rule_ips=("${remaining_ipv6[@]}")
  return "$removal_failed"
}

cleanup() {
  local original_status=$?
  local cleanup_started_ms cleanup_duration_ms
  local cleanup_failed=0
  local daemon_stopped=true
  local wrapper_stopped=true
  trap - ERR
  trap - TERM INT
  set +e
  cleanup_started_ms="$(date +%s%3N)"
  remove_network_rules
  if [[ -z "$daemon_pid" && -n "$retry_pid_file" && -n "$retry_uid" && -n "$retry_handshake_nonce" ]]; then
    if validate_pidfile_handshake "$retry_pid_file" "$retry_uid" "$retry_handshake_nonce"; then
      daemon_pid="$PIDFILE_HANDSHAKE_PID"
    fi
  fi
  if [[ -n "$daemon_pid" ]]; then
    if ! terminate_process_bounded "$daemon_pid" 10 5; then
      daemon_stopped=false
      cleanup_failed=1
    fi
  fi
  if [[ -n "$daemon_wrapper_pid" && "$daemon_wrapper_pid" != "$daemon_pid" ]]; then
    if ! terminate_process_bounded "$daemon_wrapper_pid" 5 3; then
      wrapper_stopped=false
      cleanup_failed=1
    fi
  fi
  if [[ -n "$daemon_wrapper_pid" ]] && ! process_is_alive "$daemon_wrapper_pid"; then
    wait "$daemon_wrapper_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$retry_dir" ]]; then
    if remove_directory_with_permission_repair \
      "$retry_dir" \
      "$work_root" \
      "$(id -u)" \
      "$(id -g)"; then
      retry_directory_cleanup="$DIRECTORY_CLEANUP_STATUS"
      cleanup_permission_repair_applied="$DIRECTORY_CLEANUP_PERMISSION_REPAIR_APPLIED"
    else
      retry_directory_cleanup="fail"
      cleanup_permission_repair_applied="$DIRECTORY_CLEANUP_PERMISSION_REPAIR_APPLIED"
      cleanup_failed=1
    fi
  fi
  cleanup_duration_ms=$(( $(date +%s%3N) - cleanup_started_ms ))
  if [[ -f "$QUALIFICATION_REPORT_PATH" ]]; then
    atomic_report \
      --argjson durationMs "$cleanup_duration_ms" \
      --argjson daemonStopped "$daemon_stopped" \
      --argjson wrapperStopped "$wrapper_stopped" \
      --arg retryDirectoryCleanup "$retry_directory_cleanup" \
      --argjson cleanupPermissionRepairApplied "$cleanup_permission_repair_applied" \
      '.cleanup = {
        durationMs: $durationMs,
        daemonStopped: $daemonStopped,
        wrapperStopped: $wrapperStopped,
        retryDirectoryCleanup: $retryDirectoryCleanup,
        cleanupPermissionRepairApplied: $cleanupPermissionRepairApplied,
        bounded: true
      }' || true
  fi
  if ! rm -rf -- "$work_root"; then
    cleanup_failed=1
  fi
  if [[ "$original_status" -eq 0 && "$cleanup_failed" -ne 0 ]]; then
    if [[ -f "$QUALIFICATION_REPORT_PATH" ]]; then
      atomic_report \
        '.status = "failure"
          | .currentStage = "cleanup"
          | .failure = {
              code: "QUALIFICATION_CLEANUP_FAILED",
              message: "Qualification cleanup could not safely stop processes or remove its exact temporary directory.",
              exitCode: 1,
              diagnostics: .cleanup
            }' || true
    fi
    original_status=1
  fi
  return "$original_status"
}

on_error() {
  local original_status=$?
  trap - ERR
  set +e
  finalize_failure_report "$original_status"
  exit "$original_status"
}

on_termination() {
  trap - ERR TERM INT
  set +e
  failure_code="QUALIFICATION_WATCHDOG_TERMINATED"
  failure_message="Qualification received a termination signal before completion."
  finalize_failure_report 124
  exit 124
}

mkdir -p "$(dirname "$QUALIFICATION_REPORT_PATH")"
initial_report_tmp="${QUALIFICATION_REPORT_PATH}.tmp.$$"
jq -n \
  --arg runId "$QUALIFICATION_RUN_ID" \
  --arg prefix "$prefix" \
  '{
    runId: $runId,
    prefix: $prefix,
    status: "running",
    currentStage: "initialization",
    tests: {}
  }' >"$initial_report_tmp"
mv -f -- "$initial_report_tmp" "$QUALIFICATION_REPORT_PATH"
trap cleanup EXIT
trap on_error ERR
trap on_termination TERM INT

mkdir -p "$live_dir"
cat >"$config_path" <<EOF
logging:
  level: info
dbs:
  - path: $database_path
    replica:
      type: s3
      bucket: $HF_S3_BUCKET
      path: $prefix/replica
      endpoint: $HF_S3_ENDPOINT
      region: $HF_S3_REGION
      force-path-style: true
      sign-payload: true
      require-content-md5: false
EOF

aws_hf() {
  aws --endpoint-url "$HF_S3_ENDPOINT" --region "$HF_S3_REGION" s3api "$@"
}

object_count() {
  local object_prefix="$1"
  aws_hf list-objects-v2 \
    --bucket "$HF_S3_BUCKET" \
    --prefix "$object_prefix" \
    --query 'length(Contents || `[]`)' \
    --output text
}

remove_local_database() {
  rm -rf -- "$live_dir"
  mkdir -p "$live_dir"
}

replicate_once() {
  "$LITESTREAM_BIN" replicate -config "$config_path" -once -force-snapshot
}

restore_latest() {
  local started_at finished_at
  remove_local_database
  started_at="$(date +%s%3N)"
  "$LITESTREAM_BIN" restore \
    -config "$config_path" \
    -integrity-check quick \
    "$database_path"
  finished_at="$(date +%s%3N)"
  RESTORE_DURATION_MS=$((finished_at - started_at))
}

rule_packet_count() {
  local family="$1"
  local command_name="iptables-save"
  local saved_rules
  if [[ "$family" == "ipv6" ]]; then command_name="ip6tables-save"; fi
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '0\n'
    return
  fi
  if ! saved_rules="$(sudo "$command_name" -c 2>/dev/null)"; then
    printf '0\n'
    return
  fi
  awk -v marker="$rule_comment" '
    index($0, marker) {
      token = $1
      gsub(/[\[\]]/, "", token)
      split(token, values, ":")
      packets += values[1]
    }
    END { print packets + 0 }
  ' <<<"$saved_rules"
}

install_network_rules() {
  local endpoint_host ip
  local -a resolved_ipv4=()
  local -a resolved_ipv6=()
  endpoint_host="${HF_S3_ENDPOINT#*://}"
  endpoint_host="${endpoint_host%%/*}"
  mapfile -t resolved_ipv4 < <(getent ahostsv4 "$endpoint_host" | awk '{print $1}' | sort -u)
  mapfile -t resolved_ipv6 < <(getent ahostsv6 "$endpoint_host" | awk '{print $1}' | sort -u)
  if [[ "${#resolved_ipv4[@]}" -eq 0 && "${#resolved_ipv6[@]}" -eq 0 ]]; then
    fail_qualification "RETRY_ENDPOINT_RESOLUTION_FAILED" "HF S3 endpoint did not resolve for the bounded outage test."
  fi
  for ip in "${resolved_ipv4[@]}"; do
    sudo iptables -I OUTPUT 1 \
      -p tcp -d "$ip" --dport 443 \
      -m owner --uid-owner "$retry_uid" \
      -m comment --comment "$rule_comment" \
      -j REJECT
    ipv4_rule_ips+=("$ip")
  done
  for ip in "${resolved_ipv6[@]}"; do
    if sudo ip6tables -I OUTPUT 1 \
      -p tcp -d "$ip" --dport 443 \
      -m owner --uid-owner "$retry_uid" \
      -m comment --comment "$rule_comment" \
      -j REJECT 2>/dev/null; then
      ipv6_rule_ips+=("$ip")
    fi
  done
}

sanitized_retry_logs() {
  if [[ ! -f "$work_root/retry.log" ]]; then
    printf ''
    return
  fi
  tail -n 20 "$work_root/retry.log" | sed -E \
    -e 's/(HFAK|hf_)[A-Za-z0-9_-]+/[REDACTED]/g' \
    -e 's#https?://[^[:space:]]+#<url>#g' \
    -e 's/(Authorization|Credential|Signature|X-Amz-[A-Za-z-]+)[=:][^[:space:]]+/\1=[REDACTED]/Ig'
}

capture_retry_diagnostics() {
  local elapsed_ms="$1"
  local initial_pid="$2"
  local initial_identity="$3"
  local alive=false
  local pid_unchanged=false
  local identity_unchanged=false
  local wrapper_alive=false
  local current_identity=""
  local observed_uid=""
  local tracked_pid="$initial_pid"
  local ipv4_packets=0
  local ipv6_packets=0
  local replica_objects=-1
  if [[ -n "$retry_pid_file" && -n "$retry_uid" && -n "$retry_handshake_nonce" ]]; then
    validate_pidfile_handshake "$retry_pid_file" "$retry_uid" "$retry_handshake_nonce" || true
  fi
  if [[ ! "$tracked_pid" =~ ^[0-9]+$ || "$tracked_pid" -le 1 ]]; then
    tracked_pid="$PIDFILE_HANDSHAKE_PID"
  fi
  if process_is_alive "$tracked_pid"; then
    alive=true
    if [[ -n "$initial_pid" && "$tracked_pid" == "$initial_pid" ]]; then pid_unchanged=true; fi
    current_identity="$(process_start_identity "$tracked_pid" 2>/dev/null || true)"
    if [[ -n "$current_identity" && "$current_identity" == "$initial_identity" ]]; then
      identity_unchanged=true
    fi
    observed_uid="$(process_uid "$tracked_pid" 2>/dev/null || true)"
  fi
  if process_is_alive "$daemon_wrapper_pid"; then wrapper_alive=true; fi
  ipv4_packets="$(rule_packet_count ipv4 || printf '0')"
  ipv6_packets="$(rule_packet_count ipv6 || printf '0')"
  ipv4_packets=$((ipv4_packets - ipv4_baseline_packets))
  ipv6_packets=$((ipv6_packets - ipv6_baseline_packets))
  if ((ipv4_packets < 0)); then ipv4_packets=0; fi
  if ((ipv6_packets < 0)); then ipv6_packets=0; fi
  if ((ipv4_packets < ipv4_rejected_packets)); then
    ipv4_packets="$ipv4_rejected_packets"
  fi
  if ((ipv6_packets < ipv6_rejected_packets)); then
    ipv6_packets="$ipv6_rejected_packets"
  fi
  replica_objects="$(object_count "$prefix/retry/" 2>/dev/null || printf '%s' '-1')"
  failure_diagnostics="$(jq -n \
    --argjson elapsedMs "$elapsed_ms" \
    --argjson processAlive "$alive" \
    --argjson pidUnchanged "$pid_unchanged" \
    --argjson processStartIdentityUnchanged "$identity_unchanged" \
    --argjson wrapperAlive "$wrapper_alive" \
    --argjson pidfileExists "$PIDFILE_HANDSHAKE_FILE_EXISTS" \
    --arg pidfileOwnerUid "$PIDFILE_HANDSHAKE_FILE_OWNER_UID" \
    --arg pidfileMode "$PIDFILE_HANDSHAKE_FILE_MODE" \
    --argjson pidParsed "$PIDFILE_HANDSHAKE_PID_PARSED" \
    --argjson nonceMatched "$PIDFILE_HANDSHAKE_NONCE_VALID" \
    --arg expectedUid "$retry_uid" \
    --arg observedUid "${PIDFILE_HANDSHAKE_OBSERVED_UID:-$observed_uid}" \
    --arg recordedStartTicks "$PIDFILE_HANDSHAKE_RECORDED_START_TICKS" \
    --arg observedStartTicks "${PIDFILE_HANDSHAKE_OBSERVED_START_TICKS:-$current_identity}" \
    --argjson handshakeElapsedMs "$PIDFILE_HANDSHAKE_DURATION_MS" \
    --arg handshakeFailureReason "$PIDFILE_HANDSHAKE_FAILURE_REASON" \
    --argjson ipv4RejectedPackets "$ipv4_packets" \
    --argjson ipv6RejectedPackets "$ipv6_packets" \
    --argjson replicaObjectCount "$replica_objects" \
    --arg logLines "$(sanitized_retry_logs)" \
    '{
      elapsedMs: $elapsedMs,
      processAlive: $processAlive,
      pidUnchanged: $pidUnchanged,
      processStartIdentityUnchanged: $processStartIdentityUnchanged,
      wrapperAlive: $wrapperAlive,
      pidfileExists: $pidfileExists,
      pidfileOwnerUid: $pidfileOwnerUid,
      pidfileMode: $pidfileMode,
      pidParsed: $pidParsed,
      nonceMatched: $nonceMatched,
      expectedUid: $expectedUid,
      observedUid: $observedUid,
      recordedStartTicks: $recordedStartTicks,
      observedStartTicks: $observedStartTicks,
      handshakeElapsedMs: $handshakeElapsedMs,
      handshakeFailureReason: $handshakeFailureReason,
      ipv4RejectedPackets: $ipv4RejectedPackets,
      ipv6RejectedPackets: $ipv6RejectedPackets,
      replicaObjectCount: $replicaObjectCount,
      sanitizedLitestreamLogLines: ($logLines | split("\n") | map(select(length > 0)))
    }')"
}

retry_identity_failure_code=""
retry_identity_failure_message=""
verify_retry_process_identity() {
  local expected_pid="$1"
  local expected_start_identity="$2"
  retry_identity_failure_code="RETRY_PROCESS_IDENTITY_INVALID"
  retry_identity_failure_message="Litestream same-process identity validation failed."

  if ! validate_pidfile_handshake "$retry_pid_file" "$retry_uid" "$retry_handshake_nonce"; then
    if [[ "$PIDFILE_HANDSHAKE_FAILURE_REASON" == "process-start-identity-mismatch" ]]; then
      retry_identity_failure_code="RETRY_PROCESS_IDENTITY_CHANGED"
      retry_identity_failure_message="Litestream process start identity changed."
    elif [[ "$PIDFILE_HANDSHAKE_FAILURE_REASON" == "process-uid-mismatch" ]]; then
      retry_identity_failure_code="RETRY_PROCESS_UID_CHANGED"
      retry_identity_failure_message="Litestream process UID changed."
    else
      retry_identity_failure_code="RETRY_PROCESS_HANDSHAKE_REVALIDATION_FAILED"
      retry_identity_failure_message="Litestream nonce handshake no longer validates."
    fi
    return 1
  fi
  if [[ "$PIDFILE_HANDSHAKE_PID" != "$expected_pid" ]]; then
    retry_identity_failure_code="RETRY_PROCESS_PID_CHANGED"
    retry_identity_failure_message="Litestream PID changed."
    return 1
  fi
  if ! process_is_alive "$expected_pid"; then
    retry_identity_failure_code="RETRY_PROCESS_NOT_ALIVE"
    retry_identity_failure_message="Litestream process is not alive."
    return 1
  fi
  if [[ "$(process_uid "$expected_pid")" != "$retry_uid" ]]; then
    retry_identity_failure_code="RETRY_PROCESS_UID_CHANGED"
    retry_identity_failure_message="Litestream process UID changed."
    return 1
  fi
  if [[ "$(process_start_identity "$expected_pid")" != "$expected_start_identity" ]]; then
    retry_identity_failure_code="RETRY_PROCESS_IDENTITY_CHANGED"
    retry_identity_failure_message="Litestream process start identity changed."
    return 1
  fi
}

terminate_retry_process() {
  if ! verify_retry_process_identity "$daemon_pid" "$initial_retry_identity"; then
    fail_qualification "$retry_identity_failure_code" "$retry_identity_failure_message"
  fi
  if ! terminate_process_bounded "$daemon_pid" 30 5; then
    fail_qualification "RETRY_PROCESS_TERMINATION_TIMEOUT" "Litestream did not exit within bounded TERM and KILL deadlines."
  fi
  retry_termination_ms="$PROCESS_TERMINATION_DURATION_MS"
  if [[ "$PROCESS_TERMINATION_USED_KILL" == "true" ]]; then
    fail_qualification "RETRY_PROCESS_GRACEFUL_TERMINATION_FAILED" "Litestream required SIGKILL after its graceful SIGTERM deadline."
  fi
  if [[ -n "$daemon_wrapper_pid" && "$daemon_wrapper_pid" != "$daemon_pid" ]]; then
    if ! terminate_process_bounded "$daemon_wrapper_pid" 5 3; then
      fail_qualification "RETRY_WRAPPER_TERMINATION_TIMEOUT" "The sudo wrapper did not exit within bounded cleanup deadlines."
    fi
  fi
  if [[ -n "$daemon_wrapper_pid" ]] && ! process_is_alive "$daemon_wrapper_pid"; then
    wait "$daemon_wrapper_pid" 2>/dev/null || true
  fi
  daemon_pid=""
  daemon_wrapper_pid=""
}

echo "qualification.run_id=$QUALIFICATION_RUN_ID"
echo "qualification.prefix=$prefix"

set_report_stage "s3Compatibility"
echo "qualification.test_e.direct_operations=starting"
ops_prefix="$prefix/operations"
payload="$work_root/payload.txt"
downloaded="$work_root/downloaded.txt"
printf 'oloka-hf-s3-qualification-%s\n' "$QUALIFICATION_RUN_ID" >"$payload"

aws_hf put-object \
  --bucket "$HF_S3_BUCKET" \
  --key "$ops_prefix/basic.txt" \
  --body "$payload" >/dev/null
aws_hf list-objects-v2 \
  --bucket "$HF_S3_BUCKET" \
  --prefix "$ops_prefix/" \
  --output json | jq -e '.Contents | length >= 1' >/dev/null
aws_hf get-object \
  --bucket "$HF_S3_BUCKET" \
  --key "$ops_prefix/basic.txt" \
  "$downloaded" >/dev/null
cmp "$payload" "$downloaded"

aws_hf put-object \
  --bucket "$HF_S3_BUCKET" \
  --key "$ops_prefix/conditional.txt" \
  --body "$payload" \
  --if-none-match '*' >/dev/null
if aws_hf put-object \
  --bucket "$HF_S3_BUCKET" \
  --key "$ops_prefix/conditional.txt" \
  --body "$payload" \
  --if-none-match '*' >/dev/null 2>&1; then
  fail_qualification "S3_CONDITIONAL_PUT_OVERWROTE" "Conditional Put unexpectedly overwrote an existing object."
fi

multipart_payload="$work_root/multipart.bin"
multipart_download="$work_root/multipart-download.bin"
dd if=/dev/zero of="$multipart_payload" bs=1M count=6 status=none
upload_id="$(aws_hf create-multipart-upload \
  --bucket "$HF_S3_BUCKET" \
  --key "$ops_prefix/multipart.bin" \
  --query UploadId \
  --output text)"
etag="$(aws_hf upload-part \
  --bucket "$HF_S3_BUCKET" \
  --key "$ops_prefix/multipart.bin" \
  --part-number 1 \
  --upload-id "$upload_id" \
  --body "$multipart_payload" \
  --query ETag \
  --output text)"
jq -n --arg etag "$etag" \
  '{Parts: [{ETag: $etag, PartNumber: 1}]}' >"$work_root/multipart.json"
aws_hf complete-multipart-upload \
  --bucket "$HF_S3_BUCKET" \
  --key "$ops_prefix/multipart.bin" \
  --upload-id "$upload_id" \
  --multipart-upload "file://$work_root/multipart.json" >/dev/null
aws_hf get-object \
  --bucket "$HF_S3_BUCKET" \
  --key "$ops_prefix/multipart.bin" \
  "$multipart_download" >/dev/null
cmp "$multipart_payload" "$multipart_download"

aws --endpoint-url "$HF_S3_ENDPOINT" --region "$HF_S3_REGION" \
  s3 rm "s3://$HF_S3_BUCKET/$ops_prefix/" --recursive --only-show-errors
remaining_operations="$(object_count "$ops_prefix/")"
if [[ "$remaining_operations" != "0" ]]; then
  fail_qualification "S3_DELETE_VERIFICATION_FAILED" "Delete verification failed for the isolated operations prefix."
fi
s3_compatibility_json='{
  "status": "pass",
  "listObjectsV2": true,
  "put": true,
  "get": true,
  "delete": true,
  "multipart": true,
  "conditionalPut": true,
  "pathStyle": true,
  "prefixIsolation": true,
  "retryRecovery": false
}'
set_report_test "s3Compatibility" "$s3_compatibility_json"

set_report_stage "testA"
echo "qualification.test_a=starting"
node "$database_script" seed "$database_path" 1 >/dev/null
replicate_once
restore_latest
test_a_verify_json="$(node "$database_script" verify "$database_path" 1)"
test_a_restore_ms="$RESTORE_DURATION_MS"
test_a_json="$(jq -n \
  --argjson restoreMs "$test_a_restore_ms" \
  --argjson evidence "$test_a_verify_json" \
  '{
    status: "pass",
    restoreMs: $restoreMs,
    generation: $evidence.generation,
    quickCheck: $evidence.quickCheck,
    foreignKeyFailures: $evidence.foreignKeyFailures,
    ledger: $evidence.ledger
  }')"
set_report_test "testA" "$test_a_json"

set_report_stage "testB"
echo "qualification.test_b=starting"
node "$database_script" write "$database_path" 2 >/dev/null
replicate_once
node "$database_script" write "$database_path" 3 >/dev/null
replicate_once
restore_latest
node "$database_script" verify "$database_path" 3 >/dev/null
test_b_restore_ms="$RESTORE_DURATION_MS"
test_b_json="$(jq -n \
  --argjson restoreMs "$test_b_restore_ms" \
  '{status: "pass", restoreMs: $restoreMs, finalGeneration: 3}')"
set_report_test "testB" "$test_b_json"

set_report_stage "testC"
echo "qualification.test_c=starting"
"$LITESTREAM_BIN" replicate -config "$config_path" \
  >"$work_root/abrupt.log" 2>&1 &
daemon_pid=$!
sleep 2
abrupt_commit_json="$(node "$database_script" write "$database_path" 4)"
abrupt_commit_ms="$(jq -r '.writtenAt' <<<"$abrupt_commit_json")"
sleep 0.05
abrupt_crash_ms="$(date +%s%3N)"
kill -KILL "$daemon_pid"
wait "$daemon_pid" 2>/dev/null || true
daemon_pid=""
restore_latest
abrupt_restore_json="$(node "$database_script" inspect "$database_path")"
abrupt_restore_ms="$RESTORE_DURATION_MS"
abrupt_generation="$(jq -r '.generation' <<<"$abrupt_restore_json")"
abrupt_restored_written_at="$(jq -r '.writtenAt' <<<"$abrupt_restore_json")"
if ((abrupt_generation < 3 || abrupt_generation > 4)); then
  fail_qualification "ABRUPT_RESTORE_GENERATION_INVALID" "Abrupt termination restored an unexpected generation."
fi
lost_committed_generations=$((4 - abrupt_generation))
latest_commit_recovered=false
if ((abrupt_generation == 4)); then latest_commit_recovered=true; fi
commit_to_crash_ms=$((abrupt_crash_ms - abrupt_commit_ms))
if ((commit_to_crash_ms < 0)); then commit_to_crash_ms=0; fi
restored_state_age_at_crash_ms=$((abrupt_crash_ms - abrupt_restored_written_at))
if ((restored_state_age_at_crash_ms < 0)); then restored_state_age_at_crash_ms=0; fi
test_c_json="$(jq -n \
  --argjson committedGeneration 4 \
  --argjson restoredGeneration "$abrupt_generation" \
  --argjson lostCommittedGenerations "$lost_committed_generations" \
  --argjson latestCommitRecovered "$latest_commit_recovered" \
  --argjson commitToCrashMs "$commit_to_crash_ms" \
  --argjson restoredStateAgeAtCrashMs "$restored_state_age_at_crash_ms" \
  --argjson measuredRpoMs "$restored_state_age_at_crash_ms" \
  --argjson restoreMs "$abrupt_restore_ms" \
  '{
    status: "pass",
    committedGeneration: $committedGeneration,
    restoredGeneration: $restoredGeneration,
    lostCommittedGenerations: $lostCommittedGenerations,
    latestCommitRecovered: $latestCommitRecovered,
    commitToCrashMs: $commitToCrashMs,
    restoredStateAgeAtCrashMs: $restoredStateAgeAtCrashMs,
    measuredRpoMs: $measuredRpoMs,
    restoreMs: $restoreMs,
    rpoInterpretation: "measuredRpoMs equals restoredStateAgeAtCrashMs. This is one observed crash result with sparse test writes. It is not a guaranteed maximum RPO and does not claim zero data loss."
  }')"
set_report_test "testC" "$test_c_json"

set_report_stage "testD"
echo "qualification.test_d=starting"
restart_generation_one=$((abrupt_generation + 1))
node "$database_script" write "$database_path" "$restart_generation_one" >/dev/null
replicate_once
restore_latest
node "$database_script" verify "$database_path" "$restart_generation_one" >/dev/null
restart_one_restore_ms="$RESTORE_DURATION_MS"
restart_generation_two=$((restart_generation_one + 1))
node "$database_script" write "$database_path" "$restart_generation_two" >/dev/null
replicate_once
restore_latest
node "$database_script" verify "$database_path" "$restart_generation_two" >/dev/null
restart_two_restore_ms="$RESTORE_DURATION_MS"
test_d_json="$(jq -n \
  --argjson firstRestoreMs "$restart_one_restore_ms" \
  --argjson secondRestoreMs "$restart_two_restore_ms" \
  --argjson firstGeneration "$restart_generation_one" \
  --argjson secondGeneration "$restart_generation_two" \
  '{
    status: "pass",
    firstRestoreMs: $firstRestoreMs,
    secondRestoreMs: $secondRestoreMs,
    firstGeneration: $firstGeneration,
    secondGeneration: $secondGeneration
  }')"
set_report_test "testD" "$test_d_json"

set_report_stage "retryRecovery"
echo "qualification.test_e.retry=starting"
retry_dir="$work_root/retry"
retry_db="$retry_dir/retry.db"
retry_config="$work_root/retry-litestream.yml"
retry_log="$work_root/retry.log"
retry_litestream_bin="$work_root/litestream-retry"
retry_process_control="$work_root/litestream-process-control.sh"
retry_pid_file="$retry_dir/litestream.pid"
mkdir -p "$retry_dir"
node "$database_script" seed "$retry_db" 1 >/dev/null
cp "$LITESTREAM_BIN" "$retry_litestream_bin"
chmod 755 "$retry_litestream_bin"
cp "$script_dir/hf-s3-litestream-process-control.sh" "$retry_process_control"
chmod 644 "$retry_process_control"
cat >"$retry_config" <<EOF
logging:
  level: info
dbs:
  - path: $retry_db
    replica:
      type: s3
      bucket: $HF_S3_BUCKET
      path: $prefix/retry
      endpoint: $HF_S3_ENDPOINT
      region: $HF_S3_REGION
      force-path-style: true
      sign-payload: true
      require-content-md5: false
EOF

initial_retry_objects="$(object_count "$prefix/retry/")"
if [[ "$initial_retry_objects" != "0" ]]; then
  fail_qualification "RETRY_PREFIX_NOT_EMPTY" "The exact retry prefix was not empty before the bounded outage test."
fi

retry_uid="$(id -u nobody)"
retry_gid="$(id -g nobody)"
chmod 711 "$work_root"
chmod 644 "$retry_config"
sudo chown -R "$retry_uid:$retry_gid" "$retry_dir"
install_network_rules

retry_handshake_nonce="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
if [[ ! "$retry_handshake_nonce" =~ ^[0-9a-f]{64}$ ]]; then
  fail_qualification "RETRY_HANDSHAKE_NONCE_GENERATION_FAILED" "Could not create the required 256-bit retry handshake nonce."
fi
ipv4_baseline_packets="$(rule_packet_count ipv4)"
ipv6_baseline_packets="$(rule_packet_count ipv6)"
outage_started_ms="$(date +%s%3N)"
sudo --preserve-env=AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_DEFAULT_REGION,AWS_REGION,AWS_REQUEST_CHECKSUM_CALCULATION,AWS_RESPONSE_CHECKSUM_VALIDATION,LITESTREAM_ACCESS_KEY_ID,LITESTREAM_SECRET_ACCESS_KEY \
  -u nobody -- bash -c '
    set -Eeuo pipefail
    source "$1"
    pid_file=$2
    nonce=$3
    shift 3
    write_pidfile_handshake "$pid_file" "$nonce"
    exec "$@"
  ' bash \
  "$retry_process_control" \
  "$retry_pid_file" \
  "$retry_handshake_nonce" \
  "$retry_litestream_bin" replicate -config "$retry_config" \
  >"$retry_log" 2>&1 &
daemon_wrapper_pid=$!

daemon_pid=""
if ! wait_for_pidfile_handshake \
  "$retry_pid_file" \
  "$retry_uid" \
  "$retry_handshake_nonce" \
  "$daemon_wrapper_pid" \
  10000 \
  200; then
  capture_retry_diagnostics "$(( $(date +%s%3N) - outage_started_ms ))" "" ""
  fail_qualification "RETRY_PIDFILE_HANDSHAKE_FAILED" "Litestream pidfile handshake did not validate within 10 seconds."
fi
daemon_pid="$PIDFILE_HANDSHAKE_PID"
pidfile_handshake_ms="$PIDFILE_HANDSHAKE_DURATION_MS"

initial_retry_pid="$daemon_pid"
initial_retry_identity="$PIDFILE_HANDSHAKE_START_IDENTITY"
if ! verify_retry_process_identity "$initial_retry_pid" "$initial_retry_identity"; then
  capture_retry_diagnostics "$(( $(date +%s%3N) - outage_started_ms ))" "$initial_retry_pid" "$initial_retry_identity"
  fail_qualification "$retry_identity_failure_code" "$retry_identity_failure_message"
fi
failure_observed_ms=""
first_rejected_packet_observed_at_ms=0
first_rejected_packet_family=""
failure_observation_duration_ms=0
minimum_outage_ms=0
outage_deadline_ms=$((outage_started_ms + 90000))
previous_ipv4_packet_count="$ipv4_baseline_packets"
previous_ipv6_packet_count="$ipv6_baseline_packets"

while true; do
  now_ms="$(date +%s%3N)"
  elapsed_ms=$((now_ms - outage_started_ms))
  if ! verify_retry_process_identity "$initial_retry_pid" "$initial_retry_identity"; then
    capture_retry_diagnostics "$elapsed_ms" "$initial_retry_pid" "$initial_retry_identity"
    fail_qualification "$retry_identity_failure_code" "$retry_identity_failure_message"
  fi
  current_retry_objects="$(object_count "$prefix/retry/")"
  if [[ "$current_retry_objects" != "0" ]]; then
    capture_retry_diagnostics "$elapsed_ms" "$initial_retry_pid" "$initial_retry_identity"
    fail_qualification "RETRY_OBJECT_CREATED_DURING_OUTAGE" "A retry replica object appeared while exact HF S3 traffic was blocked."
  fi
  current_ipv4_packet_count="$(rule_packet_count ipv4)"
  current_ipv6_packet_count="$(rule_packet_count ipv6)"
  if ((current_ipv4_packet_count < previous_ipv4_packet_count || current_ipv6_packet_count < previous_ipv6_packet_count)); then
    capture_retry_diagnostics "$elapsed_ms" "$initial_retry_pid" "$initial_retry_identity"
    fail_qualification "RETRY_PACKET_COUNTER_DECREASED" "An exact network-rule packet counter decreased during the outage window."
  fi
  previous_ipv4_packet_count="$current_ipv4_packet_count"
  previous_ipv6_packet_count="$current_ipv6_packet_count"
  ipv4_rejected_packets=$((current_ipv4_packet_count - ipv4_baseline_packets))
  ipv6_rejected_packets=$((current_ipv6_packet_count - ipv6_baseline_packets))
  if [[ -z "$failure_observed_ms" ]] && ((ipv4_rejected_packets + ipv6_rejected_packets > 0)); then
    failure_observed_ms="$now_ms"
    first_rejected_packet_observed_at_ms="$now_ms"
    failure_observation_duration_ms="$elapsed_ms"
    if ((ipv4_rejected_packets > 0)); then
      first_rejected_packet_family="ipv4"
    else
      first_rejected_packet_family="ipv6"
    fi
  fi
  if [[ -n "$failure_observed_ms" ]]; then
    minimum_outage_ms=$((now_ms - failure_observed_ms))
    if ((minimum_outage_ms >= 10000)); then
      break
    fi
  fi
  if ((now_ms >= outage_deadline_ms)); then
    capture_retry_diagnostics "$elapsed_ms" "$initial_retry_pid" "$initial_retry_identity"
    if [[ -z "$failure_observed_ms" ]]; then
      fail_qualification "RETRY_NETWORK_FAILURE_NOT_OBSERVED" "No exact Litestream network-rule packet rejection was observed within 90 seconds."
    fi
    fail_qualification "RETRY_MINIMUM_OUTAGE_NOT_COMPLETED" "The ten-second continuous outage window did not complete within the 90-second observation deadline."
  fi
  sleep 1
done

log_match=false
if grep -Eqi 'connection refused|network unreachable|i/o timeout|dial tcp|connection reset|TLS handshake timeout|request canceled|temporary failure|retry|backoff|error' "$retry_log"; then
  log_match=true
fi

if ! remove_network_rules; then
  capture_retry_diagnostics "$(( $(date +%s%3N) - outage_started_ms ))" "$initial_retry_pid" "$initial_retry_identity"
  fail_qualification "RETRY_NETWORK_RULE_REMOVAL_FAILED" "One or more exact qualification network rules could not be removed."
fi
if (( $(rule_packet_count ipv4) != 0 || $(rule_packet_count ipv6) != 0 )); then
  capture_retry_diagnostics "$(( $(date +%s%3N) - outage_started_ms ))" "$initial_retry_pid" "$initial_retry_identity"
  fail_qualification "RETRY_NETWORK_RULE_REMOVAL_UNVERIFIED" "Exact qualification network rules remained after unblock."
fi
if ! verify_retry_process_identity "$initial_retry_pid" "$initial_retry_identity"; then
  capture_retry_diagnostics "$(( $(date +%s%3N) - outage_started_ms ))" "$initial_retry_pid" "$initial_retry_identity"
  fail_qualification "$retry_identity_failure_code" "$retry_identity_failure_message"
fi

recovery_started_ms="$(date +%s%3N)"
recovery_deadline_ms=$((recovery_started_ms + 120000))
recovery_objects=0
while true; do
  now_ms="$(date +%s%3N)"
  if ! verify_retry_process_identity "$initial_retry_pid" "$initial_retry_identity"; then
    capture_retry_diagnostics "$((now_ms - outage_started_ms))" "$initial_retry_pid" "$initial_retry_identity"
    fail_qualification "$retry_identity_failure_code" "$retry_identity_failure_message"
  fi
  recovery_objects="$(object_count "$prefix/retry/")"
  if ((recovery_objects > 0)); then
    recovery_ms=$((now_ms - recovery_started_ms))
    break
  fi
  if ((now_ms >= recovery_deadline_ms)); then
    capture_retry_diagnostics "$((now_ms - outage_started_ms))" "$initial_retry_pid" "$initial_retry_identity"
    fail_qualification "RETRY_RECOVERY_TIMEOUT" "The same Litestream process did not create a replica object within 120 seconds after network recovery."
  fi
  sleep 1
done

terminate_retry_process
if ! remove_directory_with_permission_repair \
  "$retry_dir" \
  "$work_root" \
  "$(id -u)" \
  "$(id -g)"; then
  retry_directory_cleanup="fail"
  cleanup_permission_repair_applied="$DIRECTORY_CLEANUP_PERMISSION_REPAIR_APPLIED"
  capture_retry_diagnostics "$(( $(date +%s%3N) - outage_started_ms ))" "$initial_retry_pid" "$initial_retry_identity"
  fail_qualification "RETRY_DIRECTORY_CLEANUP_FAILED" "The exact retry directory could not be ownership-repaired and removed safely."
fi
retry_directory_cleanup="$DIRECTORY_CLEANUP_STATUS"
cleanup_permission_repair_applied="$DIRECTORY_CLEANUP_PERMISSION_REPAIR_APPLIED"
mkdir -p "$retry_dir"
retry_restore_started_ms="$(date +%s%3N)"
"$LITESTREAM_BIN" restore \
  -config "$retry_config" \
  -integrity-check quick \
  "$retry_db"
retry_restore_finished_ms="$(date +%s%3N)"
retry_restore_ms=$((retry_restore_finished_ms - retry_restore_started_ms))
retry_verify_json="$(node "$database_script" verify "$retry_db" 1)"

test_e_json="$(jq -n \
  --argjson failureObserved true \
  --arg failureEvidenceType "exact-owner-rule-packet-counter" \
  --argjson outageStartedAtMs "$outage_started_ms" \
  --argjson firstRejectedPacketObservedAtMs "$first_rejected_packet_observed_at_ms" \
  --argjson failureObservationMs "$failure_observation_duration_ms" \
  --argjson minimumOutageMs "$minimum_outage_ms" \
  --argjson processStayedAlive true \
  --argjson pidUnchanged true \
  --argjson processStartIdentityUnchanged true \
  --argjson ipv4RejectedPackets "$ipv4_rejected_packets" \
  --argjson ipv6RejectedPackets "$ipv6_rejected_packets" \
  --argjson recoveryMs "$recovery_ms" \
  --argjson restoreMs "$retry_restore_ms" \
  --argjson pidfileHandshakeMs "$pidfile_handshake_ms" \
  --argjson handshakeNonceValid "$PIDFILE_HANDSHAKE_NONCE_VALID" \
  --argjson handshakeUidValid "$PIDFILE_HANDSHAKE_UID_VALID" \
  --argjson handshakeStartIdentityValid "$PIDFILE_HANDSHAKE_START_IDENTITY_VALID" \
  --arg retryDirectoryCleanup "$retry_directory_cleanup" \
  --argjson cleanupPermissionRepairApplied "$cleanup_permission_repair_applied" \
  --arg firstRejectedPacketFamily "$first_rejected_packet_family" \
  --argjson gracefulTerminationMs "$retry_termination_ms" \
  --argjson evidence "$retry_verify_json" \
  --argjson logMatch "$log_match" \
  '{
    status: "pass",
    failureObserved: $failureObserved,
    failureEvidenceType: $failureEvidenceType,
    outageStartedAtMs: $outageStartedAtMs,
    firstRejectedPacketObservedAtMs: $firstRejectedPacketObservedAtMs,
    failureObservationMs: $failureObservationMs,
    minimumOutageMs: $minimumOutageMs,
    processStayedAlive: $processStayedAlive,
    pidUnchanged: $pidUnchanged,
    processStartIdentityUnchanged: $processStartIdentityUnchanged,
    ipv4RejectedPackets: $ipv4RejectedPackets,
    ipv6RejectedPackets: $ipv6RejectedPackets,
    recoveryMs: $recoveryMs,
    pidfileHandshakeMs: $pidfileHandshakeMs,
    handshakeNonceValid: $handshakeNonceValid,
    handshakeUidValid: $handshakeUidValid,
    handshakeStartIdentityValid: $handshakeStartIdentityValid,
    retryDirectoryCleanup: $retryDirectoryCleanup,
    cleanupPermissionRepairApplied: $cleanupPermissionRepairApplied,
    firstRejectedPacketFamily: $firstRejectedPacketFamily,
    gracefulTerminationMs: $gracefulTerminationMs,
    restoredGeneration: $evidence.generation,
    restoreMs: $restoreMs,
    restoreVerification: {
      quickCheck: $evidence.quickCheck,
      foreignKeyFailures: $evidence.foreignKeyFailures,
      ledger: $evidence.ledger,
      metadataVersion: $evidence.metadataVersion
    },
    supplementalLogMatch: $logMatch
  }')"
set_report_test "testE" "$test_e_json"
atomic_report '.tests.s3Compatibility.retryRecovery = true'

set_report_stage "finalization"
aws_cli_version="$(aws --version 2>&1 | awk '{print $1}')"
litestream_version="$($LITESTREAM_BIN version | awk '{print $NF}')"
atomic_report \
  --arg endpoint "$HF_S3_ENDPOINT" \
  --arg bucket "$HF_S3_BUCKET" \
  --arg awsCliVersion "$aws_cli_version" \
  --arg litestreamVersion "$litestream_version" \
  --arg litestreamSha256 "${LITESTREAM_SHA256:-not-provided}" \
  '.endpoint = $endpoint
    | .bucket = $bucket
    | .awsCliVersion = $awsCliVersion
    | .litestreamVersion = $litestreamVersion
    | .litestreamSha256 = $litestreamSha256
    | .status = "pass"
    | .currentStage = "complete"'
current_stage="complete"

jq . "$QUALIFICATION_REPORT_PATH"
