# Deployment

## Build artifact

The multi-stage Docker build installs the locked dependency graph, compiles contracts, design system, web, and server, then prunes development dependencies. The runtime stage contains only production dependencies and compiled artifacts. It runs as UID/GID `1000`, exposes `7860`, and includes an application health check.

Build identity enters the image through `APP_VERSION`, `GIT_COMMIT_SHA`, and `BUILD_TIMESTAMP` build arguments. Runtime configuration can override ordinary environment values, but production operators should keep build identity immutable.

## GitHub to Hugging Face

The `develop` deployment workflow invokes the reusable validation workflow first. Formatting, lint, typecheck, unit, integration, frontend, production, browser, and Docker checks must all pass. The deployment job then synchronizes the exact validated Git commit to `phucsd/Oloka-Video-Dev` using the masked `HF_TOKEN` secret. It also sets the Space runtime variables, including the validated Git SHA and deployment timestamp, so `/api/version` identifies the hosted source exactly.

The Space reads Docker metadata from the YAML header in `README.md`. Persistent Hugging Face storage must be attached at `/data`; replacing that path with ephemeral storage loses SQLite state after rebuilds.

## Observability

Fastify emits JSON logs to standard output. Use the Space Logs tab for build and container logs. Diagnose deployment layers separately: GitHub validation, repository sync, Docker build, container start, `/api/health`, then `/api/ready`.

## Rollback

Revert the faulty GitHub commit on `develop`. A new workflow run validates and deploys the revert. Confirm `/api/version` returns the expected rollback SHA and then confirm `/api/ready` reports every dependency ready.
