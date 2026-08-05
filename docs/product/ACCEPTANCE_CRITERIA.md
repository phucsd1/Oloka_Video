# MVP Acceptance Criteria

Each criterion is independently testable. “API” means the future typed capability, not an implementation created in Phase 1.

## Authentication

| ID         | Given / when / then                                                                                                                  | Planned test               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| AC-AUTH-01 | Given a visitor, when Google OAuth succeeds for an unknown subject, then one User and OAuthIdentity are created with User `pending`. | integration, E2E           |
| AC-AUTH-02 | Given a pending user, when any Project API is requested, then `ACCOUNT_PENDING` is returned before resource access.                  | authorization              |
| AC-AUTH-03 | Given an active user, when Project List is requested with a valid session, then only owned Projects are returned.                    | integration, authorization |
| AC-AUTH-04 | Given a disabled user with an unexpired session, when any product API is requested, then `ACCOUNT_DISABLED` is returned.             | authorization              |
| AC-AUTH-05 | Given a rejected user, when product access is attempted, then access is denied and the account record remains.                       | authorization              |
| AC-AUTH-06 | Given logout, when the old session cookie is reused, then authentication fails.                                                      | integration, security      |
| AC-AUTH-07 | Given an admin approval/disable/reject action, then status, actor and AuditEvent are persisted atomically.                           | integration                |
| AC-AUTH-08 | Given hosted MVP, then password/GitHub/magic-link/anonymous product entry is absent and unreachable.                                 | contract, E2E              |

## Authorization

| ID          | Given / when / then                                                                    | Planned test                    |
| ----------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| AC-AUTHZ-01 | User A cannot read, update, delete or restore User B's Project.                        | authorization                   |
| AC-AUTHZ-02 | User A cannot read, update, sign or use User B's Asset.                                | authorization                   |
| AC-AUTHZ-03 | User A cannot read or edit User B's CompositionVersion.                                | authorization                   |
| AC-AUTHZ-04 | User A cannot read/cancel/retry User B's GenerationJob or RenderJob.                   | authorization                   |
| AC-AUTHZ-05 | User A cannot list, play or download User B's RenderOutput.                            | authorization                   |
| AC-AUTHZ-06 | A traversal-like ID or path field is rejected before any storage adapter call.         | security                        |
| AC-AUTHZ-07 | A client-supplied storage key never overrides server resolution.                       | security, contract              |
| AC-AUTHZ-08 | A system worker without a matching unexpired lease cannot update Job/Step/resources.   | authorization, restart/recovery |
| AC-AUTHZ-09 | An admin read API returns credential metadata/health but never the raw secret.         | authorization, security         |
| AC-AUTHZ-10 | Credential and quota mutations require admin role and create AuditEvents.              | authorization, integration      |
| AC-AUTHZ-11 | An admin has no default capability to download a member's private Asset/output.        | authorization                   |
| AC-AUTHZ-12 | Project/Asset/output purge cannot execute through an ordinary user/admin HTTP request. | architecture, authorization     |

## Projects

| ID         | Given / when / then                                                                               | Planned test                  |
| ---------- | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| AC-PROJ-01 | Creating a Project creates exactly one canonical DB record with opaque server ID and owner.       | integration                   |
| AC-PROJ-02 | Renaming changes presentation only; ID and storage references remain unchanged.                   | unit, integration             |
| AC-PROJ-03 | Project status is independent from every Job status and object existence.                         | contract                      |
| AC-PROJ-04 | Soft delete hides the Project from active list without deleting bytes in the request.             | integration                   |
| AC-PROJ-05 | Trash lists only the owner's soft-deleted Projects.                                               | authorization, integration    |
| AC-PROJ-06 | A Project can be restored before 30 days and before purge lease acquisition.                      | integration                   |
| AC-PROJ-07 | After purge begins or completes, restore returns a stable conflict/not-found state.               | integration, restart/recovery |
| AC-PROJ-08 | `favorite` changes list organization and never changes authorization/lifecycle.                   | unit, authorization           |
| AC-PROJ-09 | No Workspace entity, alias, hidden/default Project or `posted` field is present in MVP contracts. | contract                      |

## Assets

| ID          | Given / when / then                                                                                 | Planned test            |
| ----------- | --------------------------------------------------------------------------------------------------- | ----------------------- |
| AC-ASSET-01 | Upload initialization creates an opaque Asset ID and server-generated storage key.                  | integration             |
| AC-ASSET-02 | Two same-named files in one Project do not conflict in identity.                                    | integration             |
| AC-ASSET-03 | Completion verifies actual size/checksum before `processing`.                                       | integration, security   |
| AC-ASSET-04 | Unsupported/corrupt media never becomes `ready`.                                                    | unit, integration       |
| AC-ASSET-05 | Asset cannot be referenced by a Composition before `ready`.                                         | authorization, contract |
| AC-ASSET-06 | Metadata extraction persists canonical technical metadata in DB, not sidecar files.                 | integration             |
| AC-ASSET-07 | Retry resumes/starts a durable ingestion attempt without duplicate Asset identity.                  | restart/recovery        |
| AC-ASSET-08 | Soft delete removes Asset from active selection and purge cleans bytes asynchronously.              | integration             |
| AC-ASSET-09 | Search uses only original filename, media type, upload time, Project and optional ingestion status. | contract, integration   |
| AC-ASSET-10 | Semantic/embedding/similar/AI/OCR/transcript/duplicate/taxonomy controls are absent.                | E2E, contract           |

## Jobs

| ID        | Given / when / then                                                                                                | Planned test                       |
| --------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| AC-JOB-01 | Accepted generation creates a unique opaque Job ID, idempotency record and durable `queued` state before response. | integration                        |
| AC-JOB-02 | Application restart does not lose an accepted Job/Step record.                                                     | restart/recovery                   |
| AC-JOB-03 | Expired lease allows one new worker to resume from a valid checkpoint.                                             | restart/recovery                   |
| AC-JOB-04 | Two workers cannot commit the same Step under one lease version.                                                   | concurrency, integration           |
| AC-JOB-05 | Replaying a completed Step does not duplicate provider operation/artifact.                                         | integration, provider sandbox      |
| AC-JOB-06 | Same idempotency key/request returns existing Job; different request returns `IDEMPOTENCY_CONFLICT`.               | contract, integration              |
| AC-JOB-07 | Cancel request follows allowed transitions and invalid states return `JOB_NOT_CANCELLABLE`.                        | unit, integration                  |
| AC-JOB-08 | Progress is persisted, monotonic and reaches 100 only with `completed`.                                            | unit, integration                  |
| AC-JOB-09 | Terminal `completed`, `failed` or `cancelled` never returns to running.                                            | unit                               |
| AC-JOB-10 | Provider wait persists operation ID and resumes polling without blind resubmission.                                | provider sandbox, restart/recovery |
| AC-JOB-11 | Per-scene narration failure/retry does not redo completed scene artifacts.                                         | provider sandbox, restart/recovery |
| AC-JOB-12 | Logs/file existence cannot change canonical Job state during restart/reconciliation.                               | integration                        |

## Composition and preview

| ID         | Given / when / then                                                                                           | Planned test               |
| ---------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| AC-COMP-01 | CompositionVersion is immutable after creation.                                                               | unit, integration          |
| AC-COMP-02 | Every accepted edit creates a new monotonically numbered version and updates Project pointer transactionally. | integration                |
| AC-COMP-03 | Invalid schema/unknown style/direct HTML-CSS-JS input is rejected.                                            | contract, security         |
| AC-COMP-04 | Asset reference outside the Project or not `ready` is rejected.                                               | authorization              |
| AC-COMP-05 | Preview and render receive the same exact CompositionVersion ID.                                              | contract, E2E              |
| AC-COMP-06 | Their parity fingerprint matches schema/runtime/dependency/font/asset/caption manifests.                      | contract                   |
| AC-COMP-07 | Voice, caption and BGM edits are structured/versioned rather than DOM mutation.                               | contract                   |
| AC-COMP-08 | Missing or incompatible dependency/font/runtime fails preflight before Modal submission.                      | contract, provider sandbox |
| AC-COMP-09 | Preview is read-only and cannot mutate canonical composition.                                                 | E2E, security              |

## Render and quality

| ID           | Given / when / then                                                                                         | Planned test               |
| ------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------- |
| AC-RENDER-01 | RenderJob is a generic Job subtype and references one immutable CompositionVersion/bundle.                  | contract                   |
| AC-RENDER-02 | Hosted product exposes Modal only; local render is absent from settings and fallback.                       | E2E, contract              |
| AC-RENDER-03 | No playback/download URL/capability exists before output `verified`.                                        | authorization, integration |
| AC-RENDER-04 | Verification confirms object existence, availability, non-zero size and checksum.                           | integration                |
| AC-RENDER-05 | Verification confirms readable container, video stream, dimensions, duration tolerance and codec allowlist. | integration                |
| AC-RENDER-06 | Audio stream requirement matches the Composition request.                                                   | integration                |
| AC-RENDER-07 | Failed technical gate prevents successful GenerationJob completion.                                         | integration                |
| AC-RENDER-08 | Output records schema/protocol/font/renderer/HyperFrames versions and manifest lineage.                     | contract                   |
| AC-RENDER-09 | Technical, visual and human statuses are separate; no generic quality boolean exists.                       | contract                   |
| AC-RENDER-10 | Render retry never overwrites a RenderOutput and reuses only under the explicit identical-hash contract.    | integration                |
| AC-RENDER-11 | Authorized playback/download derives storage capability server-side by immutable output ID.                 | authorization, E2E         |

## Caption

| ID            | Given / when / then                                                        | Planned test                 |
| ------------- | -------------------------------------------------------------------------- | ---------------------------- |
| AC-CAPTION-01 | Vietnamese fixture renders correct diacritics in preview and final output. | visual fixture, localization |
| AC-CAPTION-02 | Wrapping stays within configured maximum line count and safe margins.      | visual fixture               |
| AC-CAPTION-03 | Preview and render use the same versioned font/caption manifests.          | contract, visual fixture     |
| AC-CAPTION-04 | Caption off produces no caption layer.                                     | contract, visual fixture     |
| AC-CAPTION-05 | Only `Clean` and `Bold` are accepted MVP presets.                          | unit, contract               |

## Background music

| ID        | Given / when / then                                                             | Planned test   |
| --------- | ------------------------------------------------------------------------------- | -------------- |
| AC-BGM-01 | A Composition may have no BGM without render failure.                           | integration    |
| AC-BGM-02 | Selected BGM must be a ready audio Asset in the same Project.                   | authorization  |
| AC-BGM-03 | Volume is validated and basic ducking is represented in the versioned document. | unit, contract |
| AC-BGM-04 | Smart selection/global catalog/mood/licensing automation is absent.             | E2E, contract  |

## Retention

| ID        | Given / when / then                                                                        | Planned test                 |
| --------- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| AC-RET-01 | Soft-deleted Project remains restorable for 30 days by default.                            | integration, time-controlled |
| AC-RET-02 | Temporary render bundle is purge-eligible after 24 hours when no active job needs it.      | time-controlled, integration |
| AC-RET-03 | Intermediate artifacts use 7-day and failed diagnostics 30-day defaults.                   | unit                         |
| AC-RET-04 | Pinned RenderOutput is never auto-purged.                                                  | integration                  |
| AC-RET-05 | Output cap is 10 by default and evicts only eligible unpinned output through a system job. | integration                  |
| AC-RET-06 | Purge produces an AuditEvent and does not run in request lifecycle.                        | integration, authorization   |
| AC-RET-07 | Retryable purge failure remains scheduled/recoverable and never claims `purged`.           | restart/recovery             |

## Quota

| ID          | Given / when / then                                                                         | Planned test              |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| AC-QUOTA-01 | Default duration/resolution/asset/storage/output limits match `QUOTA_MODEL.md`.             | unit                      |
| AC-QUOTA-02 | Active/queued generation/render admissions are atomic under concurrency.                    | integration, load         |
| AC-QUOTA-03 | Exceeded quota rejects before accepting Job/upload with stable `QUOTA_EXCEEDED`.            | integration               |
| AC-QUOTA-04 | Response identifies safe limit/current value and suggested action.                          | contract                  |
| AC-QUOTA-05 | Admin override is versioned/audited and domain/routes contain no embedded policy constants. | architecture, integration |

## Errors and diagnostics

| ID        | Given / when / then                                                                       | Planned test           |
| --------- | ----------------------------------------------------------------------------------------- | ---------------------- |
| AC-ERR-01 | Every expected failure uses one stable catalog code and retryable flag.                   | contract               |
| AC-ERR-02 | User message is safe Vietnamese and includes an actionable next step.                     | contract, localization |
| AC-ERR-03 | Response exposes no secret, storage/filesystem path, raw provider payload or stack trace. | security               |
| AC-ERR-04 | Failed Job exposes authorized step, attempt, eligibility and correlation ID.              | integration            |
| AC-ERR-05 | Provider errors map to provider-neutral codes and bounded retry policy.                   | provider sandbox       |
| AC-ERR-06 | Internal error is logged with protected details while response stays generic.             | integration, security  |

## Admin

| ID          | Given / when / then                                                                           | Planned test          |
| ----------- | --------------------------------------------------------------------------------------------- | --------------------- |
| AC-ADMIN-01 | Admin lists pending users and approves one to `active`.                                       | E2E                   |
| AC-ADMIN-02 | Admin disables an active user and existing sessions immediately lose product access.          | integration, E2E      |
| AC-ADMIN-03 | Admin rejects pending user without hard deletion.                                             | integration           |
| AC-ADMIN-04 | Non-admin receives authorization denial for every admin capability.                           | authorization         |
| AC-ADMIN-05 | Failed-job view contains safe state/step/error/timestamps but no private bytes/secrets/paths. | security, E2E         |
| AC-ADMIN-06 | Provider health is distinguishable from configured credentials and successful real use.       | contract              |
| AC-ADMIN-07 | Credential update accepts a reference/write-only value and never returns raw secret.          | security, integration |
| AC-ADMIN-08 | User, credential and quota mutations create actor/target AuditEvents.                         | integration           |

## Security and observability

| ID        | Given / when / then                                                                              | Planned test          |
| --------- | ------------------------------------------------------------------------------------------------ | --------------------- |
| AC-SEC-01 | Session records store token hash, not raw token; cookie attributes meet policy.                  | security              |
| AC-SEC-02 | OAuth callback rejects missing/mismatched/expired state.                                         | security, integration |
| AC-SEC-03 | No production secret/token appears in browser storage, URL, normal DB table or safe log fixture. | security              |
| AC-SEC-04 | Cookie-authenticated mutations reject cross-site requests under chosen CSRF strategy.            | security              |
| AC-SEC-05 | Upload rejects declared/actual size, MIME or checksum mismatch.                                  | security, integration |
| AC-SEC-06 | Signed storage capabilities are short-lived and resource/operation scoped.                       | security              |
| AC-SEC-07 | CI secret/dependency scans enforce documented severity policy.                                   | CI                    |
| AC-SEC-08 | Audit metadata redaction tests reject secrets, tokens, paths and stack traces.                   | unit, security        |
| AC-OBS-01 | Structured request logs contain correlation ID and build SHA.                                    | integration           |
| AC-OBS-02 | Job logs/metrics contain Job/Step/provider operation IDs where applicable.                       | integration           |
| AC-OBS-03 | Health, readiness, version and provider health have distinct semantics.                          | contract, integration |
| AC-OBS-04 | Metrics expose queue age, lease expiry, retry, provider, verification and purge outcomes.        | integration           |

## Accessibility, localization and performance

| ID        | Given / when / then                                                                                             | Planned test                  |
| --------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| AC-NFR-01 | Primary flows are keyboard operable with visible focus and semantic names.                                      | accessibility, E2E            |
| AC-NFR-02 | Contrast is WCAG 2.2 AA and status is not color-only.                                                           | accessibility                 |
| AC-NFR-03 | Product UI respects reduced-motion preference.                                                                  | accessibility, visual fixture |
| AC-NFR-04 | UTF-8 Vietnamese fixtures pass through input, DB, errors, composition and captions unchanged.                   | localization, integration     |
| AC-NFR-05 | Warm valid preview starts within p95 5 seconds under the documented test profile.                               | load, E2E                     |
| AC-NFR-06 | Health/readiness meet p95 250 ms/1 s targets under the documented profile.                                      | load                          |
| AC-NFR-07 | Project List and Asset search meet p95 500 ms target at stated fixture sizes.                                   | load                          |
| AC-NFR-08 | Job status meets p95 300 ms and upload initiation p95 500 ms excluding transfer.                                | load                          |
| AC-NFR-09 | External provider duration is measured separately and bounded by step deadlines, not hidden in API latency SLA. | contract, observability       |
| AC-NFR-10 | Dates display in selected locale/time zone while stored timestamps remain UTC.                                  | localization                  |
| AC-NFR-11 | Stable error code is identical across localized safe messages.                                                  | contract, localization        |
| AC-NFR-12 | Loading/progress/error announcements are accessible without excessive live-region repetition.                   | accessibility, E2E            |

## Deployment

| ID           | Given / when / then                                                                          | Planned test                  |
| ------------ | -------------------------------------------------------------------------------------------- | ----------------------------- |
| AC-DEPLOY-01 | Runtime metadata exposes the validated Git source SHA.                                       | integration, deployment smoke |
| AC-DEPLOY-02 | Validation failure prevents the HF sync job.                                                 | CI                            |
| AC-DEPLOY-03 | HF sync deploys the exact validated commit only after validation.                            | CI, deployment smoke          |
| AC-DEPLOY-04 | Cloudflare, D1, R2 and dual topology are absent from MVP architecture/runtime configuration. | architecture, contract        |
| AC-DEPLOY-05 | Database and object storage readiness are checked independently from liveness.               | integration                   |
| AC-DEPLOY-06 | Rebuild/restart preserves canonical data and resumes eligible durable Jobs.                  | restart/recovery              |
| AC-DEPLOY-07 | Modal protocol is versioned and incompatible runtime versions are rejected before rendering. | contract, provider sandbox    |
