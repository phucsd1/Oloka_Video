import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { sha256Hex } from "../kernel/canonical-json.js";
import { verifyBackupDirectory } from "../database/pre-migration-backup.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Private Asset migration v5", () => {
  it("creates only the authorized Asset tables after v4", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-asset-v5-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
      { appBuildSha: "phase3d-test", appKey: Buffer.alloc(32, 3) },
    );

    try {
      await database.migrate();
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .all(),
        ),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
      ]);
      expect(database.listApplicationTables()).toEqual(
        expect.arrayContaining([
          "assets",
          "upload_sessions",
          "delivery_capabilities",
        ]),
      );
      expect(database.listApplicationTables()).not.toEqual(
        expect.arrayContaining(["jobs", "job_steps", "job_events"]),
      );
    } finally {
      await database.close();
    }
  });

  it("creates one verified exact-v4-to-v5 backup and no duplicate on restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-asset-v5-backup-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "database.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(
      await readFile(
        new URL(
          "../../migrations/0001-foundation-system-tables.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const [version, name, filename] of [
      [2, "persistence-kernel", "0002-persistence-kernel.sql"],
      [3, "identity-and-approval", "0003-identity-and-approval.sql"],
      [4, "canonical-project", "0004-canonical-project.sql"],
    ] as const) {
      const bytes = await readFile(
        new URL(`../../migrations/${filename}`, import.meta.url),
      );
      legacy.exec(bytes.toString("utf8"));
      legacy
        .prepare(
          `INSERT INTO schema_migrations
            (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
           VALUES (?, ?, ?, ?, 0, 'phase3c')`,
        )
        .run(version, name, sha256Hex(bytes), version);
    }
    legacy.close();
    const backupRoot = join(directory, "backups");
    const applicationKey = Buffer.alloc(32, 4);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
      {
        appBuildSha: "phase3d-test",
        appKey: applicationKey,
        backupRoot,
        idGenerator: { generate: () => "exact-v4-to-v5" },
      },
    );
    try {
      await database.migrate();
      await expect(
        verifyBackupDirectory(
          join(backupRoot, "pre-migration", "exact-v4-to-v5"),
          applicationKey,
        ),
      ).resolves.toMatchObject({
        sourceSchemaVersion: 4,
        targetSchemaVersion: 5,
        migrationVersionsPending: [5],
      });
      await database.migrate();
      expect(await readdir(join(backupRoot, "pre-migration"))).toEqual([
        "exact-v4-to-v5",
      ]);
    } finally {
      await database.close();
    }
  });
});
