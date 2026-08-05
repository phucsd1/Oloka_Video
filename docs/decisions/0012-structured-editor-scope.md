# ADR 0012: Basic structured editor

- Status: Accepted
- Date: 2026-08-05

## Context

Direct document/DOM editing makes validation, authorization, versioning and preview/render parity unsafe.

## Decision

MVP edits only schema-allowlisted scene, voice, caption, aspect-ratio, BGM and style fields. Preview is read-only. Direct HTML/CSS/JavaScript, arbitrary code/DOM mutation, full visual Studio, advanced history and AI multi-turn editing are excluded.

## Consequences

Every edit validates and creates a CompositionVersion. Trusted render adapters may materialize runtime artifacts, but generated source is not the canonical edit contract.
