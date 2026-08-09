# Secret Management V1

## Source of truth

Actual credentials exist only as Hugging Face Space Secrets exposed to the process as environment variables. The application does not create, edit, return, or persist secret values. Local development uses operator-managed environment injection outside Git; `.env` files and values are never committed.

`OLOKA_APP_KEY` is a high-entropy root, never a direct encryption/MAC key.
HKDF-SHA256 derives versioned 32-byte subkeys with distinct information
contexts: `oloka/oauth-pkce/v1`, `oloka/csrf/v1`,
`oloka/cursor-mac/v1`, and `oloka/backup-manifest/v1`. Session IP
pseudonymization uses its own context `oloka/session-ip-hash/v1`. Delivery
capability bearer reconstruction uses its own context
`oloka/delivery-capability-token/v1`. Salt and key
version are deployment-controlled metadata; no derived key is reused across
purposes. Rotation keeps only the bounded prior versions needed to validate
unexpired envelopes, cursors, or backups.

`ProviderCredentialReference` stores only provider, purpose, approved environment variable name, enabled/status, and safe health metadata. The resolver accepts only administrator-configured names matching an allowlist and reads the environment at use time. User/provider requests cannot choose an environment name.

## Administrative workflow

1. Operator creates/rotates the actual secret in HF Space settings.
2. Admin configures or enables the approved reference name in Oloka.
3. A bounded health check reports `configured`, `unhealthy`, `disabled`, or `unknown` plus a safe code/time.
4. Rotation requires no database secret write; existing jobs either use the resolved value for a single call or retry under provider policy.

Admin UI/API displays provider/purpose/reference name/status/last health only. It never shows a masked prefix/suffix, length, fingerprint derived from secret value, or raw error body.

## Required environment references

| Purpose                                                    | Planned reference                                    | Required in MVP            |
| ---------------------------------------------------------- | ---------------------------------------------------- | -------------------------- |
| Google OIDC client                                         | `GOOGLE_OIDC_CLIENT_ID`, `GOOGLE_OIDC_CLIENT_SECRET` | yes                        |
| application root for HKDF-separated cryptographic purposes | `OLOKA_APP_KEY`                                      | yes; random high entropy   |
| verified first-admin bootstrap identity                    | `OLOKA_BOOTSTRAP_ADMIN_EMAIL`                        | yes for first deployment   |
| Modal authentication                                       | approved Modal token/environment pair                | render slice               |
| LLM                                                        | provider-specific approved variable                  | generation slice           |
| TTS                                                        | provider-specific approved variable                  | when TTS enabled           |
| transcription                                              | provider-specific approved variable                  | when transcription enabled |

Exact provider set beyond Google/Modal follows Phase 1 product approval. References are configuration names, not permission to copy legacy secrets.

## Redaction and failure

Structured logging redacts authorization/cookie headers, query tokens, OAuth parameters, environment values, credential-like keys, provider request headers, and database token/hash fields. Exceptions are mapped before logging. A missing/unhealthy secret fails readiness only when required for the enabled MVP capability; otherwise the capability is explicitly unavailable. Jobs fail or retry with a safe credential-unavailable code, never the secret or provider body.

Incident response is operator rotation in HF, reference disable/revoke, session revocation if relevant, and audit review. Secret scanning remains a CI/operational control; this blueprint does not add a tool or workflow.

The bootstrap email is normalized configuration, not a credential. It is read
only in the verified Google callback while the no-admin database predicate is
true, is never returned to clients, and is not logged beyond safe action/outcome
metadata.
