import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { DatabaseReadiness, SystemDatabase } from "./database.js";

export class SqliteSystemDatabase implements SystemDatabase {
  private constructor(private readonly database: DatabaseSync) {}

  static async connect(databaseUrl: string): Promise<SqliteSystemDatabase> {
    if (!databaseUrl.startsWith("file:")) {
      throw new Error("The SQLite adapter requires a file: DATABASE_URL");
    }
    const databasePath = fileURLToPath(databaseUrl);
    await mkdir(dirname(databasePath), { recursive: true });
    return new SqliteSystemDatabase(new DatabaseSync(databasePath));
  }

  migrate(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS system_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
      VALUES (1, 'foundation_system_tables', datetime('now'));
    `);
  }

  checkReadiness(): Promise<DatabaseReadiness> {
    try {
      const result = this.database.prepare("SELECT 1 AS healthy").get() as
        | { healthy?: number }
        | undefined;
      return Promise.resolve(
        result?.healthy === 1
          ? { status: "ready" }
          : {
              status: "not_ready",
              message: "Database health query returned an unexpected result",
            },
      );
    } catch (error) {
      return Promise.resolve({
        status: "not_ready",
        message:
          error instanceof Error ? error.message : "Unknown database error",
      });
    }
  }

  close(): Promise<void> {
    this.database.close();
    return Promise.resolve();
  }
}
