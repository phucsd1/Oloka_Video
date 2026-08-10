import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import { BaselineQuotaPolicyResolver } from "../quota/quota-policy.js";
import {
  JobRetryPolicyRegistry,
  JobRetryService,
  type JobRetryPolicy,
} from "./job-retry-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JobRetryService", () => {
  it("enforces queued, generation, user-render, and system-render limits without durable side effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-retry-quota-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const ids = {
      user: "11111111-1111-4111-8111-111111111111",
      otherUser: "22222222-2222-4222-8222-222222222222",
      project: "33333333-3333-4333-8333-333333333333",
      otherProject: "44444444-4444-4444-8444-444444444444",
      genSource: "55555555-5555-4555-8555-555555555555",
      renderSource: "66666666-6666-4666-8666-666666666666",
      systemRenderSource: "77777777-7777-4777-8777-777777777777",
      queuedSource: "88888888-8888-4888-8888-888888888888",
      activeGen: "99999999-9999-4999-8999-999999999999",
      activeRender: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      activeSystemRender: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${ids.user}','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${ids.otherUser}','other@example.test','Other','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${ids.project}','${ids.user}','Project',0,'active',1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${ids.otherProject}','${ids.otherUser}','Other Project',0,'active',1,1);
      `);
      const terminal = [
        [ids.genSource, ids.project, ids.user, "generation"],
        [ids.renderSource, ids.project, ids.user, "render"],
        [ids.systemRenderSource, ids.otherProject, ids.otherUser, "render"],
        [ids.queuedSource, ids.project, ids.user, "generation"],
      ] as const;
      for (const [id, projectId, userId, type] of terminal)
        connection
          .prepare(
            `INSERT INTO jobs (id,project_id,owner_user_id,type,status,request_json,current_step_key,max_attempts,available_at,failure_code,created_at,started_at,finished_at,updated_at)
           VALUES (?, ?, ?, ?, 'failed', '{"schemaVersion":1}', 'plan', 3, 1, 'FAILED', 1, 2, 3, 3)`,
          )
          .run(id, projectId, userId, type);
      for (const [id, projectId, userId, type] of [
        [ids.activeGen, ids.project, ids.user, "generation"],
        [ids.activeRender, ids.project, ids.user, "render"],
        [ids.activeSystemRender, ids.otherProject, ids.otherUser, "render"],
      ] as const)
        connection
          .prepare(
            `INSERT INTO jobs (id,project_id,owner_user_id,type,status,request_json,current_step_key,max_attempts,available_at,created_at,started_at,updated_at)
           VALUES (?, ?, ?, ?, ?, '{"schemaVersion":1}', 'plan', 3, 1, 1, 2, 2)`,
          )
          .run(
            id,
            projectId,
            userId,
            type,
            type === "render" && id === ids.activeSystemRender
              ? "waiting_provider"
              : "running",
          );
    });
    const plan: JobRetryPolicy = {
      type: "generation",
      plan: () => ({
        request: { schemaVersion: 1 },
        currentStepKey: "plan",
        maxAttempts: 3,
        steps: [
          {
            stepKey: "plan",
            itemKey: "",
            maxAttempts: 3,
            input: { schemaVersion: 1 },
          },
        ],
      }),
    };
    const renderPlan: JobRetryPolicy = { ...plan, type: "render" };
    const actor = (id: string): AuthenticatedSession => ({
      sessionId: `${id}-session`,
      user: {
        id,
        email: `${id}@example.test`,
        displayName: id,
        avatarUrl: null,
        role: "member",
        status: "active",
        version: 1,
      },
    });
    const policy = (limits: {
      queued: number;
      generation: number;
      render: number;
      system: number;
    }) => ({
      version: "test",
      maxVideoDurationSeconds: 60,
      maxResolution: { longEdge: 1920, shortEdge: 1080 },
      maxActiveGenerationPerUser: limits.generation,
      maxActiveRenderPerUser: limits.render,
      maxQueuedJobsPerUser: limits.queued,
      maxActiveRenderSystemDev: limits.system,
      maxAssetSizeBytes: 1_000_000,
      maxProjectStorageBytes: 1_000_000,
      maxRetainedOutputsPerProject: 10,
    });
    const before = database.transactions.run(
      "read",
      ({ database: connection }) =>
        connection.prepare("SELECT COUNT(*) AS jobs FROM jobs").get(),
    );
    const cases = [
      [
        ids.genSource,
        ids.user,
        "generation",
        policy({ queued: 10, generation: 1, render: 10, system: 10 }),
        /active_generation_limit/,
      ],
      [
        ids.renderSource,
        ids.user,
        "render",
        policy({ queued: 10, generation: 10, render: 1, system: 10 }),
        /active_render_limit/,
      ],
      [
        ids.systemRenderSource,
        ids.otherUser,
        "render",
        policy({ queued: 10, generation: 10, render: 10, system: 1 }),
        /active_render_system_limit/,
      ],
      [
        ids.queuedSource,
        ids.user,
        "generation",
        policy({ queued: 0, generation: 10, render: 10, system: 10 }),
        /queued_job_limit/,
      ],
    ] as const;
    try {
      for (const [jobId, userId, type, quota, expected] of cases) {
        const service = new JobRetryService({
          transactions: database.transactions,
          clock: { now: () => 100 },
          idGenerator: new UuidIdGenerator(),
          quotaPolicyResolver: { resolve: () => quota },
          policies: new JobRetryPolicyRegistry([
            type === "render" ? renderPlan : plan,
          ]),
        });
        expect(() =>
          service.retry(actor(userId), jobId, 1, `quota-${jobId}`),
        ).toThrowError(expected);
      }
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection.prepare("SELECT COUNT(*) AS jobs FROM jobs").get(),
        ),
      ).toEqual(before);
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare("SELECT COUNT(*) AS count FROM outbox_events")
            .get(),
        ),
      ).toEqual({ count: 0 });
    } finally {
      await database.close();
    }
  });

  it("keeps the terminal source immutable and idempotently admits a new validated Job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-retry-service-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const ids = {
      user: "11111111-1111-4111-8111-111111111111",
      project: "22222222-2222-4222-8222-222222222222",
      sourceJob: "33333333-3333-4333-8333-333333333333",
      sourceStep: "44444444-4444-4444-8444-444444444444",
    };
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${ids.user}','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${ids.project}','${ids.user}','Project',0,'active',1,1);
        INSERT INTO jobs
          (id,project_id,owner_user_id,type,status,request_json,current_step_key,
           max_attempts,available_at,failure_code,created_at,started_at,finished_at,updated_at)
          VALUES ('${ids.sourceJob}','${ids.project}','${ids.user}','generation','failed',
                  '{"schemaVersion":1}','plan',3,1,'PROVIDER_UNAVAILABLE',1,2,3,3);
        INSERT INTO job_steps
          (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,
           failure_code,created_at,started_at,completed_at,updated_at)
          VALUES ('${ids.sourceStep}','${ids.sourceJob}','plan','','failed',3,1,
                  '{"schemaVersion":1}','PROVIDER_UNAVAILABLE',1,2,3,3);
      `);
    });
    const policy: JobRetryPolicy = {
      type: "generation",
      plan(source) {
        expect(JSON.parse(source.requestJson)).toEqual({ schemaVersion: 1 });
        return {
          request: { schemaVersion: 1 },
          currentStepKey: "plan",
          maxAttempts: 3,
          steps: [
            {
              stepKey: "plan",
              itemKey: "",
              maxAttempts: 3,
              input: { schemaVersion: 1 },
            },
          ],
        };
      },
    };
    const service = new JobRetryService({
      transactions: database.transactions,
      clock: { now: () => 100 },
      idGenerator: new UuidIdGenerator(),
      quotaPolicyResolver: new BaselineQuotaPolicyResolver(),
      policies: new JobRetryPolicyRegistry([policy]),
    });
    const actor: AuthenticatedSession = {
      sessionId: "session",
      user: {
        id: ids.user,
        email: "owner@example.test",
        displayName: "Owner",
        avatarUrl: null,
        role: "member",
        status: "active",
        version: 1,
      },
    };

    try {
      const first = service.retry(actor, ids.sourceJob, 1, "retry-generation");
      expect(first.replayed).toBe(false);
      expect(first.job).toMatchObject({
        type: "generation",
        status: "queued",
        projectId: ids.project,
      });
      expect(first.job.id).not.toBe(ids.sourceJob);
      const replay = service.retry(actor, ids.sourceJob, 1, "retry-generation");
      expect(replay).toMatchObject({
        replayed: true,
        job: { id: first.job.id },
      });
      expect(() =>
        service.retry(actor, ids.sourceJob, 2, "retry-generation"),
      ).toThrowError(/job_retry_idempotency_conflict/);
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              `SELECT
                 (SELECT status FROM jobs WHERE id = ?) AS source_status,
                 (SELECT version FROM jobs WHERE id = ?) AS source_version,
                 (SELECT COUNT(*) FROM jobs) AS jobs,
                 (SELECT COUNT(*) FROM job_steps WHERE job_id = ?) AS new_steps,
                 (SELECT COUNT(*) FROM job_events WHERE job_id = ? AND type = 'job.queued') AS queued_events,
                 (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = ? AND topic = 'job.dispatch.requested') AS wakes,
                 (SELECT COUNT(*) FROM audit_events WHERE resource_id = ? AND action = 'job.retry_admit') AS audits`,
            )
            .get(
              ids.sourceJob,
              ids.sourceJob,
              first.job.id,
              first.job.id,
              first.job.id,
              first.job.id,
            ),
        ),
      ).toEqual({
        source_status: "failed",
        source_version: 1,
        jobs: 2,
        new_steps: 1,
        queued_events: 1,
        wakes: 1,
        audits: 1,
      });
    } finally {
      await database.close();
    }
  });
});
