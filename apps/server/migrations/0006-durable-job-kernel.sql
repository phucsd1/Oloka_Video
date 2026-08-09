CREATE TABLE jobs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  parent_job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('generation', 'render', 'asset_ingestion', 'project_purge', 'asset_purge', 'output_purge', 'upload_cleanup')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_provider', 'retry_scheduled', 'cancel_requested', 'cancelled', 'completed', 'failed')),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  progress_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (progress_basis_points BETWEEN 0 AND 10000),
  current_step_key TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  available_at INTEGER NOT NULL CHECK (available_at >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  heartbeat_at INTEGER,
  cancel_requested_at INTEGER,
  failure_code TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (status != 'completed' OR progress_basis_points = 10000),
  CHECK (status NOT IN ('cancelled', 'completed', 'failed') OR finished_at IS NOT NULL)
) STRICT;

CREATE INDEX jobs_claim_idx
  ON jobs(status, priority, available_at, created_at, id);
CREATE INDEX jobs_lease_idx
  ON jobs(status, lease_expires_at);
CREATE INDEX jobs_parent_type_idx
  ON jobs(parent_job_id, type);
CREATE INDEX jobs_owner_list_idx
  ON jobs(owner_user_id, created_at DESC, id DESC);
CREATE INDEX jobs_project_list_idx
  ON jobs(project_id, created_at DESC, id DESC);
CREATE INDEX jobs_finished_idx
  ON jobs(status, finished_at, id);

CREATE TABLE job_steps (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  parent_step_id TEXT REFERENCES job_steps(id) ON DELETE RESTRICT,
  step_key TEXT NOT NULL CHECK (length(step_key) BETWEEN 1 AND 120),
  item_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting_provider', 'retry_scheduled', 'completed', 'skipped', 'cancelled', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  available_at INTEGER NOT NULL CHECK (available_at >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  heartbeat_at INTEGER,
  timeout_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  provider_operation_id TEXT,
  provider_submission_state TEXT CHECK (provider_submission_state IS NULL OR provider_submission_state IN ('requested', 'accepted', 'outcome_unknown')),
  provider_request_hash_sha256 TEXT CHECK (provider_request_hash_sha256 IS NULL OR (length(provider_request_hash_sha256) = 64 AND provider_request_hash_sha256 NOT GLOB '*[^0-9a-f]*')),
  provider_idempotency_key_hash_sha256 TEXT CHECK (provider_idempotency_key_hash_sha256 IS NULL OR (length(provider_idempotency_key_hash_sha256) = 64 AND provider_idempotency_key_hash_sha256 NOT GLOB '*[^0-9a-f]*')),
  provider_submission_attempt INTEGER NOT NULL DEFAULT 0 CHECK (provider_submission_attempt >= 0),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  failure_code TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (status NOT IN ('completed', 'skipped', 'cancelled', 'failed') OR completed_at IS NOT NULL),
  CHECK (provider_submission_state != 'accepted' OR provider_operation_id IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX job_steps_root_identity_idx
  ON job_steps(job_id, step_key, item_key)
  WHERE parent_step_id IS NULL;
CREATE UNIQUE INDEX job_steps_child_identity_idx
  ON job_steps(job_id, parent_step_id, step_key, item_key)
  WHERE parent_step_id IS NOT NULL;
CREATE INDEX job_steps_job_status_idx
  ON job_steps(job_id, status);
CREATE INDEX job_steps_claim_idx
  ON job_steps(status, available_at, created_at, id);
CREATE INDEX job_steps_lease_idx
  ON job_steps(status, lease_expires_at);

CREATE TABLE job_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 120),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (job_id, sequence)
) STRICT;

CREATE INDEX job_events_history_idx
  ON job_events(job_id, created_at, id);
CREATE TRIGGER job_events_no_update BEFORE UPDATE ON job_events BEGIN
  SELECT RAISE(ABORT, 'job_events are append-only');
END;
CREATE TRIGGER job_events_no_delete BEFORE DELETE ON job_events BEGIN
  SELECT RAISE(ABORT, 'job_events are append-only');
END;

CREATE TABLE quota_policies (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('system', 'user')),
  scope_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  effective_from INTEGER NOT NULL CHECK (effective_from >= 0),
  effective_until INTEGER,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((scope_type = 'system' AND scope_id IS NULL) OR (scope_type = 'user' AND scope_id IS NOT NULL)),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
) STRICT;

CREATE INDEX quota_policies_resolution_idx
  ON quota_policies(scope_type, scope_id, effective_from DESC, id DESC);
CREATE INDEX quota_policies_expiry_idx
  ON quota_policies(scope_type, scope_id, effective_until);
CREATE TRIGGER quota_policies_no_overlap BEFORE INSERT ON quota_policies BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM quota_policies existing
    WHERE existing.scope_type = NEW.scope_type
      AND existing.scope_id IS NEW.scope_id
      AND COALESCE(existing.effective_until, 9223372036854775807) > NEW.effective_from
      AND COALESCE(NEW.effective_until, 9223372036854775807) > existing.effective_from
  ) THEN RAISE(ABORT, 'quota policy interval overlaps') END;
END;
CREATE TRIGGER quota_policies_no_update BEFORE UPDATE ON quota_policies BEGIN
  SELECT RAISE(ABORT, 'quota_policies are append-only');
END;
CREATE TRIGGER quota_policies_no_delete BEFORE DELETE ON quota_policies BEGIN
  SELECT RAISE(ABORT, 'quota_policies are append-only');
END;

CREATE TABLE quota_reservations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('upload_bytes', 'generation', 'render')),
  resource_id TEXT NOT NULL CHECK (length(resource_id) = 36),
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released', 'expired')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (resource_type, resource_id),
  CHECK (status != 'reserved' OR expires_at IS NOT NULL)
) STRICT;

CREATE INDEX quota_reservations_user_status_expiry_idx
  ON quota_reservations(user_id, status, expires_at);
CREATE INDEX quota_reservations_status_expiry_idx
  ON quota_reservations(status, expires_at);

INSERT INTO quota_reservations
  (id, user_id, project_id, resource_type, resource_id, amount, status,
   expires_at, created_at, updated_at, version)
SELECT
  id,
  owner_user_id,
  project_id,
  'upload_bytes',
  id,
  declared_size,
  CASE status
    WHEN 'open' THEN 'reserved'
    WHEN 'verifying' THEN 'reserved'
    WHEN 'completed' THEN 'consumed'
    WHEN 'expired' THEN 'expired'
    ELSE 'released'
  END,
  expires_at,
  created_at,
  updated_at,
  1
FROM upload_sessions;

CREATE INDEX outbox_job_wake_idx
  ON outbox_events(topic, status, available_at, aggregate_id);
CREATE INDEX idempotency_operation_resource_idx
  ON idempotency_records(operation, resource_id, status);
