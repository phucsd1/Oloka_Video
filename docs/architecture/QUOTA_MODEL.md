# Quota and Concurrency Model

Status: database-backed policy composition and canonical upload reservations are live in production migration v6 from the Phase 3E core cutover. Phase 3E.3 does not change quota schema or semantics, and Phase 3F has not started.

## Default MVP limits

| Limit key                      |                                                                                                 Default |
| ------------------------------ | ------------------------------------------------------------------------------------------------------: |
| `maxVideoDurationSeconds`      |                                                                                                      60 |
| `maxResolution`                | 1920 × 1080 landscape-equivalent; long edge ≤ 1920 and short edge ≤ 1080, allowing portrait 1080 × 1920 |
| `maxActiveGenerationPerUser`   |                                                                                                       1 |
| `maxActiveRenderPerUser`       |                                                                                                       1 |
| `maxQueuedJobsPerUser`         |                                                                                                       3 |
| `maxActiveRenderSystemDev`     |                                                                                                       2 |
| `maxAssetSizeBytes`            |                                                                                                  500 MB |
| `maxProjectStorageBytes`       |                                                                                                    5 GB |
| `maxRetainedOutputsPerProject` |                                                                                                      10 |

## Policy resolution

The quota service resolves a versioned effective policy using
platform/environment defaults and optional append-only admin policy versions.
Each interval is half-open `[effectiveFrom,effectiveUntil)`; a null end is
open-ended, and overlapping intervals for the same scope are rejected. At time
`t`, a matching user policy wins over a matching system policy, then environment
baseline applies. Ties are resolved by latest start and stable ID. Overrides
name individual keys, scope, effective interval, and audit actor. Domain logic
asks the service for effective limits; routes, UI, provider adapters, and workers
do not hard-code them.

## Admission

Admission is atomic with job/upload creation. It evaluates account status, ownership, active/queued counts, reserved capacity, Project storage, requested duration/resolution/size, and idempotency. Replayed idempotent commands return the existing reservation instead of consuming quota twice.

If admission fails, the request is rejected before accepting work with `QUOTA_EXCEEDED`, a stable exceeded-limit detail, current/limit values where safe, and a suggested action such as wait, cancel, remove/unpin output, reduce size, or contact admin. Work is never accepted into indefinite pending state.

## Capacity release and reconciliation

Reservations release on terminal jobs, aborted uploads, expiration, or reconciled orphan state. Lease loss alone does not release an active logical job because it may resume. A reconciler derives counts from canonical records and repairs leaked reservations transactionally. Metrics report admission denials and utilization without exposing private data.
