# ADR 0007: No Workspace entity in MVP

- Status: Accepted
- Date: 2026-08-05

## Context

The reference system conflated working directories, aliases and special Projects with Workspace semantics.

## Decision

After login, users enter an owner-scoped Project List. MVP has no Workspace, `workspace`/`workspace-<user>` alias, hidden/default Project, or special identity/path behavior.

## Consequences

Project is the central work unit. A future Organization/Team Workspace requires a separate entity, authorization model, migration plan and ADR.
