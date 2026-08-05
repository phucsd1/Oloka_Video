# ADR 0008: Private Project-owned Assets

- Status: Accepted
- Date: 2026-08-05

## Context

Filename identity and a global shared library created ownership, permission and lifecycle ambiguity.

## Decision

Every MVP Asset has an opaque ID, owner and Project. Metadata is canonical in the database; bytes are in object storage behind server-generated keys/capabilities. Authorization is deny-by-default. Original filename is metadata only.

## Consequences

No global library exists. Cross-user reads and client storage paths are forbidden. Search is limited to agreed basic metadata; advanced enrichment/search/duplicate workflows are deferred.
