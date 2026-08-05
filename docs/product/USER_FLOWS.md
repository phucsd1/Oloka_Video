# MVP User Flows

Acceptance criteria IDs refer to `ACCEPTANCE_CRITERIA.md`.

## UF-01 Visitor and closed-beta entry

| State         | Contract                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| Happy         | Open landing → Google login → validated callback → new/existing User → pending screen or Project List when active |
| Loading       | Login button disables; callback shows bounded progress without exposing OAuth code/token                          |
| Empty         | Pending screen explains approval status and logout; no Product navigation                                         |
| Error         | OAuth state/provider errors use typed safe message and retry login action                                         |
| Retry         | Start a fresh OAuth state; never reuse failed callback state                                                      |
| Authorization | Visitor can access OAuth only; pending/disabled/rejected cannot enter product APIs                                |
| Audit         | Login success/failure category, user creation, approval/disable/reject/session revoke                             |
| Criteria      | AC-AUTH-01..08, AC-SEC-01..04                                                                                     |

## UF-02 Approved member creates and edits a video

| State         | Contract                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy         | Login → Project List → create Project → upload private Asset → prompt/settings → submit GenerationJob → durable progress → preview → structured edit/version → render → verify → playback/download |
| Loading       | Skeleton/list, upload progress/ingestion state, job step/progress, preview startup, render/verification status are distinct                                                                        |
| Empty         | Empty Project List offers create; empty Project offers upload/prompt; preview/render disabled until prerequisites exist                                                                            |
| Error         | Typed error shows failed step, correlation ID, safe message, suggested action and retry eligibility                                                                                                |
| Retry         | Upload retry, job checkpoint retry, render retry, or edit new version according to state machine; no duplicate artifact                                                                            |
| Authorization | Every resource is owner-scoped; Asset must be ready/same Project; quota admission precedes job acceptance                                                                                          |
| Audit         | Project create/update, upload lifecycle, job commands, version creation, output delivery capability                                                                                                |
| Criteria      | AC-PROJ-01..09, AC-ASSET-01..10, AC-JOB-01..12, AC-COMP-01..09, AC-RENDER-01..11                                                                                                                   |

## UF-03 Error recovery

| State         | Contract                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Happy         | Job failed → safe error/failed step → eligibility → retry from validated durable checkpoint → continue |
| Loading       | Retry is `queued/retry_scheduled`; attempt shown separately; progress never falls                      |
| Empty         | If no safe checkpoint exists, UI proposes a new generation rather than fake resume                     |
| Error         | Non-retryable/exhausted errors explain required input/admin action; no secret/path/stack               |
| Retry         | Idempotency prevents duplicate jobs/steps/outputs; expired lease permits a new worker                  |
| Authorization | Only requester/owner can command; admin views safe diagnostics but does not impersonate owner          |
| Audit         | Cancel/retry, lease recovery, provider failure category, terminal outcome                              |
| Criteria      | AC-JOB-02..12, AC-ERR-01..06, AC-OBS-01..04                                                            |

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
| Criteria      | AC-PROJ-04..09, AC-RET-01..07                                                                                 |

## UF-05 Admin operations

| State         | Contract                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Happy         | Login → pending users → approve/disable/reject → failed jobs/safe diagnostics → provider health → credential reference/quota update |
| Loading       | Independent bounded panels show last refreshed time and degraded dependencies                                                       |
| Empty         | Explicit empty states for pending users, failed jobs and credential references                                                      |
| Error         | 403 for non-admin; safe typed DB/provider errors; failed write leaves prior policy/reference active                                 |
| Retry         | Refresh read models; retry idempotent admin command with audit correlation                                                          |
| Authorization | Admin policy required; no raw secret read and no blanket private Asset/output access                                                |
| Audit         | Every user status, credential reference and quota mutation; diagnostic access where policy requires                                 |
| Criteria      | AC-ADMIN-01..08, AC-AUTHZ-07..12                                                                                                    |
