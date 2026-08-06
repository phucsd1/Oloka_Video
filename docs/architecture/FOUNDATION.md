# Foundation architecture

## Purpose

This repository establishes the smallest online-safe base for Oloka Video. It deliberately contains no authentication, project management, uploads, AI integrations, editor, or rendering pipeline.

## Module boundaries

The browser depends on `@oloka/contracts` and `@oloka/design-system`. The server depends on `@oloka/contracts`, application services, and infrastructure adapters. Routes translate HTTP to application services; they do not access SQLite or the filesystem directly.

The database boundary is `SystemDatabase`. `SqliteSystemDatabase` is the MVP adapter and owns verified PRAGMAs, immutable migration assets, readiness, and a synchronous transaction runner. Repositories own SQL; routes do not. A PostgreSQL adapter is a documented scaling exit, not an implemented alternative.

The persistent-byte boundary is `ObjectStorage`. `FilesystemObjectStorage` owns filesystem readiness beneath `OBJECT_STORAGE_ROOT`; future object-store implementations can replace it without changing HTTP handlers. The local SQLite primary is configured separately by `DATABASE_PATH` and must remain outside that root.

## Request flow

1. Configuration is parsed and validated before the listener opens.
2. SQLite applies/verifies connection PRAGMAs, creates an authenticated online backup when an existing database has pending migrations, and applies checksummed migrations before listening.
3. Persistent storage completes a real read/write startup probe.
4. Fastify exposes system endpoints and serves the compiled React application.
5. The frontend fetches all three system endpoints and validates responses with shared schemas.

## Readiness semantics

`/api/health` is a liveness check only. `/api/ready` verifies connection PRAGMAs, the exact complete migration ledger/checksums, and foreign keys; it also checks storage through a fixed `.oloka-readiness` probe and reports validated configuration. The probe is overwritten rather than multiplied and removed during graceful shutdown. A failed component returns HTTP `503` with per-component status.

## Persistence schema

Migration 1 preserves the exact historical foundation identity. Migration 2 upgrades the ledger and creates only `users`, append-only `audit_events`, `outbox_events`, and `idempotency_records` beside normalized system tables. OAuth, Session, Project, Asset, Composition, Preview, Render, provider, and Job tables do not exist yet. SQLite verifies foreign keys, WAL, FULL synchronization, and a 5000 ms busy timeout on every connection.
