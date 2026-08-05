# ADR 0014: Immutable RenderOutput core with guarded lifecycle

- Status: Accepted
- Date: 2026-08-05

## Context

Overwritten current output and file-derived availability cause stale delivery and broken lineage.

## Decision

Each render result creates a RenderOutput with immutable output identity, bytes, media metadata and lineage. Its availability, QA/review, retention and pin fields are guarded mutable lifecycle fields with concurrency controls and audit. Availability and retention use independent state machines. Playback/download is issued only while availability is verified, retention is active and technical QA has passed.

## Consequences

No mutable `output.mp4` product contract exists. Retry creates/reuses output only under the full Project/version/bundle/request/runtime/protocol/provider/fingerprint identity contract. Purge records retention `purged` plus availability `unavailable`; object existence alone never changes business state.
