import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(7860),
  DATA_DIR: z.string().min(1).default("/data"),
  DATABASE_URL: z.string().min(1).optional(),
  APP_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    .default("0.1.0"),
  GIT_COMMIT_SHA: z.string().min(1).default("local"),
  BUILD_TIMESTAMP: z.string().min(1).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export interface AppEnvironment {
  nodeEnv: "development" | "test" | "production";
  port: number;
  dataDir: string;
  databaseUrl: string;
  appVersion: string;
  gitCommitSha: string;
  buildTimestamp: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function parseEnvironment(input: NodeJS.ProcessEnv): AppEnvironment {
  const parsed = environmentSchema.parse(input);
  const databaseUrl =
    parsed.DATABASE_URL ?? `file:${parsed.DATA_DIR}/database/oloka-dev.db`;

  if (
    !databaseUrl.startsWith("file:") &&
    !databaseUrl.startsWith("postgresql://")
  ) {
    throw new Error("DATABASE_URL must use file: or postgresql://");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    dataDir: parsed.DATA_DIR,
    databaseUrl,
    appVersion: parsed.APP_VERSION,
    gitCommitSha: parsed.GIT_COMMIT_SHA,
    buildTimestamp: parsed.BUILD_TIMESTAMP,
    logLevel: parsed.LOG_LEVEL,
  };
}
