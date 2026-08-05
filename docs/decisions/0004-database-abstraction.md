# ADR 0004: Database abstraction

- Status: Accepted
- Date: 2026-08-05

## Context

SQLite minimizes online-development infrastructure, while expected production workloads may require PostgreSQL.

## Decision

System services depend on `SystemDatabase`. Use Node's SQLite adapter for development and reserve `postgresql://` URLs for a future PostgreSQL implementation.

## Consequences

Business and HTTP code do not know the active database engine. PostgreSQL activation requires a new adapter and focused contract tests, not route rewrites.
