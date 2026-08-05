# Backup and Recovery

## Objectives and limitation

MVP protects recoverability from application/migration error on one HF persistent volume. A backup stored only under the same `/data` volume is not full disaster recovery; loss of the Space storage can lose both live data and local backups. External encrypted, independently retained backup is a required post-MVP control before stronger DR claims.

Initial targets for Phase 3 validation: RPO at most 24 hours for periodic snapshots plus a pre-migration snapshot; RTO four hours for a documented operator restore. Product owner must confirm these targets.

## Consistent SQLite snapshot

Never copy a live database file or separately copy `.db`, `-wal`, and `-shm`. Preferred implementation on Node 22 is the official `node:sqlite` `backup(sourceDb, destination)` online-backup API after pinning a Node 22 release that includes it. It returns a Promise while using SQLite's online backup mechanism. `VACUUM INTO` is an acceptable operator-controlled fallback when its lock/disk-space behavior is tested.

Official references:

- Node 22 `node:sqlite` (synchronous `DatabaseSync`, backup API): <https://nodejs.org/docs/latest-v22.x/api/sqlite.html>
- SQLite Online Backup API: <https://www.sqlite.org/backup.html>
- SQLite `VACUUM INTO`: <https://www.sqlite.org/lang_vacuum.html>

## Backup protocol

1. Verify destination root containment and available space; allocate a new opaque timestamp/build directory.
2. Quiesce migrations and destructive purge admission; normal reads/writes may continue only for online backup behavior proven by tests.
3. Create the consistent database snapshot to a temporary file, close it, run `quick_check`/`integrity_check` and `foreign_key_check` on the snapshot, record schema version/build/checksum/size.
4. Snapshot the object manifest: each active resource ID/type, opaque key, size, checksum, and lifecycle—not user-visible filenames or secrets.
5. Atomically publish a canonical signed/keyed manifest only after all checks pass. A backup is not “successful” before verification.

Object bytes are immutable and need not be duplicated on every local DB snapshot, but the manifest must allow reconciliation. A complete external backup must copy all manifest-referenced objects plus DB snapshot and then verify checksums.

## Schedule and retention

- pre-migration backup for every pending migration run;
- daily consistent database snapshot;
- retain 7 daily and 4 weekly verified sets by default, subject to storage headroom;
- protect the newest verified pre-migration and recovery-drill set from automated rotation;
- rotation is a durable cleanup job, never deletes live object keys, and alerts before backup use can exhaust `/data`.

## Restore runbook

1. Stop traffic/app and preserve the failed DB/WAL/SHM/object state under an incident directory without overwriting it.
2. Choose a verified backup compatible with the target application build/schema; verify manifest/checksums again.
3. Restore the database as a closed single unit to a fresh path, then atomically select it; do not merge WAL/SHM.
4. Start in maintenance/readiness-blocked mode, apply only expected forward migrations, run integrity/foreign-key/schema smoke checks.
5. Reconcile every active DB object reference to size/checksum and identify orphans/missing bytes. Missing required objects keep affected resources quarantined and readiness/operator status degraded.
6. Run authentication/project/job/output smoke tests, record restore audit/incident metadata, then reopen traffic.

Restore is tested at least before production launch, after migration-runner changes, and quarterly post-MVP. A backup without a successful isolated restore drill is unproven.

## Corruption/startup behavior

Startup refuses readiness on migration checksum mismatch, unsupported newer schema, failed quick/foreign-key check, or unavailable database path. It never silently creates a new empty production DB when the expected `/data` DB is corrupt/unavailable. Operators choose restore or explicit incident-mode recovery. Object reconciliation can degrade individual resources without erasing their evidence.
