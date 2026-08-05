# Phase 3 Implementation Sequence

Status: proposed vertical slices. Only 3A may start after explicit product-owner review/approval of Phase 2. This document does not authorize any implementation.

## 3A — Persistence kernel

- Modules/files: migration asset loader/runner, `SystemDatabase` transaction runner, UUID/time helpers, repository contracts, outbox repository/consumer skeleton, append-only audit/redaction, readiness/backup integration.
- Schema/migration: v2 upgrades the exact v1 ledger and creates the persistence-kernel tables for metadata, the minimal User identity shell required by audit/idempotency foreign keys, outbox, audit, and idempotency; OAuth/session and later domain tables remain absent.
- Test gate: empty/exact-v1/all-version migration, checksum/gap/failure, SQLite PRAGMAs/busy behavior, transaction rollback, outbox at-least-once harness, audit redaction, consistent backup/restore.
- Deployment smoke: exact validated HF SHA, schema/readiness metadata, DB/storage restart persistence, no product route added.
- Rollback: stop app, restore verified pre-v2 snapshot, deploy Phase 2 foundation build; no down migration.
- Explicitly excluded: Google/auth, Project, Asset/upload, dispatcher Jobs, providers, composition, preview, render, UI.
- Exit criteria: repository/application boundaries are enforced; no route SQL; v1->v2 and restore drill pass; outbox/audit primitives have deterministic tests. Only this slice may start after Phase 2 approval.

## 3B — Identity and approval

- Modules/files: Google OIDC adapter, OAuth transaction store, user/identity/session repositories, cookie/CSRF hooks, protected-request status gate, admin pending/status capabilities.
- Schema/migration: v3 OAuth identities/transactions, hashed sessions, provider credential references and remaining identity indexes/constraints over the v2 User shell.
- Test gate: fake OIDC issuer Code/PKCE/state/nonce, pending/active/disabled/rejected, cookie/session rotation/revoke-all, Origin/Referer/synchronizer CSRF, admin atomic audit, no secret leakage.
- Deployment smoke: Google test identity becomes pending, admin approves, active member enters product shell, disable immediately blocks old session; exact SHA/readiness proven.
- Rollback: disable login admission, revoke affected sessions, deploy prior compatible build or restore pre-v3 backup before accepting identity writes.
- Explicitly excluded: Project CRUD, uploads, job dispatcher, AI, preview, render.
- Exit criteria: AC-AUTH, AC-ADMIN-01-04/08, AC-SEC-01-04, and authorization status gates pass.

## 3C — Canonical Project

- Modules/files: Project contracts/repository/service/routes, Project list/trash queries, owner authorization, quota policy read/override foundation, retention scheduling intent.
- Schema/migration: v4 projects, quota policies/reservations as required, ownership/lifecycle/list indexes and idempotency links.
- Test gate: create/list/read/rename/favorite, version/idempotency races, soft delete/trash/30-day restore, purge-lease conflict/tombstone-ready state, cross-user isolation, restart persistence and indexed query plans.
- Deployment smoke: active member performs full Project lifecycle across restart; pending/other member cannot access; no bytes are deleted in request.
- Rollback: stop Project mutations, preserve rows, deploy compatible reader or forward fix; restore only before accepted v4 writes or with explicit data-loss approval.
- Explicitly excluded: Asset/upload, worker dispatcher, composition/editor, providers, preview/render.
- Exit criteria: all AC-PROJ, Project-related AC-AUTHZ/RET/QUOTA, and list NFR fixture targets pass.

## 3D — Private Assets

- Modules/files: filesystem object adapter, Asset/UploadSession repositories/services/routes, raw chunk streaming, ingestion adapter/job admission shim, basic metadata/search, Range/capability delivery, cleanup/reconciliation.
- Schema/migration: v5 assets, upload sessions, delivery capabilities and containment/search/expiry indexes.
- Test gate: same filename, Vietnamese metadata, offset/chunk retry/restart, size/MIME/checksum/corrupt media, quota reservation, staging/orphan crash boundaries, soft-delete/restore, cross-user/path attack, Range/HEAD/416/backpressure.
- Deployment smoke: resumable private upload reaches the durable ingestion handoff and authorized playback/download works across restart; no public `/data` path.
- Rollback: close upload admission, let/abort sessions under policy, preserve immutable objects/rows, deploy compatible adapter or forward fix; never discard unknown staging blindly.
- Explicitly excluded: general dispatcher concurrency beyond the minimum durable handoff, generation, composition, HyperFrames, Modal.
- Exit criteria: all AC-ASSET plus storage/upload/delivery AC-SEC/authorization/recovery criteria pass.

## 3E — Durable Job kernel

- Modules/files: Job/JobStep/Event repositories, dispatcher pools, lease/heartbeat/reconciler, quota admission, outbox consumers, cancellation/retry, SSE/history/polling and operations metrics.
- Schema/migration: v6 jobs, steps, events plus remaining quota/outbox indexes and technical fields.
- Test gate: exact state machines, two-claimant/version races, expired leases, process death at every boundary, parent/item identity, idempotency conflict, outbox at-least-once, SSE Last-Event-ID replay, cancellation/retry and real progress.
- Deployment smoke: accepted synthetic non-provider Job survives restart, is reconciled, replays SSE, rejects stale worker results, and exposes queue/lease metrics.
- Rollback: stop new claims, let leases expire, deploy compatible worker or forward fix; admitted Jobs/events are never deleted or inferred from logs/files.
- Explicitly excluded: actual LLM/TTS/transcription/Modal calls, composition, preview, render outputs.
- Exit criteria: provider-independent AC-JOB, AC-QUOTA, AC-OBS and restart/recovery gates pass.

## 3F — Composition and immutable preview

- Modules/files: Composition V1 schemas/validation/repository, structured edit/current pointer, registry/asset checks, HyperFrames compatibility adapter/materializer, preview artifact/player/sandbox.
- Schema/migration: v7 composition versions/references and preview artifacts.
- Test gate: canonical hash/RFC vectors, unknown/raw-code rejection, immutable version races, four aspect ratios, Vietnamese captions/BGM, CSP/sandbox, deterministic snapshots and exact preview fingerprint.
- Deployment smoke: structured edit creates a new version; old preview remains immutable; warm preview meets NFR; no per-project forever process or arbitrary network.
- Rollback: disable new materialization, retain documents/artifacts, deploy compatible reader/player or forward fix.
- Explicitly excluded: real generation providers, Modal render, output publication.
- Exit criteria: AC-COMP/CAPTION/BGM and preview parity/security criteria pass.

## 3G — Generation providers

- Modules/files: provider-neutral LLM/TTS/transcription ports, HF secret resolver/health, typed adapters, generation planning/checkpoints and per-scene narration children.
- Schema/migration: forward-only provider/job lineage additions only when indexed querying requires them; never secret values.
- Test gate: explicit test-only provider servers for success/429/timeout/ambiguous/malformed/cancel, restart polling, no duplicate scene artifact, redaction; bounded manual sandbox separately.
- Deployment smoke: approved closed-beta generation survives provider wait/restart and creates a validated immutable CompositionVersion.
- Rollback: disable credential references/admission, retain/reconcile operation IDs, deploy compatible worker; never blind-resubmit.
- Explicitly excluded: Modal rendering, multiple render providers, social/semantic/visual AI features.
- Exit criteria: remaining generation/provider AC-JOB/ERR/ADMIN health criteria pass.

## 3H — Modal render, verification, output lifecycle

- Modules/files: bundle/fingerprint builder, Modal protocol adapter, submit/poll/cancel reconciliation, technical verifier, immutable output/state repositories, playback/download/pin/purge.
- Schema/migration: v8 render output/state and any approved immutable manifest reference fields.
- Test gate: protocol/lineage mismatch, unknown submit, poll restart, full technical gate, immutable-core/state races, fingerprint parity, Range delivery, pin/retention/purge and deterministic short render.
- Deployment smoke: preview fingerprint equals Modal request/verified MP4, playback/download survives restart, and purge denies delivery without rewriting evidence.
- Rollback: stop render admission, preserve operation IDs/leases/objects, reconcile before older worker; no overwrite or state inference.
- Explicitly excluded: local/second render provider, social publishing, visual AI/human approval requirement.
- Exit criteria: AC-RENDER, applicable AC-RET/DEPLOY/OBS and the complete owner flow pass.

## 3I+ — hardening and scaling exits

External backup/DR, scheduled load/security/accessibility hardening, then only evidence-driven PostgreSQL/S3/multi-worker exits. Every exit needs a new ADR, data migration/cutover/rollback, and product approval. Cloudflare, Workspace, social publishing, semantic search, extra providers, and legacy parity remain out of scope.
