import { mkdtemp, rm } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("concurrent Job claims", () => {
  it("allows exactly one winner from two independently opened connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-concurrent-claim-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "database.sqlite");
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
    );
    await database.migrate();
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users
          (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('11111111-1111-4111-8111-111111111111','owner@example.test','Owner',
                  'member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('22222222-2222-4222-8222-222222222222',
                  '11111111-1111-4111-8111-111111111111','Project',0,'active',1,1);
        INSERT INTO assets
          (id,project_id,owner_user_id,original_filename,kind,storage_key,byte_size,
           metadata_json,ingestion_status,lifecycle_status,created_at,updated_at)
          VALUES ('55555555-5555-4555-8555-555555555555',
                  '22222222-2222-4222-8222-222222222222',
                  '11111111-1111-4111-8111-111111111111','clip.mp4','video','asset/key',128,
                  '{}','processing','active',1,1);
        INSERT INTO jobs
          (id,project_id,owner_user_id,type,status,request_json,current_step_key,
           max_attempts,available_at,created_at,updated_at)
          VALUES ('33333333-3333-4333-8333-333333333333',
                  '22222222-2222-4222-8222-222222222222',
                  '11111111-1111-4111-8111-111111111111','asset_ingestion','queued',
                  '{"schemaVersion":1,"assetId":"55555555-5555-4555-8555-555555555555"}',
                  'inspect_asset',3,1,1,1);
        INSERT INTO job_steps
          (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,created_at,updated_at)
          VALUES ('44444444-4444-4444-8444-444444444444',
                  '33333333-3333-4333-8333-333333333333','inspect_asset','',
                  'pending',3,1,'{"schemaVersion":1,"assetId":"55555555-5555-4555-8555-555555555555"}',1,1);
      `);
    });
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const workers = ["worker-a", "worker-b"].map(
      (leaseOwner) =>
        new Worker(
          new URL("./job-concurrent-claim.worker.ts", import.meta.url),
          {
            workerData: { databasePath, leaseOwner, barrier },
            execArgv: ["--import", "tsx"],
          },
        ),
    );
    const results = workers.map(
      (worker) =>
        new Promise<{ claim?: { leaseOwner: string } | null; error?: string }>(
          (resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
          },
        ),
    );
    try {
      await waitForReady(barrier);
      Atomics.store(new Int32Array(barrier), 1, 1);
      Atomics.notify(new Int32Array(barrier), 1);
      const settled = await Promise.all(results);
      expect(settled.filter((result) => result.claim !== null).length).toBe(1);
      expect(settled.filter((result) => result.claim === null).length).toBe(1);
      expect(settled.every((result) => result.error === undefined)).toBe(true);
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              `SELECT j.status, j.attempt_count, j.lease_owner,
                      s.status AS step_status,
                      (SELECT COUNT(*) FROM job_events WHERE job_id = j.id AND type = 'job.started') AS jobs_started,
                      (SELECT COUNT(*) FROM job_events WHERE job_id = j.id AND type = 'step.started') AS steps_started
               FROM jobs j JOIN job_steps s ON s.job_id = j.id`,
            )
            .get(),
        ),
      ).toMatchObject({
        status: "running",
        attempt_count: 1,
        step_status: "running",
        jobs_started: 1,
        steps_started: 1,
      });
    } finally {
      for (const worker of workers) await worker.terminate();
      await database.close();
    }
  }, 30_000);
});

async function waitForReady(barrier: SharedArrayBuffer): Promise<void> {
  const view = new Int32Array(barrier);
  const deadline = Date.now() + 10_000;
  while (Atomics.load(view, 0) < 2) {
    if (Date.now() > deadline)
      throw new Error("Concurrent claim workers did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
