# Durable Job State Machine

## Decision

Generation and render are subtypes of a generic durable Job aggregate. The common aggregate owns state, lease, heartbeat, attempts, idempotency, cancellation, timeout, progress, errors, and JobStep records. `GenerationJob` orchestrates the end-to-end flow; `RenderJob` is created or reused as its child at `submit_render` and can also be requested independently for an existing CompositionVersion.

The canonical queue is persisted. RAM may cache or dispatch work but never determines job state.

## Top-level states

| State              | Meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `queued`           | Accepted durably and eligible for lease acquisition                               |
| `running`          | Worker owns an unexpired lease and is executing a local step                      |
| `waiting_provider` | Durable external operation exists; worker may release compute while polling later |
| `retry_scheduled`  | Retryable failure has `nextAttemptAt`; not immediately runnable                   |
| `cancel_requested` | Cancellation intent is durable; cleanup/provider cancellation is pending          |
| `cancelled`        | Terminal cancellation completed safely                                            |
| `completed`        | Terminal; every required step completed and output publication contract passed    |
| `failed`           | Terminal non-retryable or exhausted failure                                       |

Terminal states are `cancelled`, `completed`, and `failed`.

## Allowed transitions

| From               | To                 | Guard                                                             |
| ------------------ | ------------------ | ----------------------------------------------------------------- |
| `queued`           | `running`          | Atomic lease acquisition                                          |
| `queued`           | `cancel_requested` | User/system cancellation before execution                         |
| `running`          | `waiting_provider` | Provider operation ID durably recorded                            |
| `running`          | `retry_scheduled`  | Retryable step failure and attempts remain                        |
| `running`          | `cancel_requested` | Cancellation accepted at a safe point                             |
| `running`          | `completed`        | All required steps and invariants pass                            |
| `running`          | `failed`           | Non-retryable, timeout policy exhausted, or invalid contract      |
| `waiting_provider` | `running`          | Provider completed or poll work reacquires lease                  |
| `waiting_provider` | `retry_scheduled`  | Retryable provider/poll failure                                   |
| `waiting_provider` | `cancel_requested` | Cancellation is requested; provider cancel attempted if supported |
| `waiting_provider` | `failed`           | Provider terminal rejection/failure                               |
| `retry_scheduled`  | `queued`           | `nextAttemptAt` reached and cancellation absent                   |
| `retry_scheduled`  | `cancel_requested` | Cancellation before retry                                         |
| `cancel_requested` | `cancelled`        | Active work stopped and durable cleanup checkpoint recorded       |
| `cancel_requested` | `failed`           | Cancellation cannot be made safe and typed failure is recorded    |

All other transitions are forbidden. Terminal states never transition. A retry creates a new attempt/lease, not a state rewind of completed records.

## Lease, restart, duplicates, and idempotency

- Lease acquisition is compare-and-set on an eligible job and includes `leaseOwner`, `leaseExpiresAt`, and attempt.
- The worker heartbeats before a configurable fraction of lease duration. A stale owner cannot update after lease loss.
- Lease expiry moves eligible non-terminal work back to `queued` or `retry_scheduled` through a reconciler; it does not mark the job completed or failed solely because a process disappeared.
- On restart, dispatchers query canonical eligible states. They do not parse logs or inspect files to reconstruct state.
- Two workers may race to acquire, but only one lease version can commit a step. Late writes fail with `CONFLICT`.
- Command idempotency returns the existing semantically equivalent job for the same requester/key. Reuse with a different request hash returns `IDEMPOTENCY_CONFLICT`.
- Step idempotency keys include job, step, logical input version, and attempt-independent operation identity. Provider operation IDs are persisted before polling.

## Cancellation and progress

Cancellation is an intent, not an immediate terminal result. Non-interruptible atomic writes finish, then cleanup runs. Provider cancellation is best-effort only when supported; orphaned provider results are quarantined and cannot publish output.

Progress is integer `0..100`, persisted, and monotonic. Each step owns a fixed range. Retries cannot reduce reported progress; they expose attempt separately. `100` is written only with `completed`. Terminal failed/cancelled jobs retain their last progress.

## Generation steps

| # / step                      | Input                                           | Output and durable checkpoint                                   | Retry / timeout                             | Cancellation / idempotency / resume                                                 | Provider, label, errors, skip                                                                                                                      |
| ----------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 `validate_request`          | Command, project, quota, asset IDs              | Validated normalized request hash                               | No retry; 30s                               | Cancel before start; deterministic key; resume if checkpoint hash matches           | No provider; “Kiểm tra yêu cầu”; `VALIDATION_ERROR`, `QUOTA_EXCEEDED`; never skip                                                                  |
| 2 `plan`                      | Validated request, base version metadata        | Immutable plan artifact                                         | 2 retries; 5m/attempt                       | Cancel between calls; provider request key; resume from valid plan                  | LLM; “Lập kế hoạch”; provider/response errors; never skip                                                                                          |
| 3 `generate_composition`      | Plan, structured schema, asset refs             | Candidate structured document artifact                          | 2 retries; 10m/attempt                      | Same input hash reuses valid artifact; resume supported                             | LLM; “Tạo bố cục”; `COMPOSITION_INVALID`, provider errors; never skip                                                                              |
| 4 `resolve_dependencies`      | Candidate document, registry refs, versions     | Frozen dependency/asset/font manifests                          | 2 retries; 2m                               | Cancel between fetches; content-addressed manifest; resume supported                | HyperFrames registry; “Chuẩn bị dependency”; `DEPENDENCY_MISSING`; skip only when manifest proves none                                             |
| 5 `generate_narration`        | Scene narration, voice config                   | Per-scene audio/alignment artifact refs and task states         | 3 retries/scene; 5m/scene, 20m job envelope | Durable scene task cancellation; scene input key; resume incomplete scenes          | Omnivoice; “Tạo giọng đọc”; provider errors; skip only when narration disabled by valid request                                                    |
| 6 `normalize_alignment`       | Provider alignment/audio duration               | Normalized word/scene timing artifact                           | 1 retry; 2m                                 | Pure transform; input checksum key; resume supported                                | No external provider in MVP; “Đồng bộ lời thoại”; `ASSET_INVALID`, `COMPOSITION_INVALID`; skip only if caption off and duration data already valid |
| 7 `materialize_render_bundle` | Document, manifests, audio/assets               | Immutable object-storage bundle + checksum                      | 2 retries; 5m                               | Multipart abort on cancel; bundle hash key; resume if verified object exists        | Object storage; “Đóng gói render”; `STORAGE_UNAVAILABLE`, `DEPENDENCY_MISSING`; never skip                                                         |
| 8 `preflight`                 | Frozen bundle and expected contract versions    | Signed preflight report artifact                                | 1 retry for transient runtime; 3m           | Safe-point cancel; bundle checksum key; resume supported                            | Shared preview/render runtime; “Kiểm tra trước render”; `COMPOSITION_INVALID`, `DEPENDENCY_MISSING`; never skip                                    |
| 9 `submit_render`             | Preflight-passed bundle and render request      | Child RenderJob ID and provider submission checkpoint           | 2 transport retries; 2m                     | Cancel before/after submit; render idempotency key; resume by child job/provider ID | Modal adapter; “Gửi render”; provider errors; never skip                                                                                           |
| 10 `wait_for_render`          | Child RenderJob/provider operation ID           | Terminal provider result or typed failure                       | Poll retries with backoff; 30m overall      | Cancel requests child/provider cancel; never resubmit blindly; resume polling       | Modal adapter; “Đang render”; provider/render errors; never skip                                                                                   |
| 11 `verify_output`            | Provider result object, expected media contract | Immutable RenderOutput draft + technical QA record              | 1 transient retry; 5m                       | Cancellation cannot publish; checksum/provider result key; resume supported         | Storage/media inspector; “Xác minh video”; `QUALITY_GATE_FAILED`, `ASSET_UNAVAILABLE`; never skip                                                  |
| 12 `publish_output`           | Verified output draft and lineage               | `availabilityState=verified`, project-visible output capability | Transaction retry; 1m                       | Cancel before commit; output lineage key; resume transactionally                    | No provider; “Hoàn tất”; `CONFLICT`, `STORAGE_UNAVAILABLE`; never skip                                                                             |

## RenderJob behavior

RenderJob uses the same eight states but its steps are `validate_bundle`, `submit_provider`, `wait_provider`, `ingest_provider_output`, and `complete`. Modal is the only hosted provider. Local rendering is development tooling outside product dispatch. A render retry never overwrites a prior RenderOutput; it idempotently reuses the same verified output only when request hash, bundle checksum, provider operation, and output checksum match the reuse contract.

## Failure and recovery

- Retryable errors move to `retry_scheduled` with bounded exponential backoff and jitter.
- Non-retryable validation/authorization/contract failures move to `failed` without provider calls.
- Exhausted retries move to `failed` with stable `errorCode` and safe details.
- Reconciliation checks expired leases, provider operations, orphaned bundles, and outputs awaiting verification using canonical IDs—not log phrases.
- User retry creates a new attempt or new Job according to eligibility; completed steps are reused only after validating immutable checkpoint hashes.
