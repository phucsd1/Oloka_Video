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

describe("Job heartbeat lease matrix", () => {
  it("accepts only the current live Job and Step authority without changing progress or attempts", async () => {
    const success = await createFixture({});
    try {
      expect(heartbeat(success.database, {})).toEqual({
        jobVersion: 2,
        stepVersion: 2,
        leaseExpiresAt: 61_000,
      });
      expect(readCounters(success.database)).toEqual({
        job_attempts: 2,
        step_attempts: 2,
        progress_basis_points: 4321,
      });
    } finally {
      await success.database.close();
    }

    const cases = [
      { name: "wrong owner", call: { leaseOwner: "worker-b" } },
      { name: "stale Job version", call: { expectedJobVersion: 2 } },
      { name: "stale Step version", call: { expectedStepVersion: 2 } },
      { name: "expired Job lease", seed: { jobLeaseExpiresAt: 1_000 } },
      { name: "expired Step lease", seed: { stepLeaseExpiresAt: 1_000 } },
      { name: "terminal Job", seed: { jobStatus: "failed" as const } },
      { name: "terminal Step", seed: { stepStatus: "failed" as const } },
    ];
    for (const testCase of cases) {
      const fixture = await createFixture(testCase.seed ?? {});
      try {
        expect(
          () => heartbeat(fixture.database, testCase.call ?? {}),
          testCase.name,
        ).toThrowError(/job_lease_conflict/);
        expect(readCounters(fixture.database)).toEqual({
          job_attempts: 2,
          step_attempts: 2,
          progress_basis_points: 4321,
        });
      } finally {
        await fixture.database.close();
      }
    }
  });
});

async function createFixture(input: {
  jobLeaseExpiresAt?: number;
  stepLeaseExpiresAt?: number;
  jobStatus?: "running" | "failed";
  stepStatus?: "running" | "failed";
}): Promise<{ database: SqliteSystemDatabase }> {
  const directory = await mkdtemp(join(tmpdir(), "oloka-heartbeat-"));
  temporaryDirectories.push(directory);
  const database = await SqliteSystemDatabase.connect(
    pathToFileURL(join(directory, "database.sqlite")).href,
  );
  await database.migrate();
  const jobStatus = input.jobStatus ?? "running";
  const stepStatus = input.stepStatus ?? "running";
  database.transactions.run("immediate", ({ database: connection }) => {
    connection.exec(`
      INSERT INTO users
        (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
        VALUES ('11111111-1111-4111-8111-111111111111','owner@example.test','Owner',
                'member','active',1,1,1);
      INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
        VALUES ('22222222-2222-4222-8222-222222222222',
                '11111111-1111-4111-8111-111111111111','Project',0,'active',1,1);
    `);
    connection
      .prepare(
        `INSERT INTO jobs
          (id,project_id,owner_user_id,type,status,request_json,progress_basis_points,
           current_step_key,attempt_count,max_attempts,available_at,lease_owner,
           lease_expires_at,heartbeat_at,finished_at,created_at,updated_at)
         VALUES ('33333333-3333-4333-8333-333333333333',
                 '22222222-2222-4222-8222-222222222222',
                 '11111111-1111-4111-8111-111111111111','asset_ingestion',?,
                 '{"schemaVersion":1,"assetId":"55555555-5555-4555-8555-555555555555"}',
                 4321,'inspect_asset',2,3,1,'worker-a',?,1,?,1,1)`,
      )
      .run(
        jobStatus,
        input.jobLeaseExpiresAt ?? 60_000,
        jobStatus === "failed" ? 1 : null,
      );
    connection
      .prepare(
        `INSERT INTO job_steps
          (id,job_id,step_key,item_key,status,attempt_count,max_attempts,available_at,
           input_json,lease_owner,lease_expires_at,heartbeat_at,completed_at,created_at,updated_at)
         VALUES ('44444444-4444-4444-8444-444444444444',
                 '33333333-3333-4333-8333-333333333333','inspect_asset','',?,2,3,1,
                 '{}','worker-a',?,1,?,1,1)`,
      )
      .run(
        stepStatus,
        input.stepLeaseExpiresAt ?? 60_000,
        stepStatus === "failed" ? 1 : null,
      );
  });
  return { database };
}

function heartbeat(
  database: SqliteSystemDatabase,
  input: {
    leaseOwner?: string;
    expectedJobVersion?: number;
    expectedStepVersion?: number;
  },
): unknown {
  const repository = new JobRepository(new UuidIdGenerator());
  return database.transactions.run("immediate", (context) =>
    repository.heartbeat(context, {
      jobId: "33333333-3333-4333-8333-333333333333",
      stepId: "44444444-4444-4444-8444-444444444444",
      leaseOwner: input.leaseOwner ?? "worker-a",
      expectedJobVersion: input.expectedJobVersion ?? 1,
      expectedStepVersion: input.expectedStepVersion ?? 1,
      now: 1_000,
      leaseDurationMs: 60_000,
    }),
  );
}

function readCounters(database: SqliteSystemDatabase): unknown {
  return database.transactions.run("read", ({ database: connection }) =>
    connection
      .prepare(
        `SELECT j.attempt_count AS job_attempts,
                s.attempt_count AS step_attempts,
                j.progress_basis_points
         FROM jobs j JOIN job_steps s ON s.job_id = j.id`,
      )
      .get(),
  );
}
