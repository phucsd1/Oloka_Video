import { buildApplication } from "./app.js";
import { parseEnvironment } from "./config/environment.js";

async function start(): Promise<void> {
  const environment = parseEnvironment(process.env);
  const app = await buildApplication({ environment });
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
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
