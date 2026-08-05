# Durable Dispatcher V1

## Runtime model

One in-process dispatcher runs inside the single HF application instance. SQLite is the durable source; memory only holds bounded active-work bookkeeping and wake signals. Restarting the process loses no admitted job.

| Setting       | MVP default           | Rule                                                                   |
| ------------- | --------------------- | ---------------------------------------------------------------------- |
| base poll     | 750 ms                | configurable, skipped when capacity is full                            |
| jitter        | 0-250 ms              | independent per poll to avoid fixed synchronization                    |
| job lease     | 60 s                  | durable expiration                                                     |
| heartbeat     | 20 s                  | must be less than one-third-to-one-half of lease                       |
| reconciler    | 30 s                  | finds expired leases/ambiguous provider work                           |
| graceful stop | immediate             | stop claims, request workers stop/settle, do not extend abandoned work |
| provider poll | initial 2 s, max 15 s | bounded exponential backoff with jitter                                |

## Claim algorithm

Each pool performs a short `BEGIN IMMEDIATE` transaction: select one eligible row in deterministic priority/available/created/ID order, verify quota/capacity/state, and conditionally update status, attempt, lease owner, lease expiry, heartbeat, and version. It appends the JobEvent/outbox record in the same transaction and commits. If no row changed, another claimant won. Actual work begins only after commit.

Every result update includes job/step ID, expected version, matching lease owner, and valid source state. A worker that lost its lease cannot commit success or failure.

## Pools and capacity

| Pool            | Job/step work                                | Default concurrency intent      |
| --------------- | -------------------------------------------- | ------------------------------- |
| asset ingestion | bounded MIME/media analysis                  | low CPU/memory bound            |
| generation      | LLM/TTS/transcription orchestration          | provider and quota bound        |
| render submit   | one Modal submission intent                  | very small, prevents duplicates |
| render poll     | remote status reconciliation                 | bounded I/O polling             |
| purge           | project/asset/output byte cleanup            | serialized or very low          |
| reconciliation  | leases, staging, storage, provider ambiguity | one coordinator task            |

Exact concurrency is environment configuration reviewed in Phase 3; it cannot exceed quota or memory budgets. Pools prevent long render polling from starving ingestion/purge.

## Retry and recovery

Retry classification is typed: transient network/rate/5xx and verified provider-unavailable conditions schedule bounded exponential backoff; invalid input, authorization, quota, missing asset, or failed quality gates are terminal. Retry consumes an attempt only when work actually begins. Max attempts and deadlines are job-type policy.

At startup and every 30 seconds, reconciliation:

- returns expired locally owned leases to retry scheduling or terminal failure according to policy;
- polls known provider operation IDs before any resubmit;
- finds jobs whose parent/steps disagree and applies the state-machine invariant;
- restores released/consumed quota reservations from terminal truth;
- queues stale upload and purge cleanup;
- emits safe alerts for repeated lease loss/dead outbox events.

Cancellation is a durable request. The worker observes it between bounded operations, attempts provider cancellation when supported, and commits the state-machine result. An SSE disconnect never cancels work.

## Shutdown

SIGTERM/SIGINT marks the dispatcher stopping immediately: stop new claims, stop lease extension for work that cannot finish within the platform grace window, request provider-safe cancellation only where contract permits, close SSE with retry guidance, and close DB after active short transactions settle. Recovery is lease/reconciliation based, not a graceful-shutdown assumption.
