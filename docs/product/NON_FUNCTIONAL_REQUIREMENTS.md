# Non-Functional Requirements

## Security

- SEC-01: All product resources use opaque server IDs and deny-by-default authorization.
- SEC-02: Google OAuth validates state; sessions use Secure, HttpOnly, appropriate SameSite cookies and revocable hashed server state.
- SEC-03: State-changing cookie-authenticated requests use a documented CSRF defense (SameSite plus origin/token validation as appropriate).
- SEC-04: Clients never provide trusted filesystem paths/storage keys; signed capabilities are scoped, short-lived and issued after authorization.
- SEC-05: Uploads enforce declared/actual size, supported MIME/media inspection, checksum, quotas, and safe filename presentation.
- SEC-06: Raw provider/storage secrets and tokens never enter browser storage, URLs, logs, read APIs, or normal domain tables.
- SEC-07: Sensitive mutations and purge operations create safe AuditEvents.
- SEC-08: CI runs secret scanning and dependency vulnerability scanning with an explicit severity gate before deployment.

## Durability

- DUR-01: Application restart preserves every accepted Job/Step record and re-dispatches eligible work after lease expiry.
- DUR-02: A completed Step replay does not create duplicate provider operations or artifacts.
- DUR-03: Database is canonical for lifecycle; object/file/log/RAM state cannot independently mark work complete.
- DUR-04: CompositionVersion and RenderOutput are immutable; retries never overwrite them.
- DUR-05: Soft-deleted Projects restore within the retention window; purge is a durable audited system job.
- DUR-06: Storage and DB coordination uses idempotency and transaction/outbox or reconciliation semantics.

## Performance targets

Targets apply to application-controlled latency in the development environment under 20 requests/second and exclude external provider completion latency:

| Capability            | Target                                                           |
| --------------------- | ---------------------------------------------------------------- |
| Liveness health       | p95 ≤ 250 ms                                                     |
| Readiness             | p95 ≤ 1 s with healthy dependencies                              |
| Project List          | p95 ≤ 500 ms for first page with 100 owned Projects              |
| Asset metadata/search | p95 ≤ 500 ms for first page with 1,000 owned Assets              |
| Job status            | p95 ≤ 300 ms                                                     |
| Upload initiation     | p95 ≤ 500 ms, excluding byte transfer                            |
| Preview startup       | p95 ≤ 5 s for a preflight-passed MVP Composition on warm runtime |

Provider latency is governed by explicit per-step deadlines and observed as separate metrics; the product does not claim an artificial end-to-end provider SLA.

## Observability

- Structured logs include correlation ID, build SHA, actor category, Job ID, Step ID and provider operation ID where applicable.
- Metrics cover request latency/error, admissions/quota denials, queue age, lease expiry, retries, provider outcomes, step duration, verification and purge.
- Liveness, readiness, version/build identity and provider health are distinct surfaces.
- Diagnostics are safe/redacted and identify failed state/step/error/attempt/checkpoint without secrets, stack traces or paths.

## Accessibility

- All flows are keyboard operable with visible focus, semantic controls and logical focus order.
- Text/control contrast meets WCAG 2.2 AA; status is never conveyed by color alone.
- Reduced-motion preference is respected by product UI transitions.
- Loading, errors and progress use accessible names/live-region strategy without excessive announcements.
- Caption controls and Vietnamese content remain readable at supported viewport sizes.

## Localization

- UTF-8 is enforced end-to-end for requests, DB values, structured documents, manifests and logs.
- Vietnamese fixtures cover names, prompts, errors, captions and filenames with full diacritics.
- User-visible dates/times use locale/time-zone formatting; stored timestamps remain UTC.
- Stable machine error codes are language-independent; MVP provides Vietnamese safe messages.
