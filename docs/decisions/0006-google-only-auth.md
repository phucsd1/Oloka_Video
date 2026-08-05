# ADR 0006: Google-only closed-beta authentication

- Status: Accepted
- Date: 2026-08-05

## Context

Multiple auth implementations increase attack surface and account-linking ambiguity while MVP access is curated.

## Decision

Use Google OAuth only. New users become `pending`; admins approve, disable or reject. Sessions use secure cookies and revocable hashed server-side state. No password, GitHub, magic-link or anonymous product access exists.

## Consequences

OAuth state/CSRF/session revocation are required acceptance gates. Access removal is a status/session operation, not hard deletion.
