# Durable Job State Machine

Status: the exhaustive Job and JobStep transition matrices are live in the schema-v6 Phase 3E core cut over at merge `f6761312ea30f9cc76503447be84e37b758d05f5`. Phase 3E.3 corrects outbox runtime wiring without changing these matrices or schema; the correction is not yet deployed. Phase 3F has not started.

## Decision

Generation and render are subtypes of a generic durable Job aggregate. The common aggregate owns state, lease, heartbeat, attempts, idempotency, cancellation, timeout, progress, errors, and JobStep records. `GenerationJob` orchestrates the end-to-end flow; `RenderJob` is created or reused as its child at `submit_render` and can also be requested independently for an existing CompositionVersion.

The canonical queue is persisted. `jobs.current_step_key` is the authoritative
current logical step; logs, file presence, latest event text, and RAM may never
infer or replace it. RAM may cache or dispatch work but never determines job
state.

## Top-level states

| State              | Meaning                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `queued`           | Accepted durably and eligible for lease acquisition                                                            |
| `running`          | Worker owns an unexpired lease and is executing a local step                                                   |
| `waiting_provider` | Durable provider operation exists, or submitted intent has unknown outcome and awaits key-based reconciliation |
| `retry_scheduled`  | Retryable failure has `nextAttemptAt`; not immediately runnable                                                |
| `cancel_requested` | Cancellation intent is durable; cleanup/provider cancellation is pending                                       |
| `cancelled`        | Terminal cancellation completed safely                                                                         |
| `completed`        | Terminal; every required step completed and output publication contract passed                                 |
| `failed`           | Terminal non-retryable or exhausted failure                                                                    |

Terminal states are `cancelled`, `completed`, and `failed`.

## Allowed top-level transitions

| From               | To                 | Guard                                                                                                                                                                                            |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `queued`           | `running`          | Atomic lease acquisition                                                                                                                                                                         |
| `queued`           | `cancel_requested` | User/system cancellation before execution                                                                                                                                                        |
| `running`          | `queued`           | Reconciler only: lease expired, old owner loses commit right, job is non-terminal, no active operation belongs in `waiting_provider`, and the current step is checkpoint-resumable or idempotent |
| `running`          | `waiting_provider` | Provider operation ID durably recorded, or outcome-unknown submission intent durably recorded for reconciliation                                                                                 |
| `running`          | `retry_scheduled`  | Retryable step failure and attempts remain                                                                                                                                                       |
| `running`          | `cancel_requested` | Cancellation accepted at a safe point                                                                                                                                                            |
| `running`          | `completed`        | All required steps and invariants pass                                                                                                                                                           |
| `running`          | `failed`           | Non-retryable, timeout policy exhausted, or invalid contract                                                                                                                                     |
| `waiting_provider` | `running`          | Provider completed and a worker atomically acquired the completion-work lease; the existing provider operation is retained                                                                       |
| `waiting_provider` | `retry_scheduled`  | Retryable polling/ingestion failure; never provider resubmission merely because a worker restarted                                                                                               |
| `waiting_provider` | `cancel_requested` | Cancellation is requested; provider cancel attempted if supported                                                                                                                                |
| `waiting_provider` | `failed`           | Provider terminal rejection/failure                                                                                                                                                              |
| `retry_scheduled`  | `queued`           | `nextAttemptAt` reached and cancellation absent                                                                                                                                                  |
| `retry_scheduled`  | `cancel_requested` | Cancellation before retry                                                                                                                                                                        |
| `cancel_requested` | `cancelled`        | Active work stopped and durable cleanup checkpoint recorded                                                                                                                                      |
| `cancel_requested` | `failed`           | Cleanup cannot be made safe and a typed failure is recorded                                                                                                                                      |

All other transitions are forbidden, including any terminal-to-non-terminal transition. The reconciler has no implicit override: it may perform only the explicitly listed guarded transitions. A retry creates a new attempt/lease, not a state rewind of completed records.

## Lease expiry, restart, duplicates, and idempotency

- Lease acquisition is compare-and-set on an eligible job and includes `leaseOwner`, `leaseExpiresAt`, lease version, and attempt.
- The worker heartbeats before a configurable fraction of lease duration. On expiry, the old worker loses all commit rights; every subsequent write must fail its lease/version guard with `VERSION_CONFLICT`.
- An expired `running` job returns to `queued` only through the guarded reconciler transition above. If its checkpoint is not safely resumable/idempotent, reconciliation records a typed failure or schedules policy-approved retry rather than replaying unknown work.
- An expired `waiting_provider` job remains `waiting_provider`. A known
  `providerOperationId` is preserved and a new polling lease continues polling;
  an outcome-unknown intent without an ID receives a reconciliation lease and
  looks up by the stable provider key. Neither path resubmits on restart. The job
  returns to `running` only after provider completion/absence resolution and an
  atomic completion-work lease.
- An expired `cancel_requested` job remains `cancel_requested`. Another worker acquires a cleanup lease without changing the state, then records `cancelled` or a typed `failed` result.
- On restart, dispatchers query canonical eligible states. They do not parse logs or inspect files to reconstruct state.
- Two workers may race to acquire, but only one lease version can commit a step. Late writes fail with `VERSION_CONFLICT`.
- Command idempotency returns the existing semantically equivalent job for the same requester/key. Reuse with a different request hash returns `IDEMPOTENCY_CONFLICT`.
- Step idempotency keys include job, step, logical item, logical input version, and attempt-independent operation identity. Provider operation IDs are persisted before polling.

## JobStep state machine

JobStep states are exactly `pending`, `running`, `waiting_provider`, `retry_scheduled`, `completed`, `skipped`, `cancelled`, and `failed`. Terminal states are `completed`, `skipped`, `cancelled`, and `failed`.

| From               | To                 | Guard                                                                                                                    |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `pending`          | `running`          | Atomic step lease acquisition; prerequisites satisfied                                                                   |
| `pending`          | `skipped`          | Step is optional and a validated skip reason/checkpoint proves it is unnecessary                                         |
| `pending`          | `cancelled`        | Parent cancellation accepted before work starts                                                                          |
| `running`          | `pending`          | Reconciler only after lease expiry and only when checkpoint resume or idempotent replay is safe                          |
| `running`          | `waiting_provider` | Provider operation identity or outcome-unknown submission intent is durably saved                                        |
| `running`          | `retry_scheduled`  | Retryable failure or timeout, attempts remain, and `nextAttemptAt` is persisted                                          |
| `running`          | `completed`        | Output checkpoint and postconditions pass                                                                                |
| `running`          | `skipped`          | A runtime-discovered optional condition is validated and recorded                                                        |
| `running`          | `cancelled`        | Parent cancellation reached a safe point and cleanup completed                                                           |
| `running`          | `failed`           | Failure is non-retryable, contract-invalid, or retries/timeouts are exhausted                                            |
| `waiting_provider` | `running`          | Existing provider operation completed and completion work atomically acquired a lease; ordinary polling keeps this state |
| `waiting_provider` | `retry_scheduled`  | Retryable polling or result-ingestion failure, not loss of provider identity                                             |
| `waiting_provider` | `completed`        | Provider result and required checkpoint were durably verified                                                            |
| `waiting_provider` | `cancelled`        | Parent cancellation and supported provider cleanup reached a safe terminal point                                         |
| `waiting_provider` | `failed`           | Provider terminal failure, invalid result, or exhausted timeout/retry policy                                             |
| `retry_scheduled`  | `pending`          | `nextAttemptAt` reached and parent cancellation absent                                                                   |
| `retry_scheduled`  | `cancelled`        | Parent cancellation accepted before retry                                                                                |

All other JobStep transitions are forbidden. In particular, `failed -> running` is never a retry: `failed` is terminal. Retry follows `running|waiting_provider -> retry_scheduled -> pending -> running` with a new attempt and lease.

Step execution rules:

- Lease and heartbeat fields are guarded exactly like the parent Job. Expiry removes the old worker's commit right.
- An expired `waiting_provider` step keeps its state and provider checkpoint.
  When an operation ID exists it is preserved and polled; otherwise the durable
  outcome-unknown intent is reconciled by idempotency key. A new lease keeps the
  state and never implies provider resubmission.
- Timeout produces `retry_scheduled` when policy and attempts permit, otherwise terminal `failed`. Cancellation takes precedence before a new retry lease.
- A checkpoint may be reused only when its immutable input hash, logical item key, contract version, and postconditions match. Completed or skipped checkpoints cannot be rewritten.
- Provider polling persists the latest safe status without manufacturing progress. A late worker or provider callback must pass the current lease/version and operation-identity guards.
- A skipped step requires a typed reason and evidence that the parent invariant remains satisfied; required steps cannot be skipped by convenience.
- A parent Job completes only when every required top-level JobStep is `completed` or validly `skipped`. An unrecoverable required-step failure makes the parent `failed`; parent cancellation drives unfinished steps to `cancelled` or cleanup-safe terminal outcomes.

### Narration item model

`generate_narration` is a parent JobStep with `itemKey=null`. Every required narration scene is a child JobStep whose `parentStepId` points to that parent and whose `itemKey=sceneId`. The `(parentStepId, itemKey)` logical identity is unique. Each item independently persists `state`, `attempt`, `providerOperationId`, input hash, output checkpoint, timeout, error, and lease.

The narration parent becomes `completed` only when every required scene item is `completed` or validly `skipped`; it becomes terminal `failed` only when an item has an unrecoverable failure. Retrying one failed scene advances only that scene through `retry_scheduled -> pending -> running` and reuses verified completed-scene checkpoints without redoing them.

## Cancellation and progress

Cancellation is an intent, not an immediate terminal result. Non-interruptible atomic writes finish, then cleanup runs. Provider cancellation is best-effort only when supported; orphaned provider results are quarantined and cannot publish output.

Progress is persisted as integer basis points `0..10000` and exposed as a
derived percentage. It is monotonic; each step owns a fixed range. Retries
cannot reduce reported progress and expose attempt separately. `10000` is
written only with `completed`. Terminal failed/cancelled jobs retain their last
progress.

Before a provider call, a guarded transaction records submission-requested
intent, semantic request hash, stable provider idempotency-key hash, attempt,
lease/version, and outbox intent without a fabricated operation ID. Acceptance
stores the real operation ID and `waiting_provider` in a second transaction. An
unknown outcome is reconciled by key/lookup before policy can permit resubmit.

## Generation steps

| # / step                      | Input                                           | Output and durable checkpoint                                                      | Retry / timeout                             | Cancellation / idempotency / resume                                                 | Provider, label, errors, skip                                                                                                                      |
| ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 `validate_request`          | Command, project, quota, asset IDs              | Validated normalized request hash                                                  | No retry; 30s                               | Cancel before start; deterministic key; resume if checkpoint hash matches           | No provider; “Kiểm tra yêu cầu”; `VALIDATION_ERROR`, `QUOTA_EXCEEDED`; never skip                                                                  |
| 2 `plan`                      | Validated request, base version metadata        | Immutable plan artifact                                                            | 2 retries; 5m/attempt                       | Cancel between calls; provider request key; resume from valid plan                  | LLM; “Lập kế hoạch”; provider/response errors; never skip                                                                                          |
| 3 `generate_composition`      | Plan, structured schema, asset refs             | Candidate structured document artifact                                             | 2 retries; 10m/attempt                      | Same input hash reuses valid artifact; resume supported                             | LLM; “Tạo bố cục”; `COMPOSITION_INVALID`, provider errors; never skip                                                                              |
| 4 `resolve_dependencies`      | Candidate document, registry refs, versions     | Frozen dependency, asset, font, and caption manifests with hashes                  | 2 retries; 2m                               | Cancel between fetches; content-addressed manifest; resume supported                | HyperFrames registry; “Chuẩn bị dependency”; `DEPENDENCY_MISSING`; skip only when manifest proves none                                             |
| 5 `generate_narration`        | Scene narration, voice config                   | Parent JobStep plus child items keyed by `sceneId`, each with audio/alignment refs | 3 retries/scene; 5m/scene, 20m job envelope | Per-item cancellation; scene input key; resume only incomplete scenes               | Omnivoice; “Tạo giọng đọc”; provider errors; skip only when narration is validly disabled                                                          |
| 6 `normalize_alignment`       | Provider alignment/audio duration               | Normalized word/scene timing artifact                                              | 1 retry; 2m                                 | Pure transform; input checksum key; resume supported                                | No external provider in MVP; “Đồng bộ lời thoại”; `ASSET_INVALID`, `COMPOSITION_INVALID`; skip only if caption off and duration data already valid |
| 7 `materialize_render_bundle` | Document, manifests, audio/assets               | Immutable object-storage bundle, checksum, and canonical render lineage            | 2 retries; 5m                               | Multipart abort on cancel; bundle hash key; resume if verified object exists        | Object storage; “Đóng gói render”; `STORAGE_UNAVAILABLE`, `DEPENDENCY_MISSING`; never skip                                                         |
| 8 `preflight`                 | Frozen bundle and expected contract versions    | Signed report containing the deterministic `renderContractFingerprint`             | 1 retry for transient runtime; 3m           | Safe-point cancel; bundle checksum key; resume supported                            | Shared preview/render runtime; “Kiểm tra trước render”; `COMPOSITION_INVALID`, `DEPENDENCY_MISSING`; never skip                                    |
| 9 `submit_render`             | Preflight-passed bundle and render request      | Child RenderJob ID and provider submission checkpoint                              | 2 transport retries; 2m                     | Cancel before/after submit; render idempotency key; resume by child job/provider ID | Modal adapter; “Gửi render”; provider errors; never skip                                                                                           |
| 10 `wait_for_render`          | Child RenderJob/provider operation ID           | Terminal provider result or typed failure                                          | Poll retries with backoff; 30m overall      | Cancel requests child/provider cancel; never resubmit blindly; resume polling       | Modal adapter; “Đang render”; provider/render errors; never skip                                                                                   |
| 11 `verify_output`            | Provider result object, expected media contract | RenderOutput immutable core, lifecycle initialization, and technical QA record     | 1 transient retry; 5m                       | Cancellation cannot publish; checksum/provider result key; resume supported         | Storage/media inspector; “Xác minh video”; `QUALITY_GATE_FAILED`, `ASSET_UNAVAILABLE`; never skip                                                  |
| 12 `publish_output`           | Verified output and canonical lineage           | `availabilityState=verified`, `retentionState=active`, visible output capability   | Transaction retry; 1m                       | Cancel before commit; output lineage key; resume transactionally                    | No provider; “Hoàn tất”; `VERSION_CONFLICT`, `STORAGE_UNAVAILABLE`; never skip                                                                     |

## GenerationJob and RenderJob relationship

- Every GenerationJob has `parentJobId=null` and may create zero or many child RenderJobs.
- A generation-created RenderJob has `parentJobId=GenerationJob.id`; a standalone rerender has `parentJobId=null`.
- Parent and child share the same Project and authorization boundary. The child has no ownership independent of Project.
- Child reuse is allowed only when Project, CompositionVersion, `bundleChecksum`, render request hash, `rendererVersion`, `renderProtocolVersion`, and provider operation identity/idempotency contract all match. Any mismatch creates a new RenderJob or raises `IDEMPOTENCY_CONFLICT`; it never silently reuses work.

## RenderJob behavior

RenderJob uses the same eight top-level Job states and its steps are `validate_bundle`, `submit_provider`, `wait_provider`, `ingest_provider_output`, and `complete`. Modal is the only hosted provider. Local rendering is development tooling outside product dispatch.

The adapter validates `renderProtocolVersion`, renderer compatibility, and canonical lineage before submission. A render retry never overwrites a prior RenderOutput. It may reuse a `verified + active` output only when the full child-reuse contract above, output checksum, and deterministic `renderContractFingerprint` match.

## Canonical render lineage

Materialization freezes `bundleChecksum`, `compositionSchemaVersion`, `renderProtocolVersion`, `rendererVersion`, `hyperframesVersion`, `dependencyManifestHash`, `assetManifestHash`, `fontManifestHash`, and `captionManifestHash`. Canonical versioned serialization of those values produces `renderContractFingerprint`. Preview reports the same fingerprint; preflight and the provider adapter reject incompatibility; output verification compares the stored lineage to the bundle, provider result, and immutable manifest references before publication.

## Failure and recovery

- Retryable errors move to `retry_scheduled` with bounded exponential backoff and jitter.
- Non-retryable validation/authorization/contract failures move to `failed` without provider calls.
- Exhausted retries move to `failed` with stable `errorCode` and safe details.
- Reconciliation checks expired leases, provider operations, orphaned bundles, and outputs awaiting verification using canonical IDs—not log phrases.
- User retry creates a new attempt or new Job according to eligibility; completed steps are reused only after validating immutable checkpoint hashes.
