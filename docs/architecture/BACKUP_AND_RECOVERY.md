# Backup and Recovery

## Objectives and limitation

MVP uses two complementary mechanisms: Litestream continuously replicates the local SQLite primary to the HF S3 API for ephemeral-disk/rebuild recovery, while authenticated immutable backup sets under `/data` protect migration rollback. Both remain within the same HF provider/account failure domain and are not full disaster recovery. External encrypted, independently retained backup is required before stronger DR claims.

Initial targets for Phase 3 validation: RPO at most 24 hours for periodic snapshots plus a pre-migration snapshot; RTO four hours for a documented operator restore. Product owner must confirm these targets.

The qualification crash observation lost one sparse-write generation and
restored state 8,018 ms old after a commit 60 ms before termination. This is one
measurement, not a maximum RPO and not evidence of zero data loss.

## Consistent SQLite snapshot

Never copy a live database file or separately copy `.db`, `-wal`, and `-shm`.
Preferred implementation is the official `node:sqlite`
`backup(sourceDb, destination)` online-backup API on the exact reviewed Node
22.16.0 runtime (the minimum permitted backup baseline is 22.16.0). It returns a
Promise while using SQLite's online backup mechanism. `VACUUM INTO` is an
acceptable operator-controlled fallback when its lock/disk-space behavior is
tested. Slice 3A must update Docker and GitHub Actions to the same exact patch;
the current floating major image/tag is not an accepted backup-runtime contract.

Official references:

- Node 22 `node:sqlite` (synchronous `DatabaseSync`, backup API): <https://nodejs.org/docs/latest-v22.x/api/sqlite.html>
- SQLite Online Backup API: <https://www.sqlite.org/backup.html>
- SQLite `VACUUM INTO`: <https://www.sqlite.org/lang_vacuum.html>

## Backup protocol

1. Verify destination root containment and available space; allocate a new opaque timestamp/build directory.
2. Quiesce migrations and destructive purge admission; normal reads/writes may continue only for online backup behavior proven by tests.
3. Create the consistent database snapshot to a temporary file, close it, run `quick_check`/`integrity_check` and `foreign_key_check` on the snapshot, record schema version/build/checksum/size.
4. Snapshot the object manifest: each active resource ID/type, opaque key, size, checksum, and lifecycle—not user-visible filenames or secrets.
5. Serialize the manifest as RFC 8785 canonical UTF-8 JSON and compute
   HMAC-SHA256 with the HKDF `oloka/backup-manifest/v1` key. Store algorithm and
   key version beside the MAC, then atomically publish only after all checks
   pass. A backup is not “successful” before verification.

Object bytes are immutable and need not be duplicated on every local DB snapshot, but the manifest must allow reconciliation. A complete external backup must copy all manifest-referenced objects plus DB snapshot and then verify checksums.

## Schedule and retention

- pre-migration backup for every pending migration run;
- daily consistent database snapshot;
- retain 7 daily and 4 weekly verified sets by default, subject to storage headroom;
- protect the newest verified pre-migration and recovery-drill set from automated rotation;
- rotation is a durable cleanup job, never deletes live object keys, and alerts before backup use can exhaust `/data`.

## Restore runbook

1. Stop traffic/app and preserve the failed DB/WAL/SHM/object state under an incident directory without overwriting it. Litestream must be the only supervisor/replicator.
2. Choose a compatible backup; derive the declared manifest key version,
   canonicalize the manifest, verify its HMAC in constant time, then verify all
   recorded checksums before reading it as restore authority.
3. Restore the database as a closed single unit to a fresh path, then atomically select it; do not merge WAL/SHM.
4. Start in maintenance/readiness-blocked mode, apply only expected forward migrations, run integrity/foreign-key/schema smoke checks.
5. Reconcile every active DB object reference to size/checksum and identify orphans/missing bytes. Missing required objects keep affected resources quarantined and readiness/operator status degraded.
6. Run authentication/project/job/output smoke tests, record restore audit/incident metadata, then reopen traffic.

Restore is tested at least before production launch, after migration-runner changes, and quarterly post-MVP. A backup without a successful isolated restore drill is unproven.

Manifest authentication detects unauthorized or corrupt metadata changes; it
does not encrypt the backup and does not turn a same-volume copy into disaster
recovery. Loss or compromise of the HF volume can still affect live data and its
local backups together.

## Corruption/startup behavior

Production keeps the live DB at `/var/lib/oloka/database/oloka.db`. Startup validates containment/symlinks, then restores an absent DB with `litestream restore -config /etc/litestream.yml -integrity-check quick -if-replica-exists`. Any network, authentication, permission, corruption, timeout, or command error fails closed. `restore-required` also fails when no replica exists; only explicit `fresh-if-replica-missing` permits a fresh DB. Readiness then re-verifies migrations, PRAGMAs, quick integrity, foreign keys, startup initialization, and object storage without making a fresh S3 request on every probe.
