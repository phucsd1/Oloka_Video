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

export const authSessionResponseSchema = z
  .object({ authenticated: z.literal(true), user: identityUserSchema })
  .strict();

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

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const opaqueCursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

export const adminUsersQuerySchema = z
  .object({
    status: userStatusSchema.optional(),
    search: z.string().trim().min(1).max(100).optional(),
    cursor: opaqueCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const adminUsersResponseSchema = z
  .object({
    users: z.array(identityUserSchema).max(100),
    nextCursor: z.string().min(1).max(2048).nullable(),
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

export const publicErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "INVALID_CURSOR",
  "AUTHENTICATION_REQUIRED",
  "AUTHORIZATION_DENIED",
  "ACCOUNT_PENDING",
  "ACCOUNT_DISABLED",
  "ACCOUNT_REJECTED",
  "RESOURCE_NOT_FOUND",
  "RESOURCE_STATE_CONFLICT",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "UPLOAD_NOT_OPEN",
  "UPLOAD_OFFSET_CONFLICT",
  "ASSET_UNAVAILABLE",
  "JOB_NOT_CANCELLABLE",
  "CANCELLED",
  "PAYLOAD_TOO_LARGE",
  "RANGE_NOT_SATISFIABLE",
  "UNSUPPORTED_MEDIA_TYPE",
  "ASSET_INVALID",
  "UPLOAD_LENGTH_MISMATCH",
  "CHECKSUM_MISMATCH",
  "COMPOSITION_INVALID",
  "DEPENDENCY_MISSING",
  "PROVIDER_REJECTED",
  "QUALITY_GATE_FAILED",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "PROVIDER_RATE_LIMITED",
  "INTERNAL_ERROR",
  "INVALID_PROVIDER_RESPONSE",
  "RENDER_FAILED",
  "STORAGE_UNAVAILABLE",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
]);

export const validationErrorDetailsSchema = z
  .object({
    fieldErrors: z.record(z.string(), z.array(z.string().max(200)).max(10)),
  })
  .strict();

export const errorDetailsSchema = validationErrorDetailsSchema;

export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: publicErrorCodeSchema,
        retryable: z.boolean(),
        messageKey: z.string().min(1).max(200),
        suggestedAction: z.string().min(1).max(500),
        requestId: z.string().min(1).max(200),
      })
      .strict(),
    details: errorDetailsSchema.optional(),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
export type VersionResponse = z.infer<typeof versionResponseSchema>;
export type IdentityUser = z.infer<typeof identityUserSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type PublicErrorCode = z.infer<typeof publicErrorCodeSchema>;
export type AdminUserTransitionRequest = z.infer<
  typeof adminUserTransitionRequestSchema
>;
