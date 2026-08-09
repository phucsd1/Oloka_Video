import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import { JobRepository } from "./job-repository.js";
import { JobService } from "./job-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JobService", () => {
  it("conceals owner data while exposing redacted admin diagnostics and durable intents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-service-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const otherId = "22222222-2222-4222-8222-222222222222";
    const adminId = "33333333-3333-4333-8333-333333333333";
    const projectId = "44444444-4444-4444-8444-444444444444";
    const jobId = "55555555-5555-4555-8555-555555555555";
    const stepId = "66666666-6666-4666-8666-666666666666";
    const firstEventId = "77777777-7777-4777-8777-777777777777";
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at) VALUES
          ('${ownerId}','owner@example.test','Owner','member','active',1,1,1),
          ('${otherId}','other@example.test','Other','member','active',1,1,1),
          ('${adminId}','admin@example.test','Admin','admin','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${projectId}','${ownerId}','Project',0,'active',1,1);
        INSERT INTO jobs
          (id,project_id,owner_user_id,type,status,request_json,current_step_key,max_attempts,available_at,created_at,updated_at)
          VALUES ('${jobId}','${projectId}','${ownerId}','asset_ingestion','queued',
                  '{"assetId":"88888888-8888-4888-8888-888888888888","schemaVersion":1}',
                  'inspect_asset',3,1,1,1);
        INSERT INTO job_steps
          (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,created_at,updated_at)
          VALUES ('${stepId}','${jobId}','inspect_asset','','pending',3,1,
                  '{"assetId":"88888888-8888-4888-8888-888888888888","schemaVersion":1}',1,1);
        INSERT INTO job_events (id,job_id,sequence,type,payload_json,created_at)
          VALUES ('${firstEventId}','${jobId}',1,'job.queued',
                  '{"jobId":"${jobId}","schemaVersion":1,"status":"queued"}',1);
      `);
    });
    const repository = new JobRepository(new UuidIdGenerator());
    const service = new JobService({
      transactions: database.transactions,
      clock: { now: () => 10_000 },
      idGenerator: new UuidIdGenerator(),
      applicationKey: new Uint8Array(32).fill(7),
      repository,
      dispatcherSnapshot: () => ({ active: 0, capacity: 2, stopping: false }),
    });
    const owner = session(ownerId, "member");
    const other = session(otherId, "member");
    const admin = session(adminId, "admin");

    try {
      expect(service.list(owner, { limit: 25 }).jobs).toHaveLength(1);
      expect(() => service.get(other, jobId)).toThrowError(/job_not_found/);
      expect(service.resolveEventSequence(owner, jobId, firstEventId)).toBe(1);
      expect(service.listEventsAfter(owner, jobId, 1)).toEqual([]);
      const cancelled = service.cancel(owner, jobId, 1, "cancel-owner-job");
      expect(cancelled.job.status).toBe("cancel_requested");
      expect(service.listAdmin(admin, { limit: 25 }).jobs).toHaveLength(1);
      expect(service.getAdmin(admin, jobId)).toMatchObject({
        schemaVersion: 1,
        job: { id: jobId, status: "cancel_requested" },
        steps: [{ id: stepId }],
      });
      expect(
        service.requestAdminReconcile(
          admin,
          jobId,
          2,
          "Investigate abandoned work",
          "admin-reconcile-job",
        ),
      ).toEqual({ replayed: false });
      expect(service.operations(admin)).toMatchObject({
        schemaVersion: 1,
        cancelRequested: 1,
        dispatcherCapacity: 2,
      });
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              `SELECT
                 (SELECT COUNT(*) FROM outbox_events WHERE topic = 'job.reconcile.requested') AS intents,
                 (SELECT COUNT(*) FROM audit_events WHERE action = 'admin.job_reconcile_requested') AS audits`,
            )
            .get(),
        ),
      ).toEqual({ intents: 1, audits: 1 });
    } finally {
      await database.close();
    }
  });
});

function session(
  userId: string,
  role: "member" | "admin",
): AuthenticatedSession {
  return {
    sessionId: `session-${userId}`,
    user: {
      id: userId,
      email: `${role}@example.test`,
      displayName: role,
      avatarUrl: null,
      role,
      status: "active",
      version: 1,
    },
  };
}
