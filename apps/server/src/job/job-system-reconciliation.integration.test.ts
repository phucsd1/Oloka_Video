import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
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

describe("system Asset-ingestion reconciliation", () => {
  it("admits previously accepted work for a disabled owner with system attribution", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "oloka-job-system-reconcile-"),
    );
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const ids = {
      user: "11111111-1111-4111-8111-111111111111",
      project: "22222222-2222-4222-8222-222222222222",
      asset: "33333333-3333-4333-8333-333333333333",
    };
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users
          (id,email_normalized,display_name,role,status,approved_at,disabled_at,created_at,updated_at)
          VALUES ('${ids.user}','owner@example.test','Owner','member','disabled',1,2,1,2);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${ids.project}','${ids.user}','Project',0,'active',1,1);
        INSERT INTO assets
          (id,project_id,owner_user_id,original_filename,kind,storage_key,byte_size,
           metadata_json,ingestion_status,lifecycle_status,created_at,updated_at)
          VALUES ('${ids.asset}','${ids.project}','${ids.user}','clip.mp4','video','asset/key',128,
                  '{}','processing','active',1,1);
      `);
    });
    const service = new JobAdmissionService({
      transactions: database.transactions,
      clock: { now: () => 100 },
      idGenerator: new UuidIdGenerator(),
      quotaPolicyResolver: new BaselineQuotaPolicyResolver(),
    });

    try {
      expect(service.reconcileProcessingAssets()).toBe(1);
      expect(service.reconcileProcessingAssets()).toBe(0);
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              `SELECT
                 (SELECT owner_user_id FROM jobs) AS owner_user_id,
                 (SELECT COUNT(*) FROM jobs) AS jobs,
                 (SELECT actor_type FROM audit_events WHERE action = 'job.reconcile_asset_ingestion') AS actor_type`,
            )
            .get(),
        ),
      ).toEqual({ owner_user_id: ids.user, jobs: 1, actor_type: "system" });
    } finally {
      await database.close();
    }
  });
});
