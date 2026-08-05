# ADR 0018: Versioned forward-only migrations

- Status: Accepted
- Date: 2026-08-05

## Context

Runtime schema inference and edited migration history make deploy/rollback nondeterministic. Foundation schema version 1 already exists with a minimal ledger.

## Decision

Use numbered, named, immutable forward-only SQL migrations with SHA-256 checksums in `schema_migrations`. Run pending migrations before listening, one version at a time and transactionally where SQLite permits. Version 2 deliberately upgrades/backfills the exact v1 ledger; no service executes `ALTER TABLE`.

## Consequences

There are no down migrations. A failed deployment restores a verified pre-migration backup and compatible application, or ships a new forward repair. Checksum mismatch/gaps/newer schema refuse readiness. Applied assets are never edited.
