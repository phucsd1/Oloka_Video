import { z } from "zod";
import { decodeApplicationKey } from "../kernel/app-key.js";

const bootstrapModeSchema = z.enum([
  "fresh-if-replica-missing",
  "restore-required",
]);

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(7860),
    DATABASE_PATH: z
      .string()
      .min(1)
      .default("/var/lib/oloka/database/oloka.db"),
    OBJECT_STORAGE_ROOT: z.string().min(1).default("/data"),
    HF_S3_ENDPOINT: z.url().default("https://s3.hf.co/phucsd"),
    HF_S3_REGION: z.string().min(1).default("us-east-1"),
    HF_S3_BUCKET: z.string().min(1).default("oloka-video-dev-data"),
    HF_S3_SQLITE_PREFIX: z.string().min(1).default("sqlite-replica/dev"),
    HF_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    HF_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    OLOKA_DATABASE_BOOTSTRAP_MODE: bootstrapModeSchema.optional(),
    APP_VERSION: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
      .default("0.1.0"),
    GIT_COMMIT_SHA: z.string().min(1).default("local"),
    BUILD_TIMESTAMP: z.string().min(1).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    OLOKA_APP_KEY: z.string().optional(),
    OLOKA_GOOGLE_OIDC_ISSUER: z.url().optional(),
    OLOKA_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    OLOKA_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    OLOKA_PUBLIC_ORIGIN: z.url().optional(),
    OLOKA_BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
    OLOKA_SESSION_IDLE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(7 * 24 * 60 * 60)
      .default(7 * 24 * 60 * 60),
    OLOKA_SESSION_ABSOLUTE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3600)
      .max(30 * 24 * 60 * 60)
      .default(30 * 24 * 60 * 60),
    OLOKA_OAUTH_TRANSACTION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(15 * 60)
      .default(10 * 60),
  })
  .superRefine((environment, context) => {
    if (
      environment.OLOKA_SESSION_ABSOLUTE_TTL_SECONDS <
      environment.OLOKA_SESSION_IDLE_TTL_SECONDS
    ) {
      context.addIssue({
        code: "custom",
        path: ["OLOKA_SESSION_ABSOLUTE_TTL_SECONDS"],
        message: "absolute session TTL must not be shorter than idle TTL",
      });
    }
    if (environment.NODE_ENV !== "production") return;
    for (const key of [
      "OLOKA_GOOGLE_OIDC_ISSUER",
      "OLOKA_PUBLIC_ORIGIN",
    ] as const) {
      const value = environment[key];
      if (value !== undefined && new URL(value).protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must use HTTPS in production`,
        });
      }
    }
    if (environment.DATABASE_PATH !== "/var/lib/oloka/database/oloka.db") {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_PATH"],
        message:
          "DATABASE_PATH must use the canonical production-local SQLite path",
      });
    }
    if (environment.OBJECT_STORAGE_ROOT !== "/data") {
      context.addIssue({
        code: "custom",
        path: ["OBJECT_STORAGE_ROOT"],
        message: "OBJECT_STORAGE_ROOT must use the persistent /data mount",
      });
    }
    if (environment.HF_S3_SQLITE_PREFIX !== "sqlite-replica/dev") {
      context.addIssue({
        code: "custom",
        path: ["HF_S3_SQLITE_PREFIX"],
        message:
          "HF_S3_SQLITE_PREFIX must use the isolated production replica prefix",
      });
    }
    for (const key of [
      "OLOKA_DATABASE_BOOTSTRAP_MODE",
      "HF_S3_ACCESS_KEY_ID",
      "HF_S3_SECRET_ACCESS_KEY",
      "OLOKA_APP_KEY",
      "OLOKA_GOOGLE_OIDC_ISSUER",
      "OLOKA_GOOGLE_CLIENT_ID",
      "OLOKA_GOOGLE_CLIENT_SECRET",
      "OLOKA_PUBLIC_ORIGIN",
      "OLOKA_BOOTSTRAP_ADMIN_EMAIL",
    ] as const) {
      if (environment[key] === undefined) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required in production`,
        });
      }
    }
  });

export type DatabaseBootstrapMode = z.infer<typeof bootstrapModeSchema>;

export interface AppEnvironment {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databasePath: string;
  objectStorageRoot: string;
  databaseBootstrapMode: DatabaseBootstrapMode;
  hfS3: {
    endpoint: string;
    region: string;
    bucket: string;
    sqlitePrefix: string;
  };
  appVersion: string;
  gitCommitSha: string;
  buildTimestamp: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  appKey?: Uint8Array;
  identity?: {
    googleIssuer: string;
    googleClientId: string;
    googleClientSecret: string;
    publicOrigin: string;
    bootstrapAdminEmail: string;
    sessionIdleTtlMs: number;
    sessionAbsoluteTtlMs: number;
    oauthTransactionTtlMs: number;
  };
}

export function parseEnvironment(input: NodeJS.ProcessEnv): AppEnvironment {
  const parsed = environmentSchema.parse(input);

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    objectStorageRoot: parsed.OBJECT_STORAGE_ROOT,
    databaseBootstrapMode:
      parsed.OLOKA_DATABASE_BOOTSTRAP_MODE ?? "fresh-if-replica-missing",
    hfS3: {
      endpoint: parsed.HF_S3_ENDPOINT,
      region: parsed.HF_S3_REGION,
      bucket: parsed.HF_S3_BUCKET,
      sqlitePrefix: parsed.HF_S3_SQLITE_PREFIX,
    },
    appVersion: parsed.APP_VERSION,
    gitCommitSha: parsed.GIT_COMMIT_SHA,
    buildTimestamp: parsed.BUILD_TIMESTAMP,
    logLevel: parsed.LOG_LEVEL,
    ...(parsed.OLOKA_APP_KEY === undefined
      ? {}
      : { appKey: decodeApplicationKey(parsed.OLOKA_APP_KEY) }),
    ...(parsed.OLOKA_GOOGLE_OIDC_ISSUER === undefined ||
    parsed.OLOKA_GOOGLE_CLIENT_ID === undefined ||
    parsed.OLOKA_GOOGLE_CLIENT_SECRET === undefined ||
    parsed.OLOKA_PUBLIC_ORIGIN === undefined ||
    parsed.OLOKA_BOOTSTRAP_ADMIN_EMAIL === undefined
      ? {}
      : {
          identity: {
            googleIssuer: parsed.OLOKA_GOOGLE_OIDC_ISSUER,
            googleClientId: parsed.OLOKA_GOOGLE_CLIENT_ID,
            googleClientSecret: parsed.OLOKA_GOOGLE_CLIENT_SECRET,
            publicOrigin: normalizeOrigin(parsed.OLOKA_PUBLIC_ORIGIN),
            bootstrapAdminEmail:
              parsed.OLOKA_BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase(),
            sessionIdleTtlMs: parsed.OLOKA_SESSION_IDLE_TTL_SECONDS * 1000,
            sessionAbsoluteTtlMs:
              parsed.OLOKA_SESSION_ABSOLUTE_TTL_SECONDS * 1000,
            oauthTransactionTtlMs:
              parsed.OLOKA_OAUTH_TRANSACTION_TTL_SECONDS * 1000,
          },
        }),
  };
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OLOKA_PUBLIC_ORIGIN must be an origin URL");
  }
  return url.origin;
}
