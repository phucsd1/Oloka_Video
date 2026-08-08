import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Project query plans", () => {
  it("uses the owner/lifecycle index for active and trash listings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-project-plan-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "project.db")).href,
      { appBuildSha: "phase3c-plan", appKey: Buffer.alloc(32, 4) },
    );
    try {
      await database.migrate();
      database.transactions.run("immediate", ({ database }) => {
        const ownerId = "00000000-0000-4000-8000-000000000001";
        database
          .prepare(
            `INSERT INTO users
              (id, email_normalized, display_name, role, status, approved_at,
               created_at, updated_at, version)
             VALUES (?, 'plan@example.test', 'Plan Owner', 'member', 'active',
                     1, 1, 1, 1)`,
          )
          .run(ownerId);
        const insert = database.prepare(
          `INSERT INTO projects
            (id, owner_user_id, name, favorite, status, created_at, updated_at,
             deleted_at, purge_after, retention_policy_version, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        );
        for (let index = 1; index <= 2_000; index += 1) {
          const deleted = index % 2 === 0;
          insert.run(
            `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
            ownerId,
            `Project ${index}`,
            index % 3 === 0 ? 1 : 0,
            deleted ? "soft_deleted" : "active",
            index,
            index,
            deleted ? index : null,
            deleted ? index + 2_592_000_000 : null,
            deleted ? 1 : null,
          );
        }
        database.exec("ANALYZE");
      });
      const details = database.transactions.run("read", ({ database }) =>
        database
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT id, name, favorite, updated_at
               FROM projects
              WHERE owner_user_id = ? AND status = ?
              ORDER BY favorite DESC, updated_at DESC, id DESC
              LIMIT ?`,
          )
          .all("00000000-0000-4000-8000-000000000001", "active", 25)
          .map((row) => String((row as { detail: string }).detail)),
      );

      expect(details.join(" ")).toContain("projects_owner_list_idx");
      expect(details.join(" ")).not.toContain("SCAN projects");
    } finally {
      await database.close();
    }
  });
});
