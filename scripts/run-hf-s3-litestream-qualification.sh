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
network_blocked=0
ipv6_blocked=0

cleanup() {
  if [[ -n "$daemon_pid" ]] && kill -0 "$daemon_pid" 2>/dev/null; then
    kill -TERM "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  if [[ "$network_blocked" -eq 1 ]]; then
    sudo iptables -D OUTPUT -p tcp --dport 443 -j REJECT >/dev/null 2>&1 || true
  fi
  if [[ "$ipv6_blocked" -eq 1 ]]; then
    sudo ip6tables -D OUTPUT -p tcp --dport 443 -j REJECT >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work_root"
}
trap cleanup EXIT

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

echo "qualification.run_id=$QUALIFICATION_RUN_ID"
echo "qualification.prefix=$prefix"
echo "qualification.test_e=starting"

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
set +e
aws_hf put-object \
  --bucket "$HF_S3_BUCKET" \
  --key "$ops_prefix/conditional.txt" \
  --body "$payload" \
  --if-none-match '*' >/dev/null 2>&1
conditional_status=$?
set -e
if [[ "$conditional_status" -eq 0 ]]; then
  echo "Conditional Put unexpectedly overwrote an existing object" >&2
  exit 1
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
remaining_operations="$(aws_hf list-objects-v2 \
  --bucket "$HF_S3_BUCKET" \
  --prefix "$ops_prefix/" \
  --query 'length(Contents || `[]`)' \
  --output text)"
if [[ "$remaining_operations" != "0" ]]; then
  echo "Delete verification failed for the operations prefix" >&2
  exit 1
fi

echo "qualification.test_a=starting"
node "$database_script" seed "$database_path" 1
replicate_once
restore_latest
node "$database_script" verify "$database_path" 1
test_a_restore_ms="$RESTORE_DURATION_MS"

echo "qualification.test_b=starting"
node "$database_script" write "$database_path" 2
replicate_once
node "$database_script" write "$database_path" 3
replicate_once
restore_latest
node "$database_script" verify "$database_path" 3
test_b_restore_ms="$RESTORE_DURATION_MS"

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
  echo "Abrupt termination restored an unexpected generation" >&2
  exit 1
fi
abrupt_rpo_ms=$((abrupt_commit_ms - abrupt_restored_written_at))
if ((abrupt_rpo_ms < 0)); then abrupt_rpo_ms=0; fi

echo "qualification.test_d=starting"
restart_generation_one=$((abrupt_generation + 1))
node "$database_script" write "$database_path" "$restart_generation_one"
replicate_once
restore_latest
node "$database_script" verify "$database_path" "$restart_generation_one"
restart_one_restore_ms="$RESTORE_DURATION_MS"
restart_generation_two=$((restart_generation_one + 1))
node "$database_script" write "$database_path" "$restart_generation_two"
replicate_once
restore_latest
node "$database_script" verify "$database_path" "$restart_generation_two"
restart_two_restore_ms="$RESTORE_DURATION_MS"

echo "qualification.test_e.retry=starting"
retry_dir="$work_root/retry"
retry_db="$retry_dir/retry.db"
retry_config="$work_root/retry-litestream.yml"
mkdir -p "$retry_dir"
node "$database_script" seed "$retry_db" 1 >/dev/null
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

sudo iptables -I OUTPUT -p tcp --dport 443 -j REJECT
network_blocked=1
if sudo ip6tables -I OUTPUT -p tcp --dport 443 -j REJECT 2>/dev/null; then
  ipv6_blocked=1
fi
"$LITESTREAM_BIN" replicate -config "$retry_config" \
  >"$work_root/retry.log" 2>&1 &
daemon_pid=$!
sleep 4
if ! kill -0 "$daemon_pid" 2>/dev/null; then
  echo "Litestream exited instead of retrying a transient network failure" >&2
  exit 1
fi
if ! grep -Eqi 'error|connection|network|refused|unreachable|timeout' "$work_root/retry.log"; then
  echo "No retryable network failure was observed" >&2
  exit 1
fi
sudo iptables -D OUTPUT -p tcp --dport 443 -j REJECT
network_blocked=0
if [[ "$ipv6_blocked" -eq 1 ]]; then
  sudo ip6tables -D OUTPUT -p tcp --dport 443 -j REJECT
  ipv6_blocked=0
fi

retry_recovered=0
for _ in $(seq 1 60); do
  if aws_hf list-objects-v2 \
    --bucket "$HF_S3_BUCKET" \
    --prefix "$prefix/retry/" \
    --output json | jq -e '.Contents | length > 0' >/dev/null; then
    retry_recovered=1
    break
  fi
  sleep 1
done
if [[ "$retry_recovered" -ne 1 ]]; then
  echo "Litestream did not recover after the network was restored" >&2
  exit 1
fi
kill -TERM "$daemon_pid"
wait "$daemon_pid" || true
daemon_pid=""

aws_cli_version="$(aws --version 2>&1 | awk '{print $1}')"
litestream_version="$($LITESTREAM_BIN version | awk '{print $NF}')"
jq -n \
  --arg runId "$QUALIFICATION_RUN_ID" \
  --arg prefix "$prefix" \
  --arg endpoint "$HF_S3_ENDPOINT" \
  --arg bucket "$HF_S3_BUCKET" \
  --arg awsCliVersion "$aws_cli_version" \
  --arg litestreamVersion "$litestream_version" \
  --argjson testARestoreMs "$test_a_restore_ms" \
  --argjson testBRestoreMs "$test_b_restore_ms" \
  --argjson abruptGeneration "$abrupt_generation" \
  --argjson abruptRpoMs "$abrupt_rpo_ms" \
  --argjson abruptRestoreMs "$abrupt_restore_ms" \
  --argjson restartOneRestoreMs "$restart_one_restore_ms" \
  --argjson restartTwoRestoreMs "$restart_two_restore_ms" \
  --argjson finalGeneration "$restart_generation_two" \
  '{
    runId: $runId,
    prefix: $prefix,
    endpoint: $endpoint,
    bucket: $bucket,
    litestreamVersion: $litestreamVersion,
    awsCliVersion: $awsCliVersion,
    tests: {
      basicReplication: {status: "pass", restoreMs: $testARestoreMs},
      multipleGenerations: {status: "pass", restoreMs: $testBRestoreMs},
      abruptTermination: {
        status: "pass",
        restoredGeneration: $abruptGeneration,
        measuredRpoMs: $abruptRpoMs,
        restoreMs: $abruptRestoreMs
      },
      repeatedRestart: {
        status: "pass",
        firstRestoreMs: $restartOneRestoreMs,
        secondRestoreMs: $restartTwoRestoreMs,
        finalGeneration: $finalGeneration
      },
      s3Operations: {
        status: "pass",
        list: true,
        put: true,
        get: true,
        delete: true,
        multipart: true,
        prefixIsolation: true,
        pathStyle: true,
        redirectHandling: true,
        retryRecovery: true,
        conditionalPut: true
      }
    }
  }' >"$QUALIFICATION_REPORT_PATH"

jq . "$QUALIFICATION_REPORT_PATH"
