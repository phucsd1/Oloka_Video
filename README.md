---
title: Oloka Video
emoji: 🎬
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Oloka Video

Oloka Video is a greenfield TypeScript modular monolith. This foundation hosts a React frontend and a Fastify API in one Docker image on port `7860`, with explicit database, storage, contract, and design-system boundaries. Phase 3A adds the persistence kernel only; product features remain intentionally absent.

## Repository layout

- `apps/web` — React status experience built by Vite.
- `apps/server` — Fastify API and production static-file host.
- `packages/contracts` — shared Zod API schemas and TypeScript types.
- `packages/design-system` — design tokens and reusable UI primitives.
- `docs/architecture` — architecture and operations guides.
- `docs/decisions` — architecture decision records.

## Run locally

Requirements: Node.js `22.16.0`, npm, and a writable data directory. Use `.nvmrc` or `.node-version`; the exact patch is required because the persistence backup contract depends on that runtime.

```bash
npm ci
npm run dev
```

The API listens on `http://localhost:7860`; Vite serves the local frontend on `http://localhost:5173` and proxies `/api` to the backend. On Windows, override the Linux online defaults:

```powershell
$env:DATA_DIR = "$PWD\.data"
$env:DATABASE_URL = "file:$($PWD.Path.Replace('\','/'))/.data/database/oloka-dev.db"
npm run dev
```

Run all local validation:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

An existing database with a pending migration also requires
`OLOKA_APP_KEY`: an operator-managed secret encoded as canonical unpadded
base64url for exactly 32 random bytes. A fresh empty database does not require
the key. Never commit, print, or pass it as a Docker build argument.

## Build and run Docker

```bash
docker build \
  --build-arg APP_VERSION=0.1.0 \
  --build-arg GIT_COMMIT_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t oloka-video:dev .

docker run --rm -p 7860:7860 \
  -e OLOKA_APP_KEY="$OLOKA_APP_KEY" \
  -v oloka-video-data:/data oloka-video:dev
```

The named volume is mounted at `/data`; the development SQLite database is created at `/data/database/oloka-dev.db`. The process runs as UID `1000`.

## Verify the service

```bash
curl http://localhost:7860/api/health
curl http://localhost:7860/api/ready
curl http://localhost:7860/api/version
```

`health` only confirms that the application process responds. `ready` verifies the exact migration ledger/checksums, SQLite connection invariants and foreign keys, plus the filesystem read/write check. `version` exposes immutable build identity.

## Configure Hugging Face

1. Create the Docker Space `phucsd/Oloka-Video-Dev` and select Docker SDK.
2. Configure persistent storage so Hugging Face mounts it at `/data`.
3. In the GitHub repository, open **Settings → Secrets and variables → Actions** and add a repository secret named `HF_TOKEN`. Use a Hugging Face token with write access to the target Space.
4. Push a validated change to `develop`. `.github/workflows/deploy-hf.yml` runs the full validation workflow and only pushes to the Space after it succeeds.
5. Open the Space **Logs** tab to view Docker build logs and structured runtime logs. The public application is available at `https://phucsd-oloka-video-dev.hf.space` after the Space reaches `RUNNING`.

No token belongs in `.env`, Git history, Docker build arguments, or the Space repository.

## Roll back a deployment

Find the last known-good commit in GitHub Actions or `GET /api/version`, then create a revert commit on `develop` and push it. The same validation gate redeploys that source state:

```bash
git revert <bad-commit-sha>
git push origin develop
```

Avoid force-resetting shared GitHub history. If the Space itself is unhealthy, pause it while investigating and restart after a validated rollback is available.

See [Phase 3A persistence kernel](docs/architecture/PHASE3A_PERSISTENCE_KERNEL.md), [foundation architecture](docs/architecture/FOUNDATION.md), [deployment](docs/architecture/DEPLOYMENT.md), and [local development](docs/architecture/LOCAL_DEVELOPMENT.md) for deeper operational details.
