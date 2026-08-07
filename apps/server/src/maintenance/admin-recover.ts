import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnvironment } from "../config/environment.js";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { SystemClock } from "../kernel/clock.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import { AdminRecoveryService } from "../identity/admin-recovery-service.js";

async function main(): Promise<void> {
  const argumentsByName = parseArguments(process.argv.slice(2));
  const environment = parseEnvironment(process.env);
  if (environment.appKey === undefined || environment.identity === undefined) {
    throw new Error("Identity recovery configuration is incomplete");
  }
  const database = await SqliteSystemDatabase.connect(
    pathToFileURL(environment.databasePath).href,
    {
      appKey: environment.appKey,
      appBuildSha: environment.gitCommitSha,
      backupRoot: join(environment.objectStorageRoot, "backups"),
    },
  );
  try {
    await database.migrate();
    const readiness = await database.checkReadiness();
    if (readiness.status !== "ready") {
      throw new Error("Database is not ready for operator recovery");
    }
    const result = new AdminRecoveryService(
      database.transactions,
      new SystemClock(),
      new UuidIdGenerator(),
      environment.identity.googleIssuer,
    ).recover({
      identityId: argumentsByName.identityId,
      reason: argumentsByName.reason,
    });
    process.stdout.write(`admin_recovery=complete user_id=${result.userId}\n`);
  } finally {
    await database.close();
  }
}

function parseArguments(values: string[]): {
  identityId: string;
  reason: string;
} {
  const read = (name: string): string | undefined => {
    const index = values.indexOf(name);
    return index < 0 ? undefined : values[index + 1];
  };
  const identityId = read("--identity-id");
  const reason = read("--reason");
  if (
    identityId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      identityId,
    ) ||
    reason === undefined
  ) {
    throw new Error(
      "Usage: npm run admin:recover -w @oloka/server -- --identity-id <uuid> --reason <text>",
    );
  }
  return { identityId, reason };
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      code: "ADMIN_RECOVERY_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError",
    })}\n`,
  );
  process.exitCode = 1;
});
