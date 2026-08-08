# Phase 3C Canonical Project

Status: implementation in review; production cutover pending.

## Scope

Slice 3C makes SQLite the canonical source of truth for the owner-facing
Project lifecycle. An authenticated active member or admin can create, list,
read, update presentation metadata, favorite, soft-delete, list trash, and
restore an owned Project. Admin role does not bypass ownership.

The implementation intentionally excludes Asset/upload, Job/worker, queue,
Composition, HyperFrames, preview, provider, render, and purge-worker behavior.
No production deployment or migration v4 cutover is part of this review.

## Migration v4

`apps/server/migrations/0004-canonical-project.sql` creates `projects` with:

- opaque UUID identity and `owner_user_id` with `ON DELETE RESTRICT`;
- bounded presentation metadata and boolean favorite organization;
- lifecycle foundation `active`, `soft_deleted`, `purge_scheduled`, `purging`,
  and `purged`;
- epoch-millisecond lifecycle timestamps, retention policy version, and a
  positive optimistic `version`;
- owner list index `(owner_user_id,status,favorite DESC,updated_at DESC,id DESC)`;
- retention index `(status,purge_after)`.

The composition pointer is nullable foundation only. Its foreign key is added
with Composition tables in the later authorized slice. Migrations v1-v3 remain
byte-identical. An existing v3 database is authenticated-backed-up before v4;
an already-applied v4 is a verified no-op.

## Application boundaries

- HTTP routes contain no SQL. `ProjectRepository` owns canonical queries and
  atomic `UPDATE ... WHERE id = ? AND version = ?` transitions.
- `ProjectService` owns authorization, lifecycle, 30-day retention,
  idempotency, signed opaque cursor handling, optimistic conflicts, and audit.
- Project mutation and `project.create`, `project.update`,
  `project.delete_requested`, or `project.restore` audit append commit in the
  same short SQLite transaction.
- Project CRUD has no object-storage, filesystem, provider, network, queue, or
  purge side effect.

## HTTP contract

Implemented owner routes:

```text
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:projectId
PATCH  /api/v1/projects/:projectId
DELETE /api/v1/projects/:projectId
POST   /api/v1/projects/:projectId/restore
GET    /api/v1/trash/projects
```

Unsafe routes require the existing CSRF and canonical `Idempotency-Key`
contracts. Mutable routes require the current positive version. Cross-owner
access, including admin access through owner routes, is indistinguishable from
missing and returns `404 RESOURCE_NOT_FOUND`.

Active lists sort by favorite descending, update time descending, then ID
descending. Pagination cursors are HMAC-authenticated, opaque, filter-bound,
and use default/max sizes 25/100. HTTP timestamps are ISO-8601 UTC and raw DB
rows, ownership columns, purge internals, paths, and storage keys are not
returned.

## Lifecycle

Soft delete changes only canonical DB state, records `deleted_at`, and sets
`purge_after` to 30 days. It neither deletes child rows nor bytes. A restore is
allowed only from `soft_deleted` before the retention deadline and before any
purge acquisition; it clears the soft-delete fields and increments version.
No scheduler, lease, queue, or purge worker exists in Slice 3C.

## Product surface

The active-account landing surface now provides Project and trash lists,
create, edit/rename, favorite/unfavorite, move-to-trash, and restore actions.
It includes loading, empty, request error, version-conflict, and account-status
states without demo Projects.

## Review and cutover boundary

The review gate includes unit, integration, frontend, E2E, build, migration
checksum/backup/integrity, indexed query plans, secret scan, production image
build, and three-boot MinIO/Litestream recovery. Production remains on schema
v3 until a separate audited cutover explicitly authorizes migration v4.
