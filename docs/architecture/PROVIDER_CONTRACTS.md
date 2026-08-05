# Provider Contracts

## Shared adapter rules

Routes and frontend call application capabilities, never provider SDKs/endpoints. Each adapter accepts typed, provider-neutral requests and returns typed results/errors. Credentials are resolved from `ProviderCredentialReference` inside trusted infrastructure. Every call has a deadline, correlation/job/step ID, idempotency key where supported, safe telemetry, bounded retry policy, and capability/health metadata.

Provider raw payloads, secrets, access tokens, internal prompts, URLs containing credentials, and stack traces never enter user responses or ordinary domain tables.

## LLM adapter

| Capability           | Request                                                                               | Result                                                                     |
| -------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `generateStructured` | Purpose, validated input context, output schema/version, budget, idempotency metadata | Schema-valid structured value, usage metadata, provider operation metadata |
| `health`             | Credential reference and bounded probe mode                                           | `healthy`, `degraded`, or `unavailable`; timestamp and safe reason         |

The domain does not know a concrete model name. Adapter configuration maps capabilities to a model. Responses are schema-validated before checkpointing. Supported errors map to provider unavailable/rate-limited/timeout/rejected/invalid-response. No LLM call originates in a route.

## TTS adapter

| Capability     | Request                                                                                   | Result                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `synthesize`   | Scene task ID, text, provider-independent voice selection, output format, idempotency key | Durable provider operation ID or immediate typed artifact reference                     |
| `getOperation` | Provider operation ID                                                                     | Queued/running/completed/failed state, safe progress, audio and optional alignment refs |
| `cancel`       | Provider operation ID                                                                     | Supported/accepted/final state                                                          |
| `health`       | Bounded safe probe                                                                        | Health and capabilities including alignment/cancel support                              |

Omnivoice is the first adapter implementation. Narration is per-scene durable work, not one long HTTP request. Missing alignment is represented explicitly and normalization follows the job contract.

## Render adapter

| Capability     | Request                                                                                                                                             | Result                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `submit`       | Versioned render request, immutable bundle object/checksum, CompositionVersion, dimensions, protocol/renderer/HyperFrames versions, idempotency key | Provider operation ID and accepted protocol version                    |
| `getOperation` | Operation ID and expected protocol                                                                                                                  | Queued/running/completed/failed plus output object capability/metadata |
| `cancel`       | Operation ID                                                                                                                                        | Supported/accepted/final state                                         |
| `health`       | Expected protocol/runtime versions                                                                                                                  | Health, capacity hint, supported versions, safe reason                 |

Modal is the sole hosted MVP implementation. Bundle bytes are referenced from object storage rather than embedded as an unbounded base64 route payload. Local rendering is developer tooling and cannot be selected by product settings or automatic fallback.

## Storage adapter

Capabilities include initialize upload, complete multipart upload, put/get metadata, authorized short-lived read/write capability, verify checksum/existence, copy only when contractually required, and delete idempotently. Storage object keys are server-generated. Storage availability never directly mutates business state without an application transition.

## HyperFrames/runtime adapter

The preview/preflight/materialization boundary accepts a frozen CompositionVersion and manifests and reports typed compatibility/validation results. It never becomes a second canonical editor. Version handshake covers schema, renderer, HyperFrames, registry/dependencies, fonts, assets, captions, and render protocol.

## Adapter retries and health

- Application state machine owns retries; adapters may retry safe transport failures within one attempt but report them transparently.
- Rate limits honor provider retry hints within configured bounds.
- Health does not prove quota or end-to-end success and never uses a paid generation/render request by default.
- Circuit breaking may reject quickly with `PROVIDER_UNAVAILABLE`; it does not silently choose another provider in MVP.
