# ADR 0020: SQLite dispatcher and transactional outbox

- Status: Accepted
- Date: 2026-08-05

## Context

Accepted jobs must survive process restarts and provider ambiguity without introducing an MVP broker or claiming exactly-once behavior.

## Decision

Use SQLite-backed Jobs/Steps with `BEGIN IMMEDIATE` lease claims, heartbeats, bounded retries, separate work pools, a reconciler, transactional `outbox_events`, and append-only `job_events`. Work runs outside the claim transaction. Outbox delivery is at least once with idempotent consumers; provider intent is recorded before remote submission.

## Consequences

RAM is only a wake/capacity cache. Lost leases reject stale results, SSE replays durable events, and ambiguous provider calls poll/reconcile before resubmit. Multi-instance dispatch is excluded and requires PostgreSQL/queue redesign.
