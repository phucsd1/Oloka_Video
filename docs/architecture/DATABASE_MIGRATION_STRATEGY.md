# Database Migration Strategy

Status: normative; migrations v1/v2 are implemented and immutable.

## Contract

Migrations are numbered, named, immutable, forward-only SQL assets executed before the HTTP listener starts. The runner records version, name, SHA-256 checksum, applied time, execution duration, and application build SHA in `schema_migrations`. It refuses startup on a checksum/name mismatch, gap, duplicate version, failed migration, or database schema newer than the application.

The current Persistence Kernel database is schema version 2. Phase 3A.1 changes startup durability only: it creates no migration v3 and does not alter a byte of v1/v2. Services must never infer schema, execute opportunistic `ALTER TABLE`, or edit an applied migration.

## Ledger compatibility

Foundation v1 currently has `schema_migrations(version, name, applied_at)` and uses text time. Migration v2 must deliberately upgrade the ledger without rewriting v1:

1. verify the exact frozen v1 definition known by the application;
2. add/rebuild the ledger to the normative schema from `DATABASE_SCHEMA_V1.md` in a transaction where SQLite permits;
3. backfill v1 with the SHA-256 of the frozen v1 migration asset, a documented bootstrap build marker, and its parsed epoch-millisecond application time;
4. record v2 using the new ledger only after its schema changes succeed.

The migration test fixture must begin from the actual v1 schema, not a reconstructed approximation.

## Planned sequence

| Version | Name                  | Purpose                                                                                                                          | Phase 3 slice   |
| ------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1       | foundation            | Existing `schema_migrations` and `system_metadata`                                                                               | already present |
| 2       | persistence-kernel    | checksum ledger, integer time, metadata normalization, User shell with approval/status evidence, outbox/audit/idempotency kernel | 3A              |
| 3       | identity-and-security | OAuth identities/AEAD transactions, sessions with redacted security metadata, credential references and identity indexes         | 3B              |
| 4       | canonical-project     | Project without current-composition pointer; quota policies with effective intervals and reservations                            | 3C              |
| 5       | private-assets        | Assets including purge timestamps, upload sessions with canonical offset/chunk evidence, delivery capabilities                   | 3D              |
| 6       | durable-job-kernel    | generic provider-independent Jobs/Steps/Events, submission-intent fields and dispatcher indexes; no composition FKs              | 3E              |
| 7       | compositions-preview  | immutable versions/references, Project current pointer, generation/composition lineage on Jobs, versioned preview artifacts      | 3F              |
| 8       | render-outputs        | render-only Job lineage not used before 3H, immutable output core/codecs and guarded output state                                | 3H              |

Version ownership may be split further during Phase 3 review, but ordering and
dependencies may not be collapsed into runtime auto-migration. The final schema
in `DATABASE_SCHEMA_V1.md` shows all columns; this sequence controls when they
may first exist.

Migration v7 uses this exact dependency order inside its reviewed migration:

1. create `composition_versions` (including nullable User/Job creator lineage);
2. create `composition_asset_references`;
3. add/rebuild `projects.current_composition_version_id` with its FK;
4. add/rebuild generation and composition lineage columns on `jobs`;
5. create all related indexes, FKs, CHECKs, and same-Project enforcement;
6. run `foreign_key_check` before ledger commit/readiness.

If a render-only Job column is not consumed until 3H—bundle, render request,
renderer/protocol/HyperFrames, dimensions, provider credential/operation—its
introduction belongs to v8, not v7. Migration v4 therefore cannot reference
`composition_versions`, and v6 cannot contain a FK to it. No migration may
create a foreign key whose target table does not yet exist.

## Execution algorithm

- Restore an absent local primary from the configured Litestream replica before the application opens SQLite. A non-zero restore exit always fails closed; missing replica permits fresh creation only under explicit `fresh-if-replica-missing`.
- Open the database with the required PRAGMAs and acquire an application-wide migration lock.
- Run integrity and ledger checks, discover migration assets, hash their exact UTF-8 bytes, and compare applied rows.
- Create a pre-migration consistent backup before the first pending migration.
- Apply one migration at a time. Use a transaction for all statements where SQLite allows it; document any statement that cannot be transactional before approval.
- Insert the ledger row in the same transaction as the schema change.
- Re-run `foreign_key_check`, the schema smoke queries, and application readiness before listening.
- Never retry a partially non-transactional migration automatically. Stop and require operator recovery.

## Rollback and repair

There are no down migrations. Deployment rollback is: stop the app, preserve failed files, restore the verified pre-migration SQLite backup as one database unit, deploy the compatible prior build, run integrity checks, and reopen traffic. For a defect discovered after valid writes on the new schema, prefer a new forward repair migration; restore only when product owners accept losing writes after the backup point.

Never copy a live `.db` file independently of its WAL/SHM. Use the Node `node:sqlite` online backup API (available in maintained Node 22 releases) as the primary method, or `VACUUM INTO` during an explicitly controlled maintenance path. See `BACKUP_AND_RECOVERY.md`.

## Verification matrix

- fresh empty database to latest;
- exact v1 database to latest;
- each intermediate version to latest;
- no-op second run;
- modified applied asset checksum rejection;
- version gap/newer-version rejection;
- injected failure proves transaction rollback;
- foreign-key and integrity checks;
- backup restore into the prior application build.
- three fresh local volumes restored successively from one pinned MinIO replica, proving witness counts 1/2/3 and a byte-stable v1/v2 ledger.

Litestream 0.5.11 may create `_litestream_lock` and `_litestream_seq` for its own
coordination. They are provider-internal runtime tables and never ledger
entries, application migrations, or authorization/product entities. The
application schema allowlist remains the six Slice 3A tables.
