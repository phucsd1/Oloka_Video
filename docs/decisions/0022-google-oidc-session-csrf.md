# ADR 0022: Google OIDC, server sessions, and layered CSRF

- Status: Accepted
- Date: 2026-08-05

## Context

The MVP is Google-only closed beta with pending approval. Cookie sessions need revocation and cross-site mutation defenses without browser-stored bearer tokens.

## Decision

Use standards-compliant `openid-client` v6 with Authorization Code, PKCE S256, state, and nonce. Unknown identities create pending members. Sessions use 32 random bytes in `__Host-oloka_session`; only SHA-256 is stored. Unsafe API calls require SameSite=Lax, exact Origin/strict Referer fallback, and a per-session synchronizer header. OAuth state is separate from CSRF.

## Consequences

Cookies are Secure, HttpOnly, Path=/, no Domain; tokens never enter localStorage. Sessions rotate at login/privilege change and are rejected for disabled/rejected users. Callback/navigation/API rules and audit/redaction are explicit in `AUTH_SESSION_CSRF.md`.
