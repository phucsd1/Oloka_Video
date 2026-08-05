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

Project restore is permitted before the 30-day window expires and before a purge worker atomically enters `purging`. Restore cancels scheduled purge intent transactionally. A failed purge remains visible and retryable; it does not pretend bytes are gone. Completed purge retains the minimal non-restorable Project tombstone defined in `PROJECT_LIFECYCLE.md` while dependent private bytes and active records are disposed by manifest.

## Output eviction

Availability and retention are independent. When more than 10 outputs in `availabilityState=verified` and `retentionState=active` exist, policy selects the oldest eligible unpinned outputs not referenced by an active capability/job. `pinned=true` blocks automatic transition from `active` to `purge_scheduled`; it does not create a separate retention state. If all outputs are pinned, quota rejects another retained output or requires an explicit unpin; it does not silently delete.

## Safe deletion order

1. Confirm canonical resource state and purge lease.
2. Revoke new read/write capabilities.
3. Enumerate server-owned storage manifest, never client paths.
4. Delete bytes idempotently and verify expected disposition.
5. Mark `retentionState=purged` and `availabilityState=unavailable` for RenderOutput, or the equivalent resource lifecycle; append the safe audit event/tombstone.

Object absence never marks a resource purged automatically. Temporary and failed artifacts may be purged independently only when they are not required by active retries, diagnostics retention, or pinned outputs.
