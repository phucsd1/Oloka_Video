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

describe("Project migration v4", () => {
  it("keeps the Project migration applied under the current schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-project-v4-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "project.db")).href,
      { appBuildSha: "phase3c-test", appKey: Buffer.alloc(32, 4) },
    );

    try {
      await database.migrate();

      const versions = database.transactions.run("read", ({ database }) =>
        database
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => (row as { version: number }).version),
      );
      expect(versions).toEqual([1, 2, 3, 4, 5]);
      expect(database.listApplicationTables()).toContain("projects");
      await expect(database.checkReadiness()).resolves.toEqual({
        status: "ready",
      });
    } finally {
      await database.close();
    }
  });
});
