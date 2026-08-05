# ADR 0025: Immutable isolated preview

- Status: Accepted
- Date: 2026-08-05

## Context

Preview must match final render without executing user code or maintaining unsafe long-lived per-project servers. HyperFrames Studio preview is a development/editor server, not tenant isolation.

## Decision

Materialize each valid immutable CompositionVersion with the same trusted HyperFrames runtime/manifests used by render into an immutable artifact. Serve it through authenticated delivery in a read-only sandboxed iframe/player with strict CSP and no arbitrary network. Prefer the official embeddable player/core; if a process is necessary, use a bounded secret-free isolated worker with lease/TTL/cleanup.

## Consequences

Raw HTML/CSS/JS/URLs are rejected. Old previews never mutate, fingerprints link preview and render, and no forever CLI process is created per project. Runtime/materializer upgrades are versioned and parity-tested.
