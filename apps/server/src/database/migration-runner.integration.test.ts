import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  it("preserves prior tables and adds only the authorized Slice 3D tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-migration-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );

    await database.migrate();

    expect(database.listApplicationTables()).toEqual([
      "assets",
      "audit_events",
      "delivery_capabilities",
      "idempotency_records",
      "oauth_identities",
      "oauth_transactions",
      "outbox_events",
      "projects",
      "provider_credential_references",
      "schema_migrations",
      "sessions",
      "system_metadata",
      "upload_sessions",
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
    expect(ledger).toHaveLength(5);
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
    expect(ledger[2]).toMatchObject({
      version: 3,
      name: "identity-and-approval",
      checksum_sha256: sha256Hex(
        await readFile(
          new URL(
            "../../migrations/0003-identity-and-approval.sql",
            import.meta.url,
          ),
        ),
      ),
    });
    expect(ledger[3]).toMatchObject({
      version: 4,
      name: "canonical-project",
      checksum_sha256: sha256Hex(
        await readFile(
          new URL(
            "../../migrations/0004-canonical-project.sql",
            import.meta.url,
          ),
        ),
      ),
    });
    expect(ledger[4]).toMatchObject({
      version: 5,
      name: "private-assets",
      checksum_sha256: sha256Hex(
        await readFile(
          new URL("../../migrations/0005-private-assets.sql", import.meta.url),
        ),
      ),
    });
    await database.close();
  });

  it("applies migrations v1 through v5 on a fresh database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-migration-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );

    await database.migrate();

    const ledger = database.transactions.run(
      "read",
      ({ database: connection }) =>
        connection
          .prepare(
            "SELECT version, name FROM schema_migrations ORDER BY version",
          )
          .all(),
    );
    expect(ledger).toEqual([
      { version: 1, name: "foundation_system_tables" },
      { version: 2, name: "persistence-kernel" },
      { version: 3, name: "identity-and-approval" },
      { version: 4, name: "canonical-project" },
      { version: 5, name: "private-assets" },
    ]);
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

  it("rejects a pre-created zero-byte database instead of treating it as fresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "database.sqlite");
    await writeFile(databasePath, new Uint8Array());
    await expect(
      SqliteSystemDatabase.connect(pathToFileURL(databasePath).href),
    ).rejects.toThrow(/zero bytes/i);
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
      targetSchemaVersion: 5,
      migrationVersionsPending: [2, 3, 4, 5],
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

  it("creates one verified v2-to-v5 backup and no new backup on restart", async () => {
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
    const v2Bytes = await readFile(
      new URL("../../migrations/0002-persistence-kernel.sql", import.meta.url),
    );
    legacy.exec(v2Bytes.toString("utf8"));
    legacy
      .prepare(
        `INSERT INTO schema_migrations
          (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
         VALUES (2, 'persistence-kernel', ?, 2, 0, 'slice-3a1')`,
      )
      .run(sha256Hex(v2Bytes));
    legacy.close();
    const backupRoot = join(directory, "backups");
    let id = 0;
    const applicationKey = Buffer.alloc(32, 5);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
      {
        appKey: applicationKey,
        backupRoot,
        appBuildSha: "slice-3b",
        idGenerator: { generate: () => `backup-v3-${++id}` },
      },
    );

    await database.migrate();

    await expect(
      verifyBackupDirectory(
        join(backupRoot, "pre-migration", "backup-v3-1"),
        applicationKey,
      ),
    ).resolves.toMatchObject({
      sourceSchemaVersion: 2,
      targetSchemaVersion: 5,
      migrationVersionsPending: [3, 4, 5],
    });
    await database.migrate();
    expect(await readdir(join(backupRoot, "pre-migration"))).toEqual([
      "backup-v3-1",
    ]);
    await database.close();
  });

  it("creates one verified exact-v3-to-v5 backup and applies later migrations once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-migration-v3-"));
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
    const v2Bytes = await readFile(
      new URL("../../migrations/0002-persistence-kernel.sql", import.meta.url),
    );
    legacy.exec(v2Bytes.toString("utf8"));
    legacy
      .prepare(
        `INSERT INTO schema_migrations
          (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
         VALUES (2, 'persistence-kernel', ?, 2, 0, 'slice-3a1')`,
      )
      .run(sha256Hex(v2Bytes));
    const v3Bytes = await readFile(
      new URL(
        "../../migrations/0003-identity-and-approval.sql",
        import.meta.url,
      ),
    );
    legacy.exec(v3Bytes.toString("utf8"));
    legacy
      .prepare(
        `INSERT INTO schema_migrations
          (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
         VALUES (3, 'identity-and-approval', ?, 3, 0, 'slice-3b')`,
      )
      .run(sha256Hex(v3Bytes));
    legacy.close();
    const backupRoot = join(directory, "backups");
    const applicationKey = Buffer.alloc(32, 7);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
      {
        appKey: applicationKey,
        backupRoot,
        appBuildSha: "slice-3c",
        idGenerator: { generate: () => "backup-v4-exact-v3" },
      },
    );

    await database.migrate();

    await expect(
      verifyBackupDirectory(
        join(backupRoot, "pre-migration", "backup-v4-exact-v3"),
        applicationKey,
      ),
    ).resolves.toMatchObject({
      sourceSchemaVersion: 3,
      targetSchemaVersion: 5,
      migrationVersionsPending: [4, 5],
    });
    const beforeRestart = database.transactions.run("read", ({ database }) =>
      database
        .prepare("SELECT * FROM schema_migrations ORDER BY version")
        .all(),
    );
    await database.migrate();
    const afterRestart = database.transactions.run("read", ({ database }) =>
      database
        .prepare("SELECT * FROM schema_migrations ORDER BY version")
        .all(),
    );
    expect(afterRestart).toEqual(beforeRestart);
    expect(await readdir(join(backupRoot, "pre-migration"))).toEqual([
      "backup-v4-exact-v3",
    ]);
    await database.close();
  });

  it("rolls back v4 when the migration SQL cannot create its table", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "oloka-migration-v4-failure-"),
    );
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
    ] as const) {
      const bytes = await readFile(
        new URL(`../../migrations/${filename}`, import.meta.url),
      );
      legacy.exec(bytes.toString("utf8"));
      legacy
        .prepare(
          `INSERT INTO schema_migrations
            (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
           VALUES (?, ?, ?, ?, 0, 'rollback-fixture')`,
        )
        .run(version, name, sha256Hex(bytes), version);
    }
    legacy.exec("CREATE VIEW projects AS SELECT id FROM users");
    legacy.close();
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
      {
        appKey: Buffer.alloc(32, 6),
        backupRoot: join(directory, "backups"),
        idGenerator: { generate: () => "backup-before-v4-failure" },
      },
    );

    await expect(database.migrate()).rejects.toThrow(/already exists/i);

    const state = database.transactions.run("read", ({ database }) => ({
      versions: database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => (row as { version: number }).version),
      projectObject: database
        .prepare("SELECT type FROM sqlite_schema WHERE name = 'projects'")
        .get(),
      projectIndexes: database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name LIKE 'projects_%_idx'",
        )
        .all(),
    }));
    expect(state.versions).toEqual([1, 2, 3]);
    expect(state.projectObject).toEqual({ type: "view" });
    expect(state.projectIndexes).toEqual([]);
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
