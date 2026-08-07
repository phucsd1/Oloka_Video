# ADR 0017: SQLite in one Space instance for MVP

- Status: Superseded in part by ADR 0027
- Date: 2026-08-05

## Context

The accepted topology is one Hugging Face Docker Space and the MVP needs durable relational transactions, leases, and low operational overhead.

## Decision

Use built-in `node:sqlite` with one database and one application instance. ADR 0027 corrects the physical location from `/data/database` to the local primary `/var/lib/oloka/database/oloka.db` with Litestream durability. Enable foreign keys, WAL, FULL synchronous writes, and 5000 ms busy timeout. SQL is contained in repositories; routes never execute it. Because the API is synchronous, transactions are short and never contain provider calls, media analysis, hashing, or filesystem streaming.

## Consequences

No ORM, external database, second backend, or horizontal scale enters MVP. Metrics must expose busy/transaction latency. PostgreSQL becomes mandatory when multiple instances/workers, sustained write/lock NFR breaches, managed PITR, or unacceptable maintenance/data growth is required; that exit needs a new ADR and data migration.
