CREATE TABLE composition_versions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_by_job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  parent_version_id TEXT REFERENCES composition_versions(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  composition_json TEXT NOT NULL CHECK (json_valid(composition_json)),
  canonical_hash_sha256 TEXT NOT NULL CHECK (length(canonical_hash_sha256) = 64 AND canonical_hash_sha256 NOT GLOB '*[^0-9a-f]*'),
  semantic_request_hash_sha256 TEXT CHECK (semantic_request_hash_sha256 IS NULL OR (length(semantic_request_hash_sha256) = 64 AND semantic_request_hash_sha256 NOT GLOB '*[^0-9a-f]*')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'valid', 'invalid')),
  validation_json TEXT NOT NULL CHECK (json_valid(validation_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (project_id, version_number),
  CHECK (created_by_user_id IS NOT NULL OR created_by_job_id IS NOT NULL)
) STRICT;

CREATE INDEX composition_versions_project_created_idx
  ON composition_versions(project_id, created_at DESC, id DESC);
CREATE INDEX composition_versions_project_hash_idx
  ON composition_versions(project_id, canonical_hash_sha256);
CREATE INDEX composition_versions_parent_idx
  ON composition_versions(parent_version_id);
CREATE INDEX composition_versions_creator_user_idx
  ON composition_versions(created_by_user_id);
CREATE INDEX composition_versions_creator_job_idx
  ON composition_versions(created_by_job_id);

CREATE TRIGGER composition_versions_lineage_guard BEFORE INSERT ON composition_versions BEGIN
  SELECT CASE WHEN NEW.parent_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM composition_versions parent
    WHERE parent.id = NEW.parent_version_id AND parent.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'composition parent project mismatch') END;
  SELECT CASE WHEN NEW.created_by_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs creator
    WHERE creator.id = NEW.created_by_job_id AND creator.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'composition creator job project mismatch') END;
END;
CREATE TRIGGER composition_versions_no_update BEFORE UPDATE ON composition_versions BEGIN
  SELECT RAISE(ABORT, 'composition_versions are immutable');
END;
CREATE TRIGGER composition_versions_no_delete BEFORE DELETE ON composition_versions BEGIN
  SELECT RAISE(ABORT, 'composition_versions are immutable');
END;

CREATE TABLE composition_asset_references (
  composition_version_id TEXT NOT NULL REFERENCES composition_versions(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  usage TEXT NOT NULL CHECK (usage IN ('visual', 'audio', 'font')),
  PRIMARY KEY (composition_version_id, asset_id, usage)
) STRICT;

CREATE INDEX composition_asset_references_asset_idx
  ON composition_asset_references(asset_id);
CREATE TRIGGER composition_asset_references_project_guard BEFORE INSERT ON composition_asset_references BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM composition_versions version
    JOIN assets asset ON asset.id = NEW.asset_id
    WHERE version.id = NEW.composition_version_id
      AND version.project_id = asset.project_id
  ) THEN RAISE(ABORT, 'composition asset project mismatch') END;
END;
CREATE TRIGGER composition_asset_references_no_update BEFORE UPDATE ON composition_asset_references BEGIN
  SELECT RAISE(ABORT, 'composition_asset_references are immutable');
END;
CREATE TRIGGER composition_asset_references_no_delete BEFORE DELETE ON composition_asset_references BEGIN
  SELECT RAISE(ABORT, 'composition_asset_references are immutable');
END;

ALTER TABLE projects RENAME TO projects_v6;
CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK ((status = 'purged' AND name = '') OR length(name) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'soft_deleted', 'purge_scheduled', 'purging', 'purged')),
  current_composition_version_id TEXT REFERENCES composition_versions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  deleted_at INTEGER,
  purge_after INTEGER,
  purged_at INTEGER,
  retention_policy_version INTEGER CHECK (retention_policy_version IS NULL OR retention_policy_version > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (
    (status = 'active' AND deleted_at IS NULL AND purge_after IS NULL AND purged_at IS NULL) OR
    (status IN ('soft_deleted', 'purge_scheduled', 'purging') AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NULL) OR
    (status = 'purged' AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NOT NULL AND retention_policy_version IS NOT NULL AND name = '' AND description IS NULL AND favorite = 0 AND current_composition_version_id IS NULL)
  )
) STRICT;
INSERT INTO projects
  (id, owner_user_id, name, description, favorite, status,
   current_composition_version_id, created_at, updated_at, deleted_at,
   purge_after, purged_at, retention_policy_version, version)
SELECT id, owner_user_id, name, description, favorite, status,
       current_composition_version_id, created_at, updated_at, deleted_at,
       purge_after, purged_at, retention_policy_version, version
FROM projects_v6;
DROP TABLE projects_v6;
CREATE INDEX projects_owner_list_idx
  ON projects(owner_user_id, status, favorite DESC, updated_at DESC, id DESC);
CREATE INDEX projects_retention_idx ON projects(status, purge_after);
CREATE INDEX projects_current_composition_idx
  ON projects(current_composition_version_id);
CREATE TRIGGER projects_current_composition_guard BEFORE UPDATE OF current_composition_version_id ON projects BEGIN
  SELECT CASE WHEN NEW.current_composition_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM composition_versions version
    WHERE version.id = NEW.current_composition_version_id
      AND version.project_id = NEW.id
      AND version.status = 'valid'
  ) THEN RAISE(ABORT, 'project current composition mismatch') END;
END;

ALTER TABLE jobs
  ADD COLUMN base_composition_version_id TEXT REFERENCES composition_versions(id) ON DELETE RESTRICT;
ALTER TABLE jobs
  ADD COLUMN composition_version_id TEXT REFERENCES composition_versions(id) ON DELETE RESTRICT;
CREATE INDEX jobs_base_composition_idx ON jobs(base_composition_version_id);
CREATE INDEX jobs_composition_idx ON jobs(composition_version_id);
CREATE TRIGGER jobs_composition_lineage_insert_guard BEFORE INSERT ON jobs BEGIN
  SELECT CASE WHEN NEW.base_composition_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM composition_versions version
    WHERE version.id = NEW.base_composition_version_id AND version.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'job base composition project mismatch') END;
  SELECT CASE WHEN NEW.composition_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM composition_versions version
    WHERE version.id = NEW.composition_version_id AND version.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'job composition project mismatch') END;
END;
CREATE TRIGGER jobs_composition_lineage_update_guard BEFORE UPDATE OF project_id, base_composition_version_id, composition_version_id ON jobs BEGIN
  SELECT CASE WHEN NEW.base_composition_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM composition_versions version
    WHERE version.id = NEW.base_composition_version_id AND version.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'job base composition project mismatch') END;
  SELECT CASE WHEN NEW.composition_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM composition_versions version
    WHERE version.id = NEW.composition_version_id AND version.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'job composition project mismatch') END;
END;

CREATE TABLE preview_artifacts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  composition_version_id TEXT NOT NULL REFERENCES composition_versions(id) ON DELETE RESTRICT,
  render_contract_fingerprint_sha256 TEXT NOT NULL CHECK (length(render_contract_fingerprint_sha256) = 64 AND render_contract_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'),
  materializer_version TEXT NOT NULL CHECK (length(materializer_version) BETWEEN 1 AND 100),
  hyperframes_version TEXT NOT NULL CHECK (hyperframes_version = '0.7.104'),
  csp_profile_version INTEGER NOT NULL CHECK (csp_profile_version > 0),
  storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 255),
  byte_checksum_sha256 TEXT NOT NULL CHECK (length(byte_checksum_sha256) = 64 AND byte_checksum_sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('ready', 'quarantined', 'purge_scheduled', 'purged')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  purge_after INTEGER,
  UNIQUE (composition_version_id, render_contract_fingerprint_sha256, materializer_version, csp_profile_version),
  CHECK (purge_after IS NULL OR purge_after >= created_at)
) STRICT;

CREATE INDEX preview_artifacts_status_purge_idx
  ON preview_artifacts(status, purge_after);
CREATE INDEX preview_artifacts_composition_created_idx
  ON preview_artifacts(composition_version_id, created_at DESC, id DESC);
CREATE TRIGGER preview_artifacts_immutable_core BEFORE UPDATE OF
  id, composition_version_id, render_contract_fingerprint_sha256,
  materializer_version, hyperframes_version, csp_profile_version,
  storage_key, byte_checksum_sha256, created_at
ON preview_artifacts BEGIN
  SELECT RAISE(ABORT, 'preview artifact core is immutable');
END;
CREATE TRIGGER preview_artifacts_no_delete BEFORE DELETE ON preview_artifacts BEGIN
  SELECT RAISE(ABORT, 'preview_artifacts retain lifecycle evidence');
END;

PRAGMA foreign_key_check;
