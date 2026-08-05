# ADR 0015: Mandatory technical quality gate

- Status: Accepted
- Date: 2026-08-05

## Context

Render process success does not prove a usable, compatible or available video.

## Decision

Mandatory verification covers object/checksum, readable media/streams, dimensions, duration tolerance, codecs, required Assets and all schema/protocol/font/renderer/runtime versions. `technicalStatus`, `visualReviewStatus` and `humanApprovalStatus` remain separate.

## Consequences

Technical failure prevents successful completion/publication. Visual AI remains not required and human approval defaults to not required in MVP. No generic quality boolean exists.
