CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (
    (status = 'purged' AND name = '') OR length(name) BETWEEN 1 AND 200
  ),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'soft_deleted', 'purge_scheduled', 'purging', 'purged')
  ),
  current_composition_version_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  deleted_at INTEGER,
  purge_after INTEGER,
  purged_at INTEGER,
  retention_policy_version INTEGER CHECK (
    retention_policy_version IS NULL OR retention_policy_version > 0
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (
    (status = 'active' AND deleted_at IS NULL AND purge_after IS NULL AND purged_at IS NULL) OR
    (status IN ('soft_deleted', 'purge_scheduled', 'purging') AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NULL) OR
    (status = 'purged' AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NOT NULL AND retention_policy_version IS NOT NULL AND name = '' AND description IS NULL AND favorite = 0 AND current_composition_version_id IS NULL)
  )
) STRICT;

CREATE INDEX projects_owner_list_idx
  ON projects(owner_user_id, status, favorite DESC, updated_at DESC, id DESC);
CREATE INDEX projects_retention_idx ON projects(status, purge_after);
