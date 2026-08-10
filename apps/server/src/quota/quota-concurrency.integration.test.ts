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

describe("quota admission concurrency", () => {
  it("admits one of two synchronized limit contenders and leaves no denied evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-quota-concurrency-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "database.sqlite");
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
    );
    await database.migrate();
    const ids = {
      user: "11111111-1111-4111-8111-111111111111",
      project: "22222222-2222-4222-8222-222222222222",
      assetA: "33333333-3333-4333-8333-333333333333",
      assetB: "44444444-4444-4444-8444-444444444444",
      jobA: "55555555-5555-4555-8555-555555555555",
      jobB: "66666666-6666-4666-8666-666666666666",
      stepA: "77777777-7777-4777-8777-777777777777",
      stepB: "88888888-8888-4888-8888-888888888888",
    };
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${ids.user}','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${ids.project}','${ids.user}','Project',0,'active',1,1);
        INSERT INTO assets (id,project_id,owner_user_id,original_filename,kind,storage_key,byte_size,metadata_json,ingestion_status,lifecycle_status,created_at,updated_at)
          VALUES ('${ids.assetA}','${ids.project}','${ids.user}','a.mp4','video','asset/a',128,'{}','processing','active',1,1);
        INSERT INTO assets (id,project_id,owner_user_id,original_filename,kind,storage_key,byte_size,metadata_json,ingestion_status,lifecycle_status,created_at,updated_at)
          VALUES ('${ids.assetB}','${ids.project}','${ids.user}','b.mp4','video','asset/b',128,'{}','processing','active',1,1);
      `);
    });
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const workers = [
      [ids.jobA, ids.stepA, ids.assetA],
      [ids.jobB, ids.stepB, ids.assetB],
    ].map(
      ([jobId, stepId, assetId]) =>
        new Worker(new URL("./quota-concurrency.worker.ts", import.meta.url), {
          workerData: {
            databasePath,
            barrier,
            ...ids,
            userId: ids.user,
            projectId: ids.project,
            jobId,
            stepId,
            assetId,
          },
          execArgv: ["--experimental-strip-types"],
        }),
    );
    const results = workers.map(
      (worker) =>
        new Promise<{ admitted: boolean; error?: string }>(
          (resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
          },
        ),
    );
    try {
      await waitForReady(barrier);
      const view = new Int32Array(barrier);
      Atomics.store(view, 1, 1);
      Atomics.notify(view, 1);
      const settled = await Promise.all(results);
      expect(settled.filter((result) => result.admitted).length).toBe(1);
      expect(
        settled.filter(
          (result) => !result.admitted && result.error === undefined,
        ).length,
      ).toBe(1);
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
        ),
      ).toEqual({ count: 1 });
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection.prepare("SELECT COUNT(*) AS count FROM job_steps").get(),
        ),
      ).toEqual({ count: 1 });
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare("SELECT COUNT(*) AS count FROM outbox_events")
            .get(),
        ),
      ).toEqual({ count: 1 });
    } finally {
      for (const worker of workers) await worker.terminate();
      await database.close();
    }
  }, 90_000);
});

async function waitForReady(barrier: SharedArrayBuffer): Promise<void> {
  const view = new Int32Array(barrier);
  const deadline = Date.now() + 60_000;
  while (Atomics.load(view, 0) < 2) {
    if (Date.now() > deadline) throw new Error("quota workers did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
