import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import { DurableJobDispatcher } from "./durable-job-dispatcher.js";
import { AssetIngestionJobHandler } from "./handlers/asset-ingestion-job-handler.js";
import { JobHandlerRegistry } from "./job-handler-registry.js";
import { JobRepository } from "./job-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DurableJobDispatcher", () => {
  it("stops extending active leases as soon as shutdown begins", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "oloka-dispatcher-stop-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const userId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const assetId = "33333333-3333-4333-8333-333333333333";
    const jobId = "44444444-4444-4444-8444-444444444444";
    const stepId = "55555555-5555-4555-8555-555555555555";
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users
          (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${userId}','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${projectId}','${userId}','Project',0,'active',1,1);
        INSERT INTO assets
          (id,project_id,owner_user_id,original_filename,kind,storage_key,byte_size,
           metadata_json,ingestion_status,lifecycle_status,created_at,updated_at)
          VALUES ('${assetId}','${projectId}','${userId}','clip.mp4','video','asset/key',128,
                  '{}','processing','active',1,1);
        INSERT INTO jobs
          (id,project_id,owner_user_id,type,status,request_json,current_step_key,
           max_attempts,available_at,created_at,updated_at)
          VALUES ('${jobId}','${projectId}','${userId}','asset_ingestion','queued',
                  '{"schemaVersion":1,"assetId":"${assetId}"}','inspect_asset',3,1,1,1);
        INSERT INTO job_steps
          (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,created_at,updated_at)
          VALUES ('${stepId}','${jobId}','inspect_asset','','pending',3,1,'{}',1,1);
      `);
    });
    let now = 10;
    let releaseHandler: (() => void) | undefined;
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const registry = new JobHandlerRegistry([
      {
        type: "asset_ingestion" as const,
        handle: vi.fn(() => handlerBlocked),
      },
    ]);
    const dispatcher = new DurableJobDispatcher({
      transactions: database.transactions,
      repository: new JobRepository(new UuidIdGenerator()),
      handlers: registry,
      clock: { now: () => now },
      workerId: "shutdown-worker",
      leaseDurationMs: 100,
      heartbeatIntervalMs: 10,
      shutdownGraceMs: 20,
    });

    try {
      const run = dispatcher.runOnce();
      now = 20;
      await vi.advanceTimersByTimeAsync(10);
      expect(readLeaseExpiry(database, jobId)).toEqual({
        job_lease_expires_at: 120,
        step_lease_expires_at: 120,
      });
      const stop = dispatcher.stop();
      await vi.advanceTimersByTimeAsync(30);
      await stop;
      now = 80;
      await vi.advanceTimersByTimeAsync(100);
      expect(readLeaseExpiry(database, jobId)).toEqual({
        job_lease_expires_at: 120,
        step_lease_expires_at: 120,
      });
      releaseHandler?.();
      await run;
    } finally {
      releaseHandler?.();
      vi.useRealTimers();
      await database.close();
    }
  });

  it("claims and completes cancellation cleanup before ordinary work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-dispatcher-cancel-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const userId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const jobId = "44444444-4444-4444-8444-444444444444";
    const stepId = "55555555-5555-4555-8555-555555555555";
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users
          (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${userId}','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${projectId}','${userId}','Project',0,'active',1,1);
        INSERT INTO jobs
          (id,project_id,owner_user_id,type,status,request_json,current_step_key,
           max_attempts,available_at,cancel_requested_at,created_at,updated_at)
          VALUES ('${jobId}','${projectId}','${userId}','asset_ingestion','cancel_requested',
                  '{"schemaVersion":1,"assetId":"33333333-3333-4333-8333-333333333333"}',
                  'inspect_asset',3,1,2,1,2);
        INSERT INTO job_steps
          (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,created_at,updated_at)
          VALUES ('${stepId}','${jobId}','inspect_asset','','pending',3,1,'{}',1,1);
      `);
    });
    const dispatcher = new DurableJobDispatcher({
      transactions: database.transactions,
      repository: new JobRepository(new UuidIdGenerator()),
      handlers: new JobHandlerRegistry([]),
      clock: { now: () => 100 },
      workerId: "cleanup-worker",
      leaseDurationMs: 60_000,
    });

    try {
      await expect(dispatcher.runOnce()).resolves.toBe(true);
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              `SELECT j.status, j.lease_owner, s.status AS step_status,
                      s.lease_owner AS step_lease_owner
               FROM jobs j JOIN job_steps s ON s.job_id = j.id WHERE j.id = ?`,
            )
            .get(jobId),
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

  it("runs Asset ingestion through the registered durable handler", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-dispatcher-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const userId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const assetId = "33333333-3333-4333-8333-333333333333";
    const jobId = "44444444-4444-4444-8444-444444444444";
    const stepId = "55555555-5555-4555-8555-555555555555";
    database.transactions.run("immediate", ({ database: connection }) => {
      connection
        .prepare(
          `INSERT INTO users
            (id, email_normalized, display_name, role, status, approved_at, created_at, updated_at)
           VALUES (?, 'owner@example.com', 'Owner', 'member', 'active', 1, 1, 1)`,
        )
        .run(userId);
      connection
        .prepare(
          `INSERT INTO projects
            (id, owner_user_id, name, description, favorite, status, created_at, updated_at)
           VALUES (?, ?, 'Project', NULL, 0, 'active', 1, 1)`,
        )
        .run(projectId, userId);
      connection
        .prepare(
          `INSERT INTO assets
            (id, project_id, owner_user_id, original_filename, kind, storage_key,
             byte_size, metadata_json, ingestion_status, lifecycle_status, created_at, updated_at)
           VALUES (?, ?, ?, 'clip.mp4', 'video', ?, 128, '{}', 'processing', 'active', 1, 1)`,
        )
        .run(assetId, projectId, userId, `asset/${assetId}`);
      connection
        .prepare(
          `INSERT INTO jobs
            (id, project_id, owner_user_id, type, status, request_json,
             current_step_key, max_attempts, available_at, created_at, updated_at)
           VALUES (?, ?, ?, 'asset_ingestion', 'queued', ?, 'inspect_asset', 3, 1000, 1000, 1000)`,
        )
        .run(
          jobId,
          projectId,
          userId,
          JSON.stringify({ schemaVersion: 1, assetId }),
        );
      connection
        .prepare(
          `INSERT INTO job_steps
            (id, job_id, step_key, item_key, status, max_attempts, available_at,
             input_json, created_at, updated_at)
           VALUES (?, ?, 'inspect_asset', '', 'pending', 3, 1000, ?, 1000, 1000)`,
        )
        .run(stepId, jobId, JSON.stringify({ schemaVersion: 1, assetId }));
    });
    const repository = new JobRepository(new UuidIdGenerator());
    const inspect = vi.fn(() => Promise.resolve({ byteSize: 128 }));
    const registry = new JobHandlerRegistry([
      new AssetIngestionJobHandler({
        transactions: database.transactions,
        repository,
        clock: { now: () => 2_000 },
        inspect,
      }),
    ]);
    const dispatcher = new DurableJobDispatcher({
      transactions: database.transactions,
      repository,
      handlers: registry,
      clock: { now: () => 2_000 },
      workerId: "dispatcher-test",
      leaseDurationMs: 60_000,
    });

    try {
      await expect(dispatcher.runOnce()).resolves.toBe(true);
      expect(inspect).toHaveBeenCalledWith(`asset/${assetId}`);
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              `SELECT j.status, j.progress_basis_points, s.status AS step_status,
                      a.ingestion_status
               FROM jobs j JOIN job_steps s ON s.job_id = j.id
               JOIN assets a ON a.id = ? WHERE j.id = ?`,
            )
            .get(assetId, jobId),
        ),
      ).toEqual({
        status: "completed",
        progress_basis_points: 10_000,
        step_status: "completed",
        ingestion_status: "ready",
      });
    } finally {
      await database.close();
    }
  });
});

function readLeaseExpiry(
  database: SqliteSystemDatabase,
  jobId: string,
): unknown {
  return database.transactions.run("read", ({ database: connection }) =>
    connection
      .prepare(
        `SELECT j.lease_expires_at AS job_lease_expires_at,
                s.lease_expires_at AS step_lease_expires_at
         FROM jobs j JOIN job_steps s ON s.job_id = j.id WHERE j.id = ?`,
      )
      .get(jobId),
  );
}
