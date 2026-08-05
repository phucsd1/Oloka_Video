# Foundation architecture

## Purpose

This repository establishes the smallest online-safe base for Oloka Video. It deliberately contains no authentication, project management, uploads, AI integrations, editor, or rendering pipeline.

## Module boundaries

The browser depends on `@oloka/contracts` and `@oloka/design-system`. The server depends on `@oloka/contracts`, application services, and infrastructure adapters. Routes translate HTTP to application services; they do not access SQLite or the filesystem directly.

The database boundary is `SystemDatabase`. `SqliteSystemDatabase` is the online-development adapter. A PostgreSQL adapter can later implement the same contract without changing system services or routes.

The persistent-data boundary is `ObjectStorage`. `FilesystemObjectStorage` owns all filesystem readiness work beneath `DATA_DIR`; future object-store implementations can replace it without changing HTTP handlers.

## Request flow

1. Configuration is parsed and validated before the listener opens.
2. The database directory is created and migrations are applied idempotently.
3. Persistent storage completes a real read/write startup probe.
4. Fastify exposes system endpoints and serves the compiled React application.
5. The frontend fetches all three system endpoints and validates responses with shared schemas.

## Readiness semantics

`/api/health` is a liveness check only. `/api/ready` executes `SELECT 1`, checks storage through a fixed `.oloka-readiness` probe, and reports validated configuration. The probe is overwritten rather than multiplied and removed during graceful shutdown. A failed component returns HTTP `503` with per-component status.

## Persistence schema

Migration 1 creates `schema_migrations` and `system_metadata`. There are no product-domain tables in the foundation phase. SQLite uses WAL mode for safer online-development concurrency.
