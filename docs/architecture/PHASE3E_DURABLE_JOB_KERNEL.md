# Phase 3E Durable Job Kernel

Status: implementation in review; production cutover pending.

## Boundary

Phase 3E introduces schema v6, the provider-independent durable Job kernel, quota policy/reservation persistence, the single in-process dispatcher, owner history/SSE surfaces, redacted admin diagnostics, and minimal persisted-progress UI. Production remains schema v5 until a separate approved cutover.

The only production-enabled handler is `asset_ingestion`. Generation, render, purge, LLM, TTS, transcription, Modal, Composition, preview, and RenderOutput behavior are not enabled or created by this slice. Phase 3F has not started.

## Canonical admission and execution

Upload completion transaction TX-09 commits the completed UploadSession, processing Asset, consumed upload reservation, one queued Asset-ingestion Job, one pending root step, sequence-1 durable event, outbox wake, audit evidence, and completed idempotency response atomically. Replays return the same Job and create no duplicate reservation, Job, step, or event.

The dispatcher claims in `priority, available_at, created_at, id` order inside `BEGIN IMMEDIATE`. The default lease is 60 seconds and heartbeat interval is 20 seconds. Inspection runs outside SQLite. Deterministic progress is 0 at admission, 5000 after bounded byte/metadata inspection, and 10000 only in the guarded transaction that makes the Asset ready and completes the step and Job.

Transient safe failures schedule exponential retry while the Asset remains processing. Exhausted or non-retryable failures atomically fail the Job, step, and Asset with a safe failure code. Every worker mutation requires the current lease owner, unexpired lease, expected Job/step versions, and allowed source state.

## Recovery and reconciliation

Startup creates one Job for each v5 `processing` Asset that has no existing Asset-ingestion Job. Periodic reconciliation requeues expired resumable Asset ingestion, activates due retries, preserves `waiting_provider` state and provider identity, and completes durable cancellation cleanup without reopening terminal rows.

Provider submission fields are infrastructure scaffolding only. Tests persist `requested` intent before a fake call and then persist `accepted` or `outcome_unknown`; production has no provider adapter or network call.

## Owner and admin surfaces

Owner routes provide HMAC cursor-bound Job list, detail, steps, event history, cancellation, and durable SSE replay. `Last-Event-ID` is resolved against the authorized Job before streaming. Heartbeats are comments, slow clients are disconnected on backpressure, and disconnect never cancels work. Polling remains the frontend fallback.

Admin routes provide a redacted Job list/detail, audited idempotent reconciliation intent, quota policy history/create, and a bounded operations snapshot. Admin users do not gain blanket access through owner Job routes.

## Quota

Migration v6 is the first legal migration to create `quota_policies` and `quota_reservations`; migration v4 remains canonical Project only. Effective policy order is user, system, then environment baseline with half-open intervals and stable ID tie-breaks. Live project storage counts retained Asset bytes plus only `reserved` upload bytes. Consumed reservations remain historical evidence and are not double-counted.

## Operations

SQLite remains the queue; no Redis, BullMQ, RabbitMQ, Kafka, Temporal, Celery, Prisma, Postgres, or external queue service is added. The Litestream restore bound remains 120 seconds. The observed approximately 99.35-second restore is tracked as headroom debt and is not hidden by raising the timeout.

Phase 3D is implemented, merged, and production-cutover complete at feature merge `c04576b5d905c2ef55997c53a90ed84e06512564` plus forward fix `ce6f51845013c41c1906080354e631c026862cfd`. Private Asset/media durability was verified across a normal HF restart.
