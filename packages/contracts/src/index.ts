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

export const projectStatusSchema = z.enum([
  "active",
  "soft_deleted",
  "purge_scheduled",
  "purging",
  "purged",
]);

const projectNameSchema = z.string().trim().min(1).max(200);
const projectDescriptionSchema = z.string().trim().max(2000).nullable();
const utcTimestampSchema = z.iso.datetime({ offset: true });

export const projectSchema = z
  .object({
    id: z.uuid(),
    name: projectNameSchema,
    description: projectDescriptionSchema,
    favorite: z.boolean(),
    status: projectStatusSchema,
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const projectSummarySchema = projectSchema;

export const createProjectRequestSchema = z
  .object({
    name: projectNameSchema,
    description: z.string().trim().max(2000).optional(),
  })
  .strict();

export const updateProjectRequestSchema = z
  .object({
    name: projectNameSchema.optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    favorite: z.boolean().optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.favorite !== undefined,
    { message: "At least one presentation field is required" },
  );

export const projectMutationRequestSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();

export const projectListQuerySchema = z
  .object({
    cursor: opaqueCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    favorite: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export const projectListResponseSchema = z
  .object({
    projects: z.array(projectSummarySchema).max(100),
    nextCursor: opaqueCursorSchema.nullable(),
  })
  .strict();

export const trashProjectListResponseSchema = projectListResponseSchema;

export const assetKindSchema = z.enum(["image", "video", "audio", "font"]);
export const assetIngestionStatusSchema = z.enum([
  "upload_pending",
  "uploading",
  "processing",
  "ready",
  "failed",
]);
export const assetLifecycleStatusSchema = z.enum([
  "active",
  "soft_deleted",
  "purge_scheduled",
  "purging",
  "purged",
]);
export const uploadSessionStatusSchema = z.enum([
  "open",
  "verifying",
  "completed",
  "aborted",
  "expired",
  "rejected",
]);
export const deliveryOperationSchema = z.enum([
  "stream",
  "preview",
  "download",
]);
export const assetMetadataSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(256), z.number().finite(), z.boolean()]),
);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const filenameSchema = z.string().trim().min(1).max(255);

export const assetSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    originalFilename: filenameSchema,
    kind: assetKindSchema,
    declaredMime: z.string().max(127).nullable(),
    verifiedMime: z.string().max(127).nullable(),
    byteSize: z.number().int().nonnegative().nullable(),
    byteChecksumSha256: sha256Schema.nullable(),
    metadata: assetMetadataSchema.nullable(),
    ingestionStatus: assetIngestionStatusSchema,
    lifecycleStatus: assetLifecycleStatusSchema,
    failureCode: z.string().max(100).nullable(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
    deletedAt: utcTimestampSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict();

export const assetListQuerySchema = z
  .object({
    cursor: opaqueCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    kind: assetKindSchema.optional(),
    ingestionStatus: assetIngestionStatusSchema.optional(),
    lifecycleStatus: assetLifecycleStatusSchema.optional(),
    search: z.string().trim().max(100).optional(),
    uploadedAfter: z.coerce.number().int().nonnegative().optional(),
    uploadedBefore: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export const assetListResponseSchema = z
  .object({
    assets: z.array(assetSchema).max(100),
    nextCursor: opaqueCursorSchema.nullable(),
  })
  .strict();

export const initializeUploadRequestSchema = z
  .object({
    originalFilename: filenameSchema,
    kind: assetKindSchema,
    declaredMime: z.string().trim().min(1).max(127).optional(),
    declaredSize: z.number().int().positive(),
    declaredChecksumSha256: sha256Schema.optional(),
  })
  .strict();

export const uploadSessionSchema = z
  .object({
    uploadId: z.uuid(),
    assetId: z.uuid(),
    projectId: z.uuid(),
    originalFilename: filenameSchema,
    kind: assetKindSchema,
    declaredMime: z.string().max(127).nullable(),
    declaredSize: z.number().int().positive(),
    receivedSize: z.number().int().nonnegative(),
    status: uploadSessionStatusSchema,
    expiresAt: utcTimestampSchema,
    recommendedChunkSize: z.literal(8 * 1024 * 1024),
  })
  .strict();

export const uploadCompleteRequestSchema = z
  .object({ declaredChecksumSha256: sha256Schema.optional() })
  .strict();

export const assetMutationRequestSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();

export const assetRetryIngestionRequestSchema = assetMutationRequestSchema;

export const deliveryCapabilityRequestSchema = z
  .object({ operation: deliveryOperationSchema })
  .strict();

export const deliveryCapabilityResponseSchema = z
  .object({
    capability: z.string().min(32).max(256),
    expiresAt: utcTimestampSchema,
    operation: deliveryOperationSchema,
    assetId: z.uuid(),
  })
  .strict();

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
export type Project = z.infer<typeof projectSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type TrashProjectListResponse = z.infer<
  typeof trashProjectListResponseSchema
>;
export type Asset = z.infer<typeof assetSchema>;
export type AssetListResponse = z.infer<typeof assetListResponseSchema>;
export type AssetListQuery = z.infer<typeof assetListQuerySchema>;
export type InitializeUploadRequest = z.infer<
  typeof initializeUploadRequestSchema
>;
export type UploadSession = z.infer<typeof uploadSessionSchema>;
export type UploadCompleteRequest = z.infer<typeof uploadCompleteRequestSchema>;
export type AssetMutationRequest = z.infer<typeof assetMutationRequestSchema>;
export type AssetRetryIngestionRequest = z.infer<
  typeof assetRetryIngestionRequestSchema
>;
export type DeliveryCapabilityRequest = z.infer<
  typeof deliveryCapabilityRequestSchema
>;
export type DeliveryCapabilityResponse = z.infer<
  typeof deliveryCapabilityResponseSchema
>;
export type PublicErrorCode = z.infer<typeof publicErrorCodeSchema>;
export type AdminUserTransitionRequest = z.infer<
  typeof adminUserTransitionRequestSchema
>;
