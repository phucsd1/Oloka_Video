import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import { ProviderReconciliationService } from "./job-provider-reconciliation.js";
import { JobRepository } from "./job-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("waiting_provider reconciliation", () => {
  it("polls an accepted operation under a new lease without submitting again", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "oloka-provider-reconcile-"),
    );
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    seedWaitingProvider(database, {
      submissionState: "accepted",
      operationId: "provider-operation-1",
    });
    const poll = vi.fn(() => Promise.resolve({ status: "pending" as const }));
    const lookup = vi.fn(() =>
      Promise.resolve({ status: "not_found" as const }),
    );
    const service = new ProviderReconciliationService({
      transactions: database.transactions,
      repository: new JobRepository(new UuidIdGenerator()),
      clock: { now: () => 100 },
      workerId: "provider-reconciler",
      leaseDurationMs: 60_000,
      adapter: { poll, lookup },
    });

    try {
      await expect(service.runOnce()).resolves.toBe(true);
      expect(poll).toHaveBeenCalledTimes(1);
      expect(poll).toHaveBeenCalledWith("provider-operation-1");
      expect(lookup).not.toHaveBeenCalled();
      expect(readProviderState(database)).toEqual({
        job_status: "waiting_provider",
        step_status: "waiting_provider",
        provider_submission_state: "accepted",
        provider_operation_id: "provider-operation-1",
        provider_submission_attempt: 1,
        job_lease_owner: null,
        step_lease_owner: null,
      });
    } finally {
      await database.close();
    }
  });

  it("looks up an outcome_unknown submission by stable key after restart without resubmitting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-provider-unknown-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    seedRunningProvider(database);
    const repository = new JobRepository(new UuidIdGenerator());
    let submitCount = 0;
    database.transactions.run("immediate", (context) => {
      const intentVersion = repository.recordProviderSubmissionIntent(context, {
        jobId: "33333333-3333-4333-8333-333333333333",
        stepId: "44444444-4444-4444-8444-444444444444",
        leaseOwner: "worker-a",
        expectedVersion: 1,
        now: 10,
        requestHashSha256: "a".repeat(64),
        idempotencyKeyHashSha256: "b".repeat(64),
      });
      submitCount += 1;
      const unknownVersion = repository.recordProviderOutcomeUnknown(context, {
        jobId: "33333333-3333-4333-8333-333333333333",
        stepId: "44444444-4444-4444-8444-444444444444",
        leaseOwner: "worker-a",
        expectedVersion: intentVersion,
        now: 20,
      });
      repository.markWaitingProvider(context, {
        jobId: "33333333-3333-4333-8333-333333333333",
        stepId: "44444444-4444-4444-8444-444444444444",
        leaseOwner: "worker-a",
        expectedJobVersion: 1,
        expectedStepVersion: unknownVersion,
        now: 20,
      });
    });
    const lookup = vi.fn(() =>
      Promise.resolve({
        status: "found" as const,
        operationId: "provider-operation-recovered",
      }),
    );
    const poll = vi.fn(() => Promise.resolve({ status: "pending" as const }));
    const service = new ProviderReconciliationService({
      transactions: database.transactions,
      repository,
      clock: { now: () => 100 },
      workerId: "provider-reconciler-b",
      leaseDurationMs: 60_000,
      adapter: { poll, lookup },
    });

    try {
      await expect(service.runOnce()).resolves.toBe(true);
      expect(submitCount).toBe(1);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledWith("b".repeat(64));
      expect(poll).not.toHaveBeenCalled();
      expect(readProviderState(database)).toMatchObject({
        job_status: "waiting_provider",
        step_status: "waiting_provider",
        provider_submission_state: "accepted",
        provider_operation_id: "provider-operation-recovered",
        provider_submission_attempt: 1,
      });
    } finally {
      await database.close();
    }
  });

  it("does not treat a confirmed-absent lookup as permission to resubmit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-provider-absent-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    seedWaitingProvider(database, {
      submissionState: "outcome_unknown",
      operationId: null,
    });
    const lookup = vi.fn(() =>
      Promise.resolve({ status: "not_found" as const }),
    );
    const poll = vi.fn(() => Promise.resolve({ status: "pending" as const }));
    const service = new ProviderReconciliationService({
      transactions: database.transactions,
      repository: new JobRepository(new UuidIdGenerator()),
      clock: { now: () => 100 },
      workerId: "provider-reconciler",
      leaseDurationMs: 60_000,
      adapter: { poll, lookup },
    });

    try {
      await expect(service.runOnce()).resolves.toBe(true);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(poll).not.toHaveBeenCalled();
      expect(readProviderState(database)).toMatchObject({
        job_status: "waiting_provider",
        step_status: "waiting_provider",
        provider_submission_state: "outcome_unknown",
        provider_operation_id: null,
        provider_submission_attempt: 1,
      });
    } finally {
      await database.close();
    }
  });
});

function seedWaitingProvider(
  database: SqliteSystemDatabase,
  input: {
    submissionState: "accepted" | "outcome_unknown";
    operationId: string | null;
  },
): void {
  database.transactions.run("immediate", ({ database: connection }) => {
    connection
      .prepare(
        `INSERT INTO users
          (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
         VALUES ('11111111-1111-4111-8111-111111111111','owner@example.test','Owner',
                 'member','active',1,1,1)`,
      )
      .run();
    connection
      .prepare(
        `INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
         VALUES ('22222222-2222-4222-8222-222222222222',
                 '11111111-1111-4111-8111-111111111111','Project',0,'active',1,1)`,
      )
      .run();
    connection
      .prepare(
        `INSERT INTO jobs
          (id,project_id,owner_user_id,type,status,request_json,current_step_key,
           max_attempts,available_at,created_at,updated_at)
         VALUES ('33333333-3333-4333-8333-333333333333',
                 '22222222-2222-4222-8222-222222222222',
                 '11111111-1111-4111-8111-111111111111','generation','waiting_provider',
                 '{"schemaVersion":1}','provider_generation',3,1,1,1)`,
      )
      .run();
    connection
      .prepare(
        `INSERT INTO job_steps
          (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,
           provider_submission_state,provider_operation_id,
           provider_request_hash_sha256,provider_idempotency_key_hash_sha256,
           provider_submission_attempt,created_at,updated_at)
         VALUES ('44444444-4444-4444-8444-444444444444',
                 '33333333-3333-4333-8333-333333333333','provider_generation','',
                 'waiting_provider',3,1,'{}',?,?,?, ?,1,1,1)`,
      )
      .run(
        input.submissionState,
        input.operationId,
        "a".repeat(64),
        "b".repeat(64),
      );
  });
}

function readProviderState(database: SqliteSystemDatabase): unknown {
  return database.transactions.run("read", ({ database: connection }) =>
    connection
      .prepare(
        `SELECT j.status AS job_status, s.status AS step_status,
                s.provider_submission_state, s.provider_operation_id,
                s.provider_submission_attempt, j.lease_owner AS job_lease_owner,
                s.lease_owner AS step_lease_owner
         FROM jobs j JOIN job_steps s ON s.job_id = j.id`,
      )
      .get(),
  );
}

function seedRunningProvider(database: SqliteSystemDatabase): void {
  database.transactions.run("immediate", ({ database: connection }) => {
    connection.exec(`
      INSERT INTO users
        (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
        VALUES ('11111111-1111-4111-8111-111111111111','owner@example.test','Owner',
                'member','active',1,1,1);
      INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
        VALUES ('22222222-2222-4222-8222-222222222222',
                '11111111-1111-4111-8111-111111111111','Project',0,'active',1,1);
      INSERT INTO jobs
        (id,project_id,owner_user_id,type,status,request_json,current_step_key,
         max_attempts,available_at,lease_owner,lease_expires_at,heartbeat_at,
         created_at,updated_at)
        VALUES ('33333333-3333-4333-8333-333333333333',
                '22222222-2222-4222-8222-222222222222',
                '11111111-1111-4111-8111-111111111111','generation','running',
                '{"schemaVersion":1}','provider_generation',3,1,'worker-a',50,1,1,1);
      INSERT INTO job_steps
        (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,
         lease_owner,lease_expires_at,heartbeat_at,created_at,updated_at)
        VALUES ('44444444-4444-4444-8444-444444444444',
                '33333333-3333-4333-8333-333333333333','provider_generation','',
                'running',3,1,'{}','worker-a',50,1,1,1);
    `);
  });
}
