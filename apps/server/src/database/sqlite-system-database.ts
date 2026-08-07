import { access, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { Clock } from "../kernel/clock.js";
import { SystemClock } from "../kernel/clock.js";
import { sha256Hex } from "../kernel/canonical-json.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import {
  PersistenceBusyError,
  type DatabaseReadiness,
  type SystemDatabase,
  type TransactionContext,
  type TransactionMode,
  type TransactionRunner,
} from "./database.js";
import { createPreMigrationBackup } from "./pre-migration-backup.js";
import type { OperationalMetrics } from "../observability/operational-metrics.js";

interface MigrationAsset {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface SqliteConnectionOptions {
  appBuildSha?: string;
  appKey?: Uint8Array;
  backupRoot?: string;
  clock?: Clock;
  idGenerator?: IdGenerator;
  metrics?: OperationalMetrics;
}

class SqliteTransactionRunner implements TransactionRunner {
  private activeMode: TransactionMode | undefined;

  constructor(
    private readonly database: DatabaseSync,
    private readonly metrics?: OperationalMetrics,
  ) {}

  run<T>(
    mode: TransactionMode,
    operation: (context: TransactionContext) => T,
  ): T {
    const startedAt = performance.now();
    if (this.activeMode !== undefined) {
      if (mode !== "read") {
        throw new Error("Nested write transactions are not allowed");
      }
      return this.invoke(operation);
    }

    this.activeMode = mode;
    const begin = mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED";
    try {
      this.database.exec(begin);
      const result = this.invoke(operation);
      this.database.exec(mode === "read" ? "ROLLBACK" : "COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      if (isSqliteBusy(error)) {
        this.metrics?.recordSqliteBusy();
        throw new PersistenceBusyError({ cause: error });
      }
      throw error;
    } finally {
      this.activeMode = undefined;
      const durationMs = performance.now() - startedAt;
      this.metrics?.observe("transaction", durationMs);
      this.metrics?.observe("databaseOperation", durationMs);
    }
  }

  private invoke<T>(operation: (context: TransactionContext) => T): T {
    const result = operation({ database: this.database });
    if (isThenable(result)) {
      throw new TypeError("Transaction callbacks must be synchronous");
    }
    return result;
  }
}

export class SqliteSystemDatabase implements SystemDatabase {
  readonly transactions: TransactionRunner;
  private readonly clock: Clock;
  private readonly appBuildSha: string;
  private readonly appKey: Uint8Array | undefined;
  private readonly backupRoot: string;
  private readonly idGenerator: IdGenerator;
  private readonly metrics: OperationalMetrics | undefined;
  private migrationFailure: string | undefined;
  private expectedMigrationChecksums = new Map<number, string>();

  private constructor(
    private readonly database: DatabaseSync,
    private readonly databasePath: string,
    options: SqliteConnectionOptions,
  ) {
    this.clock = options.clock ?? new SystemClock();
    this.appBuildSha = options.appBuildSha ?? "local";
    this.appKey = options.appKey;
    this.backupRoot =
      options.backupRoot ?? join(dirname(databasePath), "..", "backups");
    this.idGenerator = options.idGenerator ?? new UuidIdGenerator();
    this.metrics = options.metrics;
    this.transactions = new SqliteTransactionRunner(database, options.metrics);
  }

  static async connect(
    databaseUrl: string,
    options: SqliteConnectionOptions = {},
  ): Promise<SqliteSystemDatabase> {
    if (!databaseUrl.startsWith("file:")) {
      throw new Error("The SQLite adapter requires a file URL");
    }
    const databasePath = fileURLToPath(databaseUrl);
    try {
      const existing = await stat(databasePath);
      if (!existing.isFile()) throw new Error("Database path is not a file");
      if (existing.size === 0) throw new Error("Database file is zero bytes");
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    await mkdir(dirname(databasePath), { recursive: true });
    const instance = new SqliteSystemDatabase(
      new DatabaseSync(databasePath),
      databasePath,
      options,
    );
    instance.applyConnectionPragmas();
    return instance;
  }

  async migrate(): Promise<void> {
    const startedAt = performance.now();
    try {
      const migrations = await loadMigrationAssets();
      this.expectedMigrationChecksums = new Map(
        migrations.map((migration) => [migration.version, migration.checksum]),
      );
      const tables = this.listApplicationTables();
      const isFreshDatabase = tables.length === 0;
      if (isFreshDatabase) this.applyFoundationMigration(migrations[0]);
      this.assertKnownSchemaBeforeMigration(migrations);

      let currentVersion = this.currentSchemaVersion();
      if (currentVersion > migrations.length) {
        throw new Error("Database schema is newer than this application build");
      }
      if (!isFreshDatabase && currentVersion < migrations.length) {
        await this.createPendingMigrationBackup(currentVersion, migrations);
      }
      if (currentVersion === 1) {
        this.applyPersistenceKernelMigration(migrations[1]);
        currentVersion = 2;
      }
      if (currentVersion === 2) {
        this.applyIdentityAndApprovalMigration(migrations[2]);
      }
      this.verifyAppliedMigrations(migrations);
      this.migrationFailure = undefined;
    } catch (error) {
      this.migrationFailure = "Database migration verification failed";
      throw error;
    } finally {
      this.metrics?.observe("migration", performance.now() - startedAt);
    }
  }

  listApplicationTables(): string[] {
    return (
      this.database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map(({ name }) => name);
  }

  checkReadiness(): Promise<DatabaseReadiness> {
    const startedAt = performance.now();
    try {
      if (this.migrationFailure !== undefined) {
        return Promise.resolve({
          status: "not_ready",
          message: this.migrationFailure,
        });
      }
      this.verifyConnectionPragmas();
      this.verifyAppliedMigrationsAgainstExpected();
      const foreignKeyFailures = this.database
        .prepare("PRAGMA foreign_key_check")
        .all();
      if (foreignKeyFailures.length > 0) {
        throw new Error("Foreign key verification failed");
      }
      const quickCheck = this.database.prepare("PRAGMA quick_check").get() as
        | Record<string, string>
        | undefined;
      if (quickCheck === undefined || Object.values(quickCheck)[0] !== "ok") {
        throw new Error("SQLite quick integrity check failed");
      }
      return Promise.resolve({ status: "ready" });
    } catch {
      return Promise.resolve({
        status: "not_ready",
        message: "Database integrity verification failed",
      });
    } finally {
      this.metrics?.observe("databaseOperation", performance.now() - startedAt);
    }
  }

  close(): Promise<void> {
    this.database.close();
    return Promise.resolve();
  }

  private applyConnectionPragmas(): void {
    this.database.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    this.verifyConnectionPragmas();
  }

  private verifyConnectionPragmas(): void {
    const scalar = (pragma: string): number | string | undefined => {
      const row = this.database.prepare(pragma).get() as
        | Record<string, number | string>
        | undefined;
      return row === undefined ? undefined : Object.values(row)[0];
    };
    if (
      scalar("PRAGMA foreign_keys") !== 1 ||
      String(scalar("PRAGMA journal_mode")).toLowerCase() !== "wal" ||
      scalar("PRAGMA synchronous") !== 2 ||
      scalar("PRAGMA busy_timeout") !== 5000
    ) {
      throw new Error("Required SQLite connection PRAGMAs are not active");
    }
  }

  private applyFoundationMigration(
    migration: MigrationAsset | undefined,
  ): void {
    if (migration?.version !== 1)
      throw new Error("Foundation migration is missing");
    this.transactions.run("immediate", ({ database }) =>
      database.exec(migration.sql),
    );
  }

  private assertKnownSchemaBeforeMigration(migrations: MigrationAsset[]): void {
    const tables = this.listApplicationTables();
    if (!tables.includes("schema_migrations")) {
      throw new Error("Unrecognized database without a migration ledger");
    }
    const version = this.currentSchemaVersion();
    if (version === 1) {
      const allowed = ["schema_migrations", "system_metadata"];
      if (tables.some((table) => !allowed.includes(table))) {
        throw new Error("Foundation v1 database contains unknown tables");
      }
      const row = this.database
        .prepare("SELECT version, name FROM schema_migrations")
        .all() as { version: number; name: string }[];
      if (
        row.length !== 1 ||
        row[0]?.version !== 1 ||
        row[0].name !== "foundation_system_tables"
      ) {
        throw new Error("Foundation v1 migration identity is invalid");
      }
      this.assertExactFoundationColumns();
      return;
    }
    if (version === 2 || version === 3) {
      const expectedTables =
        version === 2
          ? [
              "audit_events",
              "idempotency_records",
              "outbox_events",
              "schema_migrations",
              "system_metadata",
              "users",
            ]
          : [
              "audit_events",
              "idempotency_records",
              "oauth_identities",
              "oauth_transactions",
              "outbox_events",
              "provider_credential_references",
              "schema_migrations",
              "sessions",
              "system_metadata",
              "users",
            ];
      const applicationTables = tables.filter(
        (table) => !table.startsWith("_litestream_"),
      );
      if (
        JSON.stringify(applicationTables) !== JSON.stringify(expectedTables)
      ) {
        throw new Error(
          `Schema v${version} contains unknown application tables`,
        );
      }
      const rows = this.database
        .prepare(
          "SELECT version, name, checksum_sha256 FROM schema_migrations ORDER BY version",
        )
        .all() as Array<{
        version: number;
        name: string;
        checksum_sha256: string;
      }>;
      if (
        rows.length !== version ||
        rows.some((row, index) => {
          const migration = migrations[index];
          return (
            migration === undefined ||
            row.version !== migration.version ||
            row.name !== migration.name ||
            row.checksum_sha256 !== migration.checksum
          );
        })
      ) {
        throw new Error(`Schema v${version} migration identity is invalid`);
      }
    }
  }

  private assertExactFoundationColumns(): void {
    const columns = (table: string) =>
      (
        this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>
      ).map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
    const expectedLedger = [
      { name: "version", type: "INTEGER", notnull: 0, pk: 1 },
      { name: "name", type: "TEXT", notnull: 1, pk: 0 },
      { name: "applied_at", type: "TEXT", notnull: 1, pk: 0 },
    ];
    const expectedMetadata = [
      { name: "key", type: "TEXT", notnull: 0, pk: 1 },
      { name: "value", type: "TEXT", notnull: 1, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
    ];
    if (
      JSON.stringify(columns("schema_migrations")) !==
        JSON.stringify(expectedLedger) ||
      JSON.stringify(columns("system_metadata")) !==
        JSON.stringify(expectedMetadata)
    ) {
      throw new Error("Foundation v1 table shape is invalid");
    }
  }

  private currentSchemaVersion(): number {
    const row = this.database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    return row.version ?? 0;
  }

  private async createPendingMigrationBackup(
    currentVersion: number,
    migrations: MigrationAsset[],
  ): Promise<void> {
    if (this.appKey === undefined) {
      throw new Error(
        "An application key is required for pre-migration backup",
      );
    }
    await createPreMigrationBackup({
      database: this.database,
      backupRoot: this.backupRoot,
      applicationKey: this.appKey,
      appBuildSha: this.appBuildSha,
      clock: this.clock,
      idGenerator: this.idGenerator,
      sourceSchemaVersion: currentVersion,
      targetSchemaVersion: migrations.length,
      migrationVersionsPending: migrations
        .filter(({ version }) => version > currentVersion)
        .map(({ version }) => version),
    });
  }

  private applyPersistenceKernelMigration(
    migration: MigrationAsset | undefined,
  ): void {
    if (migration?.version !== 2)
      throw new Error("Persistence migration is missing");
    const metadataCount = this.database
      .prepare("SELECT COUNT(*) AS count FROM system_metadata")
      .get() as { count: number };
    if (metadataCount.count !== 0) {
      throw new Error("Legacy system metadata cannot be safely normalized");
    }
    const startedAt = this.clock.now();
    this.transactions.run("immediate", ({ database }) => {
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations
            (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          this.clock.now(),
          Math.max(0, this.clock.now() - startedAt),
          this.appBuildSha,
        );
    });
  }

  private applyIdentityAndApprovalMigration(
    migration: MigrationAsset | undefined,
  ): void {
    if (migration?.version !== 3)
      throw new Error("Identity and approval migration is missing");
    const startedAt = this.clock.now();
    this.transactions.run("immediate", ({ database }) => {
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations
            (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          this.clock.now(),
          Math.max(0, this.clock.now() - startedAt),
          this.appBuildSha,
        );
    });
  }

  private verifyAppliedMigrations(migrations: MigrationAsset[]): void {
    const rows = this.database
      .prepare(
        "SELECT version, name, checksum_sha256 FROM schema_migrations ORDER BY version",
      )
      .all() as { version: number; name: string; checksum_sha256: string }[];
    if (rows.length !== migrations.length) {
      throw new Error("Migration ledger has a version gap");
    }
    for (const [index, migration] of migrations.entries()) {
      const row = rows[index];
      if (
        row?.version !== migration.version ||
        row.name !== migration.name ||
        row.checksum_sha256 !== migration.checksum
      ) {
        throw new Error("Applied migration checksum or identity mismatch");
      }
    }
  }

  private verifyAppliedMigrationsAgainstExpected(): void {
    const rows = this.database
      .prepare(
        "SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version",
      )
      .all() as { version: number; checksum_sha256: string }[];
    if (rows.length !== this.expectedMigrationChecksums.size) {
      throw new Error("Migration count mismatch");
    }
    for (const row of rows) {
      if (
        this.expectedMigrationChecksums.get(row.version) !== row.checksum_sha256
      ) {
        throw new Error("Migration checksum mismatch");
      }
    }
  }
}

async function loadMigrationAssets(): Promise<MigrationAsset[]> {
  const definitions = [
    [1, "foundation_system_tables", "0001-foundation-system-tables.sql"],
    [2, "persistence-kernel", "0002-persistence-kernel.sql"],
    [3, "identity-and-approval", "0003-identity-and-approval.sql"],
  ] as const;
  return Promise.all(
    definitions.map(async ([version, name, filename]) => {
      const url = new URL(`../../migrations/${filename}`, import.meta.url);
      await access(url);
      const bytes = await readFile(url);
      const details = await stat(url);
      if (!details.isFile() || bytes.length === 0) {
        throw new Error(`Migration asset ${version} is invalid`);
      }
      return {
        version,
        name,
        sql: bytes.toString("utf8"),
        checksum: sha256Hex(bytes),
      };
    }),
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    "then" in value
  );
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ERR_SQLITE_ERROR" &&
    /busy|locked/i.test(error.message)
  );
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
