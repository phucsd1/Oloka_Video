# Observability and Operations

## Structured logging

Use Pino JSON logs to stdout with UTC epoch/ISO time and stable fields. Every request receives/validates a bounded `requestId` and records build SHA, normalized route, status, and duration. Async work propagates `traceId`, `jobId`, `parentJobId`, `jobStepId`, `itemKey`, `projectId`, `userId` (opaque), `provider`, `providerOperationId` (operator-only), `attempt`, `leaseOwner`, `leaseVersion`, `durationMs`, `outcome`, and stable `errorCode` as applicable.

Do not log cookies, authorization/CSRF/capability/idempotency tokens or hashes, OAuth code/state/nonce/verifier, environment values, storage/staging keys, raw filenames when avoidable, request bodies/prompts, composition JSON, user media, provider headers/bodies, SQL parameters containing user data, or stack traces in user responses. Logger redaction is configured centrally and tested.

## Metrics

| Area            | Required metrics                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP            | request count/latency/status by normalized route/method; active requests/SSE; response bytes; rate-limit/CSRF/auth rejection                |
| SQLite          | query/transaction latency by operation; busy/lock count and wait; rollback; migration/integrity/backup result; DB/WAL size                  |
| Dispatcher      | queue depth/oldest age by pool/status; claims; active leases; lease loss; heartbeat lag; retries; terminal outcomes; reconciliation actions |
| Outbox/events   | pending/dead depth, oldest age, publish latency/attempts; SSE replay lag/disconnects                                                        |
| Upload/storage  | active/stale sessions, bytes staged/stored, chunk/finalize latency, offset/checksum failure, missing/orphan objects, range throughput       |
| Providers       | call/poll latency and outcomes by provider/operation; rate limit/timeout; ambiguous submit; health status; never credential labels          |
| Preview/render  | materialization/check duration, parity/quality failures, render end-to-end duration, output bytes/duration, quarantines                     |
| Quota/retention | admission denial, reservations by state/age, purge backlog/failure, recoverable storage headroom                                            |

Canonical metric names use the `oloka_` prefix:

| Metric                                       | Type / labels                                 |
| -------------------------------------------- | --------------------------------------------- |
| `oloka_job_queue_oldest_age_seconds`         | gauge by pool and job type                    |
| `oloka_job_leases_active`                    | gauge by pool                                 |
| `oloka_job_leases_expired_total`             | counter by pool and recovery outcome          |
| `oloka_job_retries_total`                    | counter by job type and safe reason           |
| `oloka_provider_operation_duration_seconds`  | histogram by provider, operation, outcome     |
| `oloka_upload_bytes_total`                   | counter by outcome; no user/project label     |
| `oloka_upload_failures_total`                | counter by stable error code                  |
| `oloka_render_verification_duration_seconds` | histogram by outcome                          |
| `oloka_render_verification_findings_total`   | counter by safe finding code                  |
| `oloka_purge_operations_total`               | counter by resource type and outcome          |
| `oloka_sqlite_busy_total`                    | counter by repository operation               |
| `oloka_sqlite_transaction_duration_seconds`  | histogram by transaction boundary and outcome |
| `oloka_sse_connections_active`               | gauge                                         |
| `oloka_sse_replayed_events_total`            | counter by replay outcome                     |
| `oloka_outbox_oldest_age_seconds`            | gauge by topic class                          |

`prom-client` is the planned metrics candidate; exact version and endpoint exposure require Phase 3 review. A metrics endpoint must be operator-restricted or bound privately; public health probes expose only coarse state.

## SLO-oriented alerts

- Critical: database integrity failure, migration mismatch, active referenced object missing/corrupt, backup restore verification failure, authorization bypass signal.
- High: persistent SQLite lock/latency breach, expired leases repeatedly reclaimed, outbox dead event, render/provider ambiguous submissions, storage headroom below safety threshold, backups stale.
- Medium: queue age over NFR, provider degradation, high upload rejection, cleanup/reconciliation backlog, SSE reconnect spike.

Thresholds are configurable and mapped to the NFR/operational runbook in Phase 3. Logs alone are not progress truth; `jobs`/`job_events` are.

## Operational endpoints and runbooks

`/api/health` proves the process loop; `/api/ready` checks migration compatibility, a bounded SQLite query, storage root/readiness, required configuration, and dispatcher startup; `/api/version` exposes source/schema/runtime compatibility without secrets. Admin operations summarizes queue/lease/outbox/storage/backup state with redacted drill-down.

Required runbooks cover: failed startup migration, SQLite busy/integrity, storage missing/orphan, stuck job/expired lease, ambiguous provider submission, dead outbox event, upload staging growth, secret rotation, backup/restore, and HF deployment drift. Operator actions create audit events where they change state.

## Correlation and retention

Request/job/event IDs connect browser error envelopes, logs, metrics, audit, and provider calls. High-cardinality IDs are log context, not unrestricted metric labels. Log/metric retention follows HF/operator facilities and must not be mistaken for product/audit durability; `audit_events` and `job_events` have their own retention contracts.
