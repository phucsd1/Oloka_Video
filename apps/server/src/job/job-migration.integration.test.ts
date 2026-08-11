import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { verifyBackupDirectory } from "../database/pre-migration-backup.js";
import { sha256Hex } from "../kernel/canonical-json.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Durable Job kernel migration v6", () => {
  it("creates the authorized v6 tables and migration ledger entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-v6-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );

    try {
      await database.migrate();

      expect(database.listApplicationTables()).toEqual(
        expect.arrayContaining([
          "jobs",
          "job_steps",
          "job_events",
          "quota_policies",
          "quota_reservations",
        ]),
      );
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              "SELECT version, name FROM schema_migrations ORDER BY version",
            )
            .all(),
        ),
      ).toEqual([
        { version: 1, name: "foundation_system_tables" },
        { version: 2, name: "persistence-kernel" },
        { version: 3, name: "identity-and-approval" },
        { version: 4, name: "canonical-project" },
        { version: 5, name: "private-assets" },
        { version: 6, name: "durable-job-kernel" },
        { version: 7, name: "compositions-preview" },
      ]);
    } finally {
      await database.close();
    }
  });

  it("backfills every v5 upload state into one canonical reservation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-v6-backfill-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "database.sqlite");
    const legacy = new DatabaseSync(databasePath);
    const migrationFiles = [
      "0001-foundation-system-tables.sql",
      "0002-persistence-kernel.sql",
      "0003-identity-and-approval.sql",
      "0004-canonical-project.sql",
      "0005-private-assets.sql",
    ];
    for (const [index, filename] of migrationFiles.entries()) {
      const bytes = await readFile(
        new URL(`../../migrations/${filename}`, import.meta.url),
      );
      legacy.exec(bytes.toString("utf8"));
      if (index > 0) {
        const names = [
          "foundation_system_tables",
          "persistence-kernel",
          "identity-and-approval",
          "canonical-project",
          "private-assets",
        ];
        legacy
          .prepare(
            `INSERT INTO schema_migrations
              (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
             VALUES (?, ?, ?, ?, 0, 'phase3e-backfill')`,
          )
          .run(index + 1, names[index]!, sha256Hex(bytes), index + 1);
      }
    }
    legacy
      .prepare(
        `INSERT INTO users
          (id, email_normalized, display_name, role, status, approved_at, created_at, updated_at)
         VALUES ('11111111-1111-4111-8111-111111111111', 'owner@example.com', 'Owner', 'member', 'active', 1, 1, 1)`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO projects
          (id, owner_user_id, name, description, favorite, status, created_at, updated_at)
         VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'P', NULL, 0, 'active', 1, 1)`,
      )
      .run();
    const states = [
      "open",
      "verifying",
      "completed",
      "aborted",
      "rejected",
      "expired",
    ] as const;
    for (const [index, status] of states.entries()) {
      const id = `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`;
      legacy
        .prepare(
          `INSERT INTO assets
            (id, project_id, owner_user_id, original_filename, kind, storage_key,
             ingestion_status, lifecycle_status, created_at, updated_at)
           VALUES (?, '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', ?, 'image', ?, 'upload_pending', 'active', 1, 1)`,
        )
        .run(id, `${status}.png`, `asset/${id}`);
      legacy
        .prepare(
          `INSERT INTO upload_sessions
            (id, project_id, owner_user_id, asset_id, staging_key, original_filename,
             declared_size, status, expires_at, created_at, updated_at)
           VALUES (?, '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', ?, ?, ?, 10, ?, 10000, 1, 1)`,
        )
        .run(id, id, `staging/${id}`, `${status}.png`, status);
    }
    legacy.close();
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
      {
        appBuildSha: "phase3e-backfill",
        appKey: Buffer.alloc(32, 2),
        backupRoot: join(directory, "backups"),
        idGenerator: { generate: () => "phase3e-v5-backup" },
      },
    );
    try {
      await database.migrate();
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              "SELECT status, amount FROM quota_reservations ORDER BY resource_id",
            )
            .all(),
        ),
      ).toEqual([
        { status: "reserved", amount: 10 },
        { status: "reserved", amount: 10 },
        { status: "consumed", amount: 10 },
        { status: "released", amount: 10 },
        { status: "released", amount: 10 },
        { status: "expired", amount: 10 },
      ]);
      await expect(
        verifyBackupDirectory(
          join(directory, "backups", "pre-migration", "phase3e-v5-backup"),
          Buffer.alloc(32, 2),
        ),
      ).resolves.toMatchObject({
        sourceSchemaVersion: 5,
        targetSchemaVersion: 7,
        migrationVersionsPending: [6, 7],
      });
      await database.migrate();
      expect(
        await readdir(join(directory, "backups", "pre-migration")),
      ).toEqual(["phase3e-v5-backup"]);
    } finally {
      await database.close();
    }
  });
});
