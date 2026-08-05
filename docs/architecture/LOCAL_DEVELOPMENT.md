# Local development

## Setup

Install exactly Node.js `22.16.0` using `.nvmrc`/`.node-version` and run `npm ci`. Copy `.env.example` only when a local environment file is useful; never add `.env` to Git. Windows developers should set `DATA_DIR` and `DATABASE_URL` to a writable repository-local path because `/data` is the online Linux default.

`npm run dev` starts Fastify on `7860` and Vite on `5173`. Vite proxies API requests to Fastify. Production and browser checks use the single-port compiled build.

## Quality commands

- `npm run format:check` verifies formatting.
- `npm run lint` applies typed ESLint rules.
- `npm run typecheck` checks every workspace and tool configuration.
- `npm run test:unit` verifies environment, canonical JSON/hash vectors, health, and storage behavior.
- `npm run test:integration` exercises migrations/backup/restore, transaction and repository contracts, outbox delivery, and system endpoints.
- `npm run test:frontend` exercises connected and error states.
- `npm run build` produces all production artifacts.
- `npm run test:e2e` starts the compiled server and checks the page in Chromium.

## Data cleanup

Repository-local `.data`, `.tmp`, SQLite/WAL/SHM files, and backup directories are ignored. Stop the server before removing a SQLite development database, especially on Windows where open files remain locked. An existing v1 fixture needs a valid `OLOKA_APP_KEY` before v2 can run; fresh databases do not. Do not delete a mounted production `/data` volume or a recovery set as part of routine development.
