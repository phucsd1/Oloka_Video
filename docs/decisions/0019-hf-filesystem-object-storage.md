# ADR 0019: Hugging Face filesystem object storage

- Status: Accepted
- Date: 2026-08-05

## Context

The single HF Space provides persistent `/data`; the MVP does not need a second cloud storage control plane, but private media must not become public paths.

## Decision

Store durable immutable bytes under `/data/objects` and staging bytes under `/data/tmp` through a contained object adapter. Keys are opaque, server-generated, and never client-visible. Finalize uses verified staging and an atomic same-filesystem rename followed by a guarded DB commit and reconciliation.

## Consequences

No runtime byte enters Git, public static serving, S3, or R2. DB/filesystem atomicity gaps are explicit and crash-tested. Same-volume persistence is not DR; future S3-compatible migration uses the adapter after a new scaling/DR decision.
