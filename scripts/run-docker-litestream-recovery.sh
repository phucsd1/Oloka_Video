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
google_client_secret="docker-recovery-google-client-secret"
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
    -e OLOKA_GOOGLE_OIDC_ISSUER="https://accounts.google.com" \
    -e OLOKA_GOOGLE_CLIENT_ID="docker-recovery-client" \
    -e OLOKA_GOOGLE_CLIENT_SECRET="$google_client_secret" \
    -e OLOKA_PUBLIC_ORIGIN="https://oloka-recovery.example" \
    -e OLOKA_BOOTSTRAP_ADMIN_EMAIL="admin@oloka-recovery.example" \
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
     grep -Fq "$application_key" <<<"$logs" || \
     grep -Fq "$google_client_secret" <<<"$logs"; then
    echo "A test credential leaked into container logs" >&2
    return 1
  fi
  echo "boot_container=$container shutdown_seconds=$elapsed secret_scan=pass"
}

prepare_v5_database() {
  local local_volume="$1"
  docker run --rm --entrypoint node \
    -v "$local_volume:/var/lib/oloka" "$image" --input-type=module -e '
      import { mkdirSync, readFileSync } from "node:fs";
      import { createHash } from "node:crypto";
      import { DatabaseSync } from "node:sqlite";
      mkdirSync("/var/lib/oloka/database", { recursive: true });
      const path = "/var/lib/oloka/database/oloka.db";
      const database = new DatabaseSync(path);
      const v1 = readFileSync("/app/apps/server/migrations/0001-foundation-system-tables.sql");
      const v2 = readFileSync("/app/apps/server/migrations/0002-persistence-kernel.sql");
      const v3 = readFileSync("/app/apps/server/migrations/0003-identity-and-approval.sql");
      const v4 = readFileSync("/app/apps/server/migrations/0004-canonical-project.sql");
      const v5 = readFileSync("/app/apps/server/migrations/0005-private-assets.sql");
      database.exec(v1.toString("utf8"));
      database.exec(v2.toString("utf8"));
      database.prepare(`INSERT INTO schema_migrations
        (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
        VALUES (2, ?, ?, 2, 0, ?)`).run(
          "persistence-kernel",
          createHash("sha256").update(v2).digest("hex"),
          "slice-3a1-docker-fixture",
        );
      database.exec(v3.toString("utf8"));
      database.prepare(`INSERT INTO schema_migrations
        (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
        VALUES (3, ?, ?, 3, 0, ?)`).run(
          "identity-and-approval",
          createHash("sha256").update(v3).digest("hex"),
          "slice-3b-docker-fixture",
        );
      database.exec(v4.toString("utf8"));
      database.prepare(`INSERT INTO schema_migrations
        (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
        VALUES (4, ?, ?, 4, 0, ?)`).run(
          "canonical-project",
          createHash("sha256").update(v4).digest("hex"),
          "slice-3c-docker-fixture",
        );
      database.exec(v5.toString("utf8"));
      database.prepare(`INSERT INTO schema_migrations
        (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
        VALUES (5, ?, ?, 5, 0, ?)`).run(
          "private-assets",
          createHash("sha256").update(v5).digest("hex"),
          "slice-3d-docker-fixture",
        );
      database.close();
    '
}

seed_identity_state() {
  local container="$1"
  docker exec "$container" node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync("/var/lib/oloka/database/oloka.db");
    const now = Date.now();
    const adminId = "00000000-0000-4000-8000-000000000101";
    const memberId = "00000000-0000-4000-8000-000000000102";
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`INSERT INTO users
        (id, email_normalized, display_name, role, status, approved_at,
         created_at, updated_at, last_login_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
          adminId, "admin@oloka-recovery.example", "Recovery Admin",
          "admin", "active",
          now, now, now, now,
        );
      database.prepare(`INSERT INTO users
        (id, email_normalized, display_name, role, status,
         created_at, updated_at, last_login_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
          memberId, "member@oloka-recovery.example", "Recovery Member",
          "member", "pending",
          now, now, now,
        );
      const identity = database.prepare(`INSERT INTO oauth_identities
        (id, user_id, issuer, subject, email_at_link, email_verified,
         profile_json, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`);
      identity.run("00000000-0000-4000-8000-000000000111", adminId,
        "https://accounts.google.com", "recovery-admin-subject",
        "admin@oloka-recovery.example", "{}", now, now);
      identity.run("00000000-0000-4000-8000-000000000112", memberId,
        "https://accounts.google.com", "recovery-member-subject",
        "member@oloka-recovery.example", "{}", now, now);
      const session = database.prepare(`INSERT INTO sessions
        (id, user_id, token_hash_sha256, csrf_token_hash_sha256, status,
         created_at, last_seen_at, idle_expires_at, expires_at,
         user_agent_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      session.run("00000000-0000-4000-8000-000000000121", adminId,
        Buffer.alloc(32, 21), Buffer.alloc(32, 22), "active", now, now,
        now + 604800000, now + 2592000000, "Chrome; Linux; desktop");
      session.run("00000000-0000-4000-8000-000000000122", memberId,
        Buffer.alloc(32, 23), Buffer.alloc(32, 24), "active", now, now,
        now + 604800000, now + 2592000000, "Chrome; Linux; desktop");
      database.prepare(`INSERT INTO audit_events
        (id, sequence, actor_type, action, resource_type, resource_id,
         outcome, metadata_json, created_at)
        VALUES (?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM audit_events),
          ?, ?, ?, ?, ?, ?, ?)`).run(
          "00000000-0000-4000-8000-000000000131", "system",
          "admin.bootstrap", "user", adminId, "success",
          "{\"provider\":\"google\"}", now);
      database.exec("COMMIT");
      database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  '
}

transition_member_state() {
  local container="$1"
  docker exec "$container" node --input-type=module -e '
    import { randomUUID } from "node:crypto";
    import { pathToFileURL } from "node:url";
    import { SqliteSystemDatabase } from "/app/apps/server/dist/database/sqlite-system-database.js";
    import { AdminUserService } from "/app/apps/server/dist/identity/admin-user-service.js";
    import { decodeApplicationKey } from "/app/apps/server/dist/kernel/app-key.js";
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL("/var/lib/oloka/database/oloka.db").href,
    );
    await database.migrate();
    try {
      new AdminUserService(
        database.transactions,
        { now: () => Date.now() },
        { generate: () => randomUUID() },
        decodeApplicationKey(process.env.OLOKA_APP_KEY),
      ).transition(
        {
          sessionId: "00000000-0000-4000-8000-000000000121",
          user: {
            id: "00000000-0000-4000-8000-000000000101",
            email: "admin@oloka-recovery.example",
            displayName: "Recovery Admin",
            avatarUrl: null,
            role: "admin",
            status: "active",
            version: 1,
          },
        },
        "00000000-0000-4000-8000-000000000102",
        {
          status: "active",
          version: 1,
          reason: "Docker restart persistence qualification",
        },
        "docker-recovery-approve-member",
      );
    } finally {
      await database.close();
    }
  '
}

create_project_state() {
  local container="$1"
  docker exec "$container" node --input-type=module -e '
    import { randomUUID } from "node:crypto";
    import { pathToFileURL } from "node:url";
    import { SqliteSystemDatabase } from "/app/apps/server/dist/database/sqlite-system-database.js";
    import { ProjectService } from "/app/apps/server/dist/project/project-service.js";
    import { decodeApplicationKey } from "/app/apps/server/dist/kernel/app-key.js";
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL("/var/lib/oloka/database/oloka.db").href,
    );
    await database.migrate();
    try {
      const actor = {
        sessionId: "00000000-0000-4000-8000-000000000121",
        user: {
          id: "00000000-0000-4000-8000-000000000101",
          email: "admin@oloka-recovery.example",
          displayName: "Recovery Admin",
          avatarUrl: null,
          role: "admin",
          status: "active",
          version: 1,
        },
      };
      const service = new ProjectService({
        transactions: database.transactions,
        applicationKey: decodeApplicationKey(process.env.OLOKA_APP_KEY),
        clock: { now: () => Date.now() },
        idGenerator: { generate: () => randomUUID() },
      });
      const created = service.create(
        actor,
        { name: "Recovery Project", description: "Three boot witness" },
        "docker-recovery-create-project",
      ).project;
      service.update(
        actor,
        created.id,
        { name: "Recovery Project Updated", favorite: true, expectedVersion: 1 },
        "docker-recovery-update-project",
      );
    } finally {
      await database.close();
    }
  '
}

soft_delete_project() {
  local container="$1"
  docker exec "$container" node --input-type=module -e '
    import { randomUUID } from "node:crypto";
    import { pathToFileURL } from "node:url";
    import { SqliteSystemDatabase } from "/app/apps/server/dist/database/sqlite-system-database.js";
    import { ProjectService } from "/app/apps/server/dist/project/project-service.js";
    import { decodeApplicationKey } from "/app/apps/server/dist/kernel/app-key.js";
    const database = await SqliteSystemDatabase.connect(pathToFileURL("/var/lib/oloka/database/oloka.db").href);
    await database.migrate();
    try {
      const row = database.transactions.run("read", ({ database }) => database.prepare("SELECT id, version FROM projects").get());
      const actor = { sessionId: "00000000-0000-4000-8000-000000000121", user: { id: "00000000-0000-4000-8000-000000000101", email: "admin@oloka-recovery.example", displayName: "Recovery Admin", avatarUrl: null, role: "admin", status: "active", version: 1 } };
      new ProjectService({ transactions: database.transactions, applicationKey: decodeApplicationKey(process.env.OLOKA_APP_KEY), clock: { now: () => Date.now() }, idGenerator: { generate: () => randomUUID() } }).softDelete(actor, row.id, row.version, "docker-recovery-delete-project");
    } finally { await database.close(); }
  '
}

restore_project() {
  local container="$1"
  docker exec "$container" node --input-type=module -e '
    import { randomUUID } from "node:crypto";
    import { pathToFileURL } from "node:url";
    import { SqliteSystemDatabase } from "/app/apps/server/dist/database/sqlite-system-database.js";
    import { ProjectService } from "/app/apps/server/dist/project/project-service.js";
    import { decodeApplicationKey } from "/app/apps/server/dist/kernel/app-key.js";
    const database = await SqliteSystemDatabase.connect(pathToFileURL("/var/lib/oloka/database/oloka.db").href);
    await database.migrate();
    try {
      const row = database.transactions.run("read", ({ database }) => database.prepare("SELECT id, status, version FROM projects").get());
      if (row.status !== "soft_deleted") process.exit(1);
      const actor = { sessionId: "00000000-0000-4000-8000-000000000121", user: { id: "00000000-0000-4000-8000-000000000101", email: "admin@oloka-recovery.example", displayName: "Recovery Admin", avatarUrl: null, role: "admin", status: "active", version: 1 } };
      new ProjectService({ transactions: database.transactions, applicationKey: decodeApplicationKey(process.env.OLOKA_APP_KEY), clock: { now: () => Date.now() }, idGenerator: { generate: () => randomUUID() } }).restore(actor, row.id, row.version, "docker-recovery-restore-project");
    } finally { await database.close(); }
  '
}

seed_asset_job_state() {
  local container="$1"
  docker exec "$container" node --input-type=module -e '
    import { mkdirSync, writeFileSync } from "node:fs";
    import { createHash, randomUUID } from "node:crypto";
    import { DatabaseSync } from "node:sqlite";
    import { pathToFileURL } from "node:url";
    import { SqliteSystemDatabase } from "/app/apps/server/dist/database/sqlite-system-database.js";
    import { JobRepository } from "/app/apps/server/dist/job/job-repository.js";
    const database = new DatabaseSync("/var/lib/oloka/database/oloka.db");
    const now = Date.now();
    const claimNow = now + 60_000;
    const userId = "00000000-0000-4000-8000-000000000101";
    const project = database.prepare("SELECT id FROM projects ORDER BY id LIMIT 1").get();
    if (!project) process.exit(1);
    const assetId = "00000000-0000-4000-8000-000000000201";
    const jobId = "00000000-0000-4000-8000-000000000202";
    const stepId = "00000000-0000-4000-8000-000000000203";
    const bytes = Buffer.from("oloka-durable-asset-job-fixture-v1", "utf8");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    let preClaim;
    mkdirSync("/data/recovery/assets", { recursive: true });
    writeFileSync("/data/recovery/assets/recovery-asset.mp4", bytes, { flag: "wx" });
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`INSERT INTO assets
        (id, project_id, owner_user_id, original_filename, kind, storage_key,
         byte_size, byte_checksum_sha256, metadata_json, ingestion_status, lifecycle_status,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          assetId, project.id, userId, "recovery-asset.mp4", "video",
          "recovery/assets/recovery-asset.mp4", bytes.length, checksum, "{}",
          "processing", "active", now, now,
        );
      database.prepare(`INSERT INTO jobs
        (id, project_id, owner_user_id, type, status, request_json, current_step_key,
         attempt_count, max_attempts, available_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          jobId, project.id, userId, "asset_ingestion", "queued",
          JSON.stringify({ schemaVersion: 1, assetId }), "inspect_asset", 0, 3,
          claimNow, now, now,
        );
      database.prepare(`INSERT INTO job_steps
        (id, job_id, step_key, item_key, status, attempt_count, max_attempts,
         available_at, input_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          stepId, jobId, "inspect_asset", "", "pending", 0, 3, claimNow,
          JSON.stringify({ schemaVersion: 1, assetId }), now, now,
        );
      const append = database.prepare("INSERT INTO job_events (id, job_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      append.run("00000000-0000-4000-8000-000000000204", jobId, 1, "job.queued", JSON.stringify({ schemaVersion: 1, jobId, status: "queued" }), now);
      database.exec("COMMIT");
      preClaim = database.prepare(`SELECT
        j.status AS jobStatus, s.status AS stepStatus,
        j.attempt_count AS jobAttemptCount, s.attempt_count AS stepAttemptCount,
        j.lease_owner AS jobLeaseOwner, s.lease_owner AS stepLeaseOwner,
        (SELECT GROUP_CONCAT(sequence, char(44)) FROM job_events WHERE job_id = j.id ORDER BY sequence) AS eventSequences
        FROM jobs j JOIN job_steps s ON s.job_id = j.id WHERE j.id = ?`).get(jobId);
      if (preClaim.jobStatus !== "queued" || preClaim.stepStatus !== "pending" ||
          preClaim.jobAttemptCount !== 0 || preClaim.stepAttemptCount !== 0 ||
          preClaim.jobLeaseOwner !== null || preClaim.stepLeaseOwner !== null ||
          preClaim.eventSequences !== "1") throw new Error("Boot 1 pre-claim evidence invalid");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
    const canonical = await SqliteSystemDatabase.connect(pathToFileURL("/var/lib/oloka/database/oloka.db").href);
    const repository = new JobRepository({ generate: () => randomUUID() });
    let claim;
    let claimedState;
    try {
      claim = canonical.transactions.run("immediate", (context) => repository.claimNext(context, {
        leaseOwner: "worker-A",
        now: claimNow,
        leaseDurationMs: 1_000,
      }));
      if (!claim || claim.jobId !== jobId || claim.stepId !== stepId || claim.attemptCount !== 1) {
        throw new Error("canonical worker-A claim failed");
      }
      claimedState = canonical.transactions.run("read", ({ database }) => database.prepare(`SELECT
        j.status AS jobStatus, s.status AS stepStatus, j.lease_owner AS leaseOwner,
        j.attempt_count AS attemptCount, j.version AS jobVersion, s.version AS stepVersion,
        (SELECT GROUP_CONCAT(sequence, char(44)) FROM job_events WHERE job_id = j.id ORDER BY sequence) AS eventSequences,
        (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = j.id AND topic = ?) AS stateOutbox
        FROM jobs j JOIN job_steps s ON s.job_id = j.id WHERE j.id = ?`).get("job.state.changed", jobId));
      if (claimedState.jobStatus !== "running" || claimedState.stepStatus !== "running" ||
          claimedState.leaseOwner !== "worker-A" || claimedState.attemptCount !== 1 ||
          claimedState.eventSequences !== "1,2,3" || claimedState.stateOutbox !== 1) {
        throw new Error("canonical worker-A claim evidence invalid");
      }
      canonical.transactions.run("immediate", ({ database }) =>
        database.prepare(`INSERT INTO outbox_events
          (id, topic, aggregate_type, aggregate_id, payload_json, status,
           available_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
            "00000000-0000-4000-8000-000000000205",
            "job.state.changed",
            "job",
            jobId,
            JSON.stringify({ schemaVersion: 1, jobId, status: "running" }),
            "pending",
            Date.now() + 60_000,
            Date.now(),
          ),
      );
    } finally {
      await canonical.close();
    }
    writeFileSync("/data/recovery/boot1-job-evidence.json", JSON.stringify({
      assetId, jobId, stepId, checksum,
      preClaim,
      jobStatus: claimedState.jobStatus, stepStatus: claimedState.stepStatus,
      attemptCount: claimedState.attemptCount, jobVersion: claim.jobVersion,
      stepVersion: claim.stepVersion, leaseOwner: claim.leaseOwner,
      leaseExpiresAt: claim.leaseExpiresAt, eventSequences: claimedState.eventSequences,
      eventMaxSequence: 3, stateOutbox: claimedState.stateOutbox,
    }), { flag: "w" });
  '
}

release_recovered_outbox_backlog() {
  local container="$1"
  docker exec "$container" node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync("/var/lib/oloka/database/oloka.db");
    const id = "00000000-0000-4000-8000-000000000205";
    const restored = database.prepare(
      "SELECT status, attempt_count FROM outbox_events WHERE id = ?",
    ).get(id);
    if (!restored || restored.status !== "pending" || restored.attempt_count !== 0) {
      throw new Error("Boot 2 did not restore the pending outbox backlog");
    }
    database.prepare("UPDATE outbox_events SET available_at = 0 WHERE id = ?").run(id);
    database.close();
    process.stdout.write("restored_outbox_backlog=pending released_for_runtime=pass\n");
  '
}

wait_for_recovered_outbox_backlog() {
  local container="$1"
  for _ in $(seq 1 30); do
    if docker exec "$container" node --input-type=module -e '
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync("/var/lib/oloka/database/oloka.db", { readOnly: true });
      const row = database.prepare(
        "SELECT status, attempt_count FROM outbox_events WHERE id = ?",
      ).get("00000000-0000-4000-8000-000000000205");
      database.close();
      if (!row || row.status !== "published" || row.attempt_count !== 1) process.exit(1);
    '; then
      echo "restored_outbox_backlog=published attempt_count=1"
      return 0
    fi
    sleep 1
  done
  echo "Recovered outbox backlog was not published by the application runtime" >&2
  return 1
}

recover_asset_job_boot2() {
  local container="$1"
  docker exec "$container" node --input-type=module -e '
    import { randomUUID } from "node:crypto";
    import { readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    import { SqliteSystemDatabase } from "/app/apps/server/dist/database/sqlite-system-database.js";
    import { JobRepository } from "/app/apps/server/dist/job/job-repository.js";
    const database = await SqliteSystemDatabase.connect(pathToFileURL("/var/lib/oloka/database/oloka.db").href);
    const repository = new JobRepository({ generate: () => randomUUID() });
    const ids = { assetId: "00000000-0000-4000-8000-000000000201", jobId: "00000000-0000-4000-8000-000000000202", stepId: "00000000-0000-4000-8000-000000000203" };
    const boot1 = JSON.parse(readFileSync("/data/recovery/boot1-job-evidence.json", "utf8"));
    try {
      const restored = database.transactions.run("read", ({ database }) => database.prepare(`SELECT
        j.status AS jobStatus, s.status AS stepStatus, j.lease_owner AS leaseOwner,
        j.attempt_count AS attemptCount, j.version AS jobVersion, s.version AS stepVersion,
        (SELECT GROUP_CONCAT(sequence, char(44)) FROM job_events WHERE job_id = j.id ORDER BY sequence) AS eventSequences
        FROM jobs j JOIN job_steps s ON s.job_id = j.id WHERE j.id = ?`).get(ids.jobId));
      if (restored.jobStatus !== boot1.jobStatus || restored.stepStatus !== boot1.stepStatus ||
          restored.leaseOwner !== boot1.leaseOwner || restored.attemptCount !== boot1.attemptCount ||
          restored.jobVersion !== boot1.jobVersion || restored.stepVersion !== boot1.stepVersion ||
          restored.eventSequences !== boot1.eventSequences) throw new Error("Boot 2 did not restore exact worker-A claim");
      const now = boot1.leaseExpiresAt + 1;
      database.transactions.run("immediate", (context) => repository.reconcile(context, now));
      const claim = database.transactions.run("immediate", (context) => repository.claimNext(context, { leaseOwner: "worker-B", now: now + 1, leaseDurationMs: 60_000 }));
      if (!claim || claim.jobId !== ids.jobId) throw new Error("worker-B did not claim recovered Job");
      let stale = "VERSION_CONFLICT";
      try {
        database.transactions.run("immediate", (context) => repository.completeAssetIngestion(context, { ...ids, leaseOwner: boot1.leaseOwner, expectedJobVersion: boot1.jobVersion, expectedStepVersion: boot1.stepVersion, now: now + 2 }));
        stale = "INCORRECTLY_ACCEPTED";
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("job_lease_conflict")) throw error;
      }
      const progress = database.transactions.run("immediate", (context) => repository.reportProgress(context, { ...ids, leaseOwner: "worker-B", expectedJobVersion: claim.jobVersion, expectedStepVersion: claim.stepVersion, progressBasisPoints: 5_000, now: now + 3 }));
      database.transactions.run("immediate", (context) => repository.completeAssetIngestion(context, { ...ids, leaseOwner: "worker-B", expectedJobVersion: progress.jobVersion, expectedStepVersion: progress.stepVersion, now: now + 4 }));
      database.transactions.run("immediate", ({ database }) => database.prepare("INSERT OR REPLACE INTO system_metadata (key, value_json, updated_at, version) VALUES (?, ?, ?, COALESCE((SELECT version FROM system_metadata WHERE key = ?), 0) + 1)").run("recovery.job.evidence", JSON.stringify({ staleWorkerA: stale, workerB: "completed" }), now + 4, "recovery.job.evidence"));
      if (stale !== "VERSION_CONFLICT") throw new Error("stale worker A was not rejected");
      process.stdout.write(`stale_worker_A=${stale} worker_B=completed job_id=${ids.jobId}\n`);
    } finally { await database.close(); }
  '
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
      const users = db.prepare("SELECT id, role, status, version FROM users ORDER BY id").all();
      const identities = db.prepare("SELECT id, user_id, issuer, email_verified FROM oauth_identities ORDER BY id").all();
      const sessions = db.prepare("SELECT id, user_id, status, revoke_reason FROM sessions ORDER BY id").all();
      const projects = db.prepare("SELECT id, owner_user_id, name, favorite, status, version, deleted_at, purge_after FROM projects ORDER BY id").all();
      const assets = db.prepare("SELECT id, project_id, owner_user_id, byte_size, byte_checksum_sha256, ingestion_status, lifecycle_status FROM assets ORDER BY id").all();
      const jobs = db.prepare("SELECT id, type, status, owner_user_id, progress_basis_points, attempt_count, lease_owner, lease_expires_at, version FROM jobs ORDER BY id").all();
      const steps = db.prepare("SELECT id, job_id, status, attempt_count, lease_owner, lease_expires_at, version FROM job_steps ORDER BY id").all();
      const jobEvents = db.prepare("SELECT job_id, MAX(sequence) AS max_sequence, GROUP_CONCAT(sequence, char(44)) AS sequences FROM job_events GROUP BY job_id").all();
      const outboxBacklog = db.prepare("SELECT status, attempt_count, last_error_code FROM outbox_events WHERE id = ?").get("00000000-0000-4000-8000-000000000205");
      db.close();
      process.stdout.write(JSON.stringify({ quickCheck, foreignKeyFailures, ledger, coreTables, litestreamTables, users, identities, sessions, projects, assets, jobs, steps, jobEvents, outboxBacklog, metadataVersion: metadata.version, witness: JSON.parse(metadata.value_json) }));
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
  -e OLOKA_GOOGLE_OIDC_ISSUER="https://accounts.google.com" \
  -e OLOKA_GOOGLE_CLIENT_ID="docker-recovery-client" \
  -e OLOKA_GOOGLE_CLIENT_SECRET="$google_client_secret" \
  -e OLOKA_PUBLIC_ORIGIN="https://oloka-recovery.example" \
  -e OLOKA_BOOTSTRAP_ADMIN_EMAIL="admin@oloka-recovery.example" \
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
terminal_event_sequences=""
for boot in 1 2 3; do
  local_volume="oloka-recovery-local-$boot-$run_id"
  volumes+=("$local_volume")
  docker volume create "$local_volume" >/dev/null
  mode="restore-required"
  if [ "$boot" -eq 1 ]; then mode="fresh-if-replica-missing"; fi
  if [ "$boot" -eq 1 ]; then prepare_v5_database "$local_volume"; fi
  restore_started_at="$(date +%s)"
  container="$(start_boot "$boot" "$mode" "$local_volume")"
  restore_finished_at="$(date +%s)"
  restore_duration=$((restore_finished_at - restore_started_at))
  if [ "$restore_duration" -gt 120 ]; then echo "restore exceeded 120 seconds" >&2; exit 1; fi
  if [ "$boot" -eq 1 ]; then seed_identity_state "$container"; create_project_state "$container"; seed_asset_job_state "$container"; fi
  if [ "$boot" -eq 2 ]; then release_recovered_outbox_backlog "$container"; transition_member_state "$container"; soft_delete_project "$container"; recover_asset_job_boot2 "$container"; wait_for_recovered_outbox_backlog "$container"; fi
  if [ "$boot" -eq 3 ]; then restore_project "$container"; fi
  wait_for_replica
  boot_replica_objects="$(mc "ls --recursive ci/$bucket/$prefix | wc -l" | tr -d '[:space:]')"
  stop_boot "$container"
  evidence="$(inspect_database "$local_volume")"
  echo "boot_evidence=$evidence"
  startup_count="$(docker run --rm -i --entrypoint node "$image" --input-type=commonjs -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(d.witness.startupCount))' <<<"$evidence")"
  current_first_started_at="$(docker run --rm -i --entrypoint node "$image" --input-type=commonjs -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(d.witness.firstStartedAt))' <<<"$evidence")"
  current_ledger="$(docker run --rm -i --entrypoint node "$image" --input-type=commonjs -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(JSON.stringify(d.ledger))' <<<"$evidence")"
  current_job_sequences="$(docker run --rm -i --entrypoint node "$image" --input-type=commonjs -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(d.jobEvents[0].sequences))' <<<"$evidence")"
  test "$startup_count" = "$boot"
  docker run --rm -i --entrypoint node "$image" --input-type=commonjs -e '
    const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
    const boot=Number(process.argv[1]);
    const expectedTables=["assets","audit_events","delivery_capabilities","idempotency_records","job_events","job_steps","jobs","oauth_identities","oauth_transactions","outbox_events","projects","provider_credential_references","quota_policies","quota_reservations","schema_migrations","sessions","system_metadata","upload_sessions","users"];
    const expectedMemberStatus=boot === 1 ? "pending" : "active";
    const expectedMemberSession=boot === 1 ? "active" : "revoked";
    const valid=d.metadataVersion === d.witness.startupCount && d.quickCheck === "ok" && d.foreignKeyFailures === 0 &&
      JSON.stringify(d.ledger.map(row=>row.version)) === JSON.stringify([1,2,3,4,5,6]) &&
      JSON.stringify(d.ledger.map(row=>row.name)) === JSON.stringify(["foundation_system_tables","persistence-kernel","identity-and-approval","canonical-project","private-assets","durable-job-kernel"]) &&
      JSON.stringify(d.coreTables) === JSON.stringify(expectedTables) &&
      JSON.stringify(d.litestreamTables) === JSON.stringify(["_litestream_lock","_litestream_seq"]) &&
      d.identities.length === 2 && d.users.length === 2 && d.sessions.length === 2 &&
      d.users[0].role === "admin" && d.users[0].status === "active" &&
      d.users[1].status === expectedMemberStatus &&
      d.sessions[1].status === expectedMemberSession && d.projects.length === 1 &&
      d.projects[0].owner_user_id === d.users[0].id && d.projects[0].favorite === 1 &&
      d.projects[0].name === "Recovery Project Updated" && d.projects[0].version === boot + 1 &&
      d.projects[0].status === (boot === 2 ? "soft_deleted" : "active") &&
      (boot === 2 ? d.projects[0].deleted_at !== null && d.projects[0].purge_after !== null : d.projects[0].deleted_at === null && d.projects[0].purge_after === null) &&
      d.assets.length === 1 && d.assets[0].id === "00000000-0000-4000-8000-000000000201" &&
      d.assets[0].byte_checksum_sha256 && d.assets[0].lifecycle_status === "active" &&
      d.jobs.length === 1 && d.jobs[0].id === "00000000-0000-4000-8000-000000000202" &&
      d.steps.length === 1 && d.steps[0].id === "00000000-0000-4000-8000-000000000203" &&
      (boot === 1 ? d.outboxBacklog.status === "pending" && d.outboxBacklog.attempt_count === 0 :
        d.outboxBacklog.status === "published" && d.outboxBacklog.attempt_count === 1 && d.outboxBacklog.last_error_code === null) &&
      (boot === 1 ? d.jobs[0].status === "running" && d.jobs[0].attempt_count === 1 && d.jobs[0].lease_owner === "worker-A" && d.assets[0].ingestion_status === "processing" :
        d.jobs[0].status === "completed" && d.jobs[0].progress_basis_points === 10000 && d.jobs[0].attempt_count === 2 && d.steps[0].status === "completed" && d.assets[0].ingestion_status === "ready") &&
      (boot === 1 ? d.jobEvents[0].sequences === "1,2,3" : d.jobEvents[0].max_sequence >= 8);
    if (!valid) process.exit(1);
  ' "$boot" <<<"$evidence"
  if [ "$boot" -eq 1 ]; then
    first_started_at="$current_first_started_at"
    ledger_json="$current_ledger"
  else
    test "$current_first_started_at" = "$first_started_at"
    test "$current_ledger" = "$ledger_json"
  fi
  if [ "$boot" -eq 2 ]; then terminal_event_sequences="$current_job_sequences"; fi
  if [ "$boot" -eq 3 ]; then test "$current_job_sequences" = "$terminal_event_sequences"; fi
  echo "boot=$boot startup_count=$startup_count first_started_at=$current_first_started_at ledger_versions=1,2,3,4,5,6 project_persistence=pass identity_persistence=pass job_persistence=pass outbox_backlog_status=$(docker run --rm -i --entrypoint node "$image" --input-type=commonjs -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(d.outboxBacklog.status)' <<<"$evidence") event_sequences=$current_job_sequences replica_objects=$boot_replica_objects restore_seconds=$restore_duration restore_bound_seconds=120 quick_check=ok foreign_keys=0"
  docker rm "$container" >/dev/null
  docker volume rm "$local_volume" >/dev/null
done

docker run --rm --entrypoint node -v "$object_volume:/data" "$image" --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { createHash } from "node:crypto";
  const evidence = JSON.parse(readFileSync("/data/recovery/boot1-job-evidence.json", "utf8"));
  const bytes = readFileSync("/data/recovery/assets/recovery-asset.mp4");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== evidence.checksum || evidence.leaseOwner !== "worker-A" ||
      evidence.eventMaxSequence !== 3 || evidence.eventSequences !== "1,2,3" ||
      evidence.preClaim.jobStatus !== "queued" || evidence.preClaim.stepStatus !== "pending" ||
      evidence.preClaim.jobAttemptCount !== 0 || evidence.preClaim.stepAttemptCount !== 0 ||
      evidence.preClaim.jobLeaseOwner !== null || evidence.preClaim.stepLeaseOwner !== null ||
      evidence.preClaim.eventSequences !== "1" ||
      evidence.jobStatus !== "running" || evidence.stepStatus !== "running" ||
      evidence.attemptCount !== 1 || evidence.stateOutbox !== 1) process.exit(1);
  process.stdout.write(`durable_asset_checksum=${checksum} boot1_preclaim=queued/pending boot1_worker=worker-A event_sequences=1,2,3 state_outbox=1\n`);
'

docker run --rm --entrypoint node -v "$object_volume:/data" "$image" --input-type=module -e '
  import { readdir } from "node:fs/promises";
  import { join } from "node:path";
  import { verifyBackupDirectory } from "/app/apps/server/dist/database/pre-migration-backup.js";
  const root = "/data/backups/pre-migration";
  const entries = await readdir(root);
  if (entries.length !== 1) process.exit(1);
  const manifest = await verifyBackupDirectory(
    join(root, entries[0]),
    Buffer.from("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "base64url"),
  );
  if (manifest.sourceSchemaVersion !== 5 || manifest.targetSchemaVersion !== 6 ||
      JSON.stringify(manifest.migrationVersionsPending) !== JSON.stringify([6])) {
    process.exit(1);
  }
  process.stdout.write("verified_pre_migration_backup=v5-to-v6\n");
'
remaining_replica_objects="$(mc "ls --recursive ci/$bucket/$prefix | wc -l" | tr -d '[:space:]')"
test "$remaining_replica_objects" -gt 0
echo "replica_objects=$remaining_replica_objects single_verified_v6_backup=pass recovery_test=pass"
