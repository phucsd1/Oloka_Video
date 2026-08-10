import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const data = workerData as {
  barrier: SharedArrayBuffer;
  databasePath: string;
  leaseOwner: string;
};
const barrier = new Int32Array(data.barrier);
const database = new DatabaseSync(data.databasePath);
database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
Atomics.add(barrier, 0, 1);
Atomics.notify(barrier, 0);
Atomics.wait(barrier, 1, 0);
try {
  const now = 2_000;
  const leaseOwner = data.leaseOwner;
  const leaseExpiresAt = now + 60_000;
  database.exec("BEGIN IMMEDIATE");
  const candidate = database
    .prepare(
      `SELECT j.id AS job_id, j.version AS job_version, j.attempt_count,
              s.id AS step_id, s.version AS step_version
       FROM jobs j JOIN job_steps s ON s.job_id = j.id AND s.parent_step_id IS NULL
       WHERE j.type = 'asset_ingestion' AND j.status = 'queued' AND j.available_at <= ?
         AND s.status = 'pending' AND s.available_at <= ?
       ORDER BY j.priority, j.available_at, j.created_at, j.id LIMIT 1`,
    )
    .get(now, now) as
    | {
        job_id: string;
        job_version: number;
        attempt_count: number;
        step_id: string;
        step_version: number;
      }
    | undefined;
  let claim: { leaseOwner: string } | null = null;
  if (candidate !== undefined) {
    const job = database
      .prepare(
        `UPDATE jobs SET status='running', attempt_count=attempt_count+1,
           lease_owner=?, lease_expires_at=?, heartbeat_at=?, started_at=COALESCE(started_at,?),
           updated_at=?, version=version+1
         WHERE id=? AND status='queued' AND version=?`,
      )
      .run(
        leaseOwner,
        leaseExpiresAt,
        now,
        now,
        now,
        candidate.job_id,
        candidate.job_version,
      );
    if (job.changes === 1) {
      const step = database
        .prepare(
          `UPDATE job_steps SET status='running', attempt_count=attempt_count+1,
             lease_owner=?, lease_expires_at=?, heartbeat_at=?, started_at=COALESCE(started_at,?),
             updated_at=?, version=version+1
           WHERE id=? AND job_id=? AND status='pending' AND version=?`,
        )
        .run(
          leaseOwner,
          leaseExpiresAt,
          now,
          now,
          now,
          candidate.step_id,
          candidate.job_id,
          candidate.step_version,
        );
      if (step.changes !== 1) throw new Error("step claim conflict");
      const maxSequence = database
        .prepare(
          "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM job_events WHERE job_id=?",
        )
        .get(candidate.job_id) as { sequence: number };
      database
        .prepare(
          "INSERT INTO job_events (id,job_id,sequence,type,payload_json,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          candidate.job_id,
          maxSequence.sequence,
          "job.started",
          JSON.stringify({
            schemaVersion: 1,
            jobId: candidate.job_id,
            status: "running",
            attempt: candidate.attempt_count + 1,
          }),
          now,
        );
      database
        .prepare(
          "INSERT INTO job_events (id,job_id,sequence,type,payload_json,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          candidate.job_id,
          maxSequence.sequence + 1,
          "step.started",
          JSON.stringify({
            schemaVersion: 1,
            jobId: candidate.job_id,
            stepId: candidate.step_id,
            status: "running",
          }),
          now,
        );
      claim = { leaseOwner };
    }
  }
  database.exec("COMMIT");
  parentPort?.postMessage({ claim });
} catch (error) {
  try {
    database.exec("ROLLBACK");
  } catch {
    /* transaction already closed */
  }
  parentPort?.postMessage({ error: String(error) });
} finally {
  database.close();
}
