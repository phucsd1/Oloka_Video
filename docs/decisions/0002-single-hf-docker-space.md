# ADR 0002: Single Hugging Face Docker Space

- Status: Accepted
- Date: 2026-08-05

## Context

The development environment needs to be online from the first commit with minimal operational surface.

## Decision

Serve the compiled React application and API from one Fastify process on public port `7860` in `phucsd/Oloka-Video-Dev`.

## Consequences

Frontend and API share an origin, eliminating CORS configuration and coordinating deployment. Independent scaling is deferred until product usage requires it.
