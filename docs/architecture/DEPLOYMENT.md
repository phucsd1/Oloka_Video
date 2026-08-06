# Deployment

## Build artifact

All Node stages use exactly Node `22.16.0`. A separate build stage downloads Litestream `0.5.11`, verifies archive SHA-256 `2f80fdb6b0a0ff7a116ee37adf02d3de8e977ef76e052b28a6690218f0f7ab55`, and copies only its binary/license. The runtime contains production dependencies, compiled artifacts, immutable SQL migrations, and credential-free `/etc/litestream.yml`. It runs as UID/GID `1000`, exposes `7860`, and includes an application health check.

Build identity enters the image through `APP_VERSION`, `GIT_COMMIT_SHA`, and `BUILD_TIMESTAMP` build arguments. Runtime configuration can override ordinary environment values, but production operators should keep build identity immutable.

## GitHub to Hugging Face

The `develop` deployment workflow invokes validation first on Node `22.16.0`. Formatting, lint, typecheck, unit, integration, frontend, aggregate, build, browser, production-image, and pinned-MinIO three-boot recovery checks must pass. Validation destroys three successive local DB volumes while preserving the replica, proves startup counts 1/2/3 and signal shutdown, and never uses the production HF bucket.

The Space reads Docker metadata from the YAML header in `README.md`. `/data` remains the persistent object/backup mount. The live SQLite primary is local ephemeral storage at `/var/lib/oloka/database/oloka.db`; Litestream restores it before Fastify starts and continuously replicates it to the isolated production prefix `sqlite-replica/dev`.

Configure `OLOKA_APP_KEY`, `HF_S3_ACCESS_KEY_ID`, and
`HF_S3_SECRET_ACCESS_KEY` as Hugging Face Space secrets. The deploy preflight
checks names only. Set `OLOKA_DATABASE_BOOTSTRAP_MODE` explicitly as a Space
variable; a missing mode blocks upload. Use `fresh-if-replica-missing` only for
the separately approved first cutover, then change to `restore-required` after
replica verification. Never configure secret values as variables or build args.
Pre-migration recovery sets are written under
`/data/backups/pre-migration/<opaque-set>` and share the same volume failure
domain.

## Observability

Fastify and Litestream emit structured operational logs. Aggregates cover startup, restore, migration, database operation, transaction, event-loop delay, and SQLite busy counts without per-SQL logs. Diagnose deployment layers separately: GitHub validation, repository sync, Docker build, restore/bootstrap, Litestream supervision, container start, `/api/health`, then `/api/ready`.

This implementation PR does not set the live bootstrap variable, upload the
Space, touch `sqlite-replica/dev`, restart the Space, or migrate/delete the
legacy `/data/database/oloka-dev.db`. Those are a separate cutover gate.

## Rollback

There are no down migrations. Before accepted v2 writes, stop the app, verify and restore the authenticated pre-v2 recovery set, then deploy the compatible Phase 2 build. Otherwise ship a forward repair. Source-only rollback uses a revert commit on `develop`; confirm `/api/version` and `/api/ready` after deployment.
