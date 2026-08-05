# ADR 0010: Modal-only hosted final rendering

- Status: Accepted
- Date: 2026-08-05

## Context

Multiple production render choices create parity, deadline and operational ambiguity.

## Decision

Modal is the sole final-render provider for hosted MVP behind a typed, versioned render adapter. Local render is development tooling only and is neither user-selectable nor an automatic production fallback.

## Consequences

Modal protocol/version/capability checks are release gates. Provider outage surfaces a typed failure/retry path instead of silently changing runtime.
