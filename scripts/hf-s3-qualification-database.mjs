import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { SqliteSystemDatabase } from "../apps/server/dist/database/sqlite-system-database.js";
import { SystemMetadataRepository } from "../apps/server/dist/database/repositories/system-metadata-repository.js";

const [, , command, databasePathArgument, generationArgument] = process.argv;

if (!command || !databasePathArgument) {
  throw new Error(
    "Usage: node scripts/hf-s3-qualification-database.mjs <seed|write|inspect|verify> <database-path> [generation]",
  );
}

const databasePath = resolve(databasePathArgument);
const database = await SqliteSystemDatabase.connect(
  pathToFileURL(databasePath).href,
  { appBuildSha: process.env.GITHUB_SHA ?? "hf-s3-qualification" },
);

try {
  await database.migrate();
  const metadata = new SystemMetadataRepository();

  if (command === "seed" || command === "write") {
    const generation = parseGeneration(generationArgument);
    const writtenAt = Date.now();
    const record = database.transactions.run("immediate", (context) => {
      const current = metadata.get(context, "deployment.runtime");
      return metadata.put(context, {
        key: "deployment.runtime",
        value: {
          qualificationGeneration: generation,
          schemaVersion: 1,
          writtenAt,
        },
        updatedAt: writtenAt,
        expectedVersion: current?.version ?? null,
      });
    });
    process.stdout.write(
      JSON.stringify({
        command,
        generation,
        metadataVersion: record.version,
        writtenAt,
      }) + "\n",
    );
  } else if (command === "inspect" || command === "verify") {
    const expectedGeneration =
      command === "verify" ? parseGeneration(generationArgument) : undefined;
    const readiness = await database.checkReadiness();
    if (readiness.status !== "ready") {
      throw new Error(`Database is not ready: ${readiness.message}`);
    }

    const evidence = database.transactions.run("read", (context) => {
      const quickCheck = context.database.prepare("PRAGMA quick_check").get();
      const foreignKeyFailures = context.database
        .prepare("PRAGMA foreign_key_check")
        .all();
      const ledger = context.database
        .prepare(
          `SELECT version, name, COUNT(*) AS count
           FROM schema_migrations
           GROUP BY version, name
           ORDER BY version`,
        )
        .all();
      const runtime = metadata.get(context, "deployment.runtime");
      return { foreignKeyFailures, ledger, quickCheck, runtime };
    });

    const quickCheckValue = Object.values(evidence.quickCheck ?? {}).at(0);
    if (quickCheckValue !== "ok") throw new Error("quick_check failed");
    if (evidence.foreignKeyFailures.length !== 0) {
      throw new Error("foreign_key_check failed");
    }
    const expectedLedger = [
      { version: 1, name: "foundation_system_tables", count: 1 },
      { version: 2, name: "persistence-kernel", count: 1 },
    ];
    if (JSON.stringify(evidence.ledger) !== JSON.stringify(expectedLedger)) {
      throw new Error("Migration ledger is not exactly v1/v2");
    }
    if (!evidence.runtime) throw new Error("Qualification metadata is missing");

    const value = evidence.runtime.value;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof value.qualificationGeneration !== "number" ||
      typeof value.writtenAt !== "number"
    ) {
      throw new Error("Qualification metadata shape is invalid");
    }
    if (
      expectedGeneration !== undefined &&
      value.qualificationGeneration !== expectedGeneration
    ) {
      throw new Error(
        `Expected generation ${expectedGeneration}, restored ${value.qualificationGeneration}`,
      );
    }

    process.stdout.write(
      JSON.stringify({
        command,
        foreignKeyFailures: evidence.foreignKeyFailures.length,
        generation: value.qualificationGeneration,
        ledger: evidence.ledger,
        metadataVersion: evidence.runtime.version,
        quickCheck: quickCheckValue,
        writtenAt: value.writtenAt,
      }) + "\n",
    );
  } else {
    throw new Error(`Unknown qualification command: ${command}`);
  }
} finally {
  await database.close();
}

function parseGeneration(value) {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Generation must be a positive safe integer");
  }
  return generation;
}
