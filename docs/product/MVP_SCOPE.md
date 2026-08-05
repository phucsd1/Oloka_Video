# MVP Scope

## Release and users

MVP is a closed beta. A Google-authenticated new user is `pending`, an admin approves them, and only `active` users access product routes. Roles are `member` and `admin`.

## Included capabilities

1. Landing, Google-only login, pending/disabled/rejected states, revocable sessions.
2. Project List without Workspace; canonical Project create/read/rename/favorite.
3. Trash, 30-day restore, scheduled purge and safe retention.
4. Private per-user/per-project Asset upload, technical ingestion and basic metadata search.
5. Prompt/settings command and durable generation pipeline with retry/cancel/recovery.
6. Structured CompositionVersion editor for scene text/duration/order/assets, voice, caption, aspect ratio, BGM and allowlisted style fields.
7. Read-only parity preview.
8. Omnivoice narration through adapter; caption `Clean`/`Bold`; manual BGM Asset, volume and basic ducking.
9. Modal-only hosted final render, mandatory technical gate, and RenderOutput with immutable identity/bytes/media metadata/lineage plus guarded lifecycle.
10. Authorized playback/download after verification.
11. Minimal admin user review, safe failed-job diagnostics, provider credential references/health and quota policy.
12. Single HF Docker Space topology, validation-gated deployment, build identity, health/readiness and structured telemetry.

## Default limits

Maximum duration is 60 seconds; resolution is 1920×1080 landscape-equivalent (long edge 1920, short edge 1080, allowing portrait 1080×1920); active generation and render per user are one each; queued jobs per user are three; active render across the development system is two; Asset size is 500 MB; Project storage is 5 GB; retained outputs are ten per Project. Limits are configurable policies, not domain constants.

## MVP completion flow

`Google login → pending → admin approval → Project List → create Project → upload private Asset → enter prompt/settings → durable generation → preview → structured edit → Modal render → technical verification → playback → download`.

## Release gates

- All authorization, restart/recovery, idempotency, parity, quality, retention, and deployment acceptance criteria pass.
- CI fails closed and HF sync only follows validation.
- No out-of-scope capability is exposed as a working control or alternate contract.
