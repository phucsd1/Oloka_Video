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

describe("JobRepository", () => {
  it("grants exactly one lease when two workers claim the same queued Job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-claim-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "database.sqlite");
    const first = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
    );
    await first.migrate();
    const second = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
    );
    const userId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const jobId = "33333333-3333-4333-8333-333333333333";
    const stepId = "44444444-4444-4444-8444-444444444444";
    const assetId = "55555555-5555-4555-8555-555555555555";
    first.transactions.run("immediate", ({ database }) => {
      database
        .prepare(
          `INSERT INTO users
            (id, email_normalized, display_name, role, status, approved_at, created_at, updated_at)
           VALUES (?, 'owner@example.com', 'Owner', 'member', 'active', 1, 1, 1)`,
        )
        .run(userId);
      database
        .prepare(
          `INSERT INTO projects
            (id, owner_user_id, name, description, favorite, status, created_at, updated_at)
           VALUES (?, ?, 'Project', NULL, 0, 'active', 1, 1)`,
        )
        .run(projectId, userId);
      database
        .prepare(
          `INSERT INTO assets
            (id, project_id, owner_user_id, original_filename, kind, storage_key,
             byte_size, metadata_json, ingestion_status, lifecycle_status, created_at, updated_at)
           VALUES (?, ?, ?, 'clip.mp4', 'video', ?, 128, '{}', 'processing', 'active', 1, 1)`,
        )
        .run(assetId, projectId, userId, `asset/${assetId}`);
      database
        .prepare(
          `INSERT INTO jobs
            (id, project_id, owner_user_id, type, status, request_json,
             current_step_key, max_attempts, available_at, created_at, updated_at)
           VALUES (?, ?, ?, 'asset_ingestion', 'queued', '{"schemaVersion":1,"assetId":"55555555-5555-4555-8555-555555555555"}',
                   'inspect_asset', 3, 1000, 1000, 1000)`,
        )
        .run(jobId, projectId, userId);
      database
        .prepare(
          `INSERT INTO job_steps
            (id, job_id, step_key, item_key, status, max_attempts, available_at,
             input_json, created_at, updated_at)
           VALUES (?, ?, 'inspect_asset', '', 'pending', 3, 1000,
                   '{"schemaVersion":1,"assetId":"55555555-5555-4555-8555-555555555555"}', 1000, 1000)`,
        )
        .run(stepId, jobId);
    });
    const firstRepository = new JobRepository(new UuidIdGenerator());
    const secondRepository = new JobRepository(new UuidIdGenerator());

    try {
      const firstClaim = first.transactions.run("immediate", (context) =>
        firstRepository.claimNext(context, {
          leaseOwner: "worker-a",
          now: 2000,
          leaseDurationMs: 60_000,
        }),
      );
      const secondClaim = second.transactions.run("immediate", (context) =>
        secondRepository.claimNext(context, {
          leaseOwner: "worker-b",
          now: 2000,
          leaseDurationMs: 60_000,
        }),
      );

      expect(firstClaim).toMatchObject({
        jobId,
        stepId,
        leaseOwner: "worker-a",
        jobVersion: 2,
        stepVersion: 2,
      });
      expect(secondClaim).toBeNull();
      const heartbeat = first.transactions.run("immediate", (context) =>
        firstRepository.heartbeat(context, {
          jobId,
          stepId,
          leaseOwner: "worker-a",
          expectedJobVersion: 2,
          expectedStepVersion: 2,
          now: 3_000,
          leaseDurationMs: 60_000,
        }),
      );
      expect(heartbeat).toEqual({
        jobVersion: 3,
        stepVersion: 3,
        leaseExpiresAt: 63_000,
      });
      expect(
        first.transactions.run("read", ({ database }) =>
          database
            .prepare(
              "SELECT attempt_count, progress_basis_points FROM jobs WHERE id = ?",
            )
            .get(jobId),
        ),
      ).toEqual({ attempt_count: 1, progress_basis_points: 0 });
      const progressed = first.transactions.run("immediate", (context) =>
        firstRepository.reportProgress(context, {
          jobId,
          stepId,
          leaseOwner: "worker-a",
          expectedJobVersion: 3,
          expectedStepVersion: 3,
          progressBasisPoints: 4_000,
          now: 3_500,
        }),
      );
      expect(progressed).toEqual({ jobVersion: 4, stepVersion: 3 });
      const lowerProgress = first.transactions.run("immediate", (context) =>
        firstRepository.reportProgress(context, {
          jobId,
          stepId,
          leaseOwner: "worker-a",
          expectedJobVersion: 4,
          expectedStepVersion: 3,
          progressBasisPoints: 3_000,
          now: 3_600,
        }),
      );
      expect(lowerProgress).toEqual({ jobVersion: 4, stepVersion: 3 });
      expect(
        first.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT progress_basis_points FROM jobs WHERE id = ?")
            .get(jobId),
        ),
      ).toEqual({ progress_basis_points: 4_000 });
      expect(() =>
        first.transactions.run("immediate", (context) =>
          firstRepository.completeAssetIngestion(context, {
            jobId,
            stepId,
            assetId,
            leaseOwner: "worker-a",
            expectedJobVersion: 2,
            expectedStepVersion: 2,
            now: 4_000,
          }),
        ),
      ).toThrowError(/job_lease_conflict/);
      expect(
        first.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT ingestion_status FROM assets WHERE id = ?")
            .get(assetId),
        ),
      ).toEqual({ ingestion_status: "processing" });
      expect(
        first.transactions.run("immediate", (context) =>
          firstRepository.completeAssetIngestion(context, {
            jobId,
            stepId,
            assetId,
            leaseOwner: "worker-a",
            expectedJobVersion: 4,
            expectedStepVersion: 3,
            now: 5_000,
          }),
        ),
      ).toEqual({ jobVersion: 5, stepVersion: 4 });
      expect(
        first.transactions.run("read", ({ database }) =>
          database
            .prepare(
              `SELECT j.status, j.progress_basis_points, s.status AS step_status,
                      a.ingestion_status,
                      (SELECT GROUP_CONCAT(sequence, ',') FROM job_events WHERE job_id = j.id) AS sequences
               FROM jobs j
               JOIN job_steps s ON s.job_id = j.id
               JOIN assets a ON a.id = ?
               WHERE j.id = ?`,
            )
            .get(assetId, jobId),
        ),
      ).toEqual({
        status: "completed",
        progress_basis_points: 10_000,
        step_status: "completed",
        ingestion_status: "ready",
        sequences: "1,2,3,4,5",
      });

      const recoveredAssetId = "66666666-6666-4666-8666-666666666666";
      const recoveredJobId = "77777777-7777-4777-8777-777777777777";
      const recoveredStepId = "88888888-8888-4888-8888-888888888888";
      first.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            `INSERT INTO assets
              (id, project_id, owner_user_id, original_filename, kind, storage_key,
               byte_size, metadata_json, ingestion_status, lifecycle_status, created_at, updated_at)
             VALUES (?, ?, ?, 'recover.mp4', 'video', ?, 128, '{}', 'processing', 'active', 9000, 9000)`,
          )
          .run(
            recoveredAssetId,
            projectId,
            userId,
            `asset/${recoveredAssetId}`,
          );
        database
          .prepare(
            `INSERT INTO jobs
              (id, project_id, owner_user_id, type, status, request_json,
               current_step_key, max_attempts, available_at, created_at, updated_at)
             VALUES (?, ?, ?, 'asset_ingestion', 'queued', ?, 'inspect_asset', 3, 9000, 9000, 9000)`,
          )
          .run(
            recoveredJobId,
            projectId,
            userId,
            JSON.stringify({ schemaVersion: 1, assetId: recoveredAssetId }),
          );
        database
          .prepare(
            `INSERT INTO job_steps
              (id, job_id, step_key, item_key, status, max_attempts, available_at,
               input_json, created_at, updated_at)
             VALUES (?, ?, 'inspect_asset', '', 'pending', 3, 9000, ?, 9000, 9000)`,
          )
          .run(
            recoveredStepId,
            recoveredJobId,
            JSON.stringify({ schemaVersion: 1, assetId: recoveredAssetId }),
          );
      });
      const abandoned = first.transactions.run("immediate", (context) =>
        firstRepository.claimNext(context, {
          leaseOwner: "worker-a",
          now: 10_000,
          leaseDurationMs: 100,
        }),
      )!;
      expect(
        first.transactions.run("immediate", (context) =>
          firstRepository.reconcile(context, 10_100),
        ),
      ).toMatchObject({ requeued: 1 });
      const recovered = first.transactions.run("immediate", (context) =>
        firstRepository.claimNext(context, {
          leaseOwner: "worker-b",
          now: 10_100,
          leaseDurationMs: 100,
        }),
      )!;
      expect(() =>
        first.transactions.run("immediate", (context) =>
          firstRepository.completeAssetIngestion(context, {
            jobId: abandoned.jobId,
            stepId: abandoned.stepId,
            assetId: abandoned.assetId,
            leaseOwner: abandoned.leaseOwner,
            expectedJobVersion: abandoned.jobVersion,
            expectedStepVersion: abandoned.stepVersion,
            now: 10_110,
          }),
        ),
      ).toThrowError(/job_lease_conflict/);
      expect(
        first.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT ingestion_status FROM assets WHERE id = ?")
            .get(recoveredAssetId),
        ),
      ).toEqual({ ingestion_status: "processing" });
      expect(
        first.transactions.run("immediate", (context) =>
          firstRepository.completeAssetIngestion(context, {
            jobId: recovered.jobId,
            stepId: recovered.stepId,
            assetId: recovered.assetId,
            leaseOwner: recovered.leaseOwner,
            expectedJobVersion: recovered.jobVersion,
            expectedStepVersion: recovered.stepVersion,
            now: 10_110,
          }),
        ),
      ).toMatchObject({ jobVersion: 5, stepVersion: 5 });

      const providerAssetId = "99999999-9999-4999-8999-999999999999";
      const providerJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const providerStepId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      first.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            `INSERT INTO assets
              (id, project_id, owner_user_id, original_filename, kind, storage_key,
               byte_size, metadata_json, ingestion_status, lifecycle_status, created_at, updated_at)
             VALUES (?, ?, ?, 'provider.mp4', 'video', ?, 128, '{}', 'processing', 'active', 12000, 12000)`,
          )
          .run(providerAssetId, projectId, userId, `asset/${providerAssetId}`);
        database
          .prepare(
            `INSERT INTO jobs
              (id, project_id, owner_user_id, type, status, request_json,
               current_step_key, max_attempts, available_at, created_at, updated_at)
             VALUES (?, ?, ?, 'asset_ingestion', 'queued', ?, 'inspect_asset', 3, 12000, 12000, 12000)`,
          )
          .run(
            providerJobId,
            projectId,
            userId,
            JSON.stringify({ schemaVersion: 1, assetId: providerAssetId }),
          );
        database
          .prepare(
            `INSERT INTO job_steps
              (id, job_id, step_key, item_key, status, max_attempts, available_at,
               input_json, created_at, updated_at)
             VALUES (?, ?, 'inspect_asset', '', 'pending', 3, 12000, ?, 12000, 12000)`,
          )
          .run(
            providerStepId,
            providerJobId,
            JSON.stringify({ schemaVersion: 1, assetId: providerAssetId }),
          );
      });
      const providerClaim = first.transactions.run("immediate", (context) =>
        firstRepository.claimNext(context, {
          leaseOwner: "provider-test-worker",
          now: 12_000,
          leaseDurationMs: 1_000,
        }),
      )!;
      const intentVersion = first.transactions.run("immediate", (context) =>
        firstRepository.recordProviderSubmissionIntent(context, {
          jobId: providerClaim.jobId,
          stepId: providerClaim.stepId,
          leaseOwner: providerClaim.leaseOwner,
          expectedVersion: providerClaim.stepVersion,
          now: 12_010,
          requestHashSha256: "a".repeat(64),
          idempotencyKeyHashSha256: "b".repeat(64),
        }),
      );
      const fakeOperationId = (() => {
        expect(
          first.transactions.run("read", ({ database }) =>
            database
              .prepare(
                "SELECT provider_submission_state FROM job_steps WHERE id = ?",
              )
              .get(providerStepId),
          ),
        ).toEqual({ provider_submission_state: "requested" });
        return "fake-operation-1";
      })();
      first.transactions.run("immediate", (context) =>
        firstRepository.recordProviderAccepted(context, {
          jobId: providerClaim.jobId,
          stepId: providerClaim.stepId,
          leaseOwner: providerClaim.leaseOwner,
          expectedVersion: intentVersion,
          now: 12_020,
          operationId: fakeOperationId,
        }),
      );
      expect(
        first.transactions.run("read", ({ database }) =>
          database
            .prepare(
              `SELECT provider_submission_state, provider_operation_id,
                      provider_submission_attempt
               FROM job_steps WHERE id = ?`,
            )
            .get(providerStepId),
        ),
      ).toEqual({
        provider_submission_state: "accepted",
        provider_operation_id: "fake-operation-1",
        provider_submission_attempt: 1,
      });
    } finally {
      await second.close();
      await first.close();
    }
  });
});
