# ADR 0013: Immutable CompositionVersion

- Status: Accepted
- Date: 2026-08-05

## Context

Mutable current HTML and competing editor/pipeline writes prevent reliable lineage and retry.

## Decision

Generation and every edit create an immutable, monotonically numbered CompositionVersion with structured document and frozen dependency/font/runtime manifests. Project selects a current version transactionally.

## Consequences

Preview, render, diagnostics and outputs identify an exact version. Rollback means selecting/deriving a new current version, never mutating history.
