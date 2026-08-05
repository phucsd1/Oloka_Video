# ADR 0011: Single Hugging Face MVP topology

- Status: Accepted
- Date: 2026-08-05

## Context

Phase 0 found overlapping HF and incomplete Cloudflare contracts.

## Decision

Use GitHub → validation-gated GitHub Actions → one Hugging Face Docker Space → application web/API → durable database abstraction → object storage abstraction → Modal render.

## Consequences

Cloudflare frontend/backend, D1, R2, dual topology and dual writes are excluded. Runtime exposes validated source SHA; CI failure blocks HF sync.
