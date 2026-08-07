CREATE TABLE oauth_identities (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  email_at_link TEXT NOT NULL CHECK (
    length(email_at_link) BETWEEN 3 AND 320 AND
    email_at_link = lower(trim(email_at_link))
  ),
  email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= created_at),
  UNIQUE (issuer, subject)
) STRICT;

CREATE INDEX oauth_identities_user_idx ON oauth_identities(user_id, id);
CREATE INDEX oauth_identities_verified_email_idx
  ON oauth_identities(issuer, email_at_link, user_id)
  WHERE email_verified = 1;

CREATE TABLE oauth_transactions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  provider TEXT NOT NULL CHECK (provider = 'google'),
  state_hash_sha256 BLOB NOT NULL UNIQUE CHECK (length(state_hash_sha256) = 32),
  nonce_hash_sha256 BLOB NOT NULL CHECK (length(nonce_hash_sha256) = 32),
  pkce_verifier_ciphertext BLOB NOT NULL CHECK (length(pkce_verifier_ciphertext) > 0),
  pkce_cipher_algorithm TEXT NOT NULL CHECK (pkce_cipher_algorithm = 'AES-256-GCM'),
  pkce_iv BLOB NOT NULL CHECK (length(pkce_iv) = 12),
  pkce_auth_tag BLOB NOT NULL CHECK (length(pkce_auth_tag) = 16),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
  return_path TEXT NOT NULL CHECK (
    return_path LIKE '/%' AND return_path NOT LIKE '//%' AND length(return_path) <= 512
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'expired')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
) STRICT;

CREATE INDEX oauth_transactions_expiry_idx
  ON oauth_transactions(expires_at, consumed_at, id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash_sha256 BLOB NOT NULL UNIQUE CHECK (length(token_hash_sha256) = 32),
  csrf_token_hash_sha256 BLOB NOT NULL CHECK (length(csrf_token_hash_sha256) = 32),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= created_at),
  idle_expires_at INTEGER NOT NULL CHECK (idle_expires_at > created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  rotated_from_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  revoke_reason TEXT CHECK (
    revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 120
  ),
  ip_hash BLOB CHECK (
    ip_hash IS NULL OR length(ip_hash) = 32
  ),
  user_agent_summary TEXT CHECK (
    user_agent_summary IS NULL OR length(user_agent_summary) <= 200
  ),
  CHECK (idle_expires_at <= expires_at),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL) OR
    (status = 'expired' AND revoked_at IS NOT NULL AND revoke_reason = 'expired')
  )
) STRICT;

CREATE INDEX sessions_user_active_idx
  ON sessions(user_id, status, expires_at, idle_expires_at, id);
CREATE INDEX sessions_terminal_retention_idx
  ON sessions(status, revoked_at, expires_at, id);

CREATE TABLE provider_credential_references (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 120),
  environment_variable_name TEXT NOT NULL CHECK (
    environment_variable_name GLOB '[A-Z]*' AND
    environment_variable_name NOT GLOB '*[^A-Z0-9_]*' AND
    length(environment_variable_name) BETWEEN 2 AND 120
  ),
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (
    status IN ('unverified', 'healthy', 'degraded', 'disabled')
  ),
  last_verified_at INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (provider, purpose)
) STRICT;

CREATE INDEX provider_credential_references_status_idx
  ON provider_credential_references(status, provider, id);
CREATE INDEX users_role_status_id_idx ON users(role, status, id);
