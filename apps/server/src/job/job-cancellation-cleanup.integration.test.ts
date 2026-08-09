import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import { JobRepository } from "./job-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Job cancellation cleanup", () => {
  it("lets only one synchronized cleanup worker acquire the expired cleanup lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-cancel-race-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "database.sqlite");
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
    );
    await database.migrate();
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('11111111-1111-4111-8111-111111111111','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Project',0,'active',1,1);
        INSERT INTO jobs (id,project_id,owner_user_id,type,status,request_json,current_step_key,max_attempts,available_at,cancel_requested_at,created_at,updated_at)
          VALUES ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','generation','cancel_requested','{"schemaVersion":1}','provider',3,1,2,1,1);
      `);
    });
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const workers = ["cleanup-a", "cleanup-b"].map(
      (leaseOwner) =>
        new Worker(new URL("./job-cancel-race.worker.ts", import.meta.url), {
          workerData: { databasePath, barrier, leaseOwner },
          execArgv: ["--import", "tsx"],
        }),
    );
    const results = workers.map(
      (worker) =>
        new Promise<{ claimed: boolean; error?: string }>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        }),
    );
    try {
      await waitForReady(barrier);
      const view = new Int32Array(barrier);
      Atomics.store(view, 1, 1);
      Atomics.notify(view, 1);
      const settled = await Promise.all(results);
      expect(settled.filter((result) => result.claimed).length).toBe(1);
      expect(settled.every((result) => result.error === undefined)).toBe(true);
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection.prepare("SELECT status, lease_owner FROM jobs").get(),
        ),
      ).toMatchObject({ status: "cancel_requested" });
    } finally {
      for (const worker of workers) await worker.terminate();
      await database.close();
    }
  });

  it("covers queued/running/provider-waiting/retry states, expired lease takeover, and stale commit rejection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-cancel-matrix-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const userId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${userId}','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${projectId}','${userId}','Project',0,'active',1,1);
      `);
      const jobs = [
        [
          "33333333-3333-4333-8333-333333333333",
          "44444444-4444-4444-8444-444444444444",
          "pending",
          null,
          null,
        ],
        [
          "55555555-5555-4555-8555-555555555555",
          "66666666-6666-4666-8666-666666666666",
          "running",
          "old-worker",
          50,
        ],
        [
          "77777777-7777-4777-8777-777777777777",
          "88888888-8888-4888-8888-888888888888",
          "waiting_provider",
          null,
          null,
        ],
        [
          "99999999-9999-4999-8999-999999999999",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "retry_scheduled",
          null,
          null,
        ],
      ] as const;
      for (const [jobId, stepId, stepStatus, leaseOwner, leaseExpiry] of jobs) {
        connection
          .prepare(
            `INSERT INTO jobs (id,project_id,owner_user_id,type,status,request_json,current_step_key,max_attempts,available_at,cancel_requested_at,lease_owner,lease_expires_at,heartbeat_at,created_at,updated_at)
             VALUES (?, ?, ?, 'generation', 'cancel_requested', '{"schemaVersion":1}', 'provider', 3, 1, 10, ?, ?, ?, 1, 1)`,
          )
          .run(
            jobId,
            projectId,
            userId,
            leaseOwner,
            leaseExpiry,
            leaseExpiry === null ? null : 10,
          );
        connection
          .prepare(
            `INSERT INTO job_steps (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,lease_owner,lease_expires_at,heartbeat_at,provider_submission_state,provider_operation_id,provider_idempotency_key_hash_sha256,provider_submission_attempt,created_at,updated_at,completed_at)
             VALUES (?, ?, 'provider', '', ?, 3, 1, '{}', ?, ?, ?, ?, ?, ?, 1, 1, 1, NULL)`,
          )
          .run(
            stepId,
            jobId,
            stepStatus,
            leaseOwner,
            leaseExpiry,
            leaseExpiry === null ? null : 10,
            stepStatus === "waiting_provider" ? "accepted" : null,
            stepStatus === "waiting_provider" ? "provider-op" : null,
            stepStatus === "waiting_provider" ? "b".repeat(64) : null,
          );
      }
    });
    const repository = new JobRepository(new UuidIdGenerator());
    try {
      const claims: Array<{ jobId: string; jobVersion: number }> = [];
      for (const leaseOwner of [
        "cleanup-1",
        "cleanup-2",
        "cleanup-3",
        "cleanup-4",
      ]) {
        const claim = database.transactions.run("immediate", (context) =>
          repository.claimCancellationCleanup(context, {
            leaseOwner,
            now: 100,
            leaseDurationMs: 10_000,
          }),
        );
        expect(claim).not.toBeNull();
        claims.push({ jobId: claim!.jobId, jobVersion: claim!.jobVersion });
        database.transactions.run("immediate", (context) =>
          repository.completeCancellationCleanup(context, {
            jobId: claim!.jobId,
            leaseOwner,
            expectedJobVersion: claim!.jobVersion,
            now: 101,
          }),
        );
      }
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              "SELECT COUNT(*) AS count FROM jobs WHERE status = 'cancelled'",
            )
            .get(),
        ),
      ).toEqual({ count: 4 });

      const stale = database.transactions.run("immediate", (context) =>
        repository.claimCancellationCleanup(context, {
          leaseOwner: "stale-a",
          now: 200,
          leaseDurationMs: 10_000,
        }),
      );
      expect(stale).toBeNull();
      expect(claims.length).toBe(4);
    } finally {
      await database.close();
    }
  });

  it("keeps cancel_requested while cleanup is leased and terminalizes unfinished steps together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-cancel-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const ids = {
      user: "11111111-1111-4111-8111-111111111111",
      project: "22222222-2222-4222-8222-222222222222",
      job: "33333333-3333-4333-8333-333333333333",
      step: "44444444-4444-4444-8444-444444444444",
    };
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${ids.user}','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${ids.project}','${ids.user}','Project',0,'active',1,1);
        INSERT INTO jobs
          (id,project_id,owner_user_id,type,status,request_json,current_step_key,
           max_attempts,available_at,cancel_requested_at,created_at,updated_at)
          VALUES ('${ids.job}','${ids.project}','${ids.user}','asset_ingestion','cancel_requested',
                  '{"assetId":"55555555-5555-4555-8555-555555555555","schemaVersion":1}',
                  'inspect_asset',3,1,10,1,10);
        INSERT INTO job_steps
          (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,created_at,updated_at)
          VALUES ('${ids.step}','${ids.job}','inspect_asset','','pending',3,1,
                  '{"assetId":"55555555-5555-4555-8555-555555555555","schemaVersion":1}',1,1);
      `);
    });
    const repository = new JobRepository(new UuidIdGenerator());

    try {
      const claim = database.transactions.run("immediate", (context) =>
        repository.claimCancellationCleanup(context, {
          leaseOwner: "cleanup-a",
          now: 100,
          leaseDurationMs: 60_000,
        }),
      );
      expect(claim).toMatchObject({
        jobId: ids.job,
        leaseOwner: "cleanup-a",
        jobVersion: 2,
      });
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare("SELECT status, lease_owner FROM jobs WHERE id = ?")
            .get(ids.job),
        ),
      ).toEqual({ status: "cancel_requested", lease_owner: "cleanup-a" });

      database.transactions.run("immediate", ({ database: connection }) =>
        connection
          .prepare("UPDATE jobs SET version = version + 1 WHERE id = ?")
          .run(ids.job),
      );
      expect(() =>
        database.transactions.run("immediate", (context) =>
          repository.completeCancellationCleanup(context, {
            jobId: ids.job,
            leaseOwner: "cleanup-a",
            expectedJobVersion: 2,
            now: 150,
          }),
        ),
      ).toThrowError(/job_lease_conflict/);

      database.transactions.run("immediate", (context) =>
        repository.completeCancellationCleanup(context, {
          jobId: ids.job,
          leaseOwner: "cleanup-a",
          expectedJobVersion: 3,
          now: 200,
        }),
      );
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              `SELECT j.status, j.lease_owner, s.status AS step_status,
                      s.lease_owner AS step_lease_owner
               FROM jobs j JOIN job_steps s ON s.job_id = j.id WHERE j.id = ?`,
            )
            .get(ids.job),
        ),
      ).toEqual({
        status: "cancelled",
        lease_owner: null,
        step_status: "cancelled",
        step_lease_owner: null,
      });
    } finally {
      await database.close();
    }
  });

  it("does not terminalize cancel_requested during ordinary lease reconciliation", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "oloka-job-cancel-reconcile-"),
    );
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('11111111-1111-4111-8111-111111111111','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Project',0,'active',1,1);
        INSERT INTO jobs
          (id,project_id,owner_user_id,type,status,request_json,current_step_key,
           max_attempts,available_at,cancel_requested_at,lease_owner,lease_expires_at,
           heartbeat_at,created_at,updated_at)
          VALUES ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222',
                  '11111111-1111-4111-8111-111111111111','asset_ingestion','cancel_requested',
                  '{"assetId":"55555555-5555-4555-8555-555555555555","schemaVersion":1}',
                  'inspect_asset',3,1,10,'old-worker',20,10,1,10);
      `);
    });
    const repository = new JobRepository(new UuidIdGenerator());

    try {
      expect(
        database.transactions.run("immediate", (context) =>
          repository.reconcile(context, 100),
        ),
      ).toMatchObject({ cancelled: 0 });
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection.prepare("SELECT status, lease_owner FROM jobs").get(),
        ),
      ).toEqual({ status: "cancel_requested", lease_owner: null });
    } finally {
      await database.close();
    }
  });
});

async function waitForReady(barrier: SharedArrayBuffer): Promise<void> {
  const view = new Int32Array(barrier);
  const deadline = Date.now() + 10_000;
  while (Atomics.load(view, 0) < 2) {
    if (Date.now() > deadline) throw new Error("cleanup workers did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
