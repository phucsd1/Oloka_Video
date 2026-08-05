# Upload Protocol V1

## Decision

Oloka implements an application-managed resumable protocol; tus is not an MVP dependency. Chunks are sequential, default/max chunk size is 8 MiB, and the server is the offset authority. The asset-size ceiling and user/project storage admission come from `QuotaPolicy`, not constants in the browser.

## Protocol

1. `POST /api/v1/projects/:projectId/uploads` validates actor, project state, declared name/type/size, quota, and `Idempotency-Key`; it creates an opaque Asset in `upload_pending + active`, preallocates its server-only object key, and creates an `UploadSession` plus quota reservation.
2. `HEAD /api/v1/uploads/:uploadId` returns lifecycle, expected offset, declared length, expiry, and recommended chunk size.
3. `PATCH /api/v1/uploads/:uploadId` accepts `application/offset+octet-stream`, `Upload-Offset`, bounded `Content-Length`, and the CSRF header. Only `offset == expectedOffset` is accepted.
4. `POST /api/v1/uploads/:uploadId/complete` verifies declared versus actual length, checksum when declared, MIME evidence, quota, and project state. It then follows `OBJECT_STORAGE_V1.md` finalization, moves the existing Asset toward `processing`, and queues asset ingestion without changing Asset identity.
5. `DELETE /api/v1/uploads/:uploadId` idempotently aborts an open session and releases its reservation.

## State and retry semantics

`open -> verifying -> completed` is the success path. `open -> expired|aborted`; `verifying -> open` for a retryable inspection failure; terminal validation becomes `rejected`. Repeating create with the same idempotency key and semantic request returns the same session. Repeating a successfully accepted chunk at an older offset returns the authoritative offset without appending bytes only when its recorded chunk checksum matches; otherwise it returns `UPLOAD_OFFSET_CONFLICT`. A future offset always conflicts.

## Required errors

| Condition                            | Result                                                 |
| ------------------------------------ | ------------------------------------------------------ |
| wrong owner/project or cross-user ID | `404 RESOURCE_NOT_FOUND`                               |
| expired/terminal session             | `409 UPLOAD_NOT_OPEN`                                  |
| wrong offset                         | `409 UPLOAD_OFFSET_CONFLICT` plus authoritative offset |
| chunk over 8 MiB or request limit    | `413 PAYLOAD_TOO_LARGE`                                |
| declared/actual size mismatch        | `422 UPLOAD_LENGTH_MISMATCH`                           |
| MIME/signature not allowed           | `415 UNSUPPORTED_MEDIA_TYPE`                           |
| quota unavailable                    | `409 QUOTA_EXCEEDED`                                   |
| project deleted/version changed      | `409 RESOURCE_STATE_CONFLICT`                          |
| checksum mismatch                    | `422 CHECKSUM_MISMATCH`                                |

Filename is display metadata only: Unicode-normalized, length-bounded, stripped of control characters, and never used as a path. MIME detection is best-effort and must be paired with size limits, bounded analysis, and downstream decoder validation.

## Cleanup and crash safety

Sessions have `expiresAt`; an `upload_cleanup` job marks expired sessions, deletes staging bytes, and releases reservations idempotently. Every append records the new offset only after the file write is durably observable. Startup reconciliation repairs DB/file offset disagreement conservatively from actual bytes and never trusts the client to advance it.
