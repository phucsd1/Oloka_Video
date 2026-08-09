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
