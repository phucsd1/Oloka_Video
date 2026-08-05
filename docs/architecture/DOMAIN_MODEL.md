# MVP Domain Model

## Purpose

This document defines canonical product entities for Oloka Video MVP. Database state is authoritative for business state; object storage owns bytes only. Log text, filesystem paths, object existence, and browser state never determine lifecycle state.

All IDs are opaque, server-generated, globally unique identifiers. Timestamps are UTC instants. Domain records use optimistic concurrency or equivalent transaction guards. No Workspace entity exists in MVP.

## Aggregate map

```mermaid
erDiagram
  USER ||--o{ OAUTH_IDENTITY : has
  USER ||--o{ SESSION : owns
  USER ||--o{ PROJECT : owns
  PROJECT ||--o{ ASSET : contains
  PROJECT ||--o{ COMPOSITION_VERSION : versions
  PROJECT ||--o{ GENERATION_JOB : requests
  JOB ||--o{ JOB_STEP : records
  GENERATION_JOB ||--o{ RENDER_JOB : creates
  RENDER_JOB ||--o{ RENDER_OUTPUT : produces
  COMPOSITION_VERSION ||--o{ RENDER_OUTPUT : rendered_as
  USER ||--o{ AUDIT_EVENT : acts
  QUOTA_POLICY }o--|| USER : may_override
```

`JOB` is a logical durable aggregate with a `jobType` discriminator. `GenerationJob` and `RenderJob` are typed subtypes sharing state, lease, heartbeat, idempotency, cancellation, retry, and step semantics. This decision is recorded in ADR 0009.

## User

| Field                      | Contract                                              |
| -------------------------- | ----------------------------------------------------- |
| `id`                       | Opaque ID                                             |
| `email`                    | Normalized Google email; unique under identity policy |
| `displayName`, `avatarUrl` | Profile presentation fields                           |
| `status`                   | `pending`, `active`, `disabled`, `rejected`           |
| `role`                     | `member`, `admin`                                     |
| `approvedAt`, `approvedBy` | Required after approval                               |
| `disabledAt`               | Set when disabled                                     |
| `createdAt`, `updatedAt`   | Audit timestamps                                      |

An authenticated Google identity creates a `pending` user. `disabled` and `rejected` users retain records and audit history. Access revocation does not hard-delete the user.

## OAuthIdentity

Fields: `id`, `userId`, `provider`, `providerSubject`, `providerEmail`, `createdAt`, `updatedAt`. MVP permits only `provider=google`. `(provider, providerSubject)` is unique. Long-lived access tokens are not stored unless a later capability requires them.

## Session

Fields: `id`, `userId`, `tokenHash`, `expiresAt`, `revokedAt`, `createdAt`, `lastSeenAt`, `ipHash`, `userAgentSummary`. The browser receives only a secure cookie containing the raw bearer value; storage keeps its hash. Logout, user disable, and security action can revoke sessions immediately.

## Project

| Field                         | Contract                                                         |
| ----------------------------- | ---------------------------------------------------------------- |
| `id`, `ownerId`               | Opaque identity and single owner                                 |
| `name`, `description`         | Mutable presentation fields                                      |
| `favorite`                    | List-organization boolean only                                   |
| `status`                      | `active`, `soft_deleted`, `purge_scheduled`, `purging`, `purged` |
| `currentCompositionVersionId` | Nullable pointer to an immutable version in this project         |
| `deletedAt`, `purgeAfter`     | Soft-delete and retention timestamps                             |
| `purgedAt`                    | Purge completion timestamp; required on the retained tombstone   |
| `retentionPolicyVersion`      | Policy version that authorized purge                             |
| `safeAuditReferences`         | Privacy-safe references to append-only purge/audit evidence      |
| `createdAt`, `updatedAt`      | Audit timestamps                                                 |

Project status is independent of generation/render job status. A project never uses name, slug, storage key, or filesystem path as identity. There is no `posted` field and no special project named `workspace`.

Purge retains a minimal Project tombstone: opaque `id`, an owner reference or privacy-safe owner lineage, `status=purged`, `purgedAt`, `retentionPolicyVersion`, and safe audit references. Presentation fields may be redacted. The tombstone cannot be restored; a purge manifest removes dependent private bytes and active domain records while append-only audit evidence remains.

## Asset

Fields: `id`, `ownerId`, `projectId`, `storageKey`, `originalFilename`, `mimeType`, `mediaType`, `sizeBytes`, `checksum`, `ingestionStatus`, `lifecycleStatus`, `technicalMetadata`, `createdAt`, `deletedAt`, `purgeScheduledAt`, `purgedAt`.

`mediaType` is a controlled value such as `image`, `video`, or `audio`. Ingestion and lifecycle are independent axes:

- `ingestionStatus`: `upload_pending`, `uploading`, `processing`, `ready`, `failed`.
- `lifecycleStatus`: `active`, `soft_deleted`, `purge_scheduled`, `purging`, `purged`.

A new Asset is `upload_pending + active`. Only `ready + active` assets are referenceable by a CompositionVersion. Soft delete, restore, and purge change lifecycle or byte availability only; they never rewrite the ingestion result. Thus `failed + active` can retry and `ready + soft_deleted` restores to `ready + active`. `storageKey` is generated server-side and is never accepted as authorization input from a client. Duplicate filenames are permitted. Searchable MVP fields are original filename, media type, upload time, project, ingestion status, and lifecycle/trash context.

## CompositionVersion

Fields: `id`, `projectId`, `versionNumber`, `schemaVersion`, `document`, `dependencyManifest`, `assetManifest`, `fontManifest`, `captionManifest`, `rendererVersion`, `hyperframesVersion`, `renderProtocolVersion`, `createdByUserId`, `createdByJobId`, `createdAt`.

The entity is immutable. Any structured edit creates the next version transactionally and may update `Project.currentCompositionVersionId`. The canonical `document` is structured data, never arbitrary HTML/CSS/JavaScript.

## Job base and GenerationJob

Every Job has: `id`, `jobType`, nullable `parentJobId`, `projectId`, `requestedByUserId`, `idempotencyKey`, `state`, `currentStep`, `progress`, `attempt`, `leaseOwner`, `leaseExpiresAt`, `heartbeatAt`, `cancelRequestedAt`, `errorCode`, `errorDetailsSafe`, `createdAt`, `startedAt`, `completedAt`, `updatedAt`.

`GenerationJob` adds `baseCompositionVersionId` and generation request/checkpoint references and always has `parentJobId=null`. One project may have many jobs. Idempotency uniqueness is scoped to requester and command semantics, not project ID.

## JobStep

Fields: `id`, `jobId`, nullable `parentStepId`, nullable `itemKey`, `stepName`, `state`, `attempt`, `inputArtifactReferences`, `outputArtifactReferences`, `providerOperationId`, `idempotencyKey`, `lease`, `timeoutAt`, `errorCode`, `startedAt`, `completedAt`.

Step states are exactly `pending`, `running`, `waiting_provider`, `retry_scheduled`, `completed`, `skipped`, `cancelled`, and `failed`; the last four are terminal. Step artifacts are immutable references. Completed steps cannot be silently rewritten.

`generate_narration` is a parent JobStep. Each required scene is a child JobStep with `parentStepId` referencing that parent and `itemKey=sceneId`; each item independently owns state, attempt, provider operation ID, and checkpoint. The parent completes only when all required items are `completed` or validly `skipped`, so retrying one scene cannot redo a completed scene.

## RenderJob

`RenderJob` is a `jobType=render` subtype of Job. It adds `compositionVersionId`, `renderRequestHash`, `bundleReference`, `bundleChecksum`, `rendererVersion`, `renderProtocolVersion`, requested dimensions, provider credential reference, and `providerOperationId`. A GenerationJob creates or idempotently reuses a child RenderJob during `submit_render`; that child has `parentJobId=GenerationJob.id`. User-triggered rerender creates a standalone RenderJob with `parentJobId=null`. One GenerationJob may have zero or many RenderJobs. Parent and child must share Project lineage and authorization; a child has no ownership independent of its Project.

A RenderJob may be reused only when Project, CompositionVersion, `bundleChecksum`, render request hash, `rendererVersion`, `renderProtocolVersion`, and provider operation identity/idempotency contract all match.

## RenderOutput

RenderOutput has immutable output identity, bytes, media metadata and lineage. Its immutable core is:

- Identity and bytes: `id`, `projectId`, `compositionVersionId`, `renderJobId`, `storageKey`, `checksum`, `sizeBytes`, `createdAt`.
- Media metadata: `durationMs`, `width`, `height`, `videoCodec`, `audioCodec`.
- Canonical render lineage: `bundleChecksum`, `compositionSchemaVersion`, `renderProtocolVersion`, `rendererVersion`, `hyperframesVersion`, `dependencyManifestHash`, `assetManifestHash`, `fontManifestHash`, `captionManifestHash`, and `renderContractFingerprint`.

The guarded mutable lifecycle fields are `availabilityState`, `technicalStatus`, `visualReviewStatus`, `humanApprovalStatus`, `retentionState`, `pinned`, `verifiedAt`, `purgeScheduledAt`, and `purgedAt`. Every mutation requires an allowed transition, concurrency guard, and audit event; none may alter the immutable core.

The allowed state values are:

- `availabilityState`: `pending`, `uploaded`, `verifying`, `verified`, `failed_verification`, `unavailable`.
- `retentionState`: `active`, `purge_scheduled`, `purging`, `purged`.
- `technicalStatus`: `pending`, `passed`, `failed`.
- `visualReviewStatus`: `not_reviewed`, `passed`, `failed`.
- `humanApprovalStatus`: `not_required`, `pending`, `approved`, `rejected`.

`pinned` is independent and blocks automatic purge scheduling. A valid output can be `verified + active` with either pin value. Purge completion sets `retentionState=purged` and `availabilityState=unavailable`; playback/download is then denied. Object existence never changes either state automatically. Otherwise playback/download is allowed only when availability is `verified`, retention is `active`, technical status is `passed`, and authorization succeeds.

The render contract fingerprint is a deterministic hash of a canonically serialized, versioned structure containing the canonical lineage fields above. Those scalar hashes and versions are stored directly in the immutable RenderOutput snapshot; larger immutable manifests and the bundle are referenced by their hashes. Verification compares the recorded values with inspected artifacts, preview reports the same fingerprint, and provider adapters reject incompatible protocol or lineage before submission.

## ProviderCredentialReference

Fields: `id`, `providerType`, `credentialReference`, `status`, `lastHealthCheckAt`, `lastHealthStatus`, `createdAt`, `updatedAt`. `credentialReference` points to a secret manager or platform secret; normal domain tables and read APIs never contain plaintext secrets.

## AuditEvent

Fields: `id`, `actorType`, `actorId`, `action`, `targetType`, `targetId`, `safeMetadata`, `createdAt`. Events are append-only and exclude raw secrets, tokens, stack traces, provider payloads, storage paths, and sensitive personal data.

## QuotaPolicy

Fields: `id`, `scopeType`, `scopeId`, `limits`, `effectiveFrom`, `effectiveUntil`, `createdBy`, `createdAt`, `updatedAt`. Environment defaults establish the baseline; an active admin policy may override named limits. Routes and UI consume a quota service and never embed limit constants.

## Cross-entity invariants

1. Owner IDs on Project and Asset must agree; an Asset cannot move across owners or projects in MVP.
2. CompositionVersion, GenerationJob, child or standalone RenderJob, and RenderOutput must reference the same Project lineage and authorization boundary.
3. `currentCompositionVersionId` must belong to the same active Project.
4. Storage keys are created from server-side identity and never supplied as trusted client identifiers.
5. A terminal Job or JobStep never returns to a non-terminal state.
6. A purged Project cannot be restored; purge is performed only by a durable system job and retains the minimal tombstone defined above.
7. Object presence can confirm availability but cannot create or change canonical business state without a guarded transition.
8. A child RenderJob has exactly one GenerationJob parent; a GenerationJob may have zero or many children. A standalone RenderJob has no parent.
9. Reuse of a RenderJob or RenderOutput requires an exact match of Project, CompositionVersion, bundle checksum, render request hash, renderer version, render protocol version, and provider operation identity/idempotency contract.
