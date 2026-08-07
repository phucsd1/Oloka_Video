import type { PublicErrorCode } from "@oloka/contracts";

interface PublicErrorDefinition {
  statusCode: number;
  retryable: boolean;
  messageKey: string;
  suggestedAction: string;
}

export const publicErrorCatalog = {
  VALIDATION_ERROR: entry(
    400,
    false,
    "error.validation",
    "Correct the indicated fields",
  ),
  INVALID_CURSOR: entry(
    400,
    false,
    "error.cursor.invalid",
    "Reload the first page",
  ),
  AUTHENTICATION_REQUIRED: entry(
    401,
    true,
    "error.auth.required",
    "Sign in again with Google",
  ),
  AUTHORIZATION_DENIED: entry(
    403,
    false,
    "error.auth.denied",
    "Return to an allowed surface",
  ),
  ACCOUNT_PENDING: entry(
    403,
    true,
    "error.account.pending",
    "Wait for approval or contact an admin",
  ),
  ACCOUNT_DISABLED: entry(
    403,
    false,
    "error.account.disabled",
    "Contact an admin",
  ),
  ACCOUNT_REJECTED: entry(
    403,
    false,
    "error.account.rejected",
    "Contact an admin if review is needed",
  ),
  RESOURCE_NOT_FOUND: entry(
    404,
    false,
    "error.resource.not_found",
    "Refresh the authorized list",
  ),
  RESOURCE_STATE_CONFLICT: entry(
    409,
    false,
    "error.resource.state_conflict",
    "Refresh status and retry if eligible",
  ),
  VERSION_CONFLICT: entry(
    409,
    true,
    "error.version.conflict",
    "Reload the latest version",
  ),
  IDEMPOTENCY_CONFLICT: entry(
    409,
    false,
    "error.idempotency.conflict",
    "Use a new key for changed input",
  ),
  UPLOAD_NOT_OPEN: entry(
    409,
    false,
    "error.upload.not_open",
    "Resume or initialize a valid upload",
  ),
  UPLOAD_OFFSET_CONFLICT: entry(
    409,
    true,
    "error.upload.offset_conflict",
    "Query and resume at the server offset",
  ),
  ASSET_UNAVAILABLE: entry(
    409,
    true,
    "error.asset.unavailable",
    "Wait, retry ingestion, or select another asset",
  ),
  JOB_NOT_CANCELLABLE: entry(
    409,
    false,
    "error.job.not_cancellable",
    "Refresh job status",
  ),
  CANCELLED: entry(
    409,
    false,
    "error.job.cancelled",
    "Create a new request if needed",
  ),
  PAYLOAD_TOO_LARGE: entry(
    413,
    false,
    "error.payload.too_large",
    "Reduce the request or file size",
  ),
  RANGE_NOT_SATISFIABLE: entry(
    416,
    true,
    "error.range.unsatisfiable",
    "Request a valid byte range",
  ),
  UNSUPPORTED_MEDIA_TYPE: entry(
    415,
    false,
    "error.media.unsupported",
    "Use a supported media type",
  ),
  ASSET_INVALID: entry(
    422,
    false,
    "error.asset.invalid",
    "Replace or correct the asset",
  ),
  UPLOAD_LENGTH_MISMATCH: entry(
    422,
    false,
    "error.upload.length_mismatch",
    "Restart with the correct declared length",
  ),
  CHECKSUM_MISMATCH: entry(
    422,
    false,
    "error.checksum.mismatch",
    "Re-upload the verified bytes",
  ),
  COMPOSITION_INVALID: entry(
    422,
    false,
    "error.composition.invalid",
    "Fix or regenerate the composition",
  ),
  DEPENDENCY_MISSING: entry(
    422,
    true,
    "error.dependency.missing",
    "Rebuild or regenerate dependencies",
  ),
  PROVIDER_REJECTED: entry(
    422,
    false,
    "error.provider.rejected",
    "Adjust content/configuration or contact an admin",
  ),
  QUALITY_GATE_FAILED: entry(
    422,
    false,
    "error.quality.failed",
    "Review findings and render again",
  ),
  RATE_LIMITED: entry(
    429,
    true,
    "error.rate_limited",
    "Wait for the indicated retry time",
  ),
  QUOTA_EXCEEDED: entry(
    429,
    true,
    "error.quota.exceeded",
    "Reduce usage, wait, cancel, or unpin",
  ),
  PROVIDER_RATE_LIMITED: entry(
    429,
    true,
    "error.provider.rate_limited",
    "Wait while the system applies bounded retry",
  ),
  INTERNAL_ERROR: entry(
    500,
    true,
    "error.internal",
    "Retry later and provide the request ID",
  ),
  INVALID_PROVIDER_RESPONSE: entry(
    502,
    true,
    "error.provider.invalid_response",
    "Retry later; contact an admin if repeated",
  ),
  RENDER_FAILED: entry(
    502,
    true,
    "error.render.failed",
    "Retry from an eligible checkpoint",
  ),
  STORAGE_UNAVAILABLE: entry(
    503,
    true,
    "error.storage.unavailable",
    "Retry later",
  ),
  PROVIDER_UNAVAILABLE: entry(
    503,
    true,
    "error.provider.unavailable",
    "Retry later",
  ),
  PROVIDER_TIMEOUT: entry(
    504,
    true,
    "error.provider.timeout",
    "Wait for reconciliation or retry when eligible",
  ),
} as const satisfies Record<PublicErrorCode, PublicErrorDefinition>;

export class ApplicationError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(
    readonly code: PublicErrorCode,
    readonly internalCause?: string,
    readonly responseHeaders?: Readonly<Record<string, string>>,
  ) {
    super(internalCause ?? code);
    this.name = "ApplicationError";
    const definition = publicErrorCatalog[code];
    this.statusCode = definition.statusCode;
    this.retryable = definition.retryable;
  }
}

function entry(
  statusCode: number,
  retryable: boolean,
  messageKey: string,
  suggestedAction: string,
): PublicErrorDefinition {
  return { statusCode, retryable, messageKey, suggestedAction };
}
