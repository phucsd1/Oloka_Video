import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  timestamp: z.string(),
});

export const componentReadinessSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  message: z.string().optional(),
});

export const readyResponseSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  checks: z.object({
    database: componentReadinessSchema,
    storage: componentReadinessSchema,
    configuration: componentReadinessSchema,
  }),
});

export const versionResponseSchema = z.object({
  name: z.literal("Oloka Video"),
  version: z.string(),
  environment: z.enum(["development", "test", "production"]),
  gitCommitSha: z.string(),
  buildTimestamp: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
export type VersionResponse = z.infer<typeof versionResponseSchema>;
