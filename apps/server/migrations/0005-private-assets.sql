CREATE TABLE assets (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  original_filename TEXT NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'font')),
  declared_mime TEXT,
  verified_mime TEXT,
  storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) > 0),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  byte_checksum_sha256 TEXT CHECK (
    byte_checksum_sha256 IS NULL OR
    (length(byte_checksum_sha256) = 64 AND byte_checksum_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  metadata_json TEXT,
  ingestion_status TEXT NOT NULL DEFAULT 'upload_pending' CHECK (
    ingestion_status IN ('upload_pending', 'uploading', 'processing', 'ready', 'failed')
  ),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN ('active', 'soft_deleted', 'purge_scheduled', 'purging', 'purged')
  ),
  failure_code TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  deleted_at INTEGER,
  purge_after INTEGER,
  purge_scheduled_at INTEGER,
  purged_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (
    (lifecycle_status = 'active' AND deleted_at IS NULL AND purge_after IS NULL AND purge_scheduled_at IS NULL AND purged_at IS NULL) OR
    (lifecycle_status IN ('soft_deleted', 'purge_scheduled', 'purging') AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NULL) OR
    (lifecycle_status = 'purged' AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_scheduled_at IS NOT NULL AND purged_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX assets_project_library_idx
  ON assets(project_id, lifecycle_status, ingestion_status, created_at DESC, id DESC);
CREATE INDEX assets_owner_lifecycle_idx
  ON assets(owner_user_id, lifecycle_status);
CREATE INDEX assets_retention_idx
  ON assets(lifecycle_status, purge_after);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id) ON DELETE RESTRICT,
  staging_key TEXT NOT NULL UNIQUE CHECK (length(staging_key) > 0),
  original_filename TEXT NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  declared_mime TEXT,
  declared_size INTEGER NOT NULL CHECK (declared_size > 0),
  declared_checksum_sha256 TEXT CHECK (
    declared_checksum_sha256 IS NULL OR
    (length(declared_checksum_sha256) = 64 AND declared_checksum_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  received_size INTEGER NOT NULL DEFAULT 0 CHECK (received_size >= 0 AND received_size <= declared_size),
  last_chunk_offset INTEGER,
  last_chunk_size INTEGER,
  last_chunk_checksum_sha256 TEXT CHECK (
    last_chunk_checksum_sha256 IS NULL OR
    (length(last_chunk_checksum_sha256) = 64 AND last_chunk_checksum_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'verifying', 'completed', 'aborted', 'expired', 'rejected')),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (
    (last_chunk_offset IS NULL AND last_chunk_size IS NULL AND last_chunk_checksum_sha256 IS NULL AND received_size = 0) OR
    (last_chunk_offset IS NOT NULL AND last_chunk_size IS NOT NULL AND last_chunk_checksum_sha256 IS NOT NULL AND last_chunk_offset + last_chunk_size = received_size)
  )
) STRICT;

CREATE INDEX upload_sessions_owner_status_expiry_idx
  ON upload_sessions(owner_user_id, status, expires_at);
CREATE INDEX upload_sessions_project_status_idx
  ON upload_sessions(project_id, status);

CREATE TABLE delivery_capabilities (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  issued_to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('asset', 'preview', 'output')),
  resource_id TEXT NOT NULL CHECK (length(resource_id) = 36),
  operation TEXT NOT NULL CHECK (operation IN ('stream', 'preview', 'download')),
  token_hash_sha256 BLOB NOT NULL UNIQUE CHECK (length(token_hash_sha256) = 32),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  used_at INTEGER
) STRICT;

CREATE INDEX delivery_capabilities_resource_idx
  ON delivery_capabilities(resource_type, resource_id, status);
CREATE INDEX delivery_capabilities_status_expiry_idx
  ON delivery_capabilities(status, expires_at);
