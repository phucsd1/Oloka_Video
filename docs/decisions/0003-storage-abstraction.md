# ADR 0003: Persistent storage abstraction

- Status: Accepted
- Date: 2026-08-05

## Context

Online development uses Hugging Face persistent disk, while future production may use object storage.

## Decision

Application services depend on `ObjectStorage`. The first adapter uses the filesystem below `/data` and owns its safe read/write readiness probe.

## Consequences

Routes contain no direct filesystem operations. A cloud object-store adapter can replace the filesystem adapter without changing HTTP contracts.
