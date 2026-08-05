import type { SystemDatabase } from "./database.js";
import { SqliteSystemDatabase } from "./sqlite-system-database.js";

export async function createDatabase(
  databaseUrl: string,
): Promise<SystemDatabase> {
  if (databaseUrl.startsWith("file:")) {
    return SqliteSystemDatabase.connect(databaseUrl);
  }
  if (databaseUrl.startsWith("postgresql://")) {
    throw new Error(
      "PostgreSQL adapter is not enabled in the online development foundation",
    );
  }
  throw new Error("Unsupported DATABASE_URL");
}
