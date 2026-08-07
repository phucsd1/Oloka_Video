# Typed Error Model

This document is the sole source of truth for stable public error codes. Other
documents may name an internal cause, but an API response, durable owner-facing
job event, upload/delivery failure, acceptance criterion, or UI contract may use
only a code in this catalog.

## Envelope and disclosure

Every expected failure returns or records `code`, `retryable`, a localized
`messageKey`, a `suggestedAction`, `requestId`, and optional allowlisted field
details. Protected telemetry may add a redacted internal cause and stack.
Responses and durable safe details never expose secrets, raw provider payloads,
tokens, prompts, filesystem paths, storage keys, or stack traces.

For JSON APIs the exact envelope is `{ error: { code, retryable, messageKey,
suggestedAction, requestId }, details? }`. Optional `details` is a top-level
allowlisted schema; arbitrary keys fail validation. `message`, `correlationId`,
stacks, raw causes, provider responses, database messages, and filesystem paths
are not public fields. Fastify's request ID is reused in the body,
`x-request-id`, and protected log context for the same request. One central
Fastify handler owns mapping: Zod/request failures become `VALIDATION_ERROR`,
typed dependency errors retain their catalog code, and unknown application or
database exceptions become `INTERNAL_ERROR`.

Authentication is evaluated before private-resource lookup where needed to
avoid disclosure. After authentication, a missing resource and a resource owned
by somebody else both return `RESOURCE_NOT_FOUND`. Names such as
project-not-found or asset-not-found may exist only as protected internal cause
categories; they are not public codes.

## Canonical catalog

| Code                        | HTTP | Retryable                     | Public message key                | Suggested action                                 | Internal severity | Allowed surfaces           |
| --------------------------- | ---: | ----------------------------- | --------------------------------- | ------------------------------------------------ | ----------------- | -------------------------- |
| `VALIDATION_ERROR`          |  400 | No until input changes        | `error.validation`                | Correct the indicated fields                     | Info              | API, command               |
| `INVALID_CURSOR`            |  400 | No with same cursor           | `error.cursor.invalid`            | Reload the first page                            | Info              | API                        |
| `AUTHENTICATION_REQUIRED`   |  401 | Yes after login               | `error.auth.required`             | Sign in again with Google                        | Info              | API, UI                    |
| `AUTHORIZATION_DENIED`      |  403 | No                            | `error.auth.denied`               | Return to an allowed surface                     | Warn              | API, admin command         |
| `ACCOUNT_PENDING`           |  403 | Yes after approval            | `error.account.pending`           | Wait for approval or contact an admin            | Info              | API, UI                    |
| `ACCOUNT_DISABLED`          |  403 | No                            | `error.account.disabled`          | Contact an admin                                 | Warn              | API, UI                    |
| `ACCOUNT_REJECTED`          |  403 | No until admin change         | `error.account.rejected`          | Contact an admin if review is needed             | Info              | API, UI                    |
| `RESOURCE_NOT_FOUND`        |  404 | No                            | `error.resource.not_found`        | Refresh the authorized list                      | Info              | API, delivery, upload      |
| `RESOURCE_STATE_CONFLICT`   |  409 | After state changes           | `error.resource.state_conflict`   | Refresh status and retry if eligible             | Info              | API, job, upload           |
| `VERSION_CONFLICT`          |  409 | Yes after refresh             | `error.version.conflict`          | Reload the latest version                        | Info              | API, job worker            |
| `IDEMPOTENCY_CONFLICT`      |  409 | No with same key              | `error.idempotency.conflict`      | Use a new key for changed input                  | Warn              | API, job admission         |
| `UPLOAD_NOT_OPEN`           |  409 | Only with an open session     | `error.upload.not_open`           | Resume or initialize a valid upload              | Info              | Upload API                 |
| `UPLOAD_OFFSET_CONFLICT`    |  409 | Yes from acknowledged offset  | `error.upload.offset_conflict`    | Query and resume at the server offset            | Info              | Upload API                 |
| `ASSET_UNAVAILABLE`         |  409 | Yes after processing/recovery | `error.asset.unavailable`         | Wait, retry ingestion, or select another asset   | Warn              | API, job, preview          |
| `JOB_NOT_CANCELLABLE`       |  409 | No in current state           | `error.job.not_cancellable`       | Refresh job status                               | Info              | API, job command           |
| `CANCELLED`                 |  409 | No                            | `error.job.cancelled`             | Create a new request if needed                   | Info              | Job result, API            |
| `PAYLOAD_TOO_LARGE`         |  413 | No until reduced              | `error.payload.too_large`         | Reduce the request or file size                  | Info              | API, upload                |
| `RANGE_NOT_SATISFIABLE`     |  416 | Yes with a valid range        | `error.range.unsatisfiable`       | Request a valid byte range                       | Info              | Delivery API               |
| `UNSUPPORTED_MEDIA_TYPE`    |  415 | No until replaced             | `error.media.unsupported`         | Use a supported media type                       | Info              | API, upload                |
| `ASSET_INVALID`             |  422 | No until replaced             | `error.asset.invalid`             | Replace or correct the asset                     | Warn              | API, job, upload           |
| `UPLOAD_LENGTH_MISMATCH`    |  422 | No until bytes match          | `error.upload.length_mismatch`    | Restart with the correct declared length         | Warn              | Upload API                 |
| `CHECKSUM_MISMATCH`         |  422 | No until bytes match          | `error.checksum.mismatch`         | Re-upload the verified bytes                     | Warn              | Upload, storage, delivery  |
| `COMPOSITION_INVALID`       |  422 | No until edited/regenerated   | `error.composition.invalid`       | Fix or regenerate the composition                | Warn              | API, job, preview          |
| `DEPENDENCY_MISSING`        |  422 | After dependency repair       | `error.dependency.missing`        | Rebuild or regenerate dependencies               | Error             | Job, preview, render       |
| `PROVIDER_REJECTED`         |  422 | Usually no                    | `error.provider.rejected`         | Adjust content/configuration or contact an admin | Warn              | Job, admin health          |
| `QUALITY_GATE_FAILED`       |  422 | No until new output/settings  | `error.quality.failed`            | Review findings and render again                 | Warn              | Job, output                |
| `RATE_LIMITED`              |  429 | Yes after retry window        | `error.rate_limited`              | Wait for the indicated retry time                | Info              | API, auth, upload          |
| `QUOTA_EXCEEDED`            |  429 | Yes after capacity/action     | `error.quota.exceeded`            | Reduce usage, wait, cancel, or unpin             | Info              | API, upload, job admission |
| `PROVIDER_RATE_LIMITED`     |  429 | Yes after provider window     | `error.provider.rate_limited`     | Wait while the system applies bounded retry      | Warn              | Job, admin health          |
| `INTERNAL_ERROR`            |  500 | Maybe; never unbounded        | `error.internal`                  | Retry later and provide the request ID           | Error             | API, job, admin            |
| `INVALID_PROVIDER_RESPONSE` |  502 | Yes when bounded              | `error.provider.invalid_response` | Retry later; contact an admin if repeated        | Error             | Job, admin health          |
| `RENDER_FAILED`             |  502 | Yes when eligible             | `error.render.failed`             | Retry from an eligible checkpoint                | Error             | Job, output                |
| `STORAGE_UNAVAILABLE`       |  503 | Yes                           | `error.storage.unavailable`       | Retry later                                      | Error             | API, upload, delivery, job |
| `PROVIDER_UNAVAILABLE`      |  503 | Yes                           | `error.provider.unavailable`      | Retry later                                      | Error             | API, job, admin health     |
| `PROVIDER_TIMEOUT`          |  504 | Yes when policy permits       | `error.provider.timeout`          | Wait for reconciliation or retry when eligible   | Warn              | Job, admin health          |

## Mapping rules

1. `QUOTA_EXCEEDED`, `RATE_LIMITED`, and `PROVIDER_RATE_LIMITED` always map
   to HTTP 429; they never map to 409.
2. Stale optimistic versions use `VERSION_CONFLICT`; invalid lifecycle or
   transition state uses `RESOURCE_STATE_CONFLICT`; reuse of a key for different
   semantics uses `IDEMPOTENCY_CONFLICT`.
3. Input shape uses `VALIDATION_ERROR`; typed domain validation uses
   `ASSET_INVALID`, `COMPOSITION_INVALID`, or `QUALITY_GATE_FAILED`.
4. Dependency failures map to `STORAGE_UNAVAILABLE`, `PROVIDER_UNAVAILABLE`,
   or `DEPENDENCY_MISSING`; there is no generic dependency-unavailable code.
5. Provider-specific codes/messages are mapped to this catalog. Raw provider
   text remains protected telemetry after redaction.
6. Retryability is contextual and bounded by attempt/deadline policy;
   `retryable=true` never means infinite retry.
7. Cancellation changes canonical job state to `cancelled`; `CANCELLED` may be
   exposed only as the operation result, not as a manufactured failure.
