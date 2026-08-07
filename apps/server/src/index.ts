import { buildApplication } from "./app.js";
import { parseEnvironment } from "./config/environment.js";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { OperationalMetrics } from "./observability/operational-metrics.js";

async function start(): Promise<void> {
  const environment = parseEnvironment(process.env);
  const metrics = new OperationalMetrics();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const app = await buildApplication({ environment, metrics });
  let shuttingDown = false;
  const metricsInterval = setInterval(() => {
    metrics.observe("eventLoopDelay", eventLoopDelay.percentile(99) / 1e6);
    eventLoopDelay.reset();
    const snapshot = metrics.snapshot();
    const warning =
      (snapshot.timings.databaseOperation?.p99Ms ?? 0) > 25 ||
      (snapshot.timings.transaction?.p99Ms ?? 0) > 20 ||
      (snapshot.timings.eventLoopDelay?.p99Ms ?? 0) > 50 ||
      snapshot.sqliteBusyCount > 0;
    app.log[warning ? "warn" : "info"](
      { metrics: snapshot },
      "persistence operational metrics",
    );
  }, 60_000);
  metricsInterval.unref();

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(metricsInterval);
    eventLoopDelay.disable();
    app.log.info({ signal }, "graceful shutdown started");
    await app.close();
    process.exitCode = 0;
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: "0.0.0.0", port: environment.port });
  app.log.info(
    {
      port: environment.port,
      environment: environment.nodeEnv,
      version: environment.appVersion,
      gitCommitSha: environment.gitCommitSha,
      persistence: {
        adapter: "sqlite",
        schemaVersion: 2,
        migrationsVerified: true,
      },
      metrics: metrics.snapshot(),
    },
    "Oloka Video is listening",
  );
}

start().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", message: "startup failed", errorCode: "STARTUP_FAILED", errorType: error instanceof Error ? error.name : "UnknownError" })}\n`,
  );
  process.exitCode = 1;
});
