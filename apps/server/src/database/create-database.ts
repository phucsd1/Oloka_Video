import type { SystemDatabase } from "./database.js";
import { SqliteSystemDatabase } from "./sqlite-system-database.js";
import type { AppEnvironment } from "../config/environment.js";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OperationalMetrics } from "../observability/operational-metrics.js";
import { prepareLocalDatabasePath } from "../startup/database-path.js";

export async function createDatabase(
  environment: AppEnvironment,
  metrics?: OperationalMetrics,
): Promise<SystemDatabase> {
  await prepareLocalDatabasePath({
    databasePath: environment.databasePath,
    objectStorageRoot: environment.objectStorageRoot,
  });
  return SqliteSystemDatabase.connect(
    pathToFileURL(environment.databasePath).href,
    {
      appBuildSha: environment.gitCommitSha,
      appKey: environment.appKey,
      backupRoot: join(environment.objectStorageRoot, "backups"),
      metrics,
    },
  );
}
