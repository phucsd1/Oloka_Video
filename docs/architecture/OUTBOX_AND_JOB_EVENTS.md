# Outbox and Job Events

## Outbox contract

Every durable mutation that requires later work creates an `outbox_events` row in the same SQLite transaction. Topics cover dispatcher wakeups, domain-event/audit side effects, provider submission intent, cleanup, reconciliation, and SSE-visible event production where not directly inserted.

Delivery is at least once. Consumers must use the outbox ID or semantic aggregate key as an idempotency key. Exactly-once delivery is not claimed. A consumer claims with a lease, performs its bounded effect outside the claim transaction, then marks published with a guarded update. Retry uses typed backoff; exhausted events become `dead` and page an operator rather than disappearing.

## Durable job event stream

`job_events` is the owner-facing event source. Each event has a stable UUID, job-scoped strictly increasing sequence, allowlisted type, safe schema-versioned payload, and epoch-ms time. State mutation and its event are atomic. Events are append-only and retained at least as long as the job.

Representative types are `job.queued`, `job.started`, `job.progress`, `step.started`, `step.waiting_provider`, `step.retry_scheduled`, `job.cancel_requested`, `job.succeeded`, `job.failed`, and `job.cancelled`. Payloads contain progress, safe codes, resource IDs, and retry timing; never raw logs, prompts, provider payloads, secrets, storage keys, or stack traces.

## SSE protocol

`GET /api/v1/jobs/:jobId/events` authenticates and authorizes the job owner/admin. It uses `text/event-stream`, `Cache-Control: no-store`, buffering-disabled headers, and emits `id`, `event`, and JSON `data` from durable rows.

- `Last-Event-ID` resumes after the matching event; an equivalent validated cursor query is allowed for clients that cannot set the header.
- Server replays retained rows in sequence before tailing new events.
- A heartbeat comment is sent about every 15 seconds; it is not a durable event.
- A slow client is disconnected with normal SSE reconnection semantics rather than buffering without bound.
- Unknown/unauthorized jobs return the private-resource `404`; a too-old event ID returns a typed replay-window conflict plus the current job snapshot endpoint.
- Disconnect has no effect on the job.

Clients must also support `GET /api/v1/jobs/:jobId` polling with cursor-paginated event history. SSE is a latency optimization over durable truth, not the only way to observe progress.

## Event sequencing

The transaction obtains the next sequence from the job's guarded version/last sequence strategy; a unique `(job_id, sequence)` constraint is the final guard. Producers retry the whole short transaction on a bounded SQLite busy conflict. Event coalescing may reduce high-frequency progress writes, but stored progress is monotonic and reflects measured work, never a timer animation.
