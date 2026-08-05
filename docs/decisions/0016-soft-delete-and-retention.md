# ADR 0016: Soft delete, restore and durable retention

- Status: Accepted
- Date: 2026-08-05

## Context

Synchronous DB plus recursive filesystem deletion is not recoverable or transactional.

## Decision

Project/Asset deletion is soft. Asset ingestion and lifecycle are independent. Projects restore for 30 days by default. Retention scheduling and byte purge are separate durable leased system jobs with idempotency, retries and AuditEvents. RenderOutput retention is independent from availability, and pinned outputs are protected from automatic purge scheduling.

## Consequences

HTTP deletion never recursively deletes bytes. Restore/purge races use guarded states. Failed purge remains visible/retryable. Completed Project purge retains a privacy-safe, non-restorable tombstone and required audit trail while dependent private bytes/active records are removed by manifest. Policy defaults are defined in `RETENTION_POLICY.md`.
