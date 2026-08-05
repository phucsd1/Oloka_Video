# Authorization Model

## Policy

Authorization is deny-by-default and evaluated server-side after authentication. Resource access is derived from opaque resource ID, canonical ownership, actor status, role, and—where applicable—an active job lease. Client-provided filenames, storage keys, object URLs, slugs, or filesystem paths never establish access.

Actors: `visitor`, `pending_user`, `active_member`, `disabled_user`, `rejected_user`, `admin`, `system_worker`. A rejected user has the same narrow account/logout surface as a disabled user, but denial uses the distinct non-retryable `ACCOUNT_REJECTED` code unless an admin changes status.

## Authorization rules

| Rule     | Actor and capability                               | Decision and conditions                                                            |
| -------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| AUTH-001 | Any unmatched request                              | Deny; no implicit local-admin or auth-disabled mode in hosted MVP                  |
| AUTH-002 | Visitor: landing and public health                 | Allow read-only public surfaces                                                    |
| AUTH-003 | Visitor: Google OAuth start/callback               | Allow with OAuth state, callback, and CSRF controls                                |
| AUTH-004 | Pending user: own account status/logout            | Allow minimum self-service surface                                                 |
| AUTH-005 | Pending user: any product API                      | Deny with `ACCOUNT_PENDING`                                                        |
| AUTH-006 | Active member: list/create Project                 | Allow; list is owner-filtered and create assigns the actor as owner                |
| AUTH-007 | Active member: read/update own Project             | Allow by canonical `ownerId`                                                       |
| AUTH-008 | Active member: another user's Project              | Deny before storage or provider access                                             |
| AUTH-009 | Active member: own soft-deleted Project            | Allow only trash metadata and restore during retention                             |
| AUTH-010 | Active member: create Asset                        | Allow only inside an owned, active Project and within quota                        |
| AUTH-011 | Active member: read/update/delete own Asset        | Allow by canonical owner and project lineage                                       |
| AUTH-012 | Active member: another user's Asset                | Deny before resolving storage key or signed URL                                    |
| AUTH-013 | Active member: reference Asset in Composition      | Allow only when Asset is `ready + active` and belongs to the same Project          |
| AUTH-014 | Any client: submit storage key/path                | Ignore as authority; reject path-like values and resolve server-side               |
| AUTH-015 | Active member: read own CompositionVersion         | Allow through owned Project lineage                                                |
| AUTH-016 | Active member: structured edit                     | Allow; creates immutable version, never mutates prior document                     |
| AUTH-017 | Active member: another user's CompositionVersion   | Deny through Project ownership check                                               |
| AUTH-018 | Active member: create GenerationJob                | Allow on owned active Project, active account, valid request, and quota            |
| AUTH-019 | Active member: read own GenerationJob/status       | Allow through Project/requester lineage; child RenderJobs inherit that boundary    |
| AUTH-020 | Active member: another user's GenerationJob        | Deny child and parent jobs, including diagnostics and events                       |
| AUTH-021 | Active member: cancel/retry own Job                | Allow only when state machine marks command eligible                               |
| AUTH-022 | Active member: create RenderJob                    | Allow against an owned valid CompositionVersion and quota                          |
| AUTH-023 | Active member: another user's RenderJob            | Deny before provider status lookup                                                 |
| AUTH-024 | Active member: playback/download own RenderOutput  | Allow only when `verified + active`, not purged, and technical QA passed           |
| AUTH-025 | Active member: another user's RenderOutput         | Deny before signing or revealing object location                                   |
| AUTH-026 | Disabled user: authenticated product route         | Deny immediately with `ACCOUNT_DISABLED` even when session is not expired          |
| AUTH-041 | Rejected user: authenticated product route         | Deny immediately with `ACCOUNT_REJECTED`; retry only after admin status change     |
| AUTH-027 | Admin: list pending/active/disabled/rejected users | Allow with safe profile projection                                                 |
| AUTH-028 | Admin: approve user                                | Allow; record approver and audit event                                             |
| AUTH-029 | Admin: disable/reject user                         | Allow; revoke applicable sessions and audit                                        |
| AUTH-030 | Admin: hard-delete user for access revocation      | Deny; status transition is required                                                |
| AUTH-031 | Admin: inspect failed jobs                         | Allow safe diagnostics without raw secrets, paths, or provider payloads            |
| AUTH-032 | Admin: read ProviderCredentialReference            | Allow metadata and health state only                                               |
| AUTH-033 | Admin: update credential reference                 | Allow through write-only secret/reference workflow and audit event                 |
| AUTH-034 | Any read API: raw provider secret                  | Deny; never return plaintext secret                                                |
| AUTH-035 | Active member: read effective QuotaPolicy          | Allow safe effective limits applicable to self                                     |
| AUTH-036 | Admin: update QuotaPolicy                          | Allow validated policy changes and audit event                                     |
| AUTH-037 | Active member: read AuditEvent                     | Deny in MVP except explicitly safe events returned as part of own operation status |
| AUTH-038 | Admin: read AuditEvent                             | Allow safe metadata under operational policy; sensitive values remain redacted     |
| AUTH-039 | System worker: mutate Job/Step/resource            | Allow only with matching unexpired lease, job lineage, and scoped capability       |
| AUTH-040 | Purge Project/Asset/Output bytes                   | Allow only a durable system purge job; never an HTTP request handler               |

## Resource matrix

| Resource                    | Visitor/pending/disabled                  | Active member                       | Admin                                                                            | System worker                                |
| --------------------------- | ----------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| User/Session                | Own minimal status/logout only after auth | Own session/profile                 | Safe user administration                                                         | Session cleanup only with system capability  |
| Project                     | Deny                                      | Own only; trash/restore rules apply | No default private-content read; operational action must be explicit and audited | Lease-scoped maintenance/purge               |
| Asset                       | Deny                                      | Own project only                    | No default private-byte read                                                     | Lease-scoped ingestion/purge                 |
| CompositionVersion          | Deny                                      | Own project only                    | No default content read                                                          | Lease-scoped create/render                   |
| GenerationJob/RenderJob     | Deny                                      | Own jobs only                       | Safe operational diagnostics                                                     | Matching lease only                          |
| RenderOutput                | Deny                                      | Own `verified + active` output only | No default playback                                                              | Verify/purge under job capability            |
| ProviderCredentialReference | Deny                                      | Deny                                | Metadata/read, reference/write; no raw secret                                    | Resolve only for assigned provider operation |
| AuditEvent                  | Deny                                      | Minimal safe operation feedback     | Safe audit projection                                                            | Append only                                  |
| QuotaPolicy                 | Deny                                      | Effective own limits                | Manage and audit                                                                 | Read effective limits                        |

## Required enforcement order

1. Validate request shape and reject path/traversal forms.
2. Authenticate and load current User status on every protected request.
3. Authorize command against canonical resource ownership and lifecycle.
4. Apply quota/idempotency checks.
5. Resolve storage/provider references server-side only after authorization.
6. Execute application service and append audit event for sensitive commands.

## Security proofs required

Authorization tests must prove cross-user denial for Project, Asset, CompositionVersion, parent/child Job, and RenderOutput; pending/disabled/rejected denial with distinct account codes; invalid or expired lease denial; credential redaction; traversal rejection before storage access; and purge unreachability from ordinary HTTP handlers. Acceptance criteria are indexed in `../product/ACCEPTANCE_CRITERIA.md`.
