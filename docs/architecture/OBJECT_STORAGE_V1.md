# Object Storage V1

Status: Slice 3D implemented, merged, and production cutover complete; private Asset durability verified on HF normal restart.

## Scope

The MVP object adapter stores durable bytes beneath `OBJECT_STORAGE_ROOT` (production `/data`) and temporary upload bytes beneath its staging area. Runtime bytes are never written to Git and are not served by a public static mount. The live SQLite primary is explicitly outside this root at `/var/lib/oloka/database/oloka.db`; `/data/database/oloka-dev.db` is legacy evidence only.

## Key and path contract

- The server creates opaque UUID-based keys such as `v1/ab/<uuid>`; the shard is derived from the UUID.
- Keys never contain an original filename, user ID, project title, MIME type, or client path.
- Clients receive resource IDs, never storage keys or filesystem paths.
- Every adapter operation normalizes separators, rejects absolute paths, `..`, NUL, symlinks, and validates that the resolved target remains under the configured root.
- Durable and staging roots must be on the same filesystem for atomic finalization.

## Object lifecycle

| State           | Durable bytes                  | Database visibility                                                | Allowed operations                               |
| --------------- | ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------ |
| staging         | `/data/tmp/<opaque-upload-id>` | existing Asset is `upload_pending + active`; UploadSession is open | append at DB-acknowledged offset, inspect, abort |
| verified        | staging                        | the same Asset exists; UploadSession is verifying                  | checksum, length, MIME analysis                  |
| active          | `/data/objects/<opaque-key>`   | active Asset/Output/Preview row                                    | authorized read/range                            |
| purge_scheduled | durable key retained           | tombstoned resource                                                | purge job only                                   |
| purged          | absent                         | state records retained as policy permits                           | none                                             |

## Finalize protocol

1. Close the staging handle and flush file data/metadata when required by the platform.
2. Verify actual size, SHA-256 byte checksum, and allowed MIME evidence outside any database transaction.
3. Claim the fresh opaque key preallocated at Asset/upload initialization with a same-filesystem no-clobber primitive (hard-link, flush, then unlink staging); exclusive creation prevents overwrite.
4. In a short guarded transaction, update the existing Asset identity from
   upload state to `processing`, complete the UploadSession, and emit the
   ingestion Job/outbox/audit events. Finalize never creates a second Asset.
5. If the DB commit fails, remove or quarantine the unreferenced new object through reconciliation; never expose it.

Existing keys are immutable. Replacement creates a new key and resource/version. Writes use exclusive creation; no overwrite is allowed.

For append staging, DB `received_size` is the sole acknowledged offset. Before
write, contained file length must equal that value. A flushed uncommitted tail is
truncated back to the DB offset after a crash; the DB is never advanced from file
length. DB-ahead-of-file is corruption: quarantine, reject, alert High, and
reconcile/abort without zero-fill.

## Reconciliation

A periodic job compares active database references with the object manifest, detects missing referenced bytes, checksum mismatch, stale staging files, and unreferenced objects. It reports first and only deletes objects after a retention delay and a second confirmation. Missing active bytes move the resource to a safe failed/unavailable state and raise a High alert.

## Adapter operations

`stage`, `appendAtOffset`, `statStaging`, `finalize`, `openRange`, `head`, `delete`, and `listForReconciliation` are server-only capabilities. Each accepts typed opaque keys or resource-derived handles, not arbitrary strings from an HTTP request.

## Limits

The filesystem, same-bucket backup sets, and Litestream's HF S3 replica share provider/account failure domains. They improve persistence and rebuild recovery but are not independent disaster recovery. Litestream's database replica is durability transport and does not bypass this object-storage interface for product bytes.
