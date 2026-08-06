import { DatabaseSync } from "node:sqlite";
import { lstat } from "node:fs/promises";
import type { DatabaseBootstrapMode } from "../config/environment.js";
import { prepareLocalDatabasePath } from "./database-path.js";

export interface DatabaseBootstrapResult {
  source: "existing" | "restored" | "fresh";
}

export async function bootstrapLocalDatabase(input: {
  databasePath: string;
  objectStorageRoot: string;
  mode: DatabaseBootstrapMode;
  restore: () => Promise<void>;
}): Promise<DatabaseBootstrapResult> {
  const before = await prepareLocalDatabasePath(input);
  if (before.existed) {
    await assertNoRollbackJournal(before.databasePath);
    verifyDatabaseIntegrity(before.databasePath);
    return { source: "existing" };
  }

  await input.restore();
  const after = await prepareLocalDatabasePath(input);
  if (after.existed) {
    await assertNoRollbackJournal(after.databasePath);
    verifyDatabaseIntegrity(after.databasePath);
    return { source: "restored" };
  }
  if (input.mode === "fresh-if-replica-missing") {
    return { source: "fresh" };
  }
  throw new Error("A database replica is required but none was restored");
}

async function assertNoRollbackJournal(databasePath: string): Promise<void> {
  try {
    await lstat(`${databasePath}-journal`);
    throw new Error("Unexpected SQLite rollback journal is present");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

function verifyDatabaseIntegrity(databasePath: string): void {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const quickCheck = database.prepare("PRAGMA quick_check").get() as
      | Record<string, string>
      | undefined;
    if (quickCheck === undefined || Object.values(quickCheck)[0] !== "ok") {
      throw new Error("SQLite quick integrity check failed");
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("SQLite foreign key integrity check failed");
    }
  } catch (error) {
    throw new Error("Local SQLite database integrity validation failed", {
      cause: error,
    });
  } finally {
    database?.close();
  }
}
