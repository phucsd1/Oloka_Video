# ADR 0009: Generic durable Job with typed subtypes

- Status: Accepted
- Date: 2026-08-05

## Context

Generation and render need the same lease, heartbeat, retry, cancellation, idempotency, checkpoint and restart semantics. Separate unrelated implementations would duplicate critical coordination logic.

## Decision

Use one logical durable Job aggregate with `jobType`. `GenerationJob` and `RenderJob` are typed subtypes; `JobStep` references the base Job. RenderJob retains its own typed render request/provider/output contract and may be a child of GenerationJob.

## Consequences

One dispatcher/state machine handles both while type-specific handlers remain separate. RAM, logs and file existence are never canonical. Terminal transitions, progress and provider operation reuse follow `JOB_STATE_MACHINE.md`.
