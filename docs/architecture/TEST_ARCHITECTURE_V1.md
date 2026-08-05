# Test Architecture V1

## Principles

Tests prove the Phase 1 acceptance criteria and Phase 2 invariants at the narrowest useful layer, then repeat critical trust boundaries end to end. Production code never switches to a fake provider through a generic environment flag. Fakes are concrete adapters imported only by test composition roots/fixtures; the production composition root cannot resolve them.

Normal CI performs no real paid/provider calls and uses no production secrets. A separately authorized provider-sandbox workflow may run against dedicated non-production credentials, bounded spend, tagged resources, and cleanup; it is not a merge prerequisite unless product owners explicitly fund/stabilize it.

## Layers

| Layer                     | Scope                                                                                                           | Examples / acceptance mapping                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| unit                      | pure domain transitions, Zod schemas, canonicalization, hashes, cursor, redaction, quota arithmetic             | AC-JOB-07-09/15-16, AC-COMP-01/03/06, AC-RENDER-12-13/16, AC-ERR-01-03, AC-QUOTA-01       |
| repository                | real temporary SQLite, PRAGMAs, constraints, indexes/query plans, row JSON revalidation                         | AC-PROJ-01-03, AC-ASSET-01/06/11-14, AC-JOB-01/04/09, AC-RENDER-08/15                     |
| migration                 | empty and exact-v1 databases through every version; checksums/failure/restore                                   | AC-DEPLOY-05-06 plus migration strategy matrix                                            |
| integration               | Fastify injection + real SQLite/temp filesystem + production services with test-only provider adapters          | AC-AUTH-01-07, AC-PROJ-04-10, AC-ASSET-02-09, AC-JOB-01-18, AC-RENDER-03-16, AC-RET-01-11 |
| authorization/security    | cross-user matrix, CSRF/OIDC/session, path containment, capability scope, upload adversarial cases, redaction   | all AC-AUTHZ, AC-SEC, AC-ADMIN-04/05/07, AC-ERR-03/06                                     |
| concurrency               | multiple DB connections/process-like dispatchers, `BEGIN IMMEDIATE`, stale versions/leases, quota admission     | AC-JOB-03-05/13-14, AC-QUOTA-02-03, AC-RENDER-15                                          |
| restart/recovery          | kill after each durable boundary, expired leases, unknown provider outcome, stale upload, backup/restore        | AC-JOB-02/03/05/07/10-14/17, AC-RET-07, AC-DEPLOY-06                                      |
| provider contract sandbox | deterministic fake server and recorded schema-safe fixtures for timeouts/rate/5xx/invalid/ambiguous/poll/cancel | AC-JOB-05/10-13/17, AC-COMP-08, AC-RENDER-18, AC-ERR-05, AC-DEPLOY-07                     |
| visual fixture            | deterministic Composition V1 snapshots and short renders at boundary frames/formats                             | AC-CAPTION-01-05, AC-BGM-01/03, AC-COMP-05-09, AC-RENDER-17, AC-NFR-02-04                 |
| browser E2E               | production-like built app, Google test harness only at explicit auth boundary, complete owner/admin journeys    | AC-AUTH-08, AC-ADMIN-01-06, AC-NFR-01/03/12, core preview/render/delivery flows           |
| load                      | documented fixture sizes/hardware, p50/p95/p99, warm/cold split, external time excluded                         | AC-NFR-05-09, AC-OBS-04                                                                   |
| CI/deploy smoke           | source SHA, gates, HF readiness, DB/object persistence across restart                                           | AC-DEPLOY-01-07, AC-OBS-01/03                                                             |

The authoritative criterion list remains `docs/product/ACCEPTANCE_CRITERIA.md`; this is its architectural execution map.

## Required fixtures

- exact foundation schema v1 database and each migration version;
- two members, one pending/disabled/rejected user, one admin, cross-owned projects/resources;
- Vietnamese Unicode filenames, prompts, errors, captions, combining marks, emoji, and non-ASCII search;
- same-name assets, zero/truncated/oversized/corrupt/polyglot media, declared/actual MIME/size/checksum mismatch;
- all four frame formats and Clean/Bold captions with safe-area edge cases;
- deterministic provider fake sequences: success, timeout-before/after acceptance, 429 retry, terminal 4xx, malformed body, stuck poll, cancel race;
- SQLite busy/lease races, process death after object rename/before DB commit, expired leases and outbox events;
- missing/orphan/checksum-mismatched objects and verified backup/restore sets.

## Test-only wiring

Use explicit `createTestApplication({ providerAdapters, clock, idGenerator, paths })`-style test composition (name illustrative, not implementation) in test code. Production startup has a separate closed provider registry and validates real credential references. No `USE_FAKE_PROVIDER`, `MOCK_MODE`, query parameter, admin toggle, or fallback exists in production bundles.

Clocks and IDs are injectable only at domain/application boundaries for deterministic tests. Cryptographic token/security tests also exercise real Node crypto and entropy-length properties. Filesystem tests use fresh OS temporary directories and assert containment.

## Contract and snapshot policy

Provider fixtures are minimized, validated, versioned, redacted, and must not contain copyrighted/private legacy payloads or prompts. Snapshot tests store stable structured output or selected rendered images; they never snapshot secrets, absolute paths, random request IDs, or entire unstable error bodies. A snapshot update requires an explained contract change.

## CI lanes

1. format/lint/typecheck/unit/contract;
2. repository/migration/integration/security/concurrency;
3. deterministic visual/browser build smoke where runtime permits;
4. load and provider-sandbox as scheduled/manual bounded lanes;
5. exact validated commit deployment smoke.

Test sharding must preserve isolation: unique temp DB/storage roots, no shared ports, no dependency on execution order, cleanup in finally hooks, and bounded timeouts. Flaky retries cannot mask invariant failures.
