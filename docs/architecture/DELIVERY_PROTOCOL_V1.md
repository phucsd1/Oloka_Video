# Delivery Protocol V1

## Authorization path

No route exposes `/data` or accepts a storage key. A delivery request follows:

`resource ID -> authenticated actor -> ownership/role authorization -> lifecycle check -> server key resolution -> contained range stream`.

Unknown and unauthorized private resources both return `404 RESOURCE_NOT_FOUND`. Deleted, quarantined, incomplete, or failed resources are not delivered.

## HTTP behavior

- Assets, preview artifacts, and render outputs support `GET` and `HEAD` through resource-specific `/api/v1` routes.
- Single HTTP byte ranges are supported with `Accept-Ranges: bytes`, validated `Range`, `206`, `Content-Range`, and exact `Content-Length`.
- Invalid/unsatisfiable ranges return `416 RANGE_NOT_SATISFIABLE` with
  `Content-Range: bytes */<size>`.
- Responses use the stored verified content type, safe `Content-Disposition`, `ETag` derived from immutable byte checksum, `Last-Modified`, `nosniff`, and private cache policy.
- Conditional `If-None-Match` may return `304`. Multi-range requests are rejected in MVP.
- Stream abort closes the file handle and records safe metrics; it never changes resource state.

## Optional short-lived capability

The normal path uses the session cookie. Where an embedded player or download handoff needs a URL capability, the app may issue a random opaque token whose SHA-256 hash is stored in `delivery_capabilities`. It is scoped to one resource ID and operation (`preview`, `stream`, or `download`), has a short expiry (default five minutes), and cannot expand actor authorization.

Issuance itself requires a current authorized session. The URL contains only the opaque token, never a storage key or secret. Tokens are not logged; access logs redact query strings. Revocation, expiry, resource lifecycle change, or user disable invalidates the capability. Download capabilities may be single-use; range/player capabilities may be reused until expiry.

## Failure handling

Missing underlying bytes are not converted to an empty response: return safe
`503 STORAGE_UNAVAILABLE`, mark a reconciliation incident, and alert. Checksum
mismatch returns `CHECKSUM_MISMATCH` on non-streaming verification paths and
quarantines delivery before further access. Backpressure is provided by Node
streams; the server never buffers a full media object in memory.
