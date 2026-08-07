# Phase 3A Persistence Kernel

## Outcome

Slice 3A implements the persistence primitives required by later product slices
without adding a product route or product workflow. Runtime, Actions, `.nvmrc`,
and `.node-version` are pinned to Node `22.16.0`. The server uses built-in
`node:sqlite`; `canonicalize` `3.0.0` is the only new runtime dependency.

## Migration assets and ledger

Immutable SQL assets live in `apps/server/migrations` and are copied beside the
compiled server in the production image. The loader resolves the same assets
from source, tests, compiled local execution, and `/app/apps/server/migrations`.

- `0001-foundation-system-tables.sql` is the exact historical foundation
  migration. It creates the original three-column ledger and legacy metadata
  table and inserts version 1 as `foundation_system_tables`.
- `0002-persistence-kernel.sql` upgrades the ledger to
  `version, name, checksum_sha256, applied_at, execution_ms, app_build_sha`,
  converts timestamps to epoch milliseconds, preserves the v1 identity and
  exact-asset checksum, normalizes empty legacy metadata, and creates the Slice
  3A tables.

Migration assets are SHA-256 checked at startup. Missing assets, ledger gaps,
changed checksums/names, an application built for an older schema, unknown v1
tables, non-empty unknown legacy metadata, or a failed DDL transaction fail
startup and readiness. Migrations execute one version per `BEGIN IMMEDIATE`
transaction. There are no down migrations.

The final Slice 3A table allowlist is exactly:

1. `schema_migrations`
2. `system_metadata`
3. `users`
4. `audit_events`
5. `outbox_events`
6. `idempotency_records`

OAuth, sessions, projects, assets, composition, preview, render, provider,
quota, and durable Job tables are intentionally absent.

Litestream 0.5.11 owns two transport-internal runtime tables,
`_litestream_lock` and `_litestream_seq`, while supervising the primary. They
are not created by application migration v1/v2 and are excluded from the
application table allowlist above.

## SQLite connection and transaction contract

Every opened connection applies and verifies `foreign_keys=ON`, WAL journal
mode, `synchronous=FULL`, and a 5000 ms busy timeout. Readiness re-verifies the
connection, complete migration ledger, exact checksums, and foreign keys.

The transaction runner exposes `read`, `deferred`, and `immediate` modes.
Callbacks must be synchronous: a returned thenable causes rollback and a typed
error. Thrown work is rolled back, nested writes are rejected, and SQLite
busy/locked errors cross the boundary as `PersistenceBusyError`. Network,
provider, filesystem streaming, hashing, and media work must remain outside a
transaction.

IDs come from an injectable `IdGenerator` whose production implementation uses
`randomUUID()`. Epoch-millisecond time comes from an injectable `Clock` whose
production implementation uses `Date.now()`.

## Canonical JSON and hashing

`canonicalizeJson` uses RFC 8785 JCS. `sha256Hex` hashes exact bytes/text and
`sha256CanonicalJson` hashes canonical JSON. Invalid JSON values fail closed.
Unit tests include the RFC 8785 serialization sample, numeric representation,
property ordering, invalid numbers, and stable SHA-256 evidence.

## Pre-migration backup

An existing known database with a pending migration is backed up before legacy
metadata validation or mutation. A fresh empty database can migrate without a
key. The default layout is:

```text
<OBJECT_STORAGE_ROOT>/backups/pre-migration/<opaque-set>/
  database.sqlite
  manifest.json
  manifest.hmac
```

The database is produced by the official `node:sqlite` online `backup()` API.
The canonical manifest fields are `manifestVersion`, `createdAt`,
`sourceSchemaVersion`, `targetSchemaVersion`, `appBuildSha`,
`databaseFilename`, `databaseSizeBytes`, `databaseChecksumSha256`,
`migrationVersionsPending`, `objectManifestVersion`, `objects`, and
`keyVersion`.

`OLOKA_APP_KEY` must be canonical, unpadded base64url representing exactly 32
bytes. It is never generated, persisted, or logged. HKDF-SHA256 with context
`oloka/backup-manifest/v1` derives a 32-byte manifest key. HMAC-SHA256 signs the
exact canonical manifest bytes. Verification uses a timing-safe comparison,
database byte checksum/size, SQLite `quick_check`, and `foreign_key_check`.
Restore refuses overwrite, verifies before copying, and repeats an integrity
check on the restored database. These snapshots share the `/data` failure
domain and are not external disaster recovery.

## Repository primitives

- `SystemMetadataRepository` accepts only typed allowlisted keys, validates
  canonical JSON after read, and requires optimistic versions for writes.
- `AuditEventRepository` appends ordered immutable events. A centralized,
  recursive, case-insensitive safety gate rejects secret/token/auth/cookie,
  storage/path, prompt, provider-payload, and stack fields. SQLite triggers
  reject update and delete.
- `IdempotencyRepository` supports begin, replay, complete, retryable failure,
  and bounded cleanup. Only SHA-256 of the client key is stored; semantic
  request hashes distinguish conflict from replay.
- `OutboxRepository` supports enqueue, ordered batch claim, publish,
  reschedule, dead-letter, and expired-lease release with state/owner guards.
  Delivery is at least once.
- `OutboxConsumer` supplies a topic registry, `runOnce`, bounded concurrency,
  retry/dead policy, and shutdown. It is not started automatically and contains
  no product dispatcher or handler.

## Startup and operations

Phase 3A.1 moves the live primary to
`/var/lib/oloka/database/oloka.db`. Before the application opens it, the
entrypoint validates configuration/path containment and performs a bounded
Litestream restore when absent. Litestream then becomes PID 1 and supervises
Fastify. Migrations/readiness run, `deployment.runtime` is updated through an
optimistic short transaction, and storage is probed before listening. Failure
emits safe error code/type only; no secret or public filesystem path is added.

The validation workflow uses exact Node/Litestream versions, runs all existing
quality gates, and proves three starts against pinned MinIO while replacing the
local DB volume after each stop. It requires counts 1/2/3, preserved first start,
unchanged v1/v2 ledger, quick/FK integrity, bounded graceful signal handling,
replica objects, and no credential in logs/config.

Operational metrics are bounded aggregates, not per-SQL telemetry. Warning
thresholds are database-operation p99 over 25 ms, transaction p99 over 20 ms,
event-loop-delay p99 over 50 ms, or any observed `SQLITE_BUSY`.

## Explicit exclusions

This slice does not implement Google login, OAuth identity, Session, Project,
Asset/upload, Composition, Preview, Render, provider adapters, product Jobs,
the durable dispatcher, UI changes, or any Phase 3B behavior.

## Phase 3A.1 production cutover closure

The durability correction was merged through PR #2 at
`f81680443de94cdbd778f9e30e47e2d2392c100b`. The controlled Hugging Face
cutover separately verified the merged runtime SHA, `restore-required` startup,
ready health, startup witness count 3, and an isolated `sqlite-replica/dev`
Litestream chain containing ten LTX objects at closure. The Space source commit
used for the cutover was `b01d539...`; runtime identity remained the GitHub
merge SHA. No database reset occurred, migration v1/v2 stayed byte-stable, and
the ledger remained exactly versions 1 and 2. This closes Phase 3A.1 and does
not imply deployment authorization for Slice 3B.
