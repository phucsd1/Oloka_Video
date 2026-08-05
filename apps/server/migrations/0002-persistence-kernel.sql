CREATE TABLE schema_migrations_v2 (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64 AND checksum_sha256 GLOB '[0-9a-f]*'),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
  execution_ms INTEGER NOT NULL CHECK (execution_ms >= 0),
  app_build_sha TEXT NOT NULL CHECK (length(app_build_sha) > 0)
) STRICT;

INSERT INTO schema_migrations_v2
  (version, name, checksum_sha256, applied_at, execution_ms, app_build_sha)
SELECT
  version,
  name,
  '34b305e2ec0bd443813108c8fa68bdb1008e1fef90d3d394f76a5e27e32619c9',
  CAST(strftime('%s', applied_at) AS INTEGER) * 1000,
  0,
  'foundation-bootstrap-v1'
FROM schema_migrations
WHERE version = 1 AND name = 'foundation_system_tables';

DROP TABLE schema_migrations;
ALTER TABLE schema_migrations_v2 RENAME TO schema_migrations;
CREATE TRIGGER schema_migrations_no_update BEFORE UPDATE ON schema_migrations BEGIN
  SELECT RAISE(ABORT, 'schema_migrations are append-only');
END;
CREATE TRIGGER schema_migrations_no_delete BEFORE DELETE ON schema_migrations BEGIN
  SELECT RAISE(ABORT, 'schema_migrations are append-only');
END;

CREATE TABLE system_metadata_v2 (
  key TEXT PRIMARY KEY CHECK (length(key) > 0),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
) STRICT;

DROP TABLE system_metadata;
ALTER TABLE system_metadata_v2 RENAME TO system_metadata;

CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  email_normalized TEXT NOT NULL UNIQUE CHECK (length(email_normalized) BETWEEN 3 AND 320),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled', 'rejected')),
  approved_at INTEGER,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  disabled_at INTEGER,
  rejected_at INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  last_login_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (
    (status = 'pending' AND approved_at IS NULL AND disabled_at IS NULL AND rejected_at IS NULL) OR
    (status = 'active' AND approved_at IS NOT NULL AND disabled_at IS NULL AND rejected_at IS NULL) OR
    (status = 'disabled' AND approved_at IS NOT NULL AND disabled_at IS NOT NULL AND rejected_at IS NULL) OR
    (status = 'rejected' AND rejected_at IS NOT NULL AND disabled_at IS NULL)
  )
) STRICT;

CREATE INDEX users_status_id_idx ON users(status, id);
CREATE INDEX users_approved_by_idx ON users(approved_by_user_id);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'admin', 'system')),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
  resource_type TEXT NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 80),
  resource_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failed')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE INDEX audit_events_created_idx ON audit_events(created_at, id);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_user_id, created_at, id);
CREATE INDEX audit_events_resource_idx ON audit_events(resource_type, resource_id, created_at);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 120),
  aggregate_type TEXT NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 80),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'published', 'dead')),
  available_at INTEGER NOT NULL CHECK (available_at >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  published_at INTEGER,
  CHECK ((status = 'processing') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'published') = (published_at IS NOT NULL))
) STRICT;

CREATE INDEX outbox_claim_idx ON outbox_events(status, available_at, created_at, id);
CREATE INDEX outbox_lease_idx ON outbox_events(status, lease_expires_at);
CREATE INDEX outbox_aggregate_idx ON outbox_events(aggregate_type, aggregate_id, created_at);

CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 120),
  idempotency_key_hash_sha256 BLOB NOT NULL CHECK (length(idempotency_key_hash_sha256) = 32),
  semantic_request_hash_sha256 TEXT NOT NULL CHECK (length(semantic_request_hash_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed_retryable')),
  response_status INTEGER,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  resource_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  UNIQUE (user_id, operation, idempotency_key_hash_sha256),
  CHECK ((status = 'completed') = (response_status IS NOT NULL AND response_json IS NOT NULL))
) STRICT;

CREATE INDEX idempotency_expiry_idx ON idempotency_records(expires_at);
