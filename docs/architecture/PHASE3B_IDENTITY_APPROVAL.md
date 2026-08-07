# Phase 3B Identity, Session, Approval, and First-Admin Bootstrap

## Outcome and boundary

Slice 3B adds Google-only OIDC entry, one-use encrypted OAuth transactions,
database-backed opaque sessions, synchronizer CSRF, current-status gates,
first-admin bootstrap, bounded admin user transitions, and an operator-only
recovery command. It deliberately adds no Project, Asset, Job, provider-media,
preview, render, or Slice 3C behavior. The slice is review-only: it does not
deploy, change Hugging Face configuration values, run a production migration,
or restart production.

Phase 3B.1 closes the pre-cutover contract gaps without changing migration v3:
the public error catalog/envelope has one typed Fastify authority; callback
failures redirect only to `/auth/error`; provider denial consumes one-use
state; unauthenticated session bootstrap is canonical 401; the admin list uses
a version-1 filter-bound HMAC cursor with 25/100 pagination; Idempotency-Key is
strict 1-128 safe ASCII; and coarse address metadata uses HMAC-SHA256.
Production cutover remains pending separate authorization.

## Migration v3

`0003-identity-and-approval.sql` adds exactly four application tables:
`oauth_identities`, `oauth_transactions`, `sessions`, and
`provider_credential_references`, plus identity indexes on the existing User
shell. Migration v1 remains `foundation_system_tables`; migration v2 remains
`persistence-kernel`; both assets are byte-immutable. An existing v2 database
is backed up and authenticated before v3 is applied. A second startup verifies
the ledger and performs no migration or new pre-migration backup.

The earlier Phase 2 planning label `identity-and-security` conflicted with the
authorized Slice 3B label `identity-and-approval`. The latter is the final
ledger identity because the Slice 3B steer is newer and explicit; the planning
table was reconciled before any v3 deployment.

## OIDC and OAuth transaction contract

The server pins `openid-client` `6.8.4`, the current reviewed v6 release when
the slice was implemented. Its official documentation supports the required
Authorization Code flow, PKCE S256, state, nonce, issuer discovery, signed ID
Token verification, and Node 20+; Node `22.16.0` satisfies that runtime floor.
The adapter explicitly enables application-level signature validation against
the discovered JWKS instead of relying on the library's direct-TLS default.
Tests use an in-process fake issuer with discovery, authorization, token, JWKS,
RS256 signature, and PKCE verification. It rejects missing or unverified email,
wrong nonce, invalid signature, expiry, malformed token response, state/PKCE
mismatch, code replay, and a bounded token-endpoint timeout. The fixture is
excluded from the production TypeScript build and there is no runtime
fake-provider flag.

OAuth state and nonce are stored only as SHA-256 hashes. The PKCE verifier and
nonce recovery envelope is AES-256-GCM with a 12-byte random IV, 16-byte tag,
HKDF-separated version-1 key, and AAD binding algorithm, key version, and
transaction ID. Transactions are atomically consumed before exchange, so a
callback replay cannot win.

## Session, CSRF, and authorization contract

The `__Host-oloka_session` cookie is Secure, HttpOnly, host-only, Path `/`, and
SameSite Lax. It carries 32 random base64url bytes; only SHA-256 is persisted.
Idle and absolute expiry default to seven and thirty days, and `last_seen_at`
is coalesced to five-minute updates. Stored network metadata is only a
dedicated-key HMAC-SHA256 of an IPv4 /24 or IPv6 /48 prefix plus a 200-character,
control-free user-agent summary. Session, CSRF, and IP hashes are absent from
read APIs.

Unsafe cookie-authenticated routes require an exact configured Origin or a
strict same-origin Referer fallback, JSON content type, and `X-Oloka-CSRF`
whose SHA-256 matches the active session. Missing Origin and Referer is denied.
The OIDC callback is exempt because state, nonce, and PKCE govern that flow.
Protected authorization reloads the current User on every request and returns
stable 401/403 decisions for no session, pending, disabled, and rejected.

## Bootstrap, administration, and recovery

Only a validated Google callback whose verified normalized email matches
`OLOKA_BOOTSTRAP_ADMIN_EMAIL` can establish the first admin, and only while no
admin User row has ever existed. The User, identity, active session,
`admin.bootstrap`, and login audit are committed through guarded database
transactions before the cookie is emitted.

Admin listing returns a bounded safe projection in `(created_at,id)` order with
an authenticated version-1 cursor bound to normalized status/search filters;
the default/max limits are 25/100. Status/role transitions
require an active admin, `Idempotency-Key`, optimistic User version, allowed
state transition, CSRF, atomic audit, and target-session revocation. The
last-active-admin predicate and mutation share one immediate transaction.
Recovery is available only through `npm run admin:recover -w @oloka/server --
--identity-id <uuid> --reason <text>` in a trusted console. It targets an
existing verified Google identity, checks database integrity, audits as system,
revokes sessions, and has no HTTP route.

## Configuration and operational safety

Production requires the Google issuer, client ID, client secret, public origin,
bootstrap email, and bounded OAuth/session durations. Only the Google client
secret is a provider secret. Hugging Face workflow preflight compares required
secret and variable names without reading or printing values. Auth/admin
responses use `no-store`, stable safe error envelopes, security headers, and no
broad CORS policy. In-memory start/callback-failure/CSRF-failure limits are
bounded and keyed by privacy-safe coarse IP hashes; they are explicitly
single-instance MVP controls rather than a distributed guarantee. `trustProxy`
is unchanged; production proxy/client-address behavior remains a separate
cutover smoke observation using only redacted or hashed evidence.
