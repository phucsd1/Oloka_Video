# Object Storage V1

## Scope

The MVP object adapter stores durable bytes beneath `/data/objects` and temporary upload bytes beneath `/data/tmp`. Runtime bytes are never written to Git and are not served by a public static mount. The interface is intentionally portable to S3-compatible storage later.

## Key and path contract

- The server creates opaque UUID-based keys such as `v1/ab/<uuid>`; the shard is derived from the UUID.
- Keys never contain an original filename, user ID, project title, MIME type, or client path.
- Clients receive resource IDs, never storage keys or filesystem paths.
- Every adapter operation normalizes separators, rejects absolute paths, `..`, NUL, symlinks, and validates that the resolved target remains under the configured root.
- Durable and staging roots must be on the same filesystem for atomic finalization.

## Object lifecycle

| State           | Durable bytes                  | Database visibility                      | Allowed operations                        |
| --------------- | ------------------------------ | ---------------------------------------- | ----------------------------------------- |
| staging         | `/data/tmp/<opaque-upload-id>` | upload session only                      | append at expected offset, inspect, abort |
| verified        | staging                        | not yet an Asset                         | checksum, length, MIME analysis           |
| active          | `/data/objects/<opaque-key>`   | active Asset/Output/Preview row          | authorized read/range                     |
| purge_scheduled | durable key retained           | tombstoned resource                      | purge job only                            |
| purged          | absent                         | state records retained as policy permits | none                                      |

## Finalize protocol

1. Close the staging handle and flush file data/metadata when required by the platform.
2. Verify actual size, SHA-256 byte checksum, and allowed MIME evidence outside any database transaction.
3. Atomically rename on the same filesystem to the fresh opaque key preallocated at Asset/upload initialization; exclusive creation prevents overwrite.
4. In a short guarded transaction, create/activate the database resource and emit outbox/audit events.
5. If the DB commit fails, remove or quarantine the unreferenced new object through reconciliation; never expose it.

Existing keys are immutable. Replacement creates a new key and resource/version. Writes use exclusive creation; no overwrite is allowed.

## Reconciliation

A periodic job compares active database references with the object manifest, detects missing referenced bytes, checksum mismatch, stale staging files, and unreferenced objects. It reports first and only deletes objects after a retention delay and a second confirmation. Missing active bytes move the resource to a safe failed/unavailable state and raise a High alert.

## Adapter operations

`stage`, `appendAtOffset`, `statStaging`, `finalize`, `openRange`, `head`, `delete`, and `listForReconciliation` are server-only capabilities. Each accepts typed opaque keys or resource-derived handles, not arbitrary strings from an HTTP request.

## Limits

The filesystem shares the Space availability zone and `/data` failure domain. It is persistence, not full disaster recovery. External replicated object storage is post-MVP and enters through this interface when scale/DR exit criteria in `TECHNICAL_ARCHITECTURE_V1.md` are met.
