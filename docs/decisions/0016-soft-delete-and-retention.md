# ADR 0016: Soft delete, restore and durable retention

- Status: Accepted
- Date: 2026-08-05

## Context

Synchronous DB plus recursive filesystem deletion is not recoverable or transactional.

## Decision

Project/Asset deletion is soft. Projects restore for 30 days by default. Retention scheduling and byte purge are separate durable leased system jobs with idempotency, retries and AuditEvents. Pinned outputs are protected.

## Consequences

HTTP deletion never recursively deletes bytes. Restore/purge races use guarded states. Failed purge remains visible/retryable; policy defaults are defined in `RETENTION_POLICY.md`.
