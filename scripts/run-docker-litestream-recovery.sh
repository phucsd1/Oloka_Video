#!/usr/bin/env bash
set -euo pipefail

export MSYS_NO_PATHCONV=1

image="${1:?production image tag is required}"
run_id="${RECOVERY_RUN_ID:-local-$$}"
run_id="${run_id//[^a-zA-Z0-9_.-]/-}"
network="oloka-recovery-network-$run_id"
minio_container="oloka-recovery-minio-$run_id"
minio_volume="oloka-recovery-minio-data-$run_id"
object_volume="oloka-recovery-objects-$run_id"
bucket="oloka-recovery"
prefix="sqlite-replica/dev"
minio_image="quay.io/minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"
mc_image="quay.io/minio/mc@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3"
access_key="minio-ci-access"
secret_key="minio-ci-secret-value"
application_key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
containers=()
volumes=("$minio_volume" "$object_volume")

cleanup() {
  for boot in 1 2 3; do
    docker rm -f "oloka-recovery-boot-$boot-$run_id" >/dev/null 2>&1 || true
  done
  for container in "${containers[@]}"; do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
  docker rm -f "$minio_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  for volume in "${volumes[@]}"; do
    docker volume rm "$volume" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

mc() {
  docker run --rm --network "$network" --entrypoint /bin/sh "$mc_image" -c \
    "mc alias set ci http://$minio_container:9000 '$access_key' '$secret_key' >/dev/null 2>&1 && mc $*"
}

wait_for_minio() {
  for _ in $(seq 1 60); do
    if mc "ready ci >/dev/null 2>&1"; then return 0; fi
    sleep 1
  done
  echo "MinIO did not become ready" >&2
  return 1
}

wait_for_application() {
  local container="$1"
  for _ in $(seq 1 60); do
    if docker exec "$container" node -e \
      "fetch('http://127.0.0.1:7860/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]; then
      docker logs "$container" >&2
      return 1
    fi
    sleep 1
  done
  docker logs "$container" >&2
  echo "Application did not become ready" >&2
  return 1
}

wait_for_replica() {
  for _ in $(seq 1 60); do
    if [ "$(mc "ls --recursive ci/$bucket/$prefix 2>/dev/null | wc -l" | tr -d '[:space:]')" -gt 0 ]; then
      return 0
    fi
    sleep 1
  done
  echo "Litestream replica did not appear" >&2
  return 1
}

start_boot() {
  local boot="$1"
  local mode="$2"
  local local_volume="$3"
  local container="oloka-recovery-boot-$boot-$run_id"
  containers+=("$container")
  docker run -d --name "$container" --network "$network" \
    -e OLOKA_DATABASE_BOOTSTRAP_MODE="$mode" \
    -e HF_S3_ACCESS_KEY_ID="$access_key" \
    -e HF_S3_SECRET_ACCESS_KEY="$secret_key" \
    -e OLOKA_APP_KEY="$application_key" \
    -e HF_S3_ENDPOINT="http://$minio_container:9000" \
    -e HF_S3_REGION=us-east-1 \
    -e HF_S3_BUCKET="$bucket" \
    -e HF_S3_SQLITE_PREFIX="$prefix" \
    -v "$local_volume:/var/lib/oloka" \
    -v "$object_volume:/data" \
    "$image" >/dev/null
  wait_for_application "$container"
  docker exec "$container" node --input-type=module -e '
    const urls=["/api/health","/api/ready","/api/version"];
    const responses=await Promise.all(urls.map(path=>fetch(`http://127.0.0.1:7860${path}`)));
    if (responses.some(response=>response.status !== 200)) process.exit(1);
    const payloads=await Promise.all(responses.map(response=>response.json()));
    if (payloads[0].status !== "ok" || payloads[1].status !== "ready") process.exit(1);
    if (JSON.stringify(payloads).includes("/var/lib/oloka")) process.exit(1);
  '
  printf '%s' "$container"
}

stop_boot() {
  local container="$1"
  local started_at finished_at elapsed logs
  started_at="$(date +%s)"
  docker stop --time 20 "$container" >/dev/null
  finished_at="$(date +%s)"
  elapsed=$((finished_at - started_at))
  if [ "$elapsed" -gt 20 ]; then
    echo "Container shutdown exceeded the bounded grace period" >&2
    return 1
  fi
  logs="$(docker logs "$container" 2>&1)"
  grep -q 'graceful shutdown started' <<<"$logs"
  if grep -Fq "$access_key" <<<"$logs" || \
     grep -Fq "$secret_key" <<<"$logs" || \
     grep -Fq "$application_key" <<<"$logs"; then
    echo "A test credential leaked into container logs" >&2
    return 1
  fi
  echo "boot_container=$container shutdown_seconds=$elapsed secret_scan=pass"
}

inspect_database() {
  local local_volume="$1"
  docker run --rm --entrypoint node \
    -v "$local_volume:/var/lib/oloka" "$image" --input-type=module -e '
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync("/var/lib/oloka/database/oloka.db", { readOnly: true });
      const quickCheck = Object.values(db.prepare("PRAGMA quick_check").get())[0];
      const foreignKeyFailures = db.prepare("PRAGMA foreign_key_check").all().length;
      const ledger = db.prepare("SELECT version, name, checksum_sha256, applied_at FROM schema_migrations ORDER BY version").all();
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE ? ORDER BY name").all("table", "sqlite_%").map(row => row.name);
      const coreTables = tables.filter(name => !name.startsWith("_litestream_"));
      const litestreamTables = tables.filter(name => name.startsWith("_litestream_"));
      const metadata = db.prepare("SELECT value_json, version FROM system_metadata WHERE key = ?").get("deployment.runtime");
      db.close();
      process.stdout.write(JSON.stringify({ quickCheck, foreignKeyFailures, ledger, coreTables, litestreamTables, metadataVersion: metadata.version, witness: JSON.parse(metadata.value_json) }));
    '
}

docker network create "$network" >/dev/null
docker volume create "$minio_volume" >/dev/null
docker volume create "$object_volume" >/dev/null
docker run -d --name "$minio_container" --network "$network" \
  -e MINIO_ROOT_USER="$access_key" \
  -e MINIO_ROOT_PASSWORD="$secret_key" \
  -v "$minio_volume:/data" \
  "$minio_image" server /data --console-address :9001 >/dev/null
wait_for_minio
mc "mb --ignore-existing ci/$bucket >/dev/null"

missing_volume="oloka-recovery-missing-$run_id"
volumes+=("$missing_volume")
docker volume create "$missing_volume" >/dev/null
set +e
missing_output="$(docker run --rm --network "$network" \
  -e OLOKA_DATABASE_BOOTSTRAP_MODE=restore-required \
  -e HF_S3_ACCESS_KEY_ID="$access_key" \
  -e HF_S3_SECRET_ACCESS_KEY="$secret_key" \
  -e OLOKA_APP_KEY="$application_key" \
  -e HF_S3_ENDPOINT="http://$minio_container:9000" \
  -e HF_S3_BUCKET="$bucket" \
  -e HF_S3_SQLITE_PREFIX="$prefix" \
  -v "$missing_volume:/var/lib/oloka" \
  -v "$object_volume:/data" "$image" 2>&1)"
missing_exit=$?
set -e
if [ "$missing_exit" -eq 0 ] || ! grep -q 'DATABASE_BOOTSTRAP_FAILED' <<<"$missing_output"; then
  echo "restore-required did not fail closed for a missing replica" >&2
  exit 1
fi
echo "missing_replica_restore_required=fail_closed"

first_started_at=""
ledger_json=""
for boot in 1 2 3; do
  local_volume="oloka-recovery-local-$boot-$run_id"
  volumes+=("$local_volume")
  docker volume create "$local_volume" >/dev/null
  mode="restore-required"
  if [ "$boot" -eq 1 ]; then mode="fresh-if-replica-missing"; fi
  container="$(start_boot "$boot" "$mode" "$local_volume")"
  wait_for_replica
  stop_boot "$container"
  evidence="$(inspect_database "$local_volume")"
  echo "boot_evidence=$evidence"
  startup_count="$(docker run --rm -i --entrypoint node "$image" --input-type=commonjs -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(d.witness.startupCount))' <<<"$evidence")"
  current_first_started_at="$(docker run --rm -i --entrypoint node "$image" --input-type=commonjs -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(d.witness.firstStartedAt))' <<<"$evidence")"
  current_ledger="$(docker run --rm -i --entrypoint node "$image" --input-type=commonjs -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(JSON.stringify(d.ledger))' <<<"$evidence")"
  test "$startup_count" = "$boot"
  docker run --rm -i --entrypoint node "$image" --input-type=commonjs -e '
    const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
    const expectedTables=["audit_events","idempotency_records","outbox_events","schema_migrations","system_metadata","users"];
    const valid=d.metadataVersion === d.witness.startupCount && d.quickCheck === "ok" && d.foreignKeyFailures === 0 &&
      JSON.stringify(d.ledger.map(row=>row.version)) === JSON.stringify([1,2]) &&
      JSON.stringify(d.ledger.map(row=>row.name)) === JSON.stringify(["foundation_system_tables","persistence-kernel"]) &&
      JSON.stringify(d.coreTables) === JSON.stringify(expectedTables) &&
      JSON.stringify(d.litestreamTables) === JSON.stringify(["_litestream_lock","_litestream_seq"]);
    if (!valid) process.exit(1);
  ' <<<"$evidence"
  if [ "$boot" -eq 1 ]; then
    first_started_at="$current_first_started_at"
    ledger_json="$current_ledger"
  else
    test "$current_first_started_at" = "$first_started_at"
    test "$current_ledger" = "$ledger_json"
  fi
  echo "boot=$boot startup_count=$startup_count first_started_at=$current_first_started_at ledger_versions=1,2 quick_check=ok foreign_keys=0"
  docker rm "$container" >/dev/null
  docker volume rm "$local_volume" >/dev/null
done

docker run --rm --entrypoint sh -v "$object_volume:/data" "$image" -c \
  'test ! -d /data/backups/pre-migration'
remaining_replica_objects="$(mc "ls --recursive ci/$bucket/$prefix | wc -l" | tr -d '[:space:]')"
test "$remaining_replica_objects" -gt 0
echo "replica_objects=$remaining_replica_objects no_pending_migration_backup=pass recovery_test=pass"
