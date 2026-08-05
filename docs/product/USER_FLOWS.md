# MVP User Flows

Acceptance criteria IDs refer to `ACCEPTANCE_CRITERIA.md`.

## UF-01 Visitor and closed-beta entry

| State         | Contract                                                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy         | Open landing → Google login → validated callback → new/existing User → pending screen or Project List when active; only the verified configured identity can bootstrap the first admin when no admin exists |
| Loading       | Login button disables; callback shows bounded progress without exposing OAuth code/token                                                                                                                    |
| Empty         | Pending screen explains approval status and logout; no Product navigation                                                                                                                                   |
| Error         | OAuth state/provider errors use typed safe message and retry login action                                                                                                                                   |
| Retry         | Start a fresh OAuth state; never reuse failed callback state                                                                                                                                                |
| Authorization | Visitor can access OAuth only; pending/disabled/rejected cannot enter product APIs                                                                                                                          |
| Audit         | Login success/failure category, user creation, approval/disable/reject/session revoke                                                                                                                       |
| Criteria      | AC-AUTH-01..10, AC-SEC-01..04                                                                                                                                                                               |

## UF-02 Approved member creates and edits a video

| State         | Contract                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy         | Login → Project List → create Project → upload private Asset → prompt/settings → submit GenerationJob → durable progress → preview → structured edit/version → render → verify → playback/download |
| Loading       | Skeleton/list, upload progress/ingestion state, job step/progress, preview startup, render/verification status are distinct                                                                        |
| Empty         | Empty Project List offers create; empty Project offers upload/prompt; preview/render disabled until prerequisites exist                                                                            |
| Error         | Typed error shows failed step, correlation ID, safe message, suggested action and retry eligibility                                                                                                |
| Retry         | Upload retry, job checkpoint retry, render retry, or edit new version according to state machine; no duplicate artifact                                                                            |
| Authorization | Every resource is owner-scoped; Asset must be `ready + active` in the same Project; quota admission precedes job acceptance                                                                        |
| Audit         | Project create/update, upload lifecycle, job commands, version creation, output delivery capability                                                                                                |
| Criteria      | AC-PROJ-01..10, AC-ASSET-01..14, AC-JOB-01..18, AC-COMP-01..09, AC-RENDER-01..18                                                                                                                   |

## UF-03 Error recovery

| State         | Contract                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Happy         | Job failed → safe error/failed step → eligibility → retry from validated durable checkpoint → continue                                   |
| Loading       | Retry is `queued/retry_scheduled`; attempt shown separately; progress never falls                                                        |
| Empty         | If no safe checkpoint exists, UI proposes a new generation rather than fake resume                                                       |
| Error         | Non-retryable/exhausted errors explain required input/admin action; no secret/path/stack                                                 |
| Retry         | Idempotency prevents duplicates; expired `running` work resumes only when safe, while provider polling and cleanup preserve their states |
| Authorization | Only requester/owner can command; admin views safe diagnostics but does not impersonate owner                                            |
| Audit         | Cancel/retry, lease recovery, provider failure category, terminal outcome                                                                |
| Criteria      | AC-JOB-02..18, AC-ERR-01..06, AC-OBS-01..04                                                                                              |

## UF-04 Project deletion and restore

| State         | Contract                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| Happy         | Soft delete → hidden active list → trash → restore within 30 days, or scheduled durable purge after retention |
| Loading       | Delete returns after canonical soft-delete transaction; purge status is asynchronous and visible safely       |
| Empty         | Trash empty state; no special Workspace/default Project appears                                               |
| Error         | Restore conflict after purge lease; purge failure stays retryable and does not claim success                  |
| Retry         | Owner retries restore before purge; system retries purge idempotently                                         |
| Authorization | Owner may soft-delete/restore own Project; only system worker may purge                                       |
| Audit         | Delete, restore, purge schedule/start/failure/completion                                                      |
| Criteria      | AC-PROJ-04..10, AC-RET-01..11                                                                                 |

## UF-05 Admin operations

| State         | Contract                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy         | Verified first-admin bootstrap when needed → login → pending users → approve/disable/reject → failed jobs through redacted admin list/detail → provider health → credential reference/quota update |
| Loading       | Independent bounded panels show last refreshed time and degraded dependencies                                                                                                                      |
| Empty         | Explicit empty states for pending users, failed jobs and credential references                                                                                                                     |
| Error         | `AUTHORIZATION_DENIED` for non-admin; last-active-admin conflict prevents lockout; safe typed DB/provider errors; failed write leaves prior policy/reference active                                |
| Retry         | Refresh read models; retry idempotent admin command with audit correlation                                                                                                                         |
| Authorization | Admin policy required; owner Project/Composition/Job-history/SSE routes remain denied; no raw secret read or blanket private content access                                                        |
| Audit         | Every user status, credential reference and quota mutation; diagnostic access where policy requires                                                                                                |
| Criteria      | AC-ADMIN-01..09, AC-AUTH-09..10, AC-AUTHZ-07..13                                                                                                                                                   |
