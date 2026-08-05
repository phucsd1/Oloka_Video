# ADR 0009: Generic durable Job with typed subtypes

- Status: Accepted
- Date: 2026-08-05

## Context

Generation and render need the same lease, heartbeat, retry, cancellation, idempotency, checkpoint and restart semantics. Separate unrelated implementations would duplicate critical coordination logic.

## Decision

Use one logical durable Job aggregate with `jobType` and nullable `parentJobId`. `GenerationJob` always has no parent and may have zero or many child RenderJobs; a generation-created RenderJob points to its GenerationJob, while standalone rerender has no parent. Parent and child share Project authorization and lineage.

JobStep has the explicit states and guarded transitions in `JOB_STATE_MACHINE.md`. Per-scene narration uses child JobStep items keyed by scene ID. Lease reconciliation may return expired safe `running` work to the queue, but preserves `waiting_provider` operation identity and preserves `cancel_requested` while cleanup is reacquired.

## Consequences

One dispatcher/state machine handles both while type-specific handlers remain separate. RAM, logs and file existence are never canonical. Late workers lose commit rights. Terminal transitions, progress, child reuse, checkpoints and provider operation reuse follow `JOB_STATE_MACHINE.md`.
