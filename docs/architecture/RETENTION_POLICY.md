# Retention Policy

## Defaults

| Resource                          | Default retention                                                 |
| --------------------------------- | ----------------------------------------------------------------- |
| Soft-deleted Project              | 30 days before purge eligibility                                  |
| Temporary render bundle           | 24 hours                                                          |
| Intermediate generation artifacts | 7 days                                                            |
| Failed-job diagnostics            | 30 days                                                           |
| RenderOutput count                | Maximum 10 retained per Project                                   |
| Final verified outputs            | Retained while Project exists, subject to per-project cap and pin |

## Enforcement

Retention timestamps are calculated by a versioned policy service and persisted. A scheduler creates idempotent durable purge jobs. Purge never executes in the HTTP request that deletes a Project/Asset/output. Purge jobs use leases, retry policies, storage manifests, and AuditEvents.

Project restore is permitted before the 30-day window expires and before a purge worker atomically enters `purging`. Restore cancels scheduled purge intent transactionally. A failed purge remains visible and retryable; it does not pretend bytes are gone.

## Output eviction

When more than 10 verified outputs exist, policy selects oldest unpinned outputs not referenced by an active capability/job. Pinned outputs are never auto-purged. If all outputs are pinned, quota rejects another retained output or requires an explicit unpin; it does not silently delete.

## Safe deletion order

1. Confirm canonical resource state and purge lease.
2. Revoke new read/write capabilities.
3. Enumerate server-owned storage manifest, never client paths.
4. Delete bytes idempotently and verify expected disposition.
5. Mark lifecycle `purged` and append safe audit event/tombstone.

Temporary and failed artifacts may be purged independently only when they are not required by active retries, diagnostics retention, or pinned outputs.
