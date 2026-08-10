import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import {
  BaselineQuotaPolicyResolver,
  DatabaseQuotaPolicyResolver,
} from "./quota-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DatabaseQuotaPolicyResolver", () => {
  it("composes active user over system over baseline with half-open intervals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-quota-policy-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const userId = "11111111-1111-4111-8111-111111111111";
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${userId}','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO quota_policies
          (id,scope_type,scope_id,policy_json,effective_from,effective_until,created_at)
          VALUES
          ('22222222-2222-4222-8222-222222222222','system',NULL,
           '{"limits":{"maxAssetSizeBytes":80,"maxQueuedJobsPerUser":2},"schemaVersion":1}',100,300,100),
          ('33333333-3333-4333-8333-333333333333','user','${userId}',
           '{"limits":{"maxAssetSizeBytes":40},"schemaVersion":1}',150,250,150);
      `);
    });
    const resolver = new DatabaseQuotaPolicyResolver(
      database.transactions,
      new BaselineQuotaPolicyResolver({
        maxAssetSizeBytes: 100,
        maxQueuedJobsPerUser: 3,
      }),
    );

    try {
      expect(
        resolver.resolve({ userId, projectId: userId, at: 149 }),
      ).toMatchObject({
        maxAssetSizeBytes: 80,
        maxQueuedJobsPerUser: 2,
      });
      expect(
        resolver.resolve({ userId, projectId: userId, at: 200 }),
      ).toMatchObject({
        maxAssetSizeBytes: 40,
        maxQueuedJobsPerUser: 2,
      });
      expect(
        resolver.resolve({ userId, projectId: userId, at: 250 }),
      ).toMatchObject({
        maxAssetSizeBytes: 80,
        maxQueuedJobsPerUser: 2,
      });
      expect(
        resolver.resolve({ userId, projectId: userId, at: 300 }),
      ).toMatchObject({
        maxAssetSizeBytes: 100,
        maxQueuedJobsPerUser: 3,
      });
    } finally {
      await database.close();
    }
  });
});
