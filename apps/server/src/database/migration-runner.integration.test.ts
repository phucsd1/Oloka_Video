import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "./sqlite-system-database.js";
import {
  restoreVerifiedBackup,
  verifyBackupDirectory,
} from "./pre-migration-backup.js";
import { sha256Hex } from "../kernel/canonical-json.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("database migrations", () => {
  it("creates exactly the Slice 3A tables on a fresh database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-migration-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );

    await database.migrate();

    expect(database.listApplicationTables()).toEqual([
      "audit_events",
      "idempotency_records",
      "outbox_events",
      "schema_migrations",
      "system_metadata",
      "users",
    ]);
    const ledger = database.transactions.run(
      "read",
      ({ database: connection }) =>
        connection
          .prepare(
            "SELECT version, name, checksum_sha256, applied_at, execution_ms, app_build_sha FROM schema_migrations ORDER BY version",
          )
          .all(),
    ) as Array<Record<string, unknown>>;
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({
      version: 1,
      name: "foundation_system_tables",
      checksum_sha256:
        "34b305e2ec0bd443813108c8fa68bdb1008e1fef90d3d394f76a5e27e32619c9",
      app_build_sha: "foundation-bootstrap-v1",
    });
    expect(ledger[1]).toMatchObject({
      version: 2,
      name: "persistence-kernel",
      checksum_sha256: sha256Hex(
        await readFile(
          new URL(
            "../../migrations/0002-persistence-kernel.sql",
            import.meta.url,
          ),
        ),
      ),
    });
    await database.close();
  });

  it("refuses to migrate an existing v1 database without an application key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-migration-"));
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
    legacy.close();
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
    );

    await expect(database.migrate()).rejects.toThrow(/application key/i);
    await database.close();
  });

  it("treats a pre-created zero-byte database as fresh and requires no key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "database.sqlite");
    await writeFile(databasePath, new Uint8Array());
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
    );

    await expect(database.migrate()).resolves.toBeUndefined();
    expect(database.listApplicationTables()).toContain("users");
    await database.close();
  });

  it("creates and verifies an authenticated online backup before upgrading v1", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-migration-"));
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
    legacy.close();
    const applicationKey = Buffer.alloc(32, 9);
    const backupRoot = join(directory, "backups");
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
      {
        appKey: applicationKey,
        backupRoot,
        idGenerator: { generate: () => "backup-set-opaque" },
        appBuildSha: "test-build",
      },
    );

    await database.migrate();

    const backupDirectory = join(
      backupRoot,
      "pre-migration",
      "backup-set-opaque",
    );
    const manifest = await verifyBackupDirectory(
      backupDirectory,
      applicationKey,
    );
    expect(manifest).toMatchObject({
      sourceSchemaVersion: 1,
      targetSchemaVersion: 2,
      migrationVersionsPending: [2],
      appBuildSha: "test-build",
    });
    await expect(
      verifyBackupDirectory(backupDirectory, Buffer.alloc(32, 3)),
    ).rejects.toThrow(/authentication/i);
    const restoredPath = join(directory, "restore", "database.sqlite");
    await restoreVerifiedBackup(backupDirectory, restoredPath, applicationKey);
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    expect(
      restored.prepare("SELECT version, name FROM schema_migrations").get(),
    ).toEqual({ version: 1, name: "foundation_system_tables" });
    restored.close();
    await database.close();
  });

  it("is a verified no-op when every migration is already applied", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-migration-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const before = database.transactions.run(
      "read",
      ({ database: connection }) =>
        connection
          .prepare("SELECT * FROM schema_migrations ORDER BY version")
          .all(),
    );

    await database.migrate();

    const after = database.transactions.run(
      "read",
      ({ database: connection }) =>
        connection
          .prepare("SELECT * FROM schema_migrations ORDER BY version")
          .all(),
    );
    expect(after).toEqual(before);
    await database.close();
  });

  it("backs up then fails closed on unknown non-empty legacy metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-migration-"));
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
    legacy
      .prepare(
        "INSERT INTO system_metadata (key, value, updated_at) VALUES ('unknown', 'value', datetime('now'))",
      )
      .run();
    legacy.close();
    const backupRoot = join(directory, "backups");
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
      {
        appKey: Buffer.alloc(32, 8),
        backupRoot,
        idGenerator: { generate: () => "before-metadata-rejection" },
      },
    );

    await expect(database.migrate()).rejects.toThrow(/legacy system metadata/i);
    await expect(
      verifyBackupDirectory(
        join(backupRoot, "pre-migration", "before-metadata-rejection"),
        Buffer.alloc(32, 8),
      ),
    ).resolves.toMatchObject({ sourceSchemaVersion: 1 });
    const ledger = database.transactions.run(
      "read",
      ({ database: connection }) =>
        connection.prepare("SELECT version, name FROM schema_migrations").get(),
    );
    expect(ledger).toEqual({ version: 1, name: "foundation_system_tables" });
    await database.close();
  });
});
