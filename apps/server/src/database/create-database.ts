import type { SystemDatabase } from "./database.js";
import { SqliteSystemDatabase } from "./sqlite-system-database.js";
import type { AppEnvironment } from "../config/environment.js";

export async function createDatabase(
  environment: AppEnvironment,
): Promise<SystemDatabase> {
  const { databaseUrl } = environment;
  if (databaseUrl.startsWith("file:")) {
    return SqliteSystemDatabase.connect(databaseUrl, {
      appBuildSha: environment.gitCommitSha,
      appKey: environment.appKey,
      backupRoot: `${environment.dataDir}/backups`,
    });
  }
  if (databaseUrl.startsWith("postgresql://")) {
    throw new Error(
      "PostgreSQL adapter is not enabled in the online development foundation",
    );
  }
  throw new Error("Unsupported DATABASE_URL");
}
