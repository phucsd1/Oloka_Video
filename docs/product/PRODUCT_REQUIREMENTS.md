# Oloka Video MVP Product Requirements

## Product contract

Oloka Video MVP is a closed-beta, project-centered prompt-to-video product. An approved member uploads private assets, creates a structured composition through a durable generation job, previews and edits structured fields, renders through Modal, passes mandatory technical verification, then plays or downloads an output with immutable output identity, bytes, media metadata and lineage.

The product ends at download. It has no Workspace, social publishing, global asset library, web ingestion, arbitrary code editor, or alternate Cloudflare topology.

## Product principles

1. Database state is canonical; files, objects, logs, and RAM are not business-state oracles.
2. Every private resource has opaque identity, explicit owner, deny-by-default authorization, and server-resolved storage references.
3. Long-running work is durable, idempotent, resumable, cancellable, bounded, and observable.
4. Composition versions are immutable; RenderOutput identity, bytes, media metadata and lineage are immutable while lifecycle/review fields change only through guarded transitions.
5. Preview and final render share a versioned contract.
6. Providers sit behind typed adapters; secrets remain server-side.
7. Errors and quality dimensions are explicit, testable, and safe.

## Requirements

| ID    | Requirement                                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR-01 | Provide a public landing entry with Google login and a clear closed-beta state.                                                                                                            |
| PR-02 | Support Google OAuth only, with state validation and no anonymous/password/GitHub product access.                                                                                          |
| PR-03 | Create new users as `pending`; bootstrap exactly the first verified configured admin, preserve at least one active admin, and approve/disable/reject without hard delete.                  |
| PR-04 | Use revocable secure-cookie sessions backed by hashed server-side session state.                                                                                                           |
| PR-05 | Route active members directly to an owner-scoped Project List; no Workspace/default project exists.                                                                                        |
| PR-06 | Support canonical Project create/read/rename with opaque server ID and one owner.                                                                                                          |
| PR-07 | Support Project soft delete, trash listing, restore for 30 days, and durable purge.                                                                                                        |
| PR-08 | Support Project `favorite` solely as list organization; no `posted` lifecycle.                                                                                                             |
| PR-09 | Let members upload private Assets into their own Project through object-storage capabilities; initialize them as `upload_pending + active`.                                                |
| PR-10 | Validate checksum/media and persist independent canonical Asset ingestion and lifecycle states plus technical metadata.                                                                    |
| PR-11 | Search Assets only by original filename, media type, upload time, Project, ingestion status, and lifecycle/trash context.                                                                  |
| PR-12 | Capture prompt, aspect ratio, voice, caption, BGM, allowed style fields, and Asset references.                                                                                             |
| PR-13 | Execute 12-step generation through durable, idempotent Job and JobStep state machines with lease reconciliation and per-scene narration checkpoints.                                       |
| PR-14 | Expose DB-authoritative monotonic progress/current step, safe error, cancellation, and eligible checkpoint retry.                                                                          |
| PR-15 | Provide a basic structured editor for the explicitly allowlisted composition fields.                                                                                                       |
| PR-16 | Store every generated or edited CompositionVersion immutably and transactionally select the current version.                                                                               |
| PR-17 | Provide read-only preview from the selected CompositionVersion using the parity contract.                                                                                                  |
| PR-18 | Support caption off, `Clean`, and `Bold` with UTF-8 Vietnamese wrapping, line limits, margins, and versioned fonts.                                                                        |
| PR-19 | Generate narration through an Omnivoice typed adapter using durable per-scene work and optional alignment.                                                                                 |
| PR-20 | Support no BGM or one private audio Asset with volume and basic voice ducking.                                                                                                             |
| PR-21 | Freeze and validate dependency, asset, font, caption, renderer, HyperFrames, schema, protocol, bundle checksum, and deterministic render fingerprint before render.                        |
| PR-22 | Render hosted outputs only through a versioned Modal adapter; local render remains development tooling.                                                                                    |
| PR-23 | Require technical QA before successful completion; keep visual/human statuses separate and optional.                                                                                       |
| PR-24 | Create RenderOutputs with immutable output identity, bytes, media metadata and lineage; authorize delivery only while availability is verified, retention active, and technical QA passed. |
| PR-25 | Use the stable typed error catalog and safe failed-step diagnostics with correlation IDs.                                                                                                  |
| PR-26 | Give admins minimal user approval/disable/reject and safe failed-job operations.                                                                                                           |
| PR-27 | Let admins manage credential references and view provider health without reading raw secrets.                                                                                              |
| PR-28 | Enforce configurable admission quotas and concurrency before accepting work.                                                                                                               |
| PR-29 | Enforce independent availability/retention state and pinning through durable purge jobs, AuditEvents, and non-restorable Project tombstones.                                               |
| PR-30 | Ship through validated GitHub Actions to one HF Docker Space with structured observability and runtime build SHA.                                                                          |

## Success condition

The MVP contract is satisfied only when the approved-user flow can complete with canonical lineage from User → Project → Asset/CompositionVersion → GenerationJob/RenderJob → `verified + active` RenderOutput, and the error/deletion/restart/cross-user cases meet `ACCEPTANCE_CRITERIA.md`.
