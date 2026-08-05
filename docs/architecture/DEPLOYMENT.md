# Deployment

## Build artifact

Both Docker stages use exactly Node `22.16.0`. The multi-stage build installs the locked dependency graph, compiles contracts, design system, web, and server, then prunes development dependencies. The runtime stage contains production dependencies, compiled artifacts, and immutable SQL migration assets. It runs as UID/GID `1000`, exposes `7860`, and includes an application health check.

Build identity enters the image through `APP_VERSION`, `GIT_COMMIT_SHA`, and `BUILD_TIMESTAMP` build arguments. Runtime configuration can override ordinary environment values, but production operators should keep build identity immutable.

## GitHub to Hugging Face

The `develop` deployment workflow invokes the reusable validation workflow first on Node `22.16.0`. Formatting, lint, typecheck, unit, integration, frontend, aggregate test, production, browser, Docker build, and two-start named-volume persistence checks must pass. The deployment job then synchronizes the exact validated Git commit to `phucsd/Oloka-Video-Dev` using the masked `HF_TOKEN` secret. It also sets the Space runtime variables, including the validated Git SHA and deployment timestamp, so `/api/version` identifies the hosted source exactly.

The Space reads Docker metadata from the YAML header in `README.md`. Persistent Hugging Face storage must be attached at `/data`; replacing that path with ephemeral storage loses SQLite state after rebuilds.

Configure `OLOKA_APP_KEY` as a Hugging Face Space secret before deploying a
build that can upgrade an existing database. It must be unpadded base64url for
exactly 32 random bytes. Never configure it as a public variable or build arg.
Pre-migration recovery sets are written under
`/data/backups/pre-migration/<opaque-set>` and share the same volume failure
domain.

## Observability

Fastify emits JSON logs to standard output. Use the Space Logs tab for build and container logs. Diagnose deployment layers separately: GitHub validation, repository sync, Docker build, container start, `/api/health`, then `/api/ready`.

## Rollback

There are no down migrations. Before accepted v2 writes, stop the app, verify and restore the authenticated pre-v2 recovery set, then deploy the compatible Phase 2 build. Otherwise ship a forward repair. Source-only rollback uses a revert commit on `develop`; confirm `/api/version` and `/api/ready` after deployment.
