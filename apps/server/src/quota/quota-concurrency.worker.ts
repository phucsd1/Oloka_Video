import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

const data = workerData as {
  barrier: SharedArrayBuffer;
  databasePath: string;
  userId: string;
  projectId: string;
  jobId: string;
  stepId: string;
  assetId: string;
};
const barrier = new Int32Array(data.barrier);
const database = new DatabaseSync(data.databasePath);
database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
Atomics.add(barrier, 0, 1);
Atomics.notify(barrier, 0);
Atomics.wait(barrier, 1, 0);
try {
  const now = 2_000;
  database.exec("BEGIN IMMEDIATE");
  const queued = database
    .prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE owner_user_id = ? AND status IN ('queued','retry_scheduled')",
    )
    .get(data.userId) as { count: number };
  if (queued.count >= 1) {
    database.exec("ROLLBACK");
    parentPort?.postMessage({ admitted: false, reason: "QUOTA_EXCEEDED" });
  } else {
    const jobId = data.jobId;
    const stepId = data.stepId;
    const assetId = data.assetId;
    database
      .prepare(
        `INSERT INTO jobs (id,project_id,owner_user_id,type,status,request_json,current_step_key,max_attempts,available_at,created_at,updated_at)
       VALUES (?, ?, ?, 'asset_ingestion', 'queued', ?, 'inspect_asset', 3, ?, ?, ?)`,
      )
      .run(
        jobId,
        data.projectId,
        data.userId,
        JSON.stringify({ schemaVersion: 1, assetId }),
        now,
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO job_steps (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,created_at,updated_at)
       VALUES (?, ?, 'inspect_asset', '', 'pending', 3, ?, ?, ?, ?)`,
      )
      .run(
        stepId,
        jobId,
        now,
        JSON.stringify({ schemaVersion: 1, assetId }),
        now,
        now,
      );
    database
      .prepare(
        "INSERT INTO job_events (id,job_id,sequence,type,payload_json,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        jobId,
        1,
        "job.queued",
        JSON.stringify({
          schemaVersion: 1,
          jobId,
          status: "queued",
          progressBasisPoints: 0,
        }),
        now,
      );
    database
      .prepare(
        "INSERT INTO outbox_events (id,topic,aggregate_type,aggregate_id,payload_json,status,available_at,created_at) VALUES (?,?,?,?,?,'pending',?,?)",
      )
      .run(
        randomUUID(),
        "job.dispatch.requested",
        "job",
        jobId,
        JSON.stringify({ schemaVersion: 1, jobId }),
        now,
        now,
      );
    database.exec("COMMIT");
    parentPort?.postMessage({ admitted: true, jobId });
  }
} catch (error) {
  try {
    database.exec("ROLLBACK");
  } catch {
    /* transaction already closed */
  }
  parentPort?.postMessage({ admitted: false, error: String(error) });
} finally {
  database.close();
}
