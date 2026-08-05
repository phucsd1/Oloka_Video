# ADR 0001: TypeScript modular monolith

- Status: Accepted
- Date: 2026-08-05

## Context

Oloka Video needs a small deployable base while preserving explicit frontend, backend, contract, and UI boundaries.

## Decision

Use npm workspaces with `apps/web`, `apps/server`, `packages/contracts`, and `packages/design-system`. Build one deployable process without combining source modules.

## Consequences

One image and one runtime simplify operations. Workspace contracts prevent accidental coupling and leave modules separable if scale later justifies it.
