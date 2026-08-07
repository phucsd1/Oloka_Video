# Authentication, Session, and CSRF

## Google OIDC

MVP supports Google login only, using Authorization Code Flow with PKCE S256, cryptographically random `state`, and OIDC `nonce`. The planned library is ESM `openid-client` v6 (version 6.8.4 observed during Phase 2; lock a reviewed current v6 in Phase 3) because its official project supports Authorization Code/OIDC, PKCE, discovery, Node.js, and a Node 20 baseline compatible with Node 22.

Login initiation creates a short-lived, one-use server-side OAuth transaction containing hashes/validated values for state, nonce, PKCE verifier, intended same-origin return path, and expiry. The callback validates issuer, audience/client ID, signature, expiry, nonce, state, PKCE exchange, and required claims. A previously unknown identity creates a `pending` member; only `active` users may enter product routes. It never accepts an arbitrary post-login redirect or links identities by email alone.

The PKCE verifier is sealed with AES-256-GCM under the current HKDF-derived
OAuth key. Its stored envelope contains algorithm, unique random 12-byte IV,
16-byte authentication tag, ciphertext, key version, and transaction expiry.
Algorithm/version/transaction identity are authenticated additional data.
Consumed or expired envelopes are purged within 24 hours and never logged.

Successful callbacks set or rotate the session and issue a 303 to the
validated same-origin return path. Every failure issues a 303 to fixed
`/auth/error` with no query string and `Cache-Control: no-store`, `Pragma:
no-cache`, and `Referrer-Policy: no-referrer`. Google denial and other provider
error callbacks require state, atomically consume a valid pending transaction
once, skip token exchange, and audit only `user_denied`, `provider_error`, or
`invalid_callback`. Ambiguous code-plus-error callbacks fail the same way. Raw
code, state, nonce, email, provider `error_description`, and callback URL are
neither rendered nor logged.

OAuth state protects the callback transaction; it is separate from application CSRF.

## Session token

- Generate 32 random bytes with Node crypto and encode base64url.
- Store only SHA-256 bytes in `sessions`; compare safely and reject missing/duplicate/malformed tokens.
- Cookie name: `__Host-oloka_session`.
- Attributes: `Secure; HttpOnly; Path=/; SameSite=Lax`, with no `Domain`.
- Default idle timeout: 7 days; absolute timeout: 30 days. Phase 3 configuration may shorten, never silently lengthen, these defaults.
- Update `last_seen_at` at most once per five minutes to avoid a write on every request.
- Reject revoked/expired sessions and any session whose user is disabled/deleted on every authenticated request.
- Rotate at every successful login, privilege/status change, and suspected compromise. Rotation invalidates the prior token.
- Logout revokes the current session; security/admin actions can revoke all sessions for a user.

The session token and CSRF token are never stored in localStorage or returned in JSON logs.

Session security metadata stores only HMAC-SHA256 under the dedicated HKDF
`session-ip-prefix/v1` key of a normalized coarse IP
prefix and a bounded browser/OS/device-class summary. It never stores a raw IP
or raw user-agent string, never returns these fields to member/admin APIs, and
purges them with terminal session retention as defined by the schema.

## CSRF defense

State-changing cookie-authenticated API requests require all layers:

1. SameSite=Lax cookie behavior;
2. exact allowlisted `Origin` match; if Origin is legitimately absent, strict same-origin `Referer` fallback; both absent is rejected for unsafe methods;
3. a per-session random synchronizer token supplied in `X-Oloka-CSRF`, compared by hash to server session state;
4. a non-simple content type for JSON APIs and explicit content types for upload chunks.

The browser obtains the synchronizer value from an authenticated, no-store bootstrap/CSRF endpoint or server-rendered bootstrap, holds it in memory, and sends the custom header. It is not a cookie and is not localStorage-persisted.

`GET /api/v1/auth/session` returns `401 AUTHENTICATION_REQUIRED` when no valid
session exists. A valid session returns the safe account projection even when
the account is pending, disabled, or rejected so the browser can render the
corresponding bounded state. It does not use a 200 `{authenticated:false}`
variant.

| Surface                     | Rule                                                                            |
| --------------------------- | ------------------------------------------------------------------------------- |
| top-level safe navigation   | no CSRF token; SameSite/session and authorization still apply                   |
| `GET/HEAD/OPTIONS` API      | must be side-effect free; no CSRF token                                         |
| `POST/PATCH/PUT/DELETE` API | exact Origin/Referer policy + synchronizer header                               |
| OIDC initiation             | creates state/nonce/PKCE transaction; safe fixed callback URI                   |
| OIDC callback               | validates one-use OAuth state/nonce/PKCE; does not require app CSRF header      |
| SSE                         | GET, authorized, no state mutation; Origin checked to reduce cross-site leakage |

`@fastify/cookie` is planned for parsing/serialization. `@fastify/csrf-protection` was evaluated but is not selected as the authority because the required synchronizer-token lifecycle and Origin policy are application-specific; Phase 3 may reuse vetted primitives only after compatibility/security review.

## First-admin bootstrap and recovery

`OLOKA_BOOTSTRAP_ADMIN_EMAIL` is normalized using the same email policy as the
User table. During a validated Google callback only, if the verified identity
email matches and no User row with `role=admin` exists, the identity transaction
creates or upgrades that User to `role=admin`, `status=active`,
`approvedAt=now`, and `approvedBy=null` (system), then appends an AuditEvent with
system actor and action `admin.bootstrap`. The transition and audit commit
atomically. The bootstrap is permanently ineligible as soon as any admin row
exists; it is not a local bypass, query parameter, request header, alternate
login, or client decision. Logs may record only the action/outcome and opaque
user ID, not the configured email.

Admin disable/reject/demotion and self-lock actions acquire the same guarded
write transaction and fail with `RESOURCE_STATE_CONFLICT` if they would leave no
active admin. Emergency recovery is an operator-only maintenance command run in
a trusted console against the canonical database, never an authenticated or
unauthenticated HTTP endpoint. It requires explicit target identity and reason,
enforces verified Google linkage, and appends an immutable system audit event.

## Failure and audit

Authentication failures expose stable safe codes and do not reveal whether an email/user exists. Rate-limit login initiation/callback failures. Audit successful login/logout, rejected identity link, session revocation, disabled-user rejection, admin session revocation, and repeated CSRF failure without recording state, nonce, verifier, cookies, token hashes, or raw claims.
