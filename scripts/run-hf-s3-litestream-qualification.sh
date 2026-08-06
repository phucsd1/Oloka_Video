#!/usr/bin/env bash
set -Eeuo pipefail

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
rule_comment="oloka-litestream-${QUALIFICATION_RUN_ID}"
ipv4_rejected_packets=0
ipv6_rejected_packets=0
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

process_is_alive() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && ((pid > 1)) || return 1
  sudo kill -0 "$pid" 2>/dev/null
}

process_start_identity() {
  local pid="$1"
  local process_stat
  process_stat="$(<"/proc/$pid/stat")"
  process_stat="${process_stat#*) }"
  awk '{print $20}' <<<"$process_stat"
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
  trap - ERR
  set +e
  remove_network_rules
  if [[ -n "$daemon_pid" ]] && process_is_alive "$daemon_pid"; then
    sudo kill -TERM "$daemon_pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do
      process_is_alive "$daemon_pid" || break
      sleep 1
    done
    if process_is_alive "$daemon_pid"; then
      sudo kill -KILL "$daemon_pid" >/dev/null 2>&1 || true
    fi
  fi
  if [[ -n "$daemon_wrapper_pid" ]]; then
    wait "$daemon_wrapper_pid" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work_root"
  return "$original_status"
}

on_error() {
  local original_status=$?
  trap - ERR
  set +e
  finalize_failure_report "$original_status"
  exit "$original_status"
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
  local current_identity=""
  local ipv4_packets=0
  local ipv6_packets=0
  local replica_objects=-1
  if process_is_alive "$initial_pid"; then
    alive=true
    pid_unchanged=true
    current_identity="$(process_start_identity "$initial_pid" 2>/dev/null || true)"
    if [[ -n "$current_identity" && "$current_identity" == "$initial_identity" ]]; then
      identity_unchanged=true
    fi
  fi
  ipv4_packets="$(rule_packet_count ipv4 || printf '0')"
  ipv6_packets="$(rule_packet_count ipv6 || printf '0')"
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
    --argjson processIdentityUnchanged "$identity_unchanged" \
    --argjson ipv4RejectedPackets "$ipv4_packets" \
    --argjson ipv6RejectedPackets "$ipv6_packets" \
    --argjson replicaObjectCount "$replica_objects" \
    --arg logLines "$(sanitized_retry_logs)" \
    '{
      elapsedMs: $elapsedMs,
      processAlive: $processAlive,
      pidUnchanged: $pidUnchanged,
      processIdentityUnchanged: $processIdentityUnchanged,
      ipv4RejectedPackets: $ipv4RejectedPackets,
      ipv6RejectedPackets: $ipv6RejectedPackets,
      replicaObjectCount: $replicaObjectCount,
      sanitizedLitestreamLogLines: ($logLines | split("\n") | map(select(length > 0)))
    }')"
}

terminate_retry_process() {
  local deadline
  sudo kill -TERM "$daemon_pid"
  deadline=$(( $(date +%s) + 30 ))
  while process_is_alive "$daemon_pid"; do
    if (( $(date +%s) >= deadline )); then
      fail_qualification "RETRY_PROCESS_TERMINATION_TIMEOUT" "Litestream did not exit within 30 seconds after SIGTERM."
    fi
    sleep 1
  done
  if [[ -n "$daemon_wrapper_pid" ]]; then
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
abrupt_rpo_ms=$((abrupt_commit_ms - abrupt_restored_written_at))
if ((abrupt_rpo_ms < 0)); then abrupt_rpo_ms=0; fi
test_c_json="$(jq -n \
  --argjson committedGeneration 4 \
  --argjson restoredGeneration "$abrupt_generation" \
  --argjson measuredRpoMs "$abrupt_rpo_ms" \
  --argjson restoreMs "$abrupt_restore_ms" \
  '{
    status: "pass",
    committedGeneration: $committedGeneration,
    restoredGeneration: $restoredGeneration,
    measuredRpoMs: $measuredRpoMs,
    restoreMs: $restoreMs,
    rpoInterpretation: "Observed interval between the newest commit and the newest restored generation; this does not claim zero data loss."
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
mkdir -p "$retry_dir"
node "$database_script" seed "$retry_db" 1 >/dev/null
cp "$LITESTREAM_BIN" "$retry_litestream_bin"
chmod 755 "$retry_litestream_bin"
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

outage_started_ms="$(date +%s%3N)"
sudo --preserve-env=AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_DEFAULT_REGION,AWS_REGION,AWS_REQUEST_CHECKSUM_CALCULATION,AWS_RESPONSE_CHECKSUM_VALIDATION,LITESTREAM_ACCESS_KEY_ID,LITESTREAM_SECRET_ACCESS_KEY \
  -u nobody "$retry_litestream_bin" replicate -config "$retry_config" \
  >"$retry_log" 2>&1 &
daemon_wrapper_pid=$!

daemon_pid=""
process_discovery_deadline=$(( $(date +%s) + 10 ))
while [[ -z "$daemon_pid" ]]; do
  mapfile -t retry_pids < <(pgrep -u "$retry_uid" -x litestream || true)
  if [[ "${#retry_pids[@]}" -eq 1 ]]; then
    daemon_pid="${retry_pids[0]}"
    break
  fi
  if ! kill -0 "$daemon_wrapper_pid" 2>/dev/null || (( $(date +%s) >= process_discovery_deadline )); then
    capture_retry_diagnostics "$(( $(date +%s%3N) - outage_started_ms ))" "${retry_pids[0]:-0}" ""
    fail_qualification "RETRY_PROCESS_START_FAILED" "The isolated Litestream retry process did not start."
  fi
  sleep 1
done

initial_retry_pid="$daemon_pid"
initial_retry_identity="$(process_start_identity "$initial_retry_pid")"
failure_observed_ms=""
failure_observation_duration_ms=0
minimum_outage_ms=0
outage_deadline_ms=$((outage_started_ms + 90000))

while true; do
  now_ms="$(date +%s%3N)"
  elapsed_ms=$((now_ms - outage_started_ms))
  if ! process_is_alive "$initial_retry_pid"; then
    capture_retry_diagnostics "$elapsed_ms" "$initial_retry_pid" "$initial_retry_identity"
    fail_qualification "RETRY_PROCESS_EXITED_DURING_OUTAGE" "Litestream exited while HF S3 traffic was blocked."
  fi
  current_identity="$(process_start_identity "$initial_retry_pid")"
  if [[ "$current_identity" != "$initial_retry_identity" ]]; then
    capture_retry_diagnostics "$elapsed_ms" "$initial_retry_pid" "$initial_retry_identity"
    fail_qualification "RETRY_PROCESS_IDENTITY_CHANGED" "Litestream process identity changed during the bounded outage."
  fi
  current_retry_objects="$(object_count "$prefix/retry/")"
  if [[ "$current_retry_objects" != "0" ]]; then
    capture_retry_diagnostics "$elapsed_ms" "$initial_retry_pid" "$initial_retry_identity"
    fail_qualification "RETRY_OBJECT_CREATED_DURING_OUTAGE" "A retry replica object appeared while exact HF S3 traffic was blocked."
  fi
  ipv4_rejected_packets="$(rule_packet_count ipv4)"
  ipv6_rejected_packets="$(rule_packet_count ipv6)"
  if [[ -z "$failure_observed_ms" ]] && ((ipv4_rejected_packets + ipv6_rejected_packets > 0)); then
    failure_observed_ms="$now_ms"
    failure_observation_duration_ms="$elapsed_ms"
  fi
  if [[ -n "$failure_observed_ms" ]]; then
    minimum_outage_ms=$((now_ms - failure_observed_ms))
    if ((minimum_outage_ms >= 10000)); then
      break
    fi
  fi
  if ((now_ms >= outage_deadline_ms)); then
    capture_retry_diagnostics "$elapsed_ms" "$initial_retry_pid" "$initial_retry_identity"
    fail_qualification "RETRY_FAILURE_NOT_OBSERVED" "No rejected Litestream packet plus ten-second continuous outage window was observed within 90 seconds."
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
if ! process_is_alive "$initial_retry_pid"; then
  capture_retry_diagnostics "$(( $(date +%s%3N) - outage_started_ms ))" "$initial_retry_pid" "$initial_retry_identity"
  fail_qualification "RETRY_PROCESS_EXITED_BEFORE_RECOVERY" "Litestream exited before network recovery could be observed."
fi
if [[ "$(process_start_identity "$initial_retry_pid")" != "$initial_retry_identity" ]]; then
  capture_retry_diagnostics "$(( $(date +%s%3N) - outage_started_ms ))" "$initial_retry_pid" "$initial_retry_identity"
  fail_qualification "RETRY_PROCESS_IDENTITY_CHANGED" "Litestream process identity changed before network recovery."
fi

recovery_started_ms="$(date +%s%3N)"
recovery_deadline_ms=$((recovery_started_ms + 120000))
recovery_objects=0
while true; do
  now_ms="$(date +%s%3N)"
  if ! process_is_alive "$initial_retry_pid"; then
    capture_retry_diagnostics "$((now_ms - outage_started_ms))" "$initial_retry_pid" "$initial_retry_identity"
    fail_qualification "RETRY_PROCESS_EXITED_DURING_RECOVERY" "Litestream exited while waiting for same-process recovery."
  fi
  if [[ "$(process_start_identity "$initial_retry_pid")" != "$initial_retry_identity" ]]; then
    capture_retry_diagnostics "$((now_ms - outage_started_ms))" "$initial_retry_pid" "$initial_retry_identity"
    fail_qualification "RETRY_PROCESS_IDENTITY_CHANGED" "Litestream process identity changed during recovery."
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
rm -rf -- "$retry_dir"
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
  --arg failureEvidenceType "exact HF S3 destination and Litestream UID reject packet counters" \
  --argjson failureObservationMs "$failure_observation_duration_ms" \
  --argjson minimumOutageMs "$minimum_outage_ms" \
  --argjson processStayedAlive true \
  --argjson pidUnchanged true \
  --argjson processIdentityUnchanged true \
  --argjson ipv4RejectedPackets "$ipv4_rejected_packets" \
  --argjson ipv6RejectedPackets "$ipv6_rejected_packets" \
  --argjson recoveryMs "$recovery_ms" \
  --argjson restoreMs "$retry_restore_ms" \
  --argjson evidence "$retry_verify_json" \
  --argjson logMatch "$log_match" \
  '{
    status: "pass",
    failureObserved: $failureObserved,
    failureEvidenceType: $failureEvidenceType,
    failureObservationMs: $failureObservationMs,
    minimumOutageMs: $minimumOutageMs,
    processStayedAlive: $processStayedAlive,
    pidUnchanged: $pidUnchanged,
    processIdentityUnchanged: $processIdentityUnchanged,
    ipv4RejectedPackets: $ipv4RejectedPackets,
    ipv6RejectedPackets: $ipv6RejectedPackets,
    recoveryMs: $recoveryMs,
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
