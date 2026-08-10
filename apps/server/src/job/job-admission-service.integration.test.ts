import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { SystemClock } from "../kernel/clock.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import { BaselineQuotaPolicyResolver } from "../quota/quota-policy.js";
import { JobAdmissionService } from "./job-admission-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JobAdmissionService", () => {
  it("atomically admits one Asset-ingestion Job with its durable evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-admission-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const userId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const assetId = "33333333-3333-4333-8333-333333333333";
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
    });
    const service = new JobAdmissionService({
      transactions: database.transactions,
      clock: new SystemClock(),
      idGenerator: new UuidIdGenerator(),
      quotaPolicyResolver: new BaselineQuotaPolicyResolver({
        maxQueuedJobsPerUser: 1,
      }),
    });

    try {
      const result = service.admitAssetIngestion(
        {
          sessionId: "session",
          user: {
            id: userId,
            email: "owner@example.com",
            displayName: "Owner",
            avatarUrl: null,
            role: "member",
            status: "active",
            version: 1,
          },
        },
        { projectId, assetId },
        "asset-ingestion-admission",
      );

      expect(result.replayed).toBe(false);
      const replay = service.admitAssetIngestion(
        {
          sessionId: "session",
          user: {
            id: userId,
            email: "owner@example.com",
            displayName: "Owner",
            avatarUrl: null,
            role: "member",
            status: "active",
            version: 1,
          },
        },
        { projectId, assetId },
        "asset-ingestion-admission",
      );
      expect(replay).toMatchObject({
        replayed: true,
        job: { id: result.job.id },
      });
      expect(() =>
        service.admitAssetIngestion(
          {
            sessionId: "session",
            user: {
              id: userId,
              email: "owner@example.com",
              displayName: "Owner",
              avatarUrl: null,
              role: "member",
              status: "active",
              version: 1,
            },
          },
          {
            projectId,
            assetId: "99999999-9999-4999-8999-999999999999",
          },
          "asset-ingestion-admission",
        ),
      ).toThrowError(/job_admission_idempotency_conflict/);
      const secondAssetId = "99999999-9999-4999-8999-999999999999";
      database.transactions.run("immediate", ({ database: connection }) => {
        connection
          .prepare(
            `INSERT INTO assets
              (id, project_id, owner_user_id, original_filename, kind, storage_key,
               byte_size, metadata_json, ingestion_status, lifecycle_status, created_at, updated_at)
             VALUES (?, ?, ?, 'second.mp4', 'video', ?, 128, '{}', 'processing', 'active', 2, 2)`,
          )
          .run(secondAssetId, projectId, userId, `asset/${secondAssetId}`);
      });
      expect(() =>
        service.admitAssetIngestion(
          {
            sessionId: "session",
            user: {
              id: userId,
              email: "owner@example.com",
              displayName: "Owner",
              avatarUrl: null,
              role: "member",
              status: "active",
              version: 1,
            },
          },
          { projectId, assetId: secondAssetId },
          "second-admission",
        ),
      ).toThrowError(/queued_job_limit/);
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              `SELECT
                 (SELECT COUNT(*) FROM jobs) AS jobs,
                 (SELECT COUNT(*) FROM job_steps) AS steps,
                 (SELECT COUNT(*) FROM job_events WHERE sequence = 1 AND type = 'job.queued') AS events,
                 (SELECT COUNT(*) FROM outbox_events WHERE topic = 'job.dispatch.requested') AS outbox,
                 (SELECT COUNT(*) FROM audit_events WHERE action = 'job.admit') AS audits,
                 (SELECT COUNT(*) FROM idempotency_records WHERE status = 'completed') AS idempotency`,
            )
            .get(),
        ),
      ).toEqual({
        jobs: 1,
        steps: 1,
        events: 1,
        outbox: 1,
        audits: 1,
        idempotency: 1,
      });
    } finally {
      await database.close();
    }
  });
});
