# ADR 0024: Resumable upload and authorized range delivery

- Status: Accepted
- Date: 2026-08-05

## Context

Large private media needs restartable transfer and video seeking while storage keys and `/data` must remain private.

## Decision

Implement sequential application-managed uploads with server-authoritative offset, 8 MiB chunks, durable upload sessions, quota reservations, checksum/MIME/length verification, expiry/abort/cleanup, and idempotent retry. Deliver by authorized resource ID with HTTP single-range support. Optional short-lived opaque capabilities are resource/operation scoped and stored only as hashes.

## Consequences

Tus/multipart/public filesystem URLs are excluded. Original filenames are metadata only. Offset conflicts, cross-user access, traversal, missing bytes, stream abort, and 416 behavior receive explicit tests and safe errors.
