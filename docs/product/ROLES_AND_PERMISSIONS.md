# Roles and Permissions

## Actors

| Actor                  | Product access                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Visitor                | Landing, health/version as public policy permits, Google OAuth entry/callback                                      |
| Pending user           | Own pending/account state and logout only                                                                          |
| Active member          | Own Projects, Assets, CompositionVersions, Jobs, deliverable `verified + active` RenderOutputs and effective quota |
| Disabled/rejected user | No product routes; minimum account/logout surface only                                                             |
| Admin                  | User lifecycle, safe job operations, credential references/health, quota and safe audit views                      |
| System worker          | Lease-scoped job/resource operations and scheduled purge only                                                      |

## Product permission summary

- Members never read another user's Project, Asset, CompositionVersion, Job, or RenderOutput.
- Admin is not a blanket private-content reader. Owner-facing Project,
  CompositionVersion, Job status/history/SSE, Asset and Output routes remain
  owner-only. MVP Job diagnostics use only redacted admin list/detail surfaces.
- Pending/disabled/rejected status is checked on every protected request, not only at session creation.
- Storage keys, paths and provider IDs do not grant access; the server resolves them after canonical authorization.
- Provider secrets are write-only through references; no role reads raw secret values.
- Restore belongs to the owner within retention. Purge belongs only to a durable system job.
- Every approval, disable/reject, credential change, quota change, delete/restore/purge and sensitive operation emits an AuditEvent.
- No role/status mutation may leave the system without an active admin. The
  first admin exists only through the documented verified-Google bootstrap;
  recovery has no authenticated HTTP bypass.

The normative 44-rule policy is in `../architecture/AUTHORIZATION_MODEL.md`.
