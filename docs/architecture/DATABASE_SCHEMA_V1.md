# Database Schema V1

Status: logical schema blueprint. Project migration v4 and Private Asset migration v5 are implemented, merged, and in production. Quota policy/reservation tables first legally appear in migration v6; v4 creates only the canonical Project.

## Conventions

- SQLite strict typing intent: `TEXT`, `INTEGER`, and `BLOB`; boolean values are `INTEGER CHECK(value IN (0,1))`.
- IDs are UUIDv4 `TEXT`; timestamps are UTC Unix epoch milliseconds `INTEGER`.
- Required text has `CHECK(length(value) > 0)` and domain-specific length bounds in migrations/contracts.
- Every foreign key is indexed unless covered by a stronger index. Parent deletes default to `RESTRICT`; exceptions are explicit below.
- Mutable aggregates have `version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)` for optimistic concurrency.
- Canonical JSON columns contain UTF-8 RFC 8785 JCS text validated by the named Zod schema before write and after read.
- Secrets, session tokens, capability tokens, raw OAuth tokens, and provider keys are never stored in plaintext.

## Schema tables

### `schema_migrations`

| Column            | Type/null/default    | Constraints and meaning                                |
| ----------------- | -------------------- | ------------------------------------------------------ |
| `version`         | INTEGER, not null    | PK; positive monotonically increasing version          |
| `name`            | TEXT, not null       | unique; immutable migration name                       |
| `checksum_sha256` | TEXT, not null       | 64 lowercase hex characters; hash of exact asset bytes |
| `applied_at`      | INTEGER, not null    | epoch ms                                               |
| `execution_ms`    | INTEGER, not null, 0 | non-negative                                           |
| `app_build_sha`   | TEXT, not null       | deploying source revision or bootstrap marker          |

Indexes: unique `(name)`. Lifecycle: append only; no update/delete. Redaction: none, though build SHA is operational metadata. Foundation v1 is upgraded as described in `DATABASE_MIGRATION_STRATEGY.md`.

### `system_metadata`

| Column       | Type/null/default    | Constraints and meaning                |
| ------------ | -------------------- | -------------------------------------- |
| `key`        | TEXT, not null       | PK, controlled allowlist               |
| `value_json` | TEXT, not null       | `SystemMetadataValueV1` canonical JSON |
| `updated_at` | INTEGER, not null    | epoch ms                               |
| `version`    | INTEGER, not null, 1 | positive optimistic version            |

Lifecycle: upsert only through a system repository. Never stores secrets or tenant data. Foundation `system_metadata` is normalized by migration v2.

### `users`

| Column                | Type/null/default         | Constraints and meaning                                |
| --------------------- | ------------------------- | ------------------------------------------------------ |
| `id`                  | TEXT, not null            | PK UUIDv4                                              |
| `email_normalized`    | TEXT, not null            | unique; lowercase canonical Google email               |
| `display_name`        | TEXT, not null            | bounded display value                                  |
| `avatar_url`          | TEXT, nullable            | validated Google HTTPS URL; display only               |
| `role`                | TEXT, not null, `member`  | check `member, admin`                                  |
| `status`              | TEXT, not null, `pending` | check `pending, active, disabled, rejected`            |
| `approved_at`         | INTEGER, nullable         | required for active users                              |
| `approved_by_user_id` | TEXT, nullable            | self FK users RESTRICT; null only for system bootstrap |
| `disabled_at`         | INTEGER, nullable         | required while disabled                                |
| `rejected_at`         | INTEGER, nullable         | required while rejected                                |
| `created_at`          | INTEGER, not null         | epoch ms                                               |
| `updated_at`          | INTEGER, not null         | epoch ms                                               |
| `last_login_at`       | INTEGER, nullable         | epoch ms                                               |
| `version`             | INTEGER, not null, 1      | optimistic version                                     |

Indexes: unique `(email_normalized)`; `(status, id)`; `(approved_by_user_id)`.
Lifecycle checks require approval evidence for `active`, disable/reject evidence
for those terminal access states, and mutually consistent timestamps. Google
identity normally creates a `pending` member. The one documented system
bootstrap may create/upgrade the first admin with `approved_by_user_id=null` and
an `admin.bootstrap` AuditEvent. Admin status/role change, session revocation,
last-active-admin guard, and AuditEvent commit atomically. Redaction: APIs expose
only actor-appropriate profile fields.

### `oauth_identities`

| Column          | Type/null/default | Constraints and meaning           |
| --------------- | ----------------- | --------------------------------- |
| `id`            | TEXT, not null    | PK UUIDv4                         |
| `user_id`       | TEXT, not null    | FK `users(id)` ON DELETE RESTRICT |
| `issuer`        | TEXT, not null    | exact normalized HTTPS issuer     |
| `subject`       | TEXT, not null    | stable OIDC subject               |
| `email_at_link` | TEXT, not null    | audit snapshot, normalized        |
| `created_at`    | INTEGER, not null | epoch ms                          |
| `last_seen_at`  | INTEGER, not null | epoch ms                          |

Constraints/indexes: unique `(issuer, subject)`; index `(user_id)`. Lifecycle: link only after validated OIDC callback; no automatic relink on email alone. Raw ID/access/refresh tokens are never persisted.

### `oauth_transactions` (technical)

| Column                     | Type/null/default         | Constraints and meaning                         |
| -------------------------- | ------------------------- | ----------------------------------------------- |
| `id`                       | TEXT, not null            | PK UUIDv4                                       |
| `state_hash_sha256`        | BLOB, not null            | unique 32-byte hash of random state             |
| `nonce_hash_sha256`        | BLOB, not null            | 32-byte hash of OIDC nonce                      |
| `pkce_verifier_ciphertext` | BLOB, not null            | AES-256-GCM ciphertext, never plaintext at rest |
| `pkce_cipher_algorithm`    | TEXT, not null            | literal `AES-256-GCM`                           |
| `pkce_iv`                  | BLOB, not null            | unique random 12-byte nonce per encryption      |
| `pkce_auth_tag`            | BLOB, not null            | 16-byte authentication tag                      |
| `key_version`              | INTEGER, not null         | positive derived-key version for decryption     |
| `return_path`              | TEXT, not null            | allowlisted same-origin relative destination    |
| `status`                   | TEXT, not null, `pending` | check `pending, consumed, expired`              |
| `created_at`               | INTEGER, not null         | epoch ms                                        |
| `expires_at`               | INTEGER, not null         | short expiry greater than created time          |
| `consumed_at`              | INTEGER, nullable         | epoch ms                                        |

Indexes: unique state hash; `(status,expires_at)`. Lifecycle: one-use callback
transaction, marked consumed before exchange/replay can race. Expired/consumed
rows and their verifier envelope are purged within 24 hours. The encryption key
is HKDF-derived for OAuth PKCE and versioned; IV/tag/algorithm are authenticated
envelope metadata. All hashes/ciphertext are redacted; ID/access/refresh tokens
are never stored.

### `sessions`

| Column                   | Type/null/default        | Constraints and meaning                    |
| ------------------------ | ------------------------ | ------------------------------------------ |
| `id`                     | TEXT, not null           | PK UUIDv4, not the cookie value            |
| `user_id`                | TEXT, not null           | FK `users(id)` ON DELETE RESTRICT          |
| `token_hash_sha256`      | BLOB, not null           | unique 32-byte hash of random cookie token |
| `csrf_token_hash_sha256` | BLOB, not null           | 32-byte synchronizer-token hash            |
| `status`                 | TEXT, not null, `active` | check `active, revoked, expired`           |
| `created_at`             | INTEGER, not null        | epoch ms                                   |
| `expires_at`             | INTEGER, not null        | greater than created time                  |
| `last_seen_at`           | INTEGER, not null        | epoch ms; rate-limited update              |
| `ip_hash`                | BLOB, nullable           | keyed hash of normalized privacy prefix    |
| `user_agent_summary`     | TEXT, nullable           | bounded coarse family/device summary       |
| `rotated_from_id`        | TEXT, nullable           | self FK ON DELETE SET NULL                 |
| `revoked_at`             | INTEGER, nullable        | epoch ms                                   |
| `revoke_reason`          | TEXT, nullable           | safe enum/reason, no token data            |

Indexes: unique token hash; `(user_id,status,expires_at)`; `(expires_at,status)`.
IP input is normalized to a coarse IPv4 /24 or IPv6 /48 prefix, then HMACed with
a dedicated derived key; raw IP is never persisted. User agent is parsed into a
bounded coarse browser/OS/device-class summary with versions and free-form text
removed. Both fields are redacted from user/admin APIs and ordinary logs and are
purged with terminal session rows no later than 90 days after expiry/revocation.
Lifecycle: rotate on login and privilege change; expire/revoke instead of delete
until retention cleanup. Hashes are never returned or logged.

### `projects`

| Column                           | Type/null/default        | Constraints and meaning                                                  |
| -------------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `id`                             | TEXT, not null           | PK UUIDv4                                                                |
| `owner_user_id`                  | TEXT, not null           | FK `users(id)` ON DELETE RESTRICT                                        |
| `name`                           | TEXT, not null           | bounded, trimmed                                                         |
| `description`                    | TEXT, nullable           | bounded user text                                                        |
| `favorite`                       | INTEGER, not null, 0     | boolean list organization only                                           |
| `status`                         | TEXT, not null, `active` | check `active, soft_deleted, purge_scheduled, purging, purged`           |
| `current_composition_version_id` | TEXT, nullable           | FK `composition_versions(id)` ON DELETE RESTRICT; same-project invariant |
| `created_at`                     | INTEGER, not null        | epoch ms                                                                 |
| `updated_at`                     | INTEGER, not null        | epoch ms                                                                 |
| `deleted_at`                     | INTEGER, nullable        | present for tombstone states                                             |
| `purge_after`                    | INTEGER, nullable        | retention deadline                                                       |
| `purged_at`                      | INTEGER, nullable        | required for the retained purged tombstone                               |
| `retention_policy_version`       | INTEGER, nullable        | policy version that authorized scheduling/purge                          |
| `version`                        | INTEGER, not null, 1     | optimistic version                                                       |

Indexes: `(owner_user_id,status,favorite DESC,updated_at DESC,id DESC)`;
`(status,purge_after)`. Lifecycle: `soft_deleted` immediately blocks
mutation/new work and is restorable for 30 days until a purge lease wins. Purge
jobs remove child bytes/eligible active records but preserve a non-restorable
privacy-safe tombstone. `safeAuditReferences` is not a JSON column: it is the
authorized query/relation from the Project ID to append-only `audit_events`.
When `status=purged`, name and description are cleared/redacted, favorite is
false, current-composition pointer is null, `purged_at` and policy version are
required, and only opaque ownership lineage plus safe audit metadata remains.
No hard cascade from user.

Slice 3C migration v4 creates only this Project foundation. The nullable
`current_composition_version_id` column intentionally has no foreign key until
the Composition table is introduced in its authorized later migration. Slice
3C does not create Asset, Job, quota, queue, or purge-worker tables.

### `assets`

| Column                 | Type/null/default                | Constraints and meaning                                             |
| ---------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `id`                   | TEXT, not null                   | PK UUIDv4                                                           |
| `project_id`           | TEXT, not null                   | FK `projects(id)` ON DELETE RESTRICT                                |
| `owner_user_id`        | TEXT, not null                   | FK `users(id)` ON DELETE RESTRICT; denormalized authorization guard |
| `original_filename`    | TEXT, not null                   | normalized display/search metadata, never path                      |
| `kind`                 | TEXT, not null                   | check `image, video, audio, font`                                   |
| `declared_mime`        | TEXT, nullable                   | client claim                                                        |
| `verified_mime`        | TEXT, nullable                   | analysis result                                                     |
| `storage_key`          | TEXT, not null                   | unique opaque server key allocated at upload initialization         |
| `byte_size`            | INTEGER, nullable                | non-negative; actual size required at processing/ready              |
| `byte_checksum_sha256` | TEXT, nullable                   | 64 hex; required after completion                                   |
| `metadata_json`        | TEXT, nullable                   | `AssetMetadataV1` canonical JSON                                    |
| `ingestion_status`     | TEXT, not null, `upload_pending` | check `upload_pending, uploading, processing, ready, failed`        |
| `lifecycle_status`     | TEXT, not null, `active`         | check `active, soft_deleted, purge_scheduled, purging, purged`      |
| `failure_code`         | TEXT, nullable                   | safe code only                                                      |
| `created_at`           | INTEGER, not null                | epoch ms                                                            |
| `updated_at`           | INTEGER, not null                | epoch ms                                                            |
| `deleted_at`           | INTEGER, nullable                | tombstone time                                                      |
| `purge_after`          | INTEGER, nullable                | retention deadline                                                  |
| `purge_scheduled_at`   | INTEGER, nullable                | epoch ms; required once purge is scheduled                          |
| `purged_at`            | INTEGER, nullable                | epoch ms; required when lifecycle is purged                         |
| `version`              | INTEGER, not null, 1             | optimistic version                                                  |

Indexes: unique `(storage_key)`; `(project_id,lifecycle_status,ingestion_status,created_at DESC,id DESC)`; `(owner_user_id,lifecycle_status)`; `(lifecycle_status,purge_after)`. Lifecycle follows `ASSET_LIFECYCLE.md`; only `ready + active` is referenceable. Ingestion and lifecycle are independent. Composition references use IDs and block purge while a retained immutable version needs the asset. Storage key/checksum are operator-only.

### `upload_sessions`

| Column                       | Type/null/default      | Constraints and meaning                                        |
| ---------------------------- | ---------------------- | -------------------------------------------------------------- |
| `id`                         | TEXT, not null         | PK UUIDv4                                                      |
| `project_id`                 | TEXT, not null         | FK projects RESTRICT                                           |
| `owner_user_id`              | TEXT, not null         | FK users RESTRICT                                              |
| `asset_id`                   | TEXT, not null         | unique FK assets RESTRICT; created at initialization           |
| `staging_key`                | TEXT, not null         | unique opaque server key                                       |
| `original_filename`          | TEXT, not null         | normalized display metadata                                    |
| `declared_mime`              | TEXT, nullable         | bounded media type                                             |
| `declared_size`              | INTEGER, not null      | positive and policy bounded                                    |
| `declared_checksum_sha256`   | TEXT, nullable         | 64 hex                                                         |
| `received_size`              | INTEGER, not null, 0   | between zero and declared size                                 |
| `last_chunk_offset`          | INTEGER, nullable      | start offset of last committed chunk                           |
| `last_chunk_size`            | INTEGER, nullable      | non-negative committed chunk length                            |
| `last_chunk_checksum_sha256` | TEXT, nullable         | retry reconciliation only                                      |
| `status`                     | TEXT, not null, `open` | check `open, verifying, completed, aborted, expired, rejected` |
| `expires_at`                 | INTEGER, not null      | epoch ms                                                       |
| `created_at`                 | INTEGER, not null      | epoch ms                                                       |
| `updated_at`                 | INTEGER, not null      | epoch ms                                                       |
| `version`                    | INTEGER, not null, 1   | optimistic version                                             |

Indexes: unique staging key; `(owner_user_id,status,expires_at)`;
`(project_id,status)`; unique `(asset_id)`. `received_size` is the canonical
acknowledged offset. The three last-chunk fields are all null before the first
commit and all present afterward; offset plus size equals `received_size`.
Lifecycle is `UPLOAD_PROTOCOL_V1.md`. Staging key is redacted.

### `composition_versions`

| Column                         | Type/null/default | Constraints and meaning                                 |
| ------------------------------ | ----------------- | ------------------------------------------------------- |
| `id`                           | TEXT, not null    | PK UUIDv4                                               |
| `project_id`                   | TEXT, not null    | FK projects RESTRICT                                    |
| `created_by_user_id`           | TEXT, nullable    | FK users RESTRICT; present for direct/user lineage      |
| `created_by_job_id`            | TEXT, nullable    | FK jobs RESTRICT; present for generated lineage         |
| `version_number`               | INTEGER, not null | positive per-project sequence                           |
| `parent_version_id`            | TEXT, nullable    | self FK RESTRICT                                        |
| `schema_version`               | INTEGER, not null | initially 1                                             |
| `composition_json`             | TEXT, not null    | `CompositionDocumentV1` canonical JSON                  |
| `canonical_hash_sha256`        | TEXT, not null    | RFC 8785 bytes hash                                     |
| `semantic_request_hash_sha256` | TEXT, nullable    | generator request identity, distinct from document hash |
| `status`                       | TEXT, not null    | check `draft, valid, invalid`                           |
| `validation_json`              | TEXT, not null    | `CompositionValidationResultV1` canonical JSON          |
| `created_at`                   | INTEGER, not null | epoch ms                                                |

Constraints/indexes: unique `(project_id,version_number)`;
non-unique lookup `(project_id,canonical_hash_sha256)`;
`(project_id,created_at DESC,id DESC)`. A CHECK requires at least one creator;
both are allowed. When job lineage is present, that Job must have the same
Project. Generation never fabricates a user creator. Immutable after insert;
identical canonical documents may exist as distinct version/audit events.
Invalid versions remain inspectable but cannot preview/render. Referenced asset
IDs are materialized in `composition_asset_references`. User APIs return
authorized structured documents but redact generator request details and
internal manifest/object references; retained versions purge only under Project
retention policy.

### `composition_asset_references` (technical)

| Column                   | Type/null/default | Constraints and meaning          |
| ------------------------ | ----------------- | -------------------------------- |
| `composition_version_id` | TEXT, not null    | FK composition_versions RESTRICT |
| `asset_id`               | TEXT, not null    | FK assets RESTRICT               |
| `usage`                  | TEXT, not null    | check `visual, audio, font`      |

PK `(composition_version_id,asset_id,usage)`; index `(asset_id)`. Inserted atomically with the immutable version. It supplies referential/purge checks that must not be hidden in JSON. It shares the parent version's retention and is not exposed as a standalone API resource; no storage key is present.

### `jobs`

| Column                             | Type/null/default      | Constraints and meaning                                                                               |
| ---------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`                               | TEXT, not null         | PK UUIDv4                                                                                             |
| `project_id`                       | TEXT, nullable         | FK projects RESTRICT; null only for system cleanup                                                    |
| `owner_user_id`                    | TEXT, nullable         | FK users RESTRICT; null only for system jobs                                                          |
| `parent_job_id`                    | TEXT, nullable         | self FK jobs RESTRICT; render lineage only                                                            |
| `type`                             | TEXT, not null         | check `generation, render, asset_ingestion, project_purge, asset_purge, output_purge, upload_cleanup` |
| `status`                           | TEXT, not null         | Phase 1 Job state-machine enum                                                                        |
| `priority`                         | INTEGER, not null, 100 | bounded; lower claimed first                                                                          |
| `request_json`                     | TEXT, not null         | type-specific `JobRequestV1` canonical JSON, secrets prohibited                                       |
| `result_json`                      | TEXT, nullable         | type-specific `JobResultV1` safe canonical JSON                                                       |
| `progress_basis_points`            | INTEGER, not null, 0   | 0..10000, durable real progress                                                                       |
| `current_step_key`                 | TEXT, nullable         | authoritative current logical step; never inferred from logs/files                                    |
| `attempt_count`                    | INTEGER, not null, 0   | non-negative                                                                                          |
| `max_attempts`                     | INTEGER, not null      | positive                                                                                              |
| `available_at`                     | INTEGER, not null      | eligibility time                                                                                      |
| `lease_owner`                      | TEXT, nullable         | process instance opaque ID                                                                            |
| `lease_expires_at`                 | INTEGER, nullable      | epoch ms                                                                                              |
| `heartbeat_at`                     | INTEGER, nullable      | epoch ms                                                                                              |
| `cancel_requested_at`              | INTEGER, nullable      | epoch ms                                                                                              |
| `failure_code`                     | TEXT, nullable         | safe stable code                                                                                      |
| `base_composition_version_id`      | TEXT, nullable         | FK composition_versions RESTRICT; generation source                                                   |
| `composition_version_id`           | TEXT, nullable         | FK composition_versions RESTRICT; render source                                                       |
| `render_request_hash_sha256`       | TEXT, nullable         | semantic render request hash                                                                          |
| `bundle_storage_key`               | TEXT, nullable         | opaque server reference, operator-only                                                                |
| `bundle_checksum_sha256`           | TEXT, nullable         | immutable render bundle checksum                                                                      |
| `renderer_version`                 | TEXT, nullable         | pinned renderer version                                                                               |
| `render_protocol_version`          | INTEGER, nullable      | positive protocol version                                                                             |
| `hyperframes_version`              | TEXT, nullable         | pinned HyperFrames version                                                                            |
| `requested_width`                  | INTEGER, nullable      | positive render width                                                                                 |
| `requested_height`                 | INTEGER, nullable      | positive render height                                                                                |
| `provider_credential_reference_id` | TEXT, nullable         | FK credential references RESTRICT                                                                     |
| `provider_operation_id`            | TEXT, nullable         | remote operation identity, operator-only                                                              |
| `created_at`                       | INTEGER, not null      | epoch ms                                                                                              |
| `started_at`                       | INTEGER, nullable      | epoch ms                                                                                              |
| `finished_at`                      | INTEGER, nullable      | epoch ms                                                                                              |
| `updated_at`                       | INTEGER, not null      | epoch ms                                                                                              |
| `version`                          | INTEGER, not null, 1   | guarded transitions                                                                                   |

Indexes: claim `(status,available_at,priority,created_at,id)`; lease `(status,lease_expires_at)`; `(parent_job_id,type)`; user/project listings; finished retention; provider-operation lookup. Type-specific CHECK/service validation requires generation lineage fields only for generation and render lineage fields only for render. Parent and child must share Project; generation has no parent, while render may have a generation parent or be standalone. Lifecycle is exactly `JOB_STATE_MACHINE.md`; terminal rows are retained per policy, never made successful by cleanup.

### `job_steps`

| Column                                 | Type/null/default     | Constraints and meaning                                                  |
| -------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `id`                                   | TEXT, not null        | PK UUIDv4                                                                |
| `job_id`                               | TEXT, not null        | FK jobs RESTRICT                                                         |
| `parent_step_id`                       | TEXT, nullable        | self FK RESTRICT, same job enforced by service/test                      |
| `step_key`                             | TEXT, not null        | stable logical stage                                                     |
| `item_key`                             | TEXT, not null, empty | stable fan-out item identity                                             |
| `status`                               | TEXT, not null        | JobStep state-machine enum                                               |
| `attempt_count`                        | INTEGER, not null, 0  | non-negative                                                             |
| `max_attempts`                         | INTEGER, not null     | positive                                                                 |
| `available_at`                         | INTEGER, not null     | epoch ms                                                                 |
| `lease_owner`                          | TEXT, nullable        | opaque process ID                                                        |
| `lease_expires_at`                     | INTEGER, nullable     | epoch ms                                                                 |
| `heartbeat_at`                         | INTEGER, nullable     | epoch ms; guarded by the active lease                                    |
| `timeout_at`                           | INTEGER, nullable     | absolute attempt deadline                                                |
| `started_at`                           | INTEGER, nullable     | first accepted execution start                                           |
| `completed_at`                         | INTEGER, nullable     | terminal completion time                                                 |
| `provider_operation_id`                | TEXT, nullable        | provider-safe opaque reference, redacted from user API                   |
| `provider_submission_state`            | TEXT, nullable        | check `requested, accepted, outcome_unknown`; null for non-provider work |
| `provider_request_hash_sha256`         | TEXT, nullable        | canonical semantic provider request hash                                 |
| `provider_idempotency_key_hash_sha256` | TEXT, nullable        | hash of stable provider idempotency key                                  |
| `provider_submission_attempt`          | INTEGER, not null, 0  | non-negative submission-intent attempt                                   |
| `input_json`                           | TEXT, not null        | `JobStepInputV1` canonical JSON, no secrets                              |
| `result_json`                          | TEXT, nullable        | `JobStepResultV1` canonical JSON                                         |
| `failure_code`                         | TEXT, nullable        | safe stable code                                                         |
| `created_at`                           | INTEGER, not null     | epoch ms                                                                 |
| `updated_at`                           | INTEGER, not null     | epoch ms                                                                 |
| `version`                              | INTEGER, not null, 1  | guarded transitions                                                      |

Constraints/indexes use two exact partial unique indexes: unique
`(job_id,step_key,item_key)` where `parent_step_id IS NULL`, and unique
`(job_id,parent_step_id,step_key,item_key)` where `parent_step_id IS NOT NULL`.
There is no sentinel representation. Additional indexes cover `(job_id,status)`
and claim/lease lookup. Retryable path is running or waiting-provider to
retry-scheduled, pending, then running; `failed` is terminal. Provider intent
fields and the matching outbox event commit before the remote call; an operation
ID appears only after provider acceptance.

### `job_events`

| Column         | Type/null/default | Constraints and meaning                       |
| -------------- | ----------------- | --------------------------------------------- |
| `id`           | TEXT, not null    | PK UUIDv4; SSE event ID                       |
| `job_id`       | TEXT, not null    | FK jobs RESTRICT                              |
| `sequence`     | INTEGER, not null | positive, monotonic per job                   |
| `type`         | TEXT, not null    | stable allowlisted event type                 |
| `payload_json` | TEXT, not null    | `PublicJobEventPayloadV1`, safe and canonical |
| `created_at`   | INTEGER, not null | epoch ms                                      |

Unique `(job_id,sequence)`; index `(job_id,created_at,id)`. Append-only durable replay; never stores logs, prompts, secrets, or raw provider payloads.

### `render_outputs`

| Column                               | Type/null/default | Constraints and meaning                                                 |
| ------------------------------------ | ----------------- | ----------------------------------------------------------------------- |
| `id`                                 | TEXT, not null    | PK UUIDv4                                                               |
| `project_id`                         | TEXT, not null    | FK projects RESTRICT                                                    |
| `composition_version_id`             | TEXT, not null    | FK composition_versions RESTRICT                                        |
| `render_job_id`                      | TEXT, not null    | FK jobs RESTRICT                                                        |
| `storage_key`                        | TEXT, not null    | unique opaque server key                                                |
| `byte_size`                          | INTEGER, not null | positive                                                                |
| `byte_checksum_sha256`               | TEXT, not null    | 64 hex byte checksum                                                    |
| `content_type`                       | TEXT, not null    | allowlisted video type                                                  |
| `width`                              | INTEGER, not null | positive                                                                |
| `height`                             | INTEGER, not null | positive                                                                |
| `duration_ms`                        | INTEGER, not null | positive                                                                |
| `fps_milli`                          | INTEGER, not null | positive fixed-point FPS                                                |
| `video_codec`                        | TEXT, not null    | immutable allowlisted inspected codec                                   |
| `audio_codec`                        | TEXT, nullable    | immutable inspected codec; null only when audio is not required/present |
| `provider`                           | TEXT, not null    | `modal` in MVP                                                          |
| `provider_operation_id`              | TEXT, nullable    | operator-only reference                                                 |
| `bundle_checksum_sha256`             | TEXT, not null    | exact immutable render bundle checksum                                  |
| `composition_schema_version`         | INTEGER, not null | positive composition contract version                                   |
| `render_protocol_version`            | INTEGER, not null | positive provider protocol version                                      |
| `renderer_version`                   | TEXT, not null    | pinned renderer version                                                 |
| `hyperframes_version`                | TEXT, not null    | pinned HyperFrames version                                              |
| `dependency_manifest_hash_sha256`    | TEXT, not null    | canonical dependency manifest hash                                      |
| `asset_manifest_hash_sha256`         | TEXT, not null    | canonical asset manifest hash                                           |
| `font_manifest_hash_sha256`          | TEXT, not null    | canonical font manifest hash                                            |
| `caption_manifest_hash_sha256`       | TEXT, not null    | canonical caption manifest hash                                         |
| `render_contract_fingerprint_sha256` | TEXT, not null    | canonical lineage fingerprint                                           |
| `created_at`                         | INTEGER, not null | epoch ms                                                                |

Unique storage key and render job (one accepted output per job); project/composition indexes. Immutable after insert. Storage/provider fields are redacted from user APIs.

### `render_output_state`

| Column                   | Type/null/default              | Constraints and meaning                                                          |
| ------------------------ | ------------------------------ | -------------------------------------------------------------------------------- |
| `render_output_id`       | TEXT, not null                 | PK/FK render_outputs RESTRICT                                                    |
| `availability_state`     | TEXT, not null, `pending`      | check `pending, uploaded, verifying, verified, failed_verification, unavailable` |
| `technical_status`       | TEXT, not null, `pending`      | check `pending, passed, failed`                                                  |
| `visual_review_status`   | TEXT, not null, `not_reviewed` | check `not_reviewed, passed, failed`                                             |
| `human_approval_status`  | TEXT, not null, `not_required` | check `not_required, pending, approved, rejected`                                |
| `retention_state`        | TEXT, not null, `active`       | check `active, purge_scheduled, purging, purged`                                 |
| `pinned`                 | INTEGER, not null, 0           | boolean; blocks automatic scheduling only                                        |
| `latest_verification_id` | TEXT, nullable                 | FK `render_output_verifications(id)` ON DELETE RESTRICT                          |
| `verified_at`            | INTEGER, nullable              | epoch ms                                                                         |
| `purge_scheduled_at`     | INTEGER, nullable              | epoch ms                                                                         |
| `purged_at`              | INTEGER, nullable              | epoch ms                                                                         |
| `updated_at`             | INTEGER, not null              | epoch ms                                                                         |
| `version`                | INTEGER, not null, 1           | optimistic version                                                               |

Indexes `(retention_state,purge_scheduled_at)`, `(availability_state,technical_status)`, and `(pinned,retention_state)`. Mutable lifecycle/review is deliberately separate from immutable output evidence. Delivery requires `verified + technical passed + retention active`; purge completion records `retention=purged` and `availability=unavailable` atomically. Object existence never changes state automatically.

### `render_output_verifications` (technical)

| Column                 | Type/null/default | Constraints and meaning                                              |
| ---------------------- | ----------------- | -------------------------------------------------------------------- |
| `id`                   | TEXT, not null    | PK UUIDv4                                                            |
| `render_output_id`     | TEXT, not null    | FK render_outputs RESTRICT                                           |
| `attempt`              | INTEGER, not null | positive verification attempt                                        |
| `passed`               | INTEGER, not null | boolean technical-gate result                                        |
| `result_json`          | TEXT, not null    | immutable `TechnicalQualityResultV1` canonical measurements/findings |
| `evidence_hash_sha256` | TEXT, not null    | canonical verification evidence hash                                 |
| `created_at`           | INTEGER, not null | epoch ms                                                             |

Unique `(render_output_id,attempt)`; index `(render_output_id,created_at DESC,id DESC)`. Append-only and redacted. TX-18 inserts evidence and points guarded mutable state at it atomically; prior attempts remain evidence.

### `preview_artifacts` (technical)

| Column                               | Type/null/default | Constraints and meaning                             |
| ------------------------------------ | ----------------- | --------------------------------------------------- |
| `id`                                 | TEXT, not null    | PK UUIDv4                                           |
| `composition_version_id`             | TEXT, not null    | FK composition_versions RESTRICT                    |
| `render_contract_fingerprint_sha256` | TEXT, not null    | canonical render-lineage fingerprint                |
| `materializer_version`               | TEXT, not null    | trusted build/package fingerprint                   |
| `hyperframes_version`                | TEXT, not null    | pinned runtime/player version                       |
| `csp_profile_version`                | INTEGER, not null | positive                                            |
| `storage_key`                        | TEXT, not null    | unique opaque artifact key                          |
| `byte_checksum_sha256`               | TEXT, not null    | artifact byte checksum                              |
| `status`                             | TEXT, not null    | check `ready, quarantined, purge_scheduled, purged` |
| `created_at`                         | INTEGER, not null | epoch ms                                            |
| `purge_after`                        | INTEGER, nullable | epoch ms                                            |

Unique `(composition_version_id,render_contract_fingerprint_sha256,materializer_version,csp_profile_version)`;
indexes `(status,purge_after)` and `(composition_version_id,created_at DESC,id DESC)`.
HyperFrames version participates in the fingerprint. Historical artifacts for
materializer, HyperFrames, CSP, registry, manifest, or fingerprint changes are
allowed and never overwritten.

### `provider_credential_references`

| Column                      | Type/null/default    | Constraints and meaning                          |
| --------------------------- | -------------------- | ------------------------------------------------ |
| `id`                        | TEXT, not null       | PK UUIDv4                                        |
| `provider`                  | TEXT, not null       | allowlisted provider                             |
| `purpose`                   | TEXT, not null       | allowlisted capability                           |
| `environment_variable_name` | TEXT, not null       | uppercase safe identifier, never its value       |
| `status`                    | TEXT, not null       | check `configured, disabled, unhealthy, unknown` |
| `last_health_at`            | INTEGER, nullable    | epoch ms                                         |
| `last_health_code`          | TEXT, nullable       | safe code only                                   |
| `created_at`                | INTEGER, not null    | epoch ms                                         |
| `updated_at`                | INTEGER, not null    | epoch ms                                         |
| `version`                   | INTEGER, not null, 1 | optimistic version                               |

Unique `(provider,purpose)`; index status. Lifecycle is configured/disabled plus guarded health updates; history-changing actions are audited, and deletion is restricted while retained Jobs reference it. Admin can change the reference name/status, not the HF secret. Actual values and provider error bodies are forbidden.

### `audit_events`

| Column          | Type/null/default | Constraints and meaning                  |
| --------------- | ----------------- | ---------------------------------------- |
| `id`            | TEXT, not null    | PK UUIDv4                                |
| `sequence`      | INTEGER, not null | unique increasing application sequence   |
| `actor_user_id` | TEXT, nullable    | FK users RESTRICT; null for system       |
| `actor_type`    | TEXT, not null    | check `user, admin, system`              |
| `action`        | TEXT, not null    | stable allowlisted action                |
| `resource_type` | TEXT, not null    | safe type                                |
| `resource_id`   | TEXT, nullable    | retained opaque ID, no cascading FK      |
| `outcome`       | TEXT, not null    | check `success, denied, failed`          |
| `metadata_json` | TEXT, not null    | `AuditMetadataV1` canonical and redacted |
| `created_at`    | INTEGER, not null | epoch ms                                 |

Indexes: unique sequence; `(created_at,id)`; `(actor_user_id,created_at,id)`; `(resource_type,resource_id,created_at)`. Append-only, no cascade/update/delete through application code. Never includes secrets, cookie/token hashes, prompt bodies, storage keys, or raw provider responses.

### `quota_policies`

| Column               | Type/null/default    | Constraints and meaning                   |
| -------------------- | -------------------- | ----------------------------------------- |
| `id`                 | TEXT, not null       | PK UUIDv4                                 |
| `scope_type`         | TEXT, not null       | check `system, user`                      |
| `scope_id`           | TEXT, nullable       | user UUID for user scope; null for system |
| `policy_json`        | TEXT, not null       | `QuotaPolicyV1` canonical JSON            |
| `effective_from`     | INTEGER, not null    | epoch ms                                  |
| `effective_until`    | INTEGER, nullable    | exclusive epoch-ms interval end           |
| `created_by_user_id` | TEXT, nullable       | FK admin user RESTRICT                    |
| `created_at`         | INTEGER, not null    | epoch ms                                  |
| `version`            | INTEGER, not null, 1 | optimistic version                        |

Indexes `(scope_type,scope_id,effective_from DESC)` and
`(scope_type,scope_id,effective_until)`. Intervals are half-open
`[effective_from,effective_until)`; null end means open-ended. A guarded insert
rejects overlapping intervals for the same scope. Resolution at instant `t`
selects the matching user policy first, otherwise the matching system policy,
ordered by latest `effective_from` and deterministic ID tie-breaker; absence uses
environment baseline. History is retained instead of updated/deleted and is
purged only under approved audit retention. User APIs expose only effective safe
limits; admin actor details remain authorized/audited.

### `quota_reservations`

| Column          | Type/null/default    | Constraints and meaning                              |
| --------------- | -------------------- | ---------------------------------------------------- |
| `id`            | TEXT, not null       | PK UUIDv4                                            |
| `user_id`       | TEXT, not null       | FK users RESTRICT                                    |
| `project_id`    | TEXT, nullable       | FK projects RESTRICT                                 |
| `resource_type` | TEXT, not null       | check `upload_bytes, generation, render`             |
| `resource_id`   | TEXT, not null       | upload/job opaque ID, deliberately no polymorphic FK |
| `amount`        | INTEGER, not null    | positive units                                       |
| `status`        | TEXT, not null       | check `reserved, consumed, released, expired`        |
| `expires_at`    | INTEGER, nullable    | required while reserved where applicable             |
| `created_at`    | INTEGER, not null    | epoch ms                                             |
| `updated_at`    | INTEGER, not null    | epoch ms                                             |
| `version`       | INTEGER, not null, 1 | guarded transition                                   |

Unique `(resource_type,resource_id)`; indexes `(user_id,status,expires_at)` and `(status,expires_at)`. Reservation and admission write share one transaction; terminal rows are retained for reconciliation and later purged by policy. User lists do not expose reservation internals or other users' usage; cleanup is idempotent.

### `outbox_events`

| Column             | Type/null/default         | Constraints and meaning                                |
| ------------------ | ------------------------- | ------------------------------------------------------ |
| `id`               | TEXT, not null            | PK UUIDv4                                              |
| `topic`            | TEXT, not null            | allowlisted event topic                                |
| `aggregate_type`   | TEXT, not null            | safe type                                              |
| `aggregate_id`     | TEXT, not null            | opaque ID                                              |
| `payload_json`     | TEXT, not null            | topic-specific `OutboxPayloadV1`, canonical/no secrets |
| `status`           | TEXT, not null, `pending` | check `pending, processing, published, dead`           |
| `available_at`     | INTEGER, not null         | epoch ms                                               |
| `attempt_count`    | INTEGER, not null, 0      | non-negative                                           |
| `lease_owner`      | TEXT, nullable            | opaque process ID                                      |
| `lease_expires_at` | INTEGER, nullable         | epoch ms                                               |
| `last_error_code`  | TEXT, nullable            | safe code                                              |
| `created_at`       | INTEGER, not null         | epoch ms                                               |
| `published_at`     | INTEGER, nullable         | epoch ms                                               |

Indexes: claim `(status,available_at,created_at,id)`; lease `(status,lease_expires_at)`; aggregate lookup. Created in the same transaction as its aggregate mutation; at-least-once delivery only. Published/dead events follow operational retention and are never user-facing; payload schemas redact secrets, paths, private prompts, and raw provider data.

### `idempotency_records`

| Column                         | Type/null/default | Constraints and meaning                          |
| ------------------------------ | ----------------- | ------------------------------------------------ |
| `id`                           | TEXT, not null    | PK UUIDv4                                        |
| `user_id`                      | TEXT, not null    | FK users RESTRICT                                |
| `operation`                    | TEXT, not null    | route/use-case stable name                       |
| `idempotency_key_hash_sha256`  | BLOB, not null    | hash of client key                               |
| `semantic_request_hash_sha256` | TEXT, not null    | canonical operation semantic hash                |
| `status`                       | TEXT, not null    | check `in_progress, completed, failed_retryable` |
| `response_status`              | INTEGER, nullable | successful replay HTTP status                    |
| `response_json`                | TEXT, nullable    | `IdempotentResponseV1`, safe canonical JSON      |
| `resource_id`                  | TEXT, nullable    | created resource ID                              |
| `created_at`                   | INTEGER, not null | epoch ms                                         |
| `expires_at`                   | INTEGER, not null | retention expiry                                 |

Unique `(user_id,operation,idempotency_key_hash_sha256)`; index expiry. Same key + different semantic hash returns conflict. Keys/hashes are never logged or exposed.

### `delivery_capabilities` (technical)

| Column              | Type/null/default        | Constraints and meaning                |
| ------------------- | ------------------------ | -------------------------------------- |
| `id`                | TEXT, not null           | PK UUIDv4                              |
| `issued_to_user_id` | TEXT, not null           | FK users RESTRICT                      |
| `resource_type`     | TEXT, not null           | check `asset, preview, output`         |
| `resource_id`       | TEXT, not null           | opaque ID                              |
| `operation`         | TEXT, not null           | check `stream, preview, download`      |
| `token_hash_sha256` | BLOB, not null           | unique 32-byte hash                    |
| `status`            | TEXT, not null, `active` | check `active, used, revoked, expired` |
| `expires_at`        | INTEGER, not null        | short expiry                           |
| `created_at`        | INTEGER, not null        | epoch ms                               |
| `used_at`           | INTEGER, nullable        | for single-use downloads               |

Indexes: unique token hash; `(resource_type,resource_id,status)`; `(status,expires_at)`. Lifecycle is short-lived active to used/revoked/expired; cleanup purges terminal rows after the security retention window. Raw capability is returned once and never persisted/logged.

## JSON schema registry

| JSON column                               | Required Zod schema                              | Key rule                                      |
| ----------------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| `system_metadata.value_json`              | `SystemMetadataValueV1` discriminated by key     | no secrets                                    |
| `assets.metadata_json`                    | `AssetMetadataV1`                                | media dimensions/duration/codec evidence only |
| `composition_versions.composition_json`   | `CompositionDocumentV1`                          | exact contract in `COMPOSITION_SCHEMA_V1.md`  |
| `composition_versions.validation_json`    | `CompositionValidationResultV1`                  | stable codes, no raw HTML                     |
| `jobs.request_json/result_json`           | discriminated `JobRequestV1`/`JobResultV1`       | resource IDs, options, safe result only       |
| `job_steps.input_json/result_json`        | discriminated `JobStepInputV1`/`JobStepResultV1` | no credential or raw provider payload         |
| `job_events.payload_json`                 | `PublicJobEventPayloadV1`                        | safe for owner-facing SSE                     |
| `render_output_verifications.result_json` | `TechnicalQualityResultV1`                       | measured values and stable findings           |
| `audit_events.metadata_json`              | action-discriminated `AuditMetadataV1`           | allowlist per action                          |
| `quota_policies.policy_json`              | `QuotaPolicyV1`                                  | limits/periods; scope is a column             |
| `outbox_events.payload_json`              | topic-discriminated `OutboxPayloadV1`            | consumer-safe intent only                     |
| `idempotency_records.response_json`       | operation-discriminated `IdempotentResponseV1`   | exact safe response body                      |

Each schema has literal `schemaVersion: 1`, rejects unknown keys, and is exported from `packages/contracts`. Repository reads fail closed on invalid stored JSON and emit an operator alert; they never silently coerce corruption.

## Domain-to-schema reconciliation appendix

This appendix is normative. A grouped domain-field cell means every named field
has the stated mapping; it does not authorize an unlisted JSON sidecar.

| Domain field                                                                                 | Table/column                                                                                    | Stored/derived      | Constraint                                                       | Migration introduced |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------- | -------------------: |
| User `id`, `email`, `displayName`, `avatarUrl`                                               | `users.id`, `email_normalized`, `display_name`, `avatar_url`                                    | stored              | opaque ID, normalized unique email, bounded presentation         |                   v2 |
| User `status`, `role`                                                                        | `users.status`, `role`                                                                          | stored              | checked enums and last-active-admin guard                        |                   v2 |
| User `approvedAt`, `approvedBy`, `disabledAt`, `rejectedAt`                                  | `users.approved_at`, `approved_by_user_id`, `disabled_at`, `rejected_at`                        | stored              | status/timestamp checks; bootstrap approver may be null          |                   v2 |
| User `createdAt`, `updatedAt`                                                                | `users.created_at`, `updated_at`                                                                | stored              | epoch ms                                                         |                   v2 |
| OAuthIdentity `id`, `userId`                                                                 | `oauth_identities.id`, `user_id`                                                                | stored              | user FK                                                          |                   v3 |
| OAuthIdentity `provider`, `providerSubject`, `providerEmail`                                 | `oauth_identities.issuer`, `subject`, `email_at_link`                                           | stored              | Google issuer; unique issuer/subject                             |                   v3 |
| OAuthIdentity `createdAt`, `updatedAt`                                                       | `oauth_identities.created_at`, `last_seen_at`                                                   | stored              | last seen is identity update instant                             |                   v3 |
| Session `id`, `userId`, `tokenHash`                                                          | `sessions.id`, `user_id`, `token_hash_sha256`                                                   | stored              | token hash unique; raw token absent                              |                   v3 |
| Session `expiresAt`, `revokedAt`, `createdAt`, `lastSeenAt`                                  | `sessions.expires_at`, `revoked_at`, `created_at`, `last_seen_at`                               | stored              | guarded lifecycle                                                |                   v3 |
| Session `ipHash`, `userAgentSummary`                                                         | `sessions.ip_hash`, `user_agent_summary`                                                        | stored              | normalized, bounded, redacted, retention-limited                 |                   v3 |
| Project `id`, `ownerId`, `name`, `description`, `favorite`                                   | `projects.id`, `owner_user_id`, `name`, `description`, `favorite`                               | stored              | owner FK; presentation redacted after purge                      |                   v4 |
| Project `status`, `currentCompositionVersionId`                                              | `projects.status`, `current_composition_version_id`                                             | stored              | pointer added in v7 and same-project checked                     |                v4/v7 |
| Project `deletedAt`, `purgeAfter`, `purgedAt`, `retentionPolicyVersion`                      | `projects.deleted_at`, `purge_after`, `purged_at`, `retention_policy_version`                   | stored              | lifecycle-consistent timestamps/policy                           |                   v4 |
| Project `safeAuditReferences`                                                                | `audit_events` queried by project resource identity                                             | derived relation    | append-only, authorized, redacted projection; no JSON blob       |                v2/v4 |
| Project `createdAt`, `updatedAt`                                                             | `projects.created_at`, `updated_at`                                                             | stored              | epoch ms                                                         |                   v4 |
| Asset `id`, `ownerId`, `projectId`, `storageKey`, `originalFilename`                         | `assets.id`, `owner_user_id`, `project_id`, `storage_key`, `original_filename`                  | stored              | same owner/project; opaque unique key                            |                   v5 |
| Asset `mimeType`, `mediaType`, `sizeBytes`, `checksum`                                       | `assets.verified_mime`, `kind`, `byte_size`, `byte_checksum_sha256`                             | stored              | verified after completion/inspection                             |                   v5 |
| Asset `ingestionStatus`, `lifecycleStatus`, `technicalMetadata`                              | `assets.ingestion_status`, `lifecycle_status`, `metadata_json`                                  | stored              | independent checked axes; typed JSON                             |                   v5 |
| Asset `createdAt`, `deletedAt`, `purgeScheduledAt`, `purgedAt`                               | `assets.created_at`, `deleted_at`, `purge_scheduled_at`, `purged_at`                            | stored              | lifecycle-consistent timestamps                                  |                   v5 |
| CompositionVersion `id`, `projectId`, `versionNumber`, `schemaVersion`, `document`           | `composition_versions.id`, `project_id`, `version_number`, `schema_version`, `composition_json` | stored              | immutable; per-project version unique                            |                   v7 |
| CompositionVersion dependency/asset/font/caption manifests and runtime versions              | `composition_versions.composition_json` plus canonical hashes in document                       | stored              | strict schema and immutable hash references                      |                   v7 |
| CompositionVersion `createdByUserId`, `createdByJobId`, `createdAt`                          | `composition_versions.created_by_user_id`, `created_by_job_id`, `created_at`                    | stored              | at least one creator; job same project                           |                   v7 |
| Job `id`, `jobType`, `parentJobId`, `projectId`, `requestedByUserId`                         | `jobs.id`, `type`, `parent_job_id`, `project_id`, `owner_user_id`                               | stored              | type/parent/project lineage checks                               |                   v6 |
| Job `idempotencyKey`                                                                         | `idempotency_records` linked by created `resource_id`                                           | stored hashed       | requester/operation/key uniqueness                               |                v2/v6 |
| Job `state`, `currentStep`, `progress`, `attempt`                                            | `jobs.status`, `current_step_key`, `progress_basis_points`, `attempt_count`                     | stored              | exact state machine; monotonic measured progress                 |                   v6 |
| Job lease/heartbeat/cancel fields                                                            | `jobs.lease_owner`, `lease_expires_at`, `heartbeat_at`, `cancel_requested_at`                   | stored              | versioned lease guards                                           |                   v6 |
| Job `errorCode`, `errorDetailsSafe`                                                          | `jobs.failure_code`, `result_json` and `job_events.payload_json`                                | stored              | catalog code and allowlisted safe details                        |                   v6 |
| Job `createdAt`, `startedAt`, `completedAt`, `updatedAt`                                     | `jobs.created_at`, `started_at`, `finished_at`, `updated_at`                                    | stored              | epoch ms and state-consistent                                    |                   v6 |
| GenerationJob base version/checkpoint references                                             | `jobs.base_composition_version_id`, typed `request_json`/`result_json`                          | stored              | version FK added in v7; typed safe JSON                          |                v6/v7 |
| JobStep identity/parent/item/name/state/attempt                                              | `job_steps.id`, `job_id`, `parent_step_id`, `item_key`, `step_key`, `status`, `attempt_count`   | stored              | exact partial unique indexes and state machine                   |                   v6 |
| JobStep input/output artifact references                                                     | `job_steps.input_json`, `result_json`                                                           | stored              | typed safe canonical JSON                                        |                   v6 |
| JobStep provider operation and submission intent                                             | `job_steps.provider_operation_id`, submission state/hash/attempt columns                        | stored              | intent first; no fabricated operation ID                         |                   v6 |
| JobStep `idempotencyKey`                                                                     | logical job/parent/step/item/input-hash identity                                                | normatively derived | stable across attempts; provider key hash stored when applicable |                   v6 |
| JobStep `lease`, `timeoutAt`, `startedAt`, `completedAt`                                     | lease/heartbeat columns, `timeout_at`, `started_at`, `completed_at`                             | stored              | guarded lease and deadline                                       |                   v6 |
| JobStep `errorCode`                                                                          | `job_steps.failure_code`                                                                        | stored              | catalog code only                                                |                   v6 |
| RenderJob composition, request, bundle, runtime, dimensions, credential and operation fields | render-specific `jobs` columns                                                                  | stored              | columns/FKs added only in v7/v8 as scheduled                     |                v7/v8 |
| RenderOutput immutable identity/bytes                                                        | `render_outputs.id`, project/composition/job FKs, storage key, size, checksum, created time     | stored              | immutable and unique render job/key                              |                   v8 |
| RenderOutput media metadata                                                                  | `render_outputs.duration_ms`, `width`, `height`, `video_codec`, `audio_codec`                   | stored              | inspected immutable values                                       |                   v8 |
| RenderOutput canonical lineage                                                               | render-output bundle/schema/protocol/runtime/manifest/fingerprint columns                       | stored              | immutable complete fingerprint input                             |                   v8 |
| RenderOutput mutable lifecycle/review fields                                                 | `render_output_state` columns                                                                   | stored              | guarded audited transitions only                                 |                   v8 |
| ProviderCredentialReference all domain fields                                                | `provider_credential_references` provider/purpose/environment/status/health/timestamps columns  | stored              | reference only; no secret value                                  |                   v3 |
| AuditEvent all domain fields                                                                 | `audit_events` actor/action/resource/outcome/metadata/time columns                              | stored              | append-only redacted event                                       |                   v2 |
| QuotaPolicy `id`, `scopeType`, `scopeId`, `limits`                                           | `quota_policies.id`, `scope_type`, `scope_id`, `policy_json`                                    | stored              | typed limits and scope check                                     |     authorized later |
| QuotaPolicy `effectiveFrom`, `effectiveUntil`                                                | `quota_policies.effective_from`, `effective_until`                                              | stored              | non-overlapping half-open interval                               |     authorized later |
| QuotaPolicy `createdBy`, `createdAt`, `updatedAt`                                            | `created_by_user_id`, `created_at`; update equals immutable creation instant                    | stored/derived      | append-only version; no in-place update                          |     authorized later |

## Delete policy summary

- Users, projects, assets, compositions, jobs, outputs, and audit rows use `RESTRICT` relationships plus domain tombstones/retention jobs.
- Only nullable lineage such as `sessions.rotated_from_id` may use `SET NULL`.
- Application tables do not use cascading hard delete for tenant records.
- Audit events are append-only and use an opaque resource ID rather than a cascading polymorphic FK.
- Purge removes bytes first only under a durable purge job, then transitions mutable state; immutable evidence rows stay until the approved retention window expires.
