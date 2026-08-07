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

export const userRoleSchema = z.enum(["member", "admin"]);
export const userStatusSchema = z.enum([
  "pending",
  "active",
  "disabled",
  "rejected",
]);

export const identityUserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    displayName: z.string().min(1).max(200),
    avatarUrl: z.url().nullable(),
    role: userRoleSchema,
    status: userStatusSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const authSessionResponseSchema = z.discriminatedUnion("authenticated", [
  z.object({ authenticated: z.literal(false) }).strict(),
  z
    .object({ authenticated: z.literal(true), user: identityUserSchema })
    .strict(),
]);

export const csrfResponseSchema = z
  .object({ csrfToken: z.string().min(32).max(200) })
  .strict();

export const sessionSummarySchema = z
  .object({
    id: z.uuid(),
    createdAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    current: z.boolean(),
    userAgentSummary: z.string().max(200).nullable(),
  })
  .strict();

export const sessionsResponseSchema = z
  .object({ sessions: z.array(sessionSummarySchema).max(100) })
  .strict();

export const adminUsersQuerySchema = z
  .object({
    status: userStatusSchema.optional(),
    search: z.string().trim().min(1).max(100).optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const adminUsersResponseSchema = z
  .object({
    users: z.array(identityUserSchema).max(100),
    nextCursor: z.uuid().nullable(),
  })
  .strict();

export const adminUserTransitionRequestSchema = z
  .object({
    status: z.enum(["active", "disabled", "rejected"]),
    role: userRoleSchema.optional(),
    version: z.number().int().positive(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
        message: z.string().min(1).max(500),
        correlationId: z.uuid(),
        retryable: z.boolean(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
export type VersionResponse = z.infer<typeof versionResponseSchema>;
export type IdentityUser = z.infer<typeof identityUserSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type AdminUserTransitionRequest = z.infer<
  typeof adminUserTransitionRequestSchema
>;
