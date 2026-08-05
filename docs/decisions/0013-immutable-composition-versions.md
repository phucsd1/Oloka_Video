# ADR 0013: Immutable CompositionVersion

- Status: Accepted
- Date: 2026-08-05

## Context

Mutable current HTML and competing editor/pipeline writes prevent reliable lineage and retry.

## Decision

Generation and every edit create an immutable, monotonically numbered CompositionVersion with structured document and frozen dependency, asset, font, caption and runtime manifests. Materialization deterministically derives the canonical render lineage and fingerprint defined by the render protocol. Project selects a current version transactionally.

## Consequences

Preview, render, diagnostics and outputs identify an exact version and compare the same lineage fingerprint. Rollback means selecting/deriving a new current version, never mutating history.
