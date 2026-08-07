# ADR 0027: Local SQLite with Hugging Face S3 replication

- Status: Accepted for implementation; production cutover pending
- Date: 2026-08-06

## Context

SQLite WAL requires ordinary local filesystem locking and write semantics. The
Hugging Face `/data` bucket mount is durable object storage presented through a
filesystem interface; it is not a safe live SQLite primary. Keeping the live
database there risks lock, WAL, latency, and partial-filesystem failures.

The MVP still benefits from SQLite's small operational surface, built-in
`node:sqlite` support, the existing custom migration/repository contracts, and a
single application writer. Moving to an ORM or PostgreSQL in Slice 3A.1 would
expand scope without evidence that the current scale envelope requires it.

The separate qualification PR proved Litestream 0.5.11 against the HF S3 API on
Node 22.16.0. Qualification A-E covered direct object operations, continuous
replication/restore, multiple generations, abrupt termination, repeated
restart, cross-UID process control, bounded outage/recovery, and secret
redaction. The observed crash restored generation 3 after generation 4 had
committed: one sparse-write generation was lost, with a 60 ms commit-to-crash
interval and restored-state age of 8,018 ms. This observation is not a maximum
RPO and does not support a zero-data-loss claim.

## Decision

Use one local SQLite primary at
`/var/lib/oloka/database/oloka.db`. Keep `/data` exclusively for object/media
bytes, immutable backup sets, and legacy evidence. Litestream 0.5.11 runs as
container PID 1, supervises the single Fastify process, and continuously
replicates to HF S3 bucket `oloka-video-dev-data` under
`sqlite-replica/dev`.

The image downloads `litestream-0.5.11-linux-x86_64.tar.gz`, verifies SHA-256
`2f80fdb6b0a0ff7a116ee37adf02d3de8e977ef76e052b28a6690218f0f7ab55`,
and carries only the binary and license into the non-root runtime. Credentials
are environment-only; `/etc/litestream.yml` contains no secret.

Startup validates absolute/real paths and symlinks before opening SQLite. When
the local DB is absent, it runs a bounded, integrity-checked conditional
restore. `fresh-if-replica-missing` permits creation only for local/test or a
controlled first cutover. `restore-required` fails closed when no replica is
available. Production has no bootstrap-mode default and therefore requires an
explicit operator choice.

Migrations remain immutable v1/v2; there is no v3 in this slice. The
`deployment.runtime` witness records first/last start, exact startup count,
build SHA, and runtime mode through the existing optimistic metadata
repository. Litestream 0.5.11 also owns `_litestream_lock` and
`_litestream_seq`; these are transport-internal tables, not application
migrations or product schema.

## Consequences

- Exactly one Space/application writer is supported. A second replica or
  process opening the same primary is forbidden.
- A local-disk loss is recovered from HF S3 before Fastify starts. Litestream
  failure terminates the supervised application instead of leaving false-ready
  HTTP service.
- HF bucket replication and `/data` backups share provider/account failure
  domains. They improve restart durability but are not independent disaster
  recovery.
- Recovery has a non-zero, workload-dependent RPO. Operational evidence must
  report measured loss/age rather than promise zero loss.
- Existing authenticated pre-migration backups remain unchanged under
  `/data/backups/pre-migration`; Litestream does not replace that contract.
- The legacy `/data/database/oloka-dev.db` remains untouched evidence. Its
  read-only bucket snapshot passed `quick_check`/foreign keys and contained only
  the six Slice 3A tables: `schema_migrations` had exactly two rows while
  `users`, `system_metadata`, `audit_events`, `outbox_events`, and
  `idempotency_records` each had zero rows. No product table/data was present,
  so no data migration or deletion is authorized.

PostgreSQL becomes the required exit when more than one application instance
or writer is needed, sustained database-operation/transaction/busy metrics
breach the NFR, independent workers are required, managed PITR or an independent
failure domain is required, or database size/maintenance makes the single-node
envelope unacceptable. That exit needs a separate ADR, migration, rollback,
and product approval.
