import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

describe("Job retry reconciliation", () => {
  it("schedules a transient retry and atomically fails the Asset after exhaustion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-retry-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const ids = {
      user: "11111111-1111-4111-8111-111111111111",
      project: "22222222-2222-4222-8222-222222222222",
      asset: "33333333-3333-4333-8333-333333333333",
      job: "44444444-4444-4444-8444-444444444444",
      step: "55555555-5555-4555-8555-555555555555",
    };
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${ids.user}','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${ids.project}','${ids.user}','Project',0,'active',1,1);
        INSERT INTO assets
          (id,project_id,owner_user_id,original_filename,kind,storage_key,byte_size,metadata_json,ingestion_status,lifecycle_status,created_at,updated_at)
          VALUES ('${ids.asset}','${ids.project}','${ids.user}','clip.mp4','video','asset/key',128,'{}','processing','active',1,1);
        INSERT INTO jobs
          (id,project_id,owner_user_id,type,status,request_json,current_step_key,max_attempts,available_at,created_at,updated_at)
          VALUES ('${ids.job}','${ids.project}','${ids.user}','asset_ingestion','queued',
                  '{"assetId":"${ids.asset}","schemaVersion":1}','inspect_asset',2,1,1,1);
        INSERT INTO job_steps
          (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,created_at,updated_at)
          VALUES ('${ids.step}','${ids.job}','inspect_asset','','pending',2,1,
                  '{"assetId":"${ids.asset}","schemaVersion":1}',1,1);
      `);
    });
    const repository = new JobRepository(new UuidIdGenerator());

    try {
      const first = database.transactions.run("immediate", (context) =>
        repository.claimNext(context, {
          leaseOwner: "worker-a",
          now: 100,
          leaseDurationMs: 100,
        }),
      )!;
      const scheduled = database.transactions.run("immediate", (context) =>
        repository.failAssetIngestion(context, {
          jobId: first.jobId,
          stepId: first.stepId,
          assetId: first.assetId,
          leaseOwner: first.leaseOwner,
          expectedJobVersion: first.jobVersion,
          expectedStepVersion: first.stepVersion,
          now: 110,
          failureCode: "STORAGE_UNAVAILABLE",
          retryable: true,
        }),
      );
      expect(scheduled.status).toBe("retry_scheduled");
      expect(
        database.transactions.run("immediate", (context) =>
          repository.reconcile(context, 1_000),
        ),
      ).toMatchObject({ retried: 0 });
      expect(
        database.transactions.run("immediate", (context) =>
          repository.reconcile(context, 1_110),
        ),
      ).toMatchObject({ retried: 1 });
      const second = database.transactions.run("immediate", (context) =>
        repository.claimNext(context, {
          leaseOwner: "worker-b",
          now: 1_110,
          leaseDurationMs: 100,
        }),
      )!;
      expect(() =>
        database.transactions.run("immediate", (context) =>
          repository.heartbeat(context, {
            jobId: second.jobId,
            stepId: second.stepId,
            leaseOwner: "worker-a",
            expectedJobVersion: second.jobVersion,
            expectedStepVersion: second.stepVersion,
            now: 1_120,
            leaseDurationMs: 100,
          }),
        ),
      ).toThrowError(/job_lease_conflict/);
      const exhausted = database.transactions.run("immediate", (context) =>
        repository.failAssetIngestion(context, {
          jobId: second.jobId,
          stepId: second.stepId,
          assetId: second.assetId,
          leaseOwner: second.leaseOwner,
          expectedJobVersion: second.jobVersion,
          expectedStepVersion: second.stepVersion,
          now: 1_120,
          failureCode: "STORAGE_UNAVAILABLE",
          retryable: true,
        }),
      );
      expect(exhausted.status).toBe("failed");
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              `SELECT j.status, j.progress_basis_points, s.status AS step_status,
                      a.ingestion_status, a.failure_code
               FROM jobs j JOIN job_steps s ON s.job_id = j.id
               JOIN assets a ON a.id = ? WHERE j.id = ?`,
            )
            .get(ids.asset, ids.job),
        ),
      ).toEqual({
        status: "failed",
        progress_basis_points: 0,
        step_status: "failed",
        ingestion_status: "failed",
        failure_code: "STORAGE_UNAVAILABLE",
      });
    } finally {
      await database.close();
    }
  });
});
