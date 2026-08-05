# ADR 0014: Immutable verified RenderOutput

- Status: Accepted
- Date: 2026-08-05

## Context

Overwritten current output and file-derived availability cause stale delivery and broken lineage.

## Decision

Each render result is a new immutable RenderOutput linked to Project, CompositionVersion, RenderJob, storage object/checksum, QA and renderer version. Playback/download is issued only after verified availability and technical pass.

## Consequences

No mutable `output.mp4` product contract exists. Retry creates/reuses output only under explicit idempotent hash rules. Retention and pinning operate on output entities.
