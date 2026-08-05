# Phase 2 Summary

## Outcome

Phase 2 converts the accepted Phase 1 product/domain contract into an implementable, clean-room MVP blueprint without application code. Oloka remains a one-instance Node 22/Fastify/React modular monolith on one HF Docker Space, with SQLite, `/data` filesystem object storage, durable in-process dispatch, Google-only OIDC, immutable structured compositions, trusted isolated HyperFrames preview, and Modal-only rendering.

## Locked decisions

- SQLite through `node:sqlite`, short repository-owned transactions, WAL/FULL synchronization, forward-only checksummed migrations.
- 25 logical tables: the 20 required domain/operational tables plus OAuth callback transactions, composition references, preview artifacts, delivery capabilities, and append-only render verification evidence.
- Server-generated UUIDv4 IDs, epoch-ms database time, strict Zod JSON, RFC 8785 JCS and distinct byte/document/request hashes.
- Application resumable sequential upload with 8 MiB chunks, atomic same-filesystem finalize, contained opaque keys, authorized Range delivery.
- SQLite leases/outbox/job events with at-least-once idempotent consumers, durable SSE replay, polling fallback, real measured progress.
- HF environment secrets only; DB holds reference names/status/health, never values.
- Google Authorization Code + PKCE/state/nonce, hashed server sessions, `__Host-oloka_session`, Origin/Referer + synchronizer CSRF.
- Immutable Composition V1 and preview artifacts; no arbitrary executable content/network and no per-project permanent preview daemon.
- Consistent online SQLite backup, manifest reconciliation, restore drill, and explicit one-volume DR limitation.

## Blueprint counts

- 20 architecture documents created in Phase 2.
- 10 new ADRs (0017-0026).
- 72 identified API capabilities, including three stable foundation probes;
  render cancel/retry use only generic Job commands.
- 35 canonical public error codes in one authoritative catalog.
- 23 named transaction boundaries.
- 25 logical database tables, of which 5 are supporting technical tables.
- 9 implementation slices (3A through 3I+); only 3A is eligible after review.

## Highest implementation risks

1. SQLite synchronous calls/long transactions can stall the one process; repository latency/lock metrics and strict no-I/O transaction boundaries are mandatory.
2. SQLite cannot atomically commit filesystem changes; finalize/purge ordering and reconciliation must be tested under process death.
3. Provider submission timeouts create unknown outcomes; durable intent and poll-before-resubmit are required to prevent duplicate cost/artifacts.
4. HyperFrames preview/render parity depends on pinned runtime/materializer/assets/fonts and deterministic composition; production cannot depend on Studio's long-running dev server.
5. Local backups on the same `/data` volume do not protect against volume loss; MVP RPO/RTO and post-MVP external backup require owner confirmation.
6. Existing foundation schema v1 has a minimal migration ledger; migration v2 must upgrade it from an exact v1 fixture without rewriting history.
7. Upload DB/filesystem divergence must never advance DB truth or zero-fill
   missing bytes; both crash directions require quarantine/truncation tests.
8. First-admin bootstrap and provider submission have race/unknown-outcome
   boundaries that require atomic guards and durable audit/intent evidence.

## Product-owner decisions required before 3A

1. Confirm backup target: daily/pre-migration RPO <=24h and operator RTO <=4h, acknowledging same-volume MVP limitation.
2. Confirm session defaults: seven-day idle and 30-day absolute lifetime.
3. Confirm whether a pending user may view only a pending screen and manage/logout their own session before approval (recommended: yes).
4. Confirm provider set/closed-beta budget beyond mandatory Google OIDC and Modal; no provider is inferred from legacy code.
5. Confirm the approved HyperFrames package/version after the 3D compatibility spike; Phase 2 observed the official package family but installs nothing.
6. Confirm load/scale exit thresholds before production telemetry exists; default trigger categories are fixed, numeric thresholds need an NFR test profile.

## Not carried forward

No legacy source, route implementation, prompt, configuration, workflow, HTML/CSS/JavaScript, SQL schema, or deployment workaround is copied. Cloudflare dual topology, workspace, social publishing, semantic asset search, arbitrary code editor, local render fallback, multiple render providers, and mock progress remain outside the MVP.

## Next gate

Review all Phase 2 documents and ADRs for consistency with Phase 1. After explicit approval, begin only slice 3A from `IMPLEMENTATION_SEQUENCE.md`. Do not begin project/upload/job/preview/render implementation as part of this phase.

## Phase 2.1 reconciliation

Phase 2.1 reconciles—not expands—the accepted MVP. It makes
`ERROR_MODEL.md` the sole code authority, removes private resource-specific
not-found codes and duplicate render commands, keeps owner routes owner-only,
and confines admin Job access to redacted admin surfaces. The final schema now
maps every Domain Model field, records User approval/status evidence, redacted
session metadata, Project/Asset purge evidence, dual Composition creator
lineage, DB-authoritative current Job step, exact JobStep lease/deadline and
partial-unique identities, output codecs, quota intervals, and upgrade-safe
preview identity.

Migration order now introduces no FK before its target: v4 has no Composition
pointer, v6 is a generic Job kernel, v7 creates compositions/references before
adding Project/Job composition lineage, and v8 owns render-only lineage/output.
Upload initialization/finalization preserves one Asset, DB offset is canonical,
provider intent precedes remote submit, and expired dispatcher states keep their
explicit reconciliation semantics.

Slice 3A must pin the same exact Node 22.16.0 patch in Docker and Actions before
relying on online backup, derive separate keys from `OLOKA_APP_KEY`, and verify
canonical HMAC-authenticated backup manifests. Phase 2.1 changes documentation
only and does not start Slice 3A.
