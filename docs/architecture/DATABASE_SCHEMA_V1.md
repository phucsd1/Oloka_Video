# Database Schema V1

Status: logical schema blueprint for Phase 3 migrations; it is not SQL and does not change the current database.

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

| Column             | Type/null/default         | Constraints and meaning                     |
| ------------------ | ------------------------- | ------------------------------------------- |
| `id`               | TEXT, not null            | PK UUIDv4                                   |
| `email_normalized` | TEXT, not null            | unique; lowercase canonical Google email    |
| `display_name`     | TEXT, not null            | bounded display value                       |
| `avatar_url`       | TEXT, nullable            | validated Google HTTPS URL; display only    |
| `role`             | TEXT, not null, `member`  | check `member, admin`                       |
| `status`           | TEXT, not null, `pending` | check `pending, active, disabled, rejected` |
| `created_at`       | INTEGER, not null         | epoch ms                                    |
| `updated_at`       | INTEGER, not null         | epoch ms                                    |
| `last_login_at`    | INTEGER, nullable         | epoch ms                                    |
| `version`          | INTEGER, not null, 1      | optimistic version                          |

Indexes: unique `(email_normalized)`; `(status, id)`. Lifecycle: Google identity creates a `pending` user; only an admin may approve to `active`, disable, or reject. Disable/reject revokes all sessions, while the user/ownership/audit record is retained. Redaction: API exposes only actor-appropriate profile fields.

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

| Column                     | Type/null/default         | Constraints and meaning                                   |
| -------------------------- | ------------------------- | --------------------------------------------------------- |
| `id`                       | TEXT, not null            | PK UUIDv4                                                 |
| `state_hash_sha256`        | BLOB, not null            | unique 32-byte hash of random state                       |
| `nonce_hash_sha256`        | BLOB, not null            | 32-byte hash of OIDC nonce                                |
| `pkce_verifier_ciphertext` | BLOB, not null            | short-lived AEAD-sealed verifier, never plaintext at rest |
| `key_version`              | INTEGER, not null         | positive app-key version for decryption                   |
| `return_path`              | TEXT, not null            | allowlisted same-origin relative destination              |
| `status`                   | TEXT, not null, `pending` | check `pending, consumed, expired`                        |
| `created_at`               | INTEGER, not null         | epoch ms                                                  |
| `expires_at`               | INTEGER, not null         | short expiry greater than created time                    |
| `consumed_at`              | INTEGER, nullable         | epoch ms                                                  |

Indexes: unique state hash; `(status,expires_at)`. Lifecycle: one-use callback transaction, marked consumed before exchange/replay can race and purged shortly after terminal expiry. All hashes/ciphertext are redacted; ID/access/refresh tokens are never stored.

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
| `rotated_from_id`        | TEXT, nullable           | self FK ON DELETE SET NULL                 |
| `revoked_at`             | INTEGER, nullable        | epoch ms                                   |
| `revoke_reason`          | TEXT, nullable           | safe enum/reason, no token data            |

Indexes: unique token hash; `(user_id,status,expires_at)`; `(expires_at,status)`. Lifecycle: rotate on login and privilege change; expire/revoke instead of delete until retention cleanup. Hashes are never returned or logged.

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
| `version`                        | INTEGER, not null, 1     | optimistic version                                                       |

Indexes: `(owner_user_id,status,favorite DESC,updated_at DESC,id DESC)`; `(status,purge_after)`. Lifecycle: `soft_deleted` immediately blocks mutation/new work and is restorable for 30 days until a purge lease wins; purge jobs remove child bytes/eligible active records but preserve a non-restorable privacy-safe project tombstone and audit references. No hard cascade from user.

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
| `last_chunk_checksum_sha256` | TEXT, nullable         | retry reconciliation only                                      |
| `status`                     | TEXT, not null, `open` | check `open, verifying, completed, aborted, expired, rejected` |
| `expires_at`                 | INTEGER, not null      | epoch ms                                                       |
| `created_at`                 | INTEGER, not null      | epoch ms                                                       |
| `updated_at`                 | INTEGER, not null      | epoch ms                                                       |
| `version`                    | INTEGER, not null, 1   | optimistic version                                             |

Indexes: unique staging key; `(owner_user_id,status,expires_at)`; `(project_id,status)`; unique `(asset_id)`. Lifecycle is `UPLOAD_PROTOCOL_V1.md`. Staging key is redacted.

### `composition_versions`

| Column                         | Type/null/default | Constraints and meaning                                 |
| ------------------------------ | ----------------- | ------------------------------------------------------- |
| `id`                           | TEXT, not null    | PK UUIDv4                                               |
| `project_id`                   | TEXT, not null    | FK projects RESTRICT                                    |
| `created_by_user_id`           | TEXT, not null    | FK users RESTRICT                                       |
| `version_number`               | INTEGER, not null | positive per-project sequence                           |
| `parent_version_id`            | TEXT, nullable    | self FK RESTRICT                                        |
| `schema_version`               | INTEGER, not null | initially 1                                             |
| `composition_json`             | TEXT, not null    | `CompositionDocumentV1` canonical JSON                  |
| `canonical_hash_sha256`        | TEXT, not null    | RFC 8785 bytes hash                                     |
| `semantic_request_hash_sha256` | TEXT, nullable    | generator request identity, distinct from document hash |
| `status`                       | TEXT, not null    | check `draft, valid, invalid`                           |
| `validation_json`              | TEXT, not null    | `CompositionValidationResultV1` canonical JSON          |
| `created_at`                   | INTEGER, not null | epoch ms                                                |

Constraints/indexes: unique `(project_id,version_number)`; unique `(project_id,canonical_hash_sha256)` only where product dedupe permits; `(project_id,created_at DESC,id DESC)`. Immutable after insert; invalid versions remain inspectable but cannot preview/render. Referenced asset IDs are also materialized in `composition_asset_references`. User APIs return authorized structured documents but redact generator request details and internal manifest/object references; retained versions purge only under Project retention policy.

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

| Column                  | Type/null/default     | Constraints and meaning                                |
| ----------------------- | --------------------- | ------------------------------------------------------ |
| `id`                    | TEXT, not null        | PK UUIDv4                                              |
| `job_id`                | TEXT, not null        | FK jobs RESTRICT                                       |
| `parent_step_id`        | TEXT, nullable        | self FK RESTRICT, same job enforced by service/test    |
| `step_key`              | TEXT, not null        | stable logical stage                                   |
| `item_key`              | TEXT, not null, empty | stable fan-out item identity                           |
| `status`                | TEXT, not null        | JobStep state-machine enum                             |
| `attempt_count`         | INTEGER, not null, 0  | non-negative                                           |
| `max_attempts`          | INTEGER, not null     | positive                                               |
| `available_at`          | INTEGER, not null     | epoch ms                                               |
| `lease_owner`           | TEXT, nullable        | opaque process ID                                      |
| `lease_expires_at`      | INTEGER, nullable     | epoch ms                                               |
| `provider_operation_id` | TEXT, nullable        | provider-safe opaque reference, redacted from user API |
| `input_json`            | TEXT, not null        | `JobStepInputV1` canonical JSON, no secrets            |
| `result_json`           | TEXT, nullable        | `JobStepResultV1` canonical JSON                       |
| `failure_code`          | TEXT, nullable        | safe stable code                                       |
| `created_at`            | INTEGER, not null     | epoch ms                                               |
| `updated_at`            | INTEGER, not null     | epoch ms                                               |
| `version`               | INTEGER, not null, 1  | guarded transitions                                    |

Constraints/indexes: unique `(job_id,parent_step_id,step_key,item_key)` with root parent normalized by a non-null sentinel or equivalent migration design; `(job_id,status)`; claim/lease indexes. Retryable path is running or waiting-provider to retry-scheduled, pending, then running; `failed` is terminal.

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

| Column                               | Type/null/default | Constraints and meaning                |
| ------------------------------------ | ----------------- | -------------------------------------- |
| `id`                                 | TEXT, not null    | PK UUIDv4                              |
| `project_id`                         | TEXT, not null    | FK projects RESTRICT                   |
| `composition_version_id`             | TEXT, not null    | FK composition_versions RESTRICT       |
| `render_job_id`                      | TEXT, not null    | FK jobs RESTRICT                       |
| `storage_key`                        | TEXT, not null    | unique opaque server key               |
| `byte_size`                          | INTEGER, not null | positive                               |
| `byte_checksum_sha256`               | TEXT, not null    | 64 hex byte checksum                   |
| `content_type`                       | TEXT, not null    | allowlisted video type                 |
| `width`                              | INTEGER, not null | positive                               |
| `height`                             | INTEGER, not null | positive                               |
| `duration_ms`                        | INTEGER, not null | positive                               |
| `fps_milli`                          | INTEGER, not null | positive fixed-point FPS               |
| `provider`                           | TEXT, not null    | `modal` in MVP                         |
| `provider_operation_id`              | TEXT, nullable    | operator-only reference                |
| `bundle_checksum_sha256`             | TEXT, not null    | exact immutable render bundle checksum |
| `composition_schema_version`         | INTEGER, not null | positive composition contract version  |
| `render_protocol_version`            | INTEGER, not null | positive provider protocol version     |
| `renderer_version`                   | TEXT, not null    | pinned renderer version                |
| `hyperframes_version`                | TEXT, not null    | pinned HyperFrames version             |
| `dependency_manifest_hash_sha256`    | TEXT, not null    | canonical dependency manifest hash     |
| `asset_manifest_hash_sha256`         | TEXT, not null    | canonical asset manifest hash          |
| `font_manifest_hash_sha256`          | TEXT, not null    | canonical font manifest hash           |
| `caption_manifest_hash_sha256`       | TEXT, not null    | canonical caption manifest hash        |
| `render_contract_fingerprint_sha256` | TEXT, not null    | canonical lineage fingerprint          |
| `created_at`                         | INTEGER, not null | epoch ms                               |

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

| Column                   | Type/null/default | Constraints and meaning                             |
| ------------------------ | ----------------- | --------------------------------------------------- |
| `id`                     | TEXT, not null    | PK UUIDv4                                           |
| `composition_version_id` | TEXT, not null    | unique FK composition_versions RESTRICT             |
| `storage_key`            | TEXT, not null    | unique opaque artifact key                          |
| `byte_checksum_sha256`   | TEXT, not null    | artifact byte checksum                              |
| `materializer_version`   | TEXT, not null    | trusted build/package fingerprint                   |
| `csp_profile_version`    | INTEGER, not null | positive                                            |
| `status`                 | TEXT, not null    | check `ready, quarantined, purge_scheduled, purged` |
| `created_at`             | INTEGER, not null | epoch ms                                            |
| `purge_after`            | INTEGER, nullable | epoch ms                                            |

Indexes `(status,purge_after)`. One immutable artifact per immutable version/materializer contract; a materializer upgrade creates a new technical generation policy, never mutates bytes in place.

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
| `created_by_user_id` | TEXT, nullable       | FK admin user RESTRICT                    |
| `created_at`         | INTEGER, not null    | epoch ms                                  |
| `version`            | INTEGER, not null, 1 | optimistic version                        |

Unique active policy selection is enforced by transaction/query rules; indexes `(scope_type,scope_id,effective_from DESC)`. Policy history is retained instead of updated/deleted and is purged only under approved audit retention. User APIs expose only their effective safe limits; admin actor details remain authorized/audited. Query-critical scope/time remain columns.

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

## Delete policy summary

- Users, projects, assets, compositions, jobs, outputs, and audit rows use `RESTRICT` relationships plus domain tombstones/retention jobs.
- Only nullable lineage such as `sessions.rotated_from_id` may use `SET NULL`.
- Application tables do not use cascading hard delete for tenant records.
- Audit events are append-only and use an opaque resource ID rather than a cascading polymorphic FK.
- Purge removes bytes first only under a durable purge job, then transitions mutable state; immutable evidence rows stay until the approved retention window expires.
