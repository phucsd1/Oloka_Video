import { describe, expect, it } from "vitest";
import {
  adminUsersQuerySchema,
  errorEnvelopeSchema,
  publicErrorCodeSchema,
} from "@oloka/contracts";
import { ApplicationError, publicErrorCatalog } from "./application-error.js";

describe("canonical application errors", () => {
  it("defines the exact public validation error contract", () => {
    expect(publicErrorCatalog.VALIDATION_ERROR).toEqual({
      statusCode: 400,
      retryable: false,
      messageKey: "error.validation",
      suggestedAction: "Correct the indicated fields",
    });
    expect(new ApplicationError("VALIDATION_ERROR")).toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      retryable: false,
    });
  });

  it("covers the complete strict public code allowlist and rejects legacy fields", () => {
    expect(Object.keys(publicErrorCatalog).sort()).toEqual(
      [...publicErrorCodeSchema.options].sort(),
    );
    expect(
      errorEnvelopeSchema.safeParse({
        error: {
          code: "VALIDATION_FAILED",
          retryable: false,
          messageKey: "error.validation",
          suggestedAction: "Correct the indicated fields",
          requestId: "request-1",
          message: "legacy",
          correlationId: "legacy",
        },
      }).success,
    ).toBe(false);
  });

  it("maps every Phase 3B.1 condition to its canonical HTTP status", () => {
    expect(
      Object.fromEntries(
        [
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
          "RATE_LIMITED",
          "INVALID_PROVIDER_RESPONSE",
          "PROVIDER_UNAVAILABLE",
          "PROVIDER_TIMEOUT",
          "INTERNAL_ERROR",
        ].map((code) => [
          code,
          publicErrorCatalog[code as keyof typeof publicErrorCatalog]
            .statusCode,
        ]),
      ),
    ).toEqual({
      VALIDATION_ERROR: 400,
      INVALID_CURSOR: 400,
      AUTHENTICATION_REQUIRED: 401,
      AUTHORIZATION_DENIED: 403,
      ACCOUNT_PENDING: 403,
      ACCOUNT_DISABLED: 403,
      ACCOUNT_REJECTED: 403,
      RESOURCE_NOT_FOUND: 404,
      RESOURCE_STATE_CONFLICT: 409,
      VERSION_CONFLICT: 409,
      IDEMPOTENCY_CONFLICT: 409,
      RATE_LIMITED: 429,
      INVALID_PROVIDER_RESPONSE: 502,
      PROVIDER_UNAVAILABLE: 503,
      PROVIDER_TIMEOUT: 504,
      INTERNAL_ERROR: 500,
    });
  });

  it("defaults admin pagination to 25 and rejects limits above 100", () => {
    expect(adminUsersQuerySchema.parse({}).limit).toBe(25);
    expect(adminUsersQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(adminUsersQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
