# ADR 0023: Zod contracts and canonical JSON

- Status: Accepted
- Date: 2026-08-05

## Context

Frontend/backend schema duplication, unvalidated JSON blobs, and unstable serialization would break idempotency and render lineage.

## Decision

Define strict versioned Zod contracts once in `packages/contracts`. Validate JSON before write and after read, serialize UTF-8 with RFC 8785 JCS, and hash with SHA-256. Keep query/join/filter fields as relational columns. Distinguish byte checksum, canonical JSON hash, and semantic request hash.

## Consequences

Unknown keys/stored corruption fail closed. Defaults must be materialized before canonicalization and RFC vectors tested. Breaking data introduces a new schema version; immutable stored compositions are not rewritten.
