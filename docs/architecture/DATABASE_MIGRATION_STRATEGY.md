# Database Migration Strategy

Status: normative Phase 2 design; no migration is created here.

## Contract

Migrations are numbered, named, immutable, forward-only SQL assets executed before the HTTP listener starts. The runner records version, name, SHA-256 checksum, applied time, execution duration, and application build SHA in `schema_migrations`. It refuses startup on a checksum/name mismatch, gap, duplicate version, failed migration, or database schema newer than the application.

The current foundation database is schema version 1. Phase 2 only designs version 2 and later. Services must never infer schema, execute opportunistic `ALTER TABLE`, or edit an applied migration.

## Ledger compatibility

Foundation v1 currently has `schema_migrations(version, name, applied_at)` and uses text time. Migration v2 must deliberately upgrade the ledger without rewriting v1:

1. verify the exact frozen v1 definition known by the application;
2. add/rebuild the ledger to the normative schema from `DATABASE_SCHEMA_V1.md` in a transaction where SQLite permits;
3. backfill v1 with the SHA-256 of the frozen v1 migration asset, a documented bootstrap build marker, and its parsed epoch-millisecond application time;
4. record v2 using the new ledger only after its schema changes succeed.

The migration test fixture must begin from the actual v1 schema, not a reconstructed approximation.

## Planned sequence

| Version | Name                  | Purpose                                                                                                             | Phase 3 slice   |
| ------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1       | foundation            | Existing `schema_migrations` and `system_metadata`                                                                  | already present |
| 2       | persistence-kernel    | checksum-bearing ledger, integer time, metadata normalization, user identity shell, outbox/audit/idempotency kernel | 3A              |
| 3       | identity-and-security | OAuth identities/transactions, sessions, credential references and identity indexes                                 | 3B              |
| 4       | canonical-project     | projects, quota policy/reservation foundation                                                                       | 3C              |
| 5       | private-assets        | assets, upload sessions, delivery capabilities                                                                      | 3D              |
| 6       | durable-job-kernel    | durable jobs/steps/events and dispatcher indexes                                                                    | 3E              |
| 7       | compositions-preview  | immutable versions/references and preview artifacts                                                                 | 3F              |
| 8       | render-outputs        | immutable output core and guarded output state                                                                      | 3H              |

Version ownership may be split further during Phase 3 review, but ordering and dependencies may not be collapsed into runtime auto-migration.

## Execution algorithm

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
