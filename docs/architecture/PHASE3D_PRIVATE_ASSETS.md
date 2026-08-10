# Phase 3D Private Assets

Status: implemented, merged, and production cutover complete. Feature merge
`c04576b5d905c2ef55997c53a90ed84e06512564`; forward correction
`ce6f51845013c41c1906080354e631c026862cfd`; production schema v5 and private
Asset durability across a normal HF restart were verified.

## Scope

Slice 3D introduces private Asset identity, sequential resumable upload,
contained filesystem objects, bounded media inspection, durable ingestion
handoff, owner-only metadata/library APIs, authorized byte delivery, and Asset
soft-delete/restore. It does not introduce Composition, generation, provider,
render, generic Job, worker-lease, queue, SSE, or purge-worker functionality.

## Schema v5

`apps/server/migrations/0005-private-assets.sql` adds only:

- `assets`, with independent ingestion/lifecycle state and opaque immutable
  storage keys;
- `upload_sessions`, with `received_size` as the canonical acknowledged offset;
- `delivery_capabilities`, storing SHA-256 token hashes only.

Migrations v1-v4 remain byte-identical. Exact v4 databases receive one verified
pre-migration backup with source v4, target v5, and pending migration `[5]`.
Restarting an applied v5 database is a migration no-op; Phase 3E creates new
v6 quota/job tables separately.

## Upload and crash boundaries

Initialization atomically admits one Asset and one UploadSession. Original
filenames are normalized display metadata and never form object paths. Storage
and staging keys are opaque server-generated identifiers.

Chunks use `application/offset+octet-stream`, a maximum of 8 MiB, exact
`Upload-Offset`, exact `Content-Length`, and a lowercase SHA-256 header. The
service checks ownership and Project state before resolving a staging key.
Bytes are appended and flushed before a short transaction advances
`received_size`. A retry of the last committed chunk is a no-op only when its
offset, length, and checksum match.

Reconciliation truncates a file-ahead tail to the database offset. A
database-ahead staging file is quarantined as `STORAGE_UNAVAILABLE` and is
never zero-filled or used to decrement canonical state silently.

## Finalization and ingestion

Completion verifies length, whole-file checksum, and bounded magic-byte MIME
evidence outside a database transaction. The staging file is atomically renamed
to a fresh durable key on the same filesystem. A short transaction updates the
same Asset ID to `processing`, completes the UploadSession, appends audit, and
enqueues `asset.ingestion.requested`. The Asset-specific local consumer is
idempotent and moves the Asset to `ready` or typed `failed` without a generic
Job table.

## Delivery and lifecycle

Only `ready + active` Assets are delivered. Owner authentication/authorization
precedes key resolution. GET/HEAD content supports immutable ETag, conditional
304, single byte Range, 206/416, exact length, verified MIME, `nosniff`, private
cache policy, and stream backpressure. Missing canonical bytes return
`STORAGE_UNAVAILABLE`.

Optional five-minute capabilities use random opaque tokens and persist only a
SHA-256 hash scoped to one Asset and operation. Asset soft delete retains bytes,
revokes active capabilities, blocks delivery/new use, and records retention.
Restore requires the owning Project to be active.

## Product surface

Each Project exposes a bounded private Asset workspace with filename search,
resumable 8 MiB upload, server-offset recovery, progress, ready/failed states,
private image/video/audio preview, download, and delete. It never constructs a
`/data` URL or stores storage keys in the browser.

## Deployment boundary

The Phase 3D branch was merged and cut over only after its migration, restart,
and private-byte durability gates passed. Phase 3E remains draft/local work: it
must not be merged or deployed and must not run migration v6 in production.
