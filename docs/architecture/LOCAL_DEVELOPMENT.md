# Local development

## Setup

Install Node.js 22 or later and run `npm ci`. Copy `.env.example` only when a local environment file is useful; never add `.env` to Git. Windows developers should set `DATA_DIR` and `DATABASE_URL` to a writable repository-local path because `/data` is the online Linux default.

`npm run dev` starts Fastify on `7860` and Vite on `5173`. Vite proxies API requests to Fastify. Production and browser checks use the single-port compiled build.

## Quality commands

- `npm run format:check` verifies formatting.
- `npm run lint` applies typed ESLint rules.
- `npm run typecheck` checks every workspace and tool configuration.
- `npm run test:unit` verifies environment, health, and storage behavior.
- `npm run test:integration` exercises all system endpoints through Fastify injection.
- `npm run test:frontend` exercises connected and error states.
- `npm run build` produces all production artifacts.
- `npm run test:e2e` starts the compiled server and checks the page in Chromium.

## Data cleanup

Repository-local `.data` and `.tmp` directories are ignored. Stop the server before removing a SQLite development database, especially on Windows where open files remain locked. Do not delete a mounted production `/data` volume as part of routine development.
