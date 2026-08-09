import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

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
  const now = 100;
  database.exec("BEGIN IMMEDIATE");
  const candidate = database
    .prepare(
      `SELECT id, version FROM jobs WHERE status='cancel_requested'
     AND (lease_owner IS NULL OR lease_expires_at <= ?) ORDER BY id LIMIT 1`,
    )
    .get(now) as { id: string; version: number } | undefined;
  let claimed = false;
  if (candidate) {
    const result = database
      .prepare(
        `UPDATE jobs SET lease_owner=?, lease_expires_at=?, heartbeat_at=?, updated_at=?, version=version+1
       WHERE id=? AND status='cancel_requested' AND (lease_owner IS NULL OR lease_expires_at <= ?) AND version=?`,
      )
      .run(
        data.leaseOwner,
        now + 10_000,
        now,
        now,
        candidate.id,
        now,
        candidate.version,
      );
    claimed = result.changes === 1;
  }
  database.exec("COMMIT");
  parentPort?.postMessage({ claimed });
} catch (error) {
  try {
    database.exec("ROLLBACK");
  } catch {
    /* transaction already closed */
  }
  parentPort?.postMessage({ claimed: false, error: String(error) });
} finally {
  database.close();
}
