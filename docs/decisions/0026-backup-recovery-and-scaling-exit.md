# ADR 0026: Backup, recovery, and scaling exit

- Status: Accepted
- Date: 2026-08-05

## Context

SQLite WAL cannot be safely protected by copying only the live DB file, and HF `/data` is one persistence/failure domain.

## Decision

Create verified pre-migration and periodic consistent snapshots with the official SQLite online backup mechanism (or tested `VACUUM INTO` fallback), manifests/checksums, rotation, restore drills, startup integrity checks, and object reconciliation. Never copy live DB/WAL/SHM independently. Treat same-volume backup as application recovery, not full DR.

## Consequences

External encrypted backup is post-MVP before stronger DR claims. Numeric RPO/RTO require owner confirmation. Multiple instances, write/lock pressure, independent workers, managed PITR, or storage/maintenance limits trigger planned SQLite->PostgreSQL, filesystem->S3, dispatcher->multi-worker architecture under new ADRs—not Phase 2 implementation.
