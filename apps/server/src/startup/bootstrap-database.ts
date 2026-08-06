import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseEnvironment } from "../config/environment.js";
import { OperationalMetrics } from "../observability/operational-metrics.js";
import { bootstrapLocalDatabase } from "./database-bootstrap.js";
import { restoreWithLitestream } from "./litestream-restorer.js";

export async function runDatabaseBootstrap(
  input: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const startedAt = performance.now();
  const environment = parseEnvironment(input);
  const metrics = new OperationalMetrics();
  const result = await bootstrapLocalDatabase({
    databasePath: environment.databasePath,
    objectStorageRoot: environment.objectStorageRoot,
    mode: environment.databaseBootstrapMode,
    restore: async () => {
      const restoreStartedAt = performance.now();
      try {
        await restoreWithLitestream(environment.databasePath);
      } finally {
        metrics.observe("restore", performance.now() - restoreStartedAt);
      }
    },
  });
  metrics.observe("startup", performance.now() - startedAt);
  process.stdout.write(
    `${JSON.stringify({ level: "info", message: "database bootstrap completed", source: result.source, mode: environment.databaseBootstrapMode, metrics: metrics.snapshot() })}\n`,
  );
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  runDatabaseBootstrap().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ level: "fatal", message: "database bootstrap failed", errorCode: "DATABASE_BOOTSTRAP_FAILED", errorType: error instanceof Error ? error.name : "UnknownError" })}\n`,
    );
    process.exitCode = 1;
  });
}
